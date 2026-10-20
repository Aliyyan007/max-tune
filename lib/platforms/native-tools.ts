import { spawn } from 'child_process';
import { getSetting, pickToken } from '@/lib/token-pool';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import ffmpegPath from 'ffmpeg-static';

export type NativeResult = { file: string; size: number; format: string };

const TIMEOUT_MS = 300000; // 5 min — downloads can be slow

export function credFilePath(kind: string, key: string): string {
    const dir = path.join(process.cwd(), 'data');
    fs.mkdirSync(dir, { recursive: true });
    const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
    return path.join(dir, `${kind}-${hash}.json`);
}

// Spawn a process, capture stdout (last line = JSON result) and stderr (for errors)
export function runNativeTool(cmd: string, args: string[], env: Record<string, string> = {}, timeoutMs = TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true });
        let out = '';
        let err = '';
        const kill = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error(`${path.basename(cmd)} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        proc.stdout.on('data', (d) => (out += d.toString()));
        proc.stderr.on('data', (d) => (err += d.toString()));
        proc.on('error', (e) => {
            clearTimeout(kill);
            reject(new Error(`${path.basename(cmd)} failed to start: ${e.message}`));
        });
        proc.on('close', (code) => {
            clearTimeout(kill);
            if (code === 0) {
                // last non-empty line should be JSON
                const lines = out.trim().split(/\r?\n/).filter(Boolean);
                resolve(lines[lines.length - 1] ?? out.trim());
            } else {
                reject(new Error((err.trim() || out.trim() || `exit code ${code}`).slice(-1400)));
            }
        });
    });
}

// amdl prints progress lines + a trailing JSON array — last-line truncation
// loses the real failure reason, so it gets full-output capture.
export function runNativeToolFull(cmd: string, args: string[], env: Record<string, string> = {}, timeoutMs = TIMEOUT_MS): Promise<{ out: string; err: string }> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true });
        let out = '';
        let err = '';
        const kill = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error(`${path.basename(cmd)} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        proc.stdout.on('data', (d) => (out += d.toString()));
        proc.stderr.on('data', (d) => (err += d.toString()));
        proc.on('error', (e) => {
            clearTimeout(kill);
            reject(new Error(`${path.basename(cmd)} failed to start: ${e.message}`));
        });
        proc.on('close', () => {
            clearTimeout(kill);
            resolve({ out, err });
        });
    });
}

export function parseNativeResult(line: string): NativeResult {
    let obj: any;
    try {
        obj = JSON.parse(line);
    } catch {
        throw new Error(`tool returned non-JSON output: ${line.slice(0, 200)}`);
    }
    if (obj.error) throw new Error(obj.error);
    if (!obj.file || !obj.size) throw new Error('tool produced no file');
    return obj as NativeResult;
}

export function tmpOutPath(prefix: string, ext: string): string {
    return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
}

// True when real-audio downloads are possible: a stored OAuth session exists
// (written by Settings → Connect Spotify / tools/spotify-login.py).
export function hasSpotifyNativeCreds(): boolean {
    return spotifyCredFile() !== null;
}

// Most recent stored credentials file: our data/ dir, then zotify's default location
function spotifyCredFile(): string | null {
    materializeSessions();
    const dirs = [path.join(process.cwd(), 'data'), path.join(process.env.APPDATA ?? '', 'Zotify')];
    const found: string[] = [];
    for (const dir of dirs) {
        try {
            for (const f of fs.readdirSync(dir)) {
                const full = path.join(dir, f);
                if (f === 'credentials.json' || /^spotify-(?!oauth-|pkce-).*\.json$/.test(f)) found.push(full);
            }
        } catch {}
    }
    return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// protobuf 6.x (pywidevine dep) rejects librespot's old generated _pb2 files —
// the pure-python impl accepts both generations.
export const PY_ENV = { PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION: 'python' };
// Docker images install the tools into their own venv (dependency conflicts) —
// NATIVE_PYTHON points at it; falls back to system python.
export const PY_BIN = process.env.NATIVE_PYTHON || 'python';

// data/ is gitignored/dockerignored — hosted deployments ship credentials as env
// vars instead. Materialize them into data/ once so every tool sees real files.
let sessionsMaterialized = false;
export function materializeSessions() {
    if (sessionsMaterialized) return;
    sessionsMaterialized = true;
    const dir = path.join(process.cwd(), 'data');
    const write = (name: string, content: string | undefined, b64 = false) => {
        if (!content) return;
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, name), b64 ? Buffer.from(content, 'base64') : content);
        } catch {}
    };
    write('spotify-env-session.json', process.env.SPOTIFY_SESSION_JSON);
    write('amazon-session.json', process.env.AMAZON_SESSION_JSON);
    write('amazon-device.wvd', process.env.AMAZON_DEVICE_WVD_B64, true);
}

// Durable session material on ephemeral hosts: the connect flows run on the web
// process and write to its private disk — Redis is the shared store. The worker
// hydrates at boot and lazily when a cred file is absent.
let sessionsHydrated = false;
export async function hydrateSessionsFromRedis(): Promise<void> {
    if (sessionsHydrated) return;
    sessionsHydrated = true;
    try {
        const { kvGet } = await import('../queue');
        const dir = path.join(process.cwd(), 'data');
        const writeIfAbsent = async (name: string, key: string) => {
            const p = path.join(dir, name);
            if (fs.existsSync(p)) return;
            const v = await kvGet(key);
            if (!v) return;
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(p, v);
        };
        await writeIfAbsent('spotify-redis.json', 'session:spotify');
        await writeIfAbsent('amazon-session.json', 'session:amazon');
    } catch {}
}

// Serialize every librespot-session spawn — Spotify's AP drops concurrent sessions on
// the same account (RemoteDisconnected), so parallel python calls kill each other.
let librespotQueue: Promise<void> = Promise.resolve();
export function withLibrespotLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = librespotQueue;
    let release: () => void;
    librespotQueue = new Promise((r) => (release = r));
    return prev.then(() => fn()).finally(() => release!());
}

// librespot session creation can hang on a dropped AP socket — hard timeout + fresh-process retries
// (each attempt re-resolves access points; a stalled socket never recovers on its own).
const SPOTIFY_ATTEMPT_TIMEOUT = 90000;
const SPOTIFY_ATTEMPTS = 3;

// Download a Spotify track via librespot (tools/spotify-native.py). Returns path to the .ogg file.
// Auth comes from the stored OAuth session written by the Settings → Connect Spotify flow
// (tools/spotify-login.py) — the account's tier decides what the keys unlock.
export async function downloadSpotifyNative(trackId: string, quality: 'normal' | 'high' | 'very_high' | 'lossless'): Promise<NativeResult> {
    let stored = spotifyCredFile();
    if (!stored) {
        // web-side Connect wrote the session to Redis on hosted deploys — pull it
        await hydrateSessionsFromRedis();
        stored = spotifyCredFile();
    }
    if (!stored) throw new Error('Spotify account not connected — use Settings → Connect Spotify to link one');
    const args = [
        path.join(process.cwd(), 'tools', 'spotify-native.py'),
        trackId,
        tmpOutPath('spotify-native', 'ogg'),
        '--quality',
        quality,
        '--creds',
        stored
    ];

    let lastErr: any = null;
    for (let attempt = 1; attempt <= SPOTIFY_ATTEMPTS; attempt++) {
        try {
            const line = await withLibrespotLock(() => runNativeTool(PY_BIN, args, PY_ENV, SPOTIFY_ATTEMPT_TIMEOUT));
            const result = parseNativeResult(line);
            if (!fs.existsSync(result.file)) throw new Error('tool produced no file');
            return result;
        } catch (e: any) {
            lastErr = e;
            console.warn(`[spotify-native] attempt ${attempt} quality=${quality}: ${e?.message ?? e}`);
            // permanent errors — don't retry
            if (/BadCredentials|no_credentials|premium_required|bad_track_id/i.test(e?.message ?? '')) throw e;
            if (attempt < SPOTIFY_ATTEMPTS) await sleep(2000 * attempt);
        }
    }
    throw lastErr;
}

function findAudioFile(dir: string): { file: string; size: number } | null {
    const candidates: string[] = [];
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(m4a|mp4|flac|ogg|opus|mp3|wav)$/i.test(e.name)) candidates.push(p);
        }
    };
    walk(dir);
    if (!candidates.length) return null;
    candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    return { file: candidates[0], size: fs.statSync(candidates[0]).size };
}

// Resolve the account's storefront so download URLs match the account's region
// (a `us` URL can 404 on region-locked tracks). Dev JWT is scraped from music.apple.com's JS.
let devJwtCache: { token: string; at: number } | null = null;
async function appleDevToken(): Promise<string> {
    if (devJwtCache && Date.now() - devJwtCache.at < 50 * 60 * 1000) return devJwtCache.token;
    const page = await fetch('https://music.apple.com', { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.text());
    // Apple renamed the bundle index-*.js → index~*.js — accept both separators
    const js = page.match(/\/assets\/index[~_-][\w~.-]+\.js/)?.[0];
    if (!js) throw new Error('dev token: no index js');
    const code = await fetch(`https://music.apple.com${js}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.text());
    // the bundle embeds several JWTs — the Music API dev token is the one whose
    // payload claims iss starts with "AMP" (the web player's WebPlay credential)
    let token: string | null = null;
    for (const m of code.matchAll(/eyJ[A-Za-z0-9_.-]{50,}/g)) {
        try {
            const payload = JSON.parse(Buffer.from(m[0].split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
            if (String(payload?.iss ?? '').startsWith('AMP')) {
                token = m[0];
                break;
            }
            token ??= m[0];
        } catch {}
    }
    if (!token) throw new Error('dev token not found in js');
    devJwtCache = { token, at: Date.now() };
    return token;
}

async function appleStorefront(mediaToken: string): Promise<string> {
    const jwt = await appleDevToken();
    const res = await fetch('https://amp-api.music.apple.com/v1/me/storefront', {
        headers: { Authorization: `Bearer ${jwt}`, 'Media-User-Token': mediaToken, 'User-Agent': 'Mozilla/5.0', Origin: 'https://music.apple.com' },
        signal: AbortSignal.timeout(8000)
    });
    const data = await res.json();
    return data?.data?.[0]?.id ?? 'us';
}

// Apple Music via amdl.exe — needs a running wrapper-lite service (user supplies Apple native
// libraries) plus the account's media-user-token. Produces ALAC/AAC from Apple's own CDN.
export async function downloadAppleNative(adamId: string, quality: 'alac-hi' | 'alac' | 'aac', tokens: { appleMediaToken?: string; appleWrapper?: string; isrc?: string; title?: string; artist?: string }): Promise<NativeResult> {
    const mediaToken = pickToken('apple') || tokens.appleMediaToken || process.env.APPLE_MEDIA_USER_TOKEN;
    if (!mediaToken) throw new Error('Apple Music requires a media-user-token — configure one in the admin panel');
    // Windows dev uses amdl.exe; Render/Linux workers carry the ELF build as bin/amdl
    const amdl = [path.join(process.cwd(), 'bin', 'amdl.exe'), path.join(process.cwd(), 'bin', 'amdl')].find((p) => fs.existsSync(p));
    if (!amdl) throw new Error('bin/amdl[.exe] missing');
    // wrapper endpoints accept a comma-separated list — each instance may hold a
    // different-region Apple account, so probing the set covers more storefronts
    const wrapperList = (tokens.appleWrapper || getSetting('appleWrapperUrl') || process.env.APPLE_WRAPPER_URL || 'http://127.0.0.1:12340')
        .split(',')
        .map((u) => u.trim().replace(/\/$/, ''))
        .filter(Boolean);
    type Wrapper = { url: string; regions: string[] };
    const wrappers: Wrapper[] = [];
    for (const u of wrapperList) {
        try {
            // TCG/QEMU wrappers on shared vCPUs burst past 8s — give a remote
            // instance room before counting it out (inconclusive != locked).
            const r = await fetch(`${u}/status`, { signal: AbortSignal.timeout(20000) });
            const j = await r.json().catch(() => null);
            wrappers.push({ url: u, regions: j?.data?.regions ?? [] });
        } catch {}
    }
    if (!wrappers.length) throw new Error(`Apple wrapper-lite not reachable at ${wrapperList.join(', ')} — start wrapper-lite-qemu.exe first, then retry`);

    // find which wrapper can serve an adamId — returns the wrapper, 'no' when
    // every wrapper definitively rejected it, or null when probes were
    // inconclusive (TCG guests can be slow — don't misreport timeouts as locks)
    const wrapperFor = async (id: string): Promise<Wrapper | 'no' | null> => {
        let sawInconclusive = false;
        // shuffle so same-region wrappers actually spread load across jobs
        for (const w of [...wrappers].sort(() => Math.random() - 0.5)) {
            const r = await fetch(`${w.url}/m3u8?adamId=${id}`, { signal: AbortSignal.timeout(25000) }).catch(() => null);
            const j = await r?.json().catch(() => null);
            if (j?.code === 0) return w;
            if (!j) sawInconclusive = true;
        }
        return sawInconclusive ? null : 'no';
    };
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amdl-'));
    // region-correct storefront: /v1/me/storefront (dev JWT + media-user-token); 'us' fallback
    const storefront = await appleStorefront(mediaToken).catch(() => 'us');
    // preflight: {"code":404} on /m3u8 means the account's storefront can't serve
    // this track under THAT adamId. The same recording often exists under a
    // different per-region adamId — resolve by ISRC (global id) or title+artist.
    let useId = adamId;
    let chosen: Wrapper | 'no' | null = await wrapperFor(adamId);
    if (chosen === 'no') {
        // search the SERVING wrapper's storefront — searching `us` just returns
        // the same us adamId that already failed; pk-region accounts license pk
        // catalog ids for the same recording.
        const wrapperStorefronts = [...new Set(wrappers.flatMap((w) => w.regions))];
        const searchStorefronts = [...wrapperStorefronts, storefront];
        const candidates: { trackId: number; trackName?: string; artistName?: string }[] = [];
        const itunesSearch = (term: string, country: string) =>
            fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&country=${country}&limit=10`, { signal: AbortSignal.timeout(10000) })
                .then((r) => r.json())
                .catch(() => null);
        if (tokens.isrc) {
            for (const sf of searchStorefronts) {
                const byIsrc = await itunesSearch(tokens.isrc, sf);
                candidates.push(...(byIsrc?.results ?? []));
                if (candidates.length) break;
            }
        }
        if (!candidates.length && (tokens.title || tokens.artist)) {
            const q = [tokens.title, tokens.artist].filter(Boolean).join(' ');
            const wantTitle = (tokens.title ?? '').trim().toLowerCase();
            const wantArtist = (tokens.artist ?? '').split(/[,&]/)[0].trim().toLowerCase();
            for (const sf of searchStorefronts) {
                const byName = await itunesSearch(q, sf);
                candidates.push(
                    ...(byName?.results ?? []).filter((t: any) => {
                        const name = (t.trackName ?? '').trim().toLowerCase();
                        const artist = (t.artistName ?? '').toLowerCase();
                        // title must match exactly or differ only by a bracketed suffix —
                        // "Faded" must not resolve to "Faded (Interlude)" (different recording)
                        const titleOk = !wantTitle || name === wantTitle;
                        const artistOk = !wantArtist || artist.includes(wantArtist);
                        return titleOk && artistOk;
                    })
                );
                if (candidates.length) break;
            }
        }
        for (const c of candidates) {
            const cid = String(c.trackId ?? '');
            if (!cid || cid === adamId) continue;
            const w = await wrapperFor(cid);
            if (w && w !== 'no') {
                useId = cid;
                chosen = w;
                break;
            }
        }
        if (chosen === 'no') {
            fs.rmSync(workDir, { recursive: true, force: true });
            throw new Error(`track not available in the account's storefront (${storefront}) — region-locked or removed`);
        }
    }
    const activeWrapper = chosen && typeof chosen === 'object' ? chosen : wrappers[0];
    // the serving wrapper's region drives storefront + lookup — a us-region
    // wrapper needs us-catalog URLs even when the account storefront is pk
    const useStorefront = activeWrapper.regions?.[0] || storefront;
    // amdl 404s on bare /song/<id> URLs — resolve the canonical album-style URL
    // (…/album/<slug>/<collectionId>?i=<trackId>) via iTunes lookup in the
    // serving storefront so region handling stays consistent.
    const lookup = await fetch(`https://itunes.apple.com/lookup?id=${useId}&entity=song&country=${useStorefront}`, { signal: AbortSignal.timeout(10000) })
        .then((r) => r.json())
        .catch(() => null);
    const trackViewUrl = lookup?.results?.find((x: any) => x?.trackViewUrl)?.trackViewUrl as string | undefined;
    const config = [
        'general:',
        `  lite-server: "${activeWrapper.url}"`,
        `  media-user-token: "${mediaToken}"`,
        `  storefront: "${useStorefront}"`,
        '  exit-on-error: true',
        'media:',
        // 'all' mode is what avoids the wrapper's Invalid CKC / EOF failures —
        // the narrow default manifest fetch drops the streams the key service needs
        '  get-m3u8-mode: "all"',
        `  alac-max: ${quality === 'alac-hi' ? 192000 : 44100}`,
        '  aac-type: "aac-lc"',
        'paths:',
        `  alac: "${workDir.replace(/\\/g, '/')}/alac"`,
        `  aac: "${workDir.replace(/\\/g, '/')}/aac"`,
        `  atmos: "${workDir.replace(/\\/g, '/')}/atmos"`,
        ''
    ].join('\n');
    const cfgPath = path.join(workDir, 'config.yaml');
    fs.writeFileSync(cfgPath, config);
    const url = trackViewUrl ?? `https://music.apple.com/${storefront}/song/${useId}`;
    const args = ['-c', cfgPath, '--json', ...(quality === 'aac' ? ['--aac'] : []), url];
    // amdl's exit-on-error means a transient CDN reset kills a whole run —
    // retry network-class failures a bounded number of times (auth/license
    // errors fail straight through).
    const AMDL_RETRYABLE = /wsarecv|forcibly closed|ECONNRESET|ECONNABORTED|ETIMEDOUT|i\/o timeout|unexpected EOF|read fragment|stream error|connection reset|failed to get token/i;
    let out = '';
    for (let attempt = 0; attempt < 3; attempt++) {
        const { out: o, err } = await runNativeToolFull(amdl, args, {}, TIMEOUT_MS);
        // success = a [{path:...}] array in stdout; anything else is a failure —
        // amdl exits 0 even on per-track errors, so check the payload not code
        const arrMatch = o.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (arrMatch) {
            out = o;
            break;
        }
        const msg = (err.trim() || o.trim()).slice(-600);
        if (!AMDL_RETRYABLE.test(msg) || attempt === 2) {
            fs.rmSync(workDir, { recursive: true, force: true });
            throw new Error(`amdl failed: ${msg || 'no audio produced'}`);
        }
    }
    // --json mode prints an array of [{path, artist, album, song, ...}] entries —
    // parse the trailing JSON array (paths may be windows-escaped) then fall back
    // to scanning the work dir.
    let found: { file: string; size: number } | null = null;
    const arrMatch = out.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (arrMatch) {
        try {
            const items: { path?: string }[] = JSON.parse(arrMatch[0]);
            for (const it of items) {
                const p = it.path;
                if (!p) continue;
                const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
                if (fs.existsSync(abs)) found = { file: abs, size: fs.statSync(abs).size };
            }
        } catch {}
    }
    found ??= findAudioFile(workDir);
    if (!found) {
        fs.rmSync(workDir, { recursive: true, force: true });
        throw new Error('amdl produced no audio file');
    }
    // move out of workDir so caller can read it after cleanup
    const dest = tmpOutPath('apple-native', path.extname(found.file).slice(1));
    fs.renameSync(found.file, dest);
    fs.rmSync(workDir, { recursive: true, force: true });
    return { file: dest, size: fs.statSync(dest).size, format: path.extname(dest).slice(1).toLowerCase().replace('m4a', 'm4a') };
}

// ------------------ Amazon Music (direct gateway download) ------------------
//
// The amz.dezalty.com gateway holds the user's Amazon session (JWT in Settings or
// AMAZON_MUSIC_TOKEN). It resolves DASH streams + PSSH per track. Decryption key:
// 1) gateway POST /widevine/key — instant when the operator loads a server WVD
// 2) local tools/amz-license.py — pywidevine + a user-supplied .wvd in data/
// Segments are fetched with Range requests, then ffmpeg remuxes/decrypts.

const AMAZON_GW = 'https://amz.dezalty.com';

async function gwFetch<T>(path: string, token: string, opts: { method?: string; json?: any } = {}, retried = false): Promise<T> {
    const axios = (await import('axios')).default;
    try {
        const res = await axios({
            url: `${AMAZON_GW}${path}`,
            method: opts.method ?? 'GET',
            data: opts.json,
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(opts.json ? { 'Content-Type': 'application/json' } : {}) },
            timeout: 30000
        });
        return (res.data?.data ?? res.data) as T;
    } catch (e: any) {
        const status = e?.response?.status;
        if ((status === 401 || status === 422) && !retried) {
            const { refreshAmazonToken } = await import('./amazon');
            const fresh = await refreshAmazonToken();
            if (fresh && fresh !== token) return gwFetch(path, fresh, opts, true);
        }
        if (status === 401 || status === 422) throw new Error('Amazon token expired — get a fresh session JWT at amz.dezalty.com');
        if (status === 503 && /wvd/i.test(JSON.stringify(e?.response?.data ?? ''))) {
            throw new Error('__GATEWAY_NO_WVD__');
        }
        throw new Error(`Amazon gateway error ${status ?? ''}: ${e?.response?.data?.detail?.message ?? e?.message ?? 'unknown'}`);
    }
}

type AmazonStream = {
    codecs?: string;
    audio_sampling_rate?: number;
    bit_depth?: number;
    bandwidth?: number;
    mime_type?: string;
    base_url?: string;
    quality?: string;
    quality_human?: string;
    track_type?: string;
    pssh?: string;
    segments?: { initialization_range?: string | null; media_range?: string | null }[];
};

// Pick the best stream for the requested quality — Max/Master want the top bandwidth entry
function pickAmazonStream(streams: AmazonStream[], requested: string): AmazonStream {
    if (!streams.length) throw new Error('no streams returned');
    const pref: Record<string, string[]> = {
        Max: ['UHD', 'HD', 'SD'],
        Master: ['UHD', 'HD', 'SD'],
        High: ['HD', 'UHD', 'SD'],
        Normal: ['SD', 'HD', 'UHD'],
        Medium: ['SD', 'HD', 'UHD'],
        Low: ['SD', 'HD', 'UHD'],
        Free: ['SD', 'HD', 'UHD'],
        Atmos_EC_3: ['EC3'],
        Atmos_AC_4: ['AC4']
    };
    const order = pref[requested] ?? ['HD', 'UHD', 'SD'];
    for (const tier of order) {
        const match = streams.find((s) => (s.quality ?? '').startsWith(tier) || s.track_type === tier);
        if (match) return match;
    }
    return streams.reduce((a, b) => ((b.bandwidth ?? 0) > (a.bandwidth ?? 0) ? b : a));
}

// Download the encrypted fMP4. CloudFront throttles single connections hard from
// some networks — fetch the segment byte-ranges in parallel when they're listed,
// else fall back to one whole-file GET.
async function fetchAmazonStream(stream: AmazonStream, dest: string): Promise<number> {
    const axios = (await import('axios')).default;
    if (!stream.base_url) throw new Error('stream has no base_url');

    const ranges = (stream.segments ?? [])
        .map((s) => s.media_range ?? s.initialization_range)
        .filter((r): r is string => !!r && /^\d+-\d+$/.test(r));

    if (ranges.length > 1) {
        const fd = fs.openSync(dest, 'w');
        let total = 0;
        try {
            const PARTS = 6;
            for (let i = 0; i < ranges.length; i += PARTS) {
                const batch = ranges.slice(i, i + PARTS);
                const parts = await Promise.all(
                    batch.map((r) =>
                        axios.get(stream.base_url!, { headers: { Range: `bytes=${r}` }, responseType: 'arraybuffer', timeout: 120000 })
                    )
                );
                for (let j = 0; j < parts.length; j++) {
                    const [start] = batch[j].split('-').map(Number);
                    fs.writeSync(fd, Buffer.from(parts[j].data), 0, parts[j].data.byteLength, start);
                    total += parts[j].data.byteLength;
                }
            }
        } finally {
            fs.closeSync(fd);
        }
        return total;
    }

    const res = await axios.get(stream.base_url, { responseType: 'arraybuffer', timeout: 180000 });
    fs.writeFileSync(dest, Buffer.from(res.data));
    return (res.data as ArrayBuffer).byteLength;
}

// Resolve the Widevine content key: gateway first, then local pywidevine + user .wvd
export async function amazonWidevineKey(pssh: string, token: string, rid = '', asin = ''): Promise<string> {
    try {
        const res = await gwFetch<{ key?: string }>('/widevine/key', token, { method: 'POST', json: { pssh } });
        if (res?.key) return res.key;
        throw new Error('gateway returned no key');
    } catch (e: any) {
        if (!e?.message?.includes('__GATEWAY_NO_WVD__')) throw e;
    }
    // Local path — needs a .wvd the user dropped into data/
    const line = await runNativeTool(PY_BIN, [path.join(process.cwd(), 'tools', 'amz-license.py'), pssh, '--rid', rid, '--asin', asin], PY_ENV, 60000);
    const m = line.trim().match(/^([0-9a-fA-F]{32}):([0-9a-fA-F]{32})$/);
    if (!m) throw new Error(`license tool returned unexpected output: ${line.slice(0, 200)}`);
    return m[2]; // the content key hex
}

export type AmazonQuality = 'Max' | 'Master' | 'High' | 'Normal' | 'Medium' | 'Low' | 'Free' | 'Atmos_EC-3' | 'Atmos_AC-4';

// Resolve the chosen stream + its Widevine key — fails fast on ineligible accounts
// before any bytes move. Exported for the streaming download path.
const isAmazonIneligible = (e: any) => /not eligible|NOT_ELIGIBLE|EligibilityException|eligible/i.test(e?.message ?? '');

// Resolve the chosen stream + its Widevine key. Amazon licenses carry the tier
// entitlement — a Free/SD-only account gets CUSTOMER_NOT_ELIGIBLE on HD/UHD at
// license time, so the ladder walks down until the account is actually served.
export async function resolveAmazonStream(asin: string, quality: AmazonQuality, tokens: { amazonToken?: string }) {
    const token = pickToken('amazon') || tokens.amazonToken || process.env.AMAZON_MUSIC_TOKEN;
    if (!token) throw new Error('Amazon Music needs an account token — get one at amz.dezalty.com, then paste it in Settings → Service Tokens');
    const ladder = [...new Set<AmazonQuality>([quality === 'Master' ? 'Max' : quality, 'Normal', 'Free', 'Low'])];
    let lastErr: any = null;
    for (const q of ladder) {
        try {
            const raw = await gwFetch<AmazonStream[] | { streams?: AmazonStream[] }>(`/tracks/${encodeURIComponent(asin)}/streams/${encodeURIComponent(q)}`, token);
            const streamList = Array.isArray(raw) ? raw : raw.streams ?? [];
            const picked = Array.isArray(streamList) && streamList.length ? pickAmazonStream(streamList, q) : (raw as any).stream ?? (raw as any);
            if (!picked?.base_url) throw new Error('no usable Amazon stream for this track');
            const pssh = picked.pssh;
            if (!pssh) throw new Error('stream has no PSSH — unexpected unencrypted content');
            const rid = /[?&]r=([0-9a-f-]+)/i.exec(picked.base_url ?? '')?.[1] ?? '';
            const key = await amazonWidevineKey(pssh, token, rid, asin);
            return { picked, key, token };
        } catch (e: any) {
            if (isAmazonIneligible(e)) {
                lastErr = e;
                continue; // account can't license this tier — try the next one down
            }
            throw e;
        }
    }
    throw lastErr ?? new Error('Amazon account is not eligible for any stream tier');
}

export async function downloadAmazonNative(asin: string, quality: AmazonQuality, tokens: { amazonToken?: string }): Promise<NativeResult> {
    if (!ffmpegPath) throw new Error('ffmpeg-static missing — run npm install first');
    const { picked, key } = await resolveAmazonStream(asin, quality, tokens);

    // 2) fetch encrypted bytes
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amz-'));
    const encPath = path.join(workDir, 'enc.mp4');
    try {
        await fetchAmazonStream(picked, encPath);
        // 4) decrypt + remux — try lossless stream copy, fall back to flac re-encode
        const isFlac = (picked.codecs ?? '').toLowerCase().includes('flac');
        const outExt = isFlac ? 'flac' : 'm4a';
        const dest = tmpOutPath('amazon-native', outExt);
        const ff = ffmpegPath && fs.existsSync(ffmpegPath) ? ffmpegPath : path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
        try {
            await runNativeTool(ff, ['-y', '-decryption_key', key, '-i', encPath, '-vn', '-c:a', 'copy', dest], {}, 120000);
        } catch {
            await runNativeTool(ff, ['-y', '-decryption_key', key, '-i', encPath, '-vn', '-c:a', 'flac', dest], {}, 180000);
        }
        if (!fs.existsSync(dest) || fs.statSync(dest).size < 10000) throw new Error('ffmpeg produced no output');
        return { file: dest, size: fs.statSync(dest).size, format: outExt };
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}
