import { spawn } from 'child_process';
import { pickToken } from '@/lib/token-pool';
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
    const stored = spotifyCredFile();
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
    const js = page.match(/\/assets\/index-[\w-]+\.js/)?.[0];
    if (!js) throw new Error('dev token: no index js');
    const code = await fetch(`https://music.apple.com${js}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.text());
    const token = code.match(/eyJh[A-Za-z0-9_.-]+/)?.[0];
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
export async function downloadAppleNative(adamId: string, quality: 'alac-hi' | 'alac' | 'aac', tokens: { appleMediaToken?: string; appleWrapper?: string }): Promise<NativeResult> {
    const mediaToken = pickToken('apple') || tokens.appleMediaToken || process.env.APPLE_MEDIA_USER_TOKEN;
    const wrapperUrl = tokens.appleWrapper || process.env.APPLE_WRAPPER_URL || 'http://127.0.0.1:12340';
    if (!mediaToken) throw new Error('Apple Music requires a media-user-token — configure one in the admin panel');
    const amdl = path.join(process.cwd(), 'bin', 'amdl.exe');
    if (!fs.existsSync(amdl)) throw new Error('bin/amdl.exe missing');
    // fail fast if wrapper-lite isn't reachable — amdl would otherwise stall on a dead endpoint
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        // any HTTP response (even an error status) means the service is up; ECONNREFUSED = down
        await fetch(`${wrapperUrl.replace(/\/$/, '')}/m3u8?adamId=0`, { signal: ctrl.signal });
        clearTimeout(t);
    } catch {
        throw new Error(`Apple wrapper-lite not reachable at ${wrapperUrl} — start wrapper-lite-qemu.exe first, then retry`);
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amdl-'));
    // region-correct storefront: /v1/me/storefront (dev JWT + media-user-token); 'us' fallback
    const storefront = await appleStorefront(mediaToken).catch(() => 'us');
    const config = [
        'general:',
        `  lite-server: "${wrapperUrl}"`,
        `  media-user-token: "${mediaToken}"`,
        `  storefront: "${storefront}"`,
        '  exit-on-error: true',
        'media:',
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
    const url = `https://music.apple.com/${storefront}/song/${adamId}`;
    const args = ['-c', cfgPath, '--json', ...(quality === 'aac' ? ['--aac'] : []), url];
    let out = '';
    try {
        out = await runNativeTool(amdl, args, {}, TIMEOUT_MS);
    } catch (e: any) {
        fs.rmSync(workDir, { recursive: true, force: true });
        throw new Error(`amdl failed: ${e.message}`);
    }
    // --json mode prints an AddedTracks array with exact output paths — prefer it over guessing
    let found: { file: string; size: number } | null = null;
    for (const m of out.matchAll(/"fileName"\s*:\s*"([^"]+)"/g)) {
        const p = m[1];
        const abs = path.isAbsolute(p) ? p : path.join(workDir, p);
        if (fs.existsSync(abs)) found = { file: abs, size: fs.statSync(abs).size };
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
export async function resolveAmazonStream(asin: string, quality: AmazonQuality, tokens: { amazonToken?: string }) {
    const token = pickToken('amazon') || tokens.amazonToken || process.env.AMAZON_MUSIC_TOKEN;
    if (!token) throw new Error('Amazon Music needs an account token — get one at amz.dezalty.com, then paste it in Settings → Service Tokens');
    const q = quality === 'Master' ? 'Max' : quality;
    const raw = await gwFetch<AmazonStream[] | { streams?: AmazonStream[] }>(`/tracks/${encodeURIComponent(asin)}/streams/${encodeURIComponent(q)}`, token);
    const streamList = Array.isArray(raw) ? raw : raw.streams ?? [];
    const picked = Array.isArray(streamList) && streamList.length ? pickAmazonStream(streamList, q) : (raw as any).stream ?? (raw as any);
    if (!picked?.base_url) throw new Error('no usable Amazon stream for this track');
    const pssh = picked.pssh;
    if (!pssh) throw new Error('stream has no PSSH — unexpected unencrypted content');
    const rid = /[?&]r=([0-9a-f-]+)/i.exec(picked.base_url ?? '')?.[1] ?? '';
    const key = await amazonWidevineKey(pssh, token, rid, asin);
    return { picked, key, token };
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
