import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { Readable } from 'stream';
import { annotateToken, getSetting, pickToken } from '@/lib/token-pool';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import ffmpegPath from 'ffmpeg-static';

export type NativeResult = { file: string; size: number; format: string };

const TIMEOUT_MS = 300000; // 5 min — downloads can be slow
const AMDL_MAX_MEMORY_LIMIT_MB = Math.max(1, Number(process.env.AMDL_MAX_MEMORY_LIMIT_MB ?? 1) || 1);

function sanitizeToolLog(s: string): string {
    return s
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
        .replace(/(media-user-token|access_token|refresh_token|id_token|client_secret|password|authorization)["'\s:=]+[^,\s}\]"']+/gi, '$1=<redacted>')
        .replace(/(https?:\/\/[^\s?)]+)\?[^\s)]+/gi, '$1?<redacted>')
        .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '<redacted>')
        .slice(-300);
}

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
export function runNativeToolFull(
    cmd: string,
    args: string[],
    env: Record<string, string> = {},
    timeoutMs = TIMEOUT_MS,
    childRef?: { p?: any }
): Promise<{ out: string; err: string; code: number | null }> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true });
        if (childRef) childRef.p = proc;
        let out = '';
        let err = '';
        let timedOut = false;
        const kill = setTimeout(() => {
            timedOut = true;
            proc.kill('SIGKILL');
        }, timeoutMs);
        proc.stdout.on('data', (d) => (out += d.toString()));
        proc.stderr.on('data', (d) => (err += d.toString()));
        proc.on('error', (e) => {
            clearTimeout(kill);
            reject(new Error(`${path.basename(cmd)} failed to start: ${e.message}`));
        });
        proc.on('close', (code) => {
            clearTimeout(kill);
            if (timedOut) err = `${err}\n${path.basename(cmd)} timed out after ${Math.round(timeoutMs / 1000)}s`.trim();
            resolve({ out, err, code });
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
            fs.writeFileSync(path.join(dir, name), b64 ? Buffer.from(content, 'base64') : content, { mode: 0o600 });
        } catch {}
    };
    const validJson = (content: string | undefined) => {
        if (!content) return undefined;
        try {
            const parsed = JSON.parse(content);
            return parsed && typeof parsed === 'object' ? content : undefined;
        } catch {
            return undefined;
        }
    };
    write('spotify-env-session.json', process.env.SPOTIFY_SESSION_JSON);
    write('amazon-session.json', validJson(process.env.AMAZON_SESSION_JSON));
    write('amazon-device.wvd', process.env.AMAZON_DEVICE_WVD_B64, true);
}

// Durable session material on ephemeral hosts: the connect flows run on the web
// process and write to its private disk — Redis is the shared store. The worker
// hydrates at boot, periodically, and lazily when a cred file is absent.
let sessionsHydratedAt = 0;
export async function hydrateSessionsFromRedis(force = false): Promise<void> {
    if (!force && Date.now() - sessionsHydratedAt < 30_000) return;
    sessionsHydratedAt = Date.now();
    try {
        const { kvGet } = await import('../queue');
        const dir = path.join(process.cwd(), 'data');
        const writeIfAbsent = async (name: string, key: string) => {
            const p = path.join(dir, name);
            if (fs.existsSync(p)) return;
            const v = await kvGet(key);
            if (!v) return;
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(p, v, { mode: 0o600 });
        };
        await writeIfAbsent('spotify-redis.json', 'session:spotify');
        const amazonPath = path.join(dir, 'amazon-session.json');
        const amazonShared = await kvGet('session:amazon');
        if (amazonShared) {
            const mobileMaterial = (raw: string) => {
                try {
                    const parsed = JSON.parse(raw);
                    return !!(parsed?.adp_token && parsed?.device_private_key_pem);
                } catch {
                    return false;
                }
            };
            const existing = fs.existsSync(amazonPath) ? fs.readFileSync(amazonPath, 'utf-8') : null;
            // A website-cookie-only export can refresh gateway JWTs, but it cannot
            // sign Widevine license requests. Prefer the shared full mobile session
            // whenever the local file is absent or merely partial.
            if (!existing || (!mobileMaterial(existing) && mobileMaterial(amazonShared))) {
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(amazonPath, amazonShared, { mode: 0o600 });
            }
        }
    } catch {}
}

// Serialize every librespot-session spawn — Spotify's AP drops concurrent sessions on
// the same account (RemoteDisconnected), so parallel python calls kill each other.
// Kept for external callers; the daemon below serializes internally.
let librespotQueue: Promise<void> = Promise.resolve();
export function withLibrespotLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = librespotQueue;
    let release: () => void;
    librespotQueue = new Promise((r) => (release = r));
    return prev.then(() => fn()).finally(() => release!());
}

// Shared ffmpeg location — was copy-pasted between server-download + here.
export function ffmpegBin(): string {
    const bundled = ffmpegPath as unknown as string;
    if (bundled && fs.existsSync(bundled)) return bundled;
    const direct = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
    if (fs.existsSync(direct)) return direct;
    const linux = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg');
    if (fs.existsSync(linux)) return linux;
    if (bundled) return bundled;
    throw new Error('ffmpeg binary not found — run npm install');
}

// ---------------- librespot daemon ----------------
// tools/spotify-native.py --daemon: one python process holding ONE librespot
// Session. Session creation (apresolve + Shannon handshake + auth + login5)
// costs several seconds per track when spawned per download — the warm daemon
// makes each track cost only its CDN fetch. Jobs are JSON lines on stdin;
// results are framed on stdout (file mode: one result line; stream mode:
// header line → {"n":len}\n<bytes> chunks → {"done"}/{"error"} trailer).
// The daemon serializes jobs internally — one session, one stream at a time.

const DAEMON_IDLE_MS = 5 * 60 * 1000;

type Waiter = { kind: 'line' } | { kind: 'bytes'; n: number };
class SpotifyDaemon {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private buf = Buffer.alloc(0);
    private queue: { w: Waiter; resolve: (v: any) => void; reject: (e: any) => void }[] = [];
    private tail: Promise<void> = Promise.resolve();
    private ready = false;
    private errTail = '';
    private idleTimer: NodeJS.Timeout | null = null;
    private starting: Promise<void> | null = null;

    private async credFile(): Promise<string> {
        let stored = spotifyCredFile();
        if (!stored) {
            await hydrateSessionsFromRedis();
            stored = spotifyCredFile();
        }
        if (!stored) throw new Error('Spotify account not connected — use Settings → Connect Spotify to link one');
        return stored;
    }

    private poke() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.kill(), DAEMON_IDLE_MS);
    }

    private onData(d: Buffer) {
        this.buf = Buffer.concat([this.buf, d]);
        this.drain();
    }

    private drain() {
        while (this.queue.length) {
            const { w, resolve } = this.queue[0];
            if (w.kind === 'line') {
                const i = this.buf.indexOf(10);
                if (i < 0) return;
                const line = this.buf.subarray(0, i).toString('utf8');
                this.buf = this.buf.subarray(i + 1);
                this.queue.shift();
                resolve(line);
            } else {
                if (this.buf.length < w.n) return;
                const b = this.buf.subarray(0, w.n);
                this.buf = this.buf.subarray(w.n);
                this.queue.shift();
                resolve(b);
            }
        }
    }

    private line(): Promise<string> {
        return new Promise((resolve, reject) => {
            this.queue.push({ w: { kind: 'line' }, resolve, reject });
            this.drain();
        });
    }
    private bytes(n: number): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            this.queue.push({ w: { kind: 'bytes', n }, resolve, reject });
            this.drain();
        });
    }

    private kill() {
        this.ready = false;
        const p = this.proc;
        this.proc = null;
        if (p) {
            try {
                p.kill('SIGKILL');
            } catch {}
        }
        const err = new Error('spotify daemon stopped');
        for (const q of this.queue.splice(0)) q.reject(err);
    }

    private async ensure(): Promise<void> {
        if (this.proc && this.ready) return this.poke();
        if (this.starting) return this.starting;
        this.starting = (async () => {
            const creds = await this.credFile();
            const proc = spawn(PY_BIN, [path.join(process.cwd(), 'tools', 'spotify-native.py'), '--daemon', '--creds', creds], {
                env: { ...process.env, ...PY_ENV },
                windowsHide: true
            });
            this.proc = proc;
            this.buf = Buffer.alloc(0);
            this.errTail = '';
            proc.stdout.on('data', (d: Buffer) => this.onData(d));
            proc.stderr.on('data', (d) => (this.errTail = (this.errTail + d.toString()).slice(-2000)));
            proc.on('close', () => {
                const err = new Error(`spotify daemon exited${this.errTail ? `: ${this.errTail.slice(-300)}` : ''}`);
                this.ready = false;
                this.proc = null;
                for (const q of this.queue.splice(0)) q.reject(err);
            });
            proc.on('error', () => this.kill());
            try {
                const head = JSON.parse(await this.line());
                if (!head.ready) throw new Error(head.error ?? 'spotify daemon failed to start');
            } catch (e) {
                this.kill(); // failed handshake — don't leave a zombie python running
                throw e;
            }
            this.ready = true;
            this.poke();
        })().finally(() => {
            this.starting = null;
        });
        return this.starting;
    }

    // Serialize: one job on the wire at a time (single session, single stream).
    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.tail.then(fn, fn);
        this.tail = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    async requestFile(track: string, quality: string): Promise<NativeResult> {
        return this.enqueue(async () => {
            await this.ensure();
            this.poke();
            const out = tmpOutPath('spotify-native', 'ogg');
            this.proc!.stdin.write(JSON.stringify({ track, quality, mode: 'file', out }) + '\n');
            const res = JSON.parse(await this.line());
            if (res.error) throw new Error(res.error);
            if (!res.file || !fs.existsSync(res.file)) throw new Error('tool produced no file');
            return res as NativeResult;
        });
    }

    // Streams decrypted OGG frames straight from librespot — first byte lands
    // ~when the CDN starts serving (session already warm), size known upfront.
    async requestStream(track: string, quality: string, signal?: AbortSignal): Promise<{ stream: Readable; size: number; cleanup: () => void }> {
        let settle!: (v: { stream: Readable; size: number; cleanup: () => void }) => void;
        let fail!: (e: any) => void;
        const out = new Promise<{ stream: Readable; size: number; cleanup: () => void }>((res, rej) => {
            settle = res;
            fail = rej;
        });
        // The tail link must stay held until the consumer has drained the body —
        // the daemon's stdout is ours for the whole stream duration.
        this.tail = this.tail.then(async () => {
            try {
                await this.ensure();
                this.poke();
                this.proc!.stdin.write(JSON.stringify({ track, quality, mode: 'stream' }) + '\n');
                const head = JSON.parse(await this.line());
                if (head.error) throw new Error(head.error);
                // a 5-min idle kill during an active stream murders healthy
                // transfers — disarm while a job is on the wire, re-arm after
                if (this.idleTimer) {
                    clearTimeout(this.idleTimer);
                    this.idleTimer = null;
                }
                if (head.file) {
                    // size unknown → daemon produced a temp file instead
                    const st = fs.statSync(head.file);
                    settle({ stream: fs.createReadStream(head.file), size: st.size, cleanup: () => fs.unlink(head.file, () => {}) });
                    return;
                }
                const body = new Readable({
                    read() {
                        (this as any)._drainCb?.();
                    }
                });
                let drainCb: (() => void) | null = null;
                // a destroyed body never calls read() again — release any
                // pending drain wait so the pump can finish draining the wire
                body.once('close', () => {
                    drainCb?.();
                    drainCb = null;
                });
                const pumpDone = (async () => {
                    try {
                        for (;;) {
                            const l = JSON.parse(await this.line());
                            if (l.n) {
                                const c = await this.bytes(l.n);
                                // consumer destroyed the body (cancel/abort) —
                                // keep draining the wire anyway or the next job's
                                // frames desync; just stop pushing
                                if (body.destroyed) continue;
                                if (!body.push(c)) {
                                    await new Promise<void>((r) => {
                                        drainCb = r;
                                        (body as any)._drainCb = r;
                                    });
                                    drainCb = null;
                                    (body as any)._drainCb = null;
                                }
                            } else if (l.done) {
                                body.push(null);
                                return;
                            } else if (l.error) {
                                body.destroy(new Error(l.error));
                                return;
                            } else {
                                body.destroy(new Error('bad daemon frame'));
                                return;
                            }
                        }
                    } catch (e) {
                        body.destroy(e as Error);
                    }
                })();
                const cleanup = () => {
                    try {
                        body.destroy();
                    } catch {}
                };
                signal?.addEventListener('abort', cleanup, { once: true });
                settle({ stream: body, size: head.size ?? 0, cleanup });
                try {
                    await pumpDone; // hold the session slot until the bytes are consumed
                } finally {
                    this.poke(); // idle again — re-arm the kill timer
                }
            } catch (e) {
                fail(e);
                return; // free the tail link
            }
        });
        this.tail = this.tail.then(
            () => undefined,
            () => undefined
        );
        return out;
    }
}

const spotifyDaemon = new SpotifyDaemon();

// A dead AP socket kills a session — the daemon rebuilds once inside python;
// one outer retry covers a poisoned process.
const SPOTIFY_ATTEMPTS = 2;

// Download a Spotify track via the warm librespot daemon. Returns path to the .ogg file.
// Auth comes from the stored OAuth session written by the Settings → Connect Spotify flow.
export async function downloadSpotifyNative(trackId: string, quality: 'normal' | 'high' | 'very_high' | 'lossless'): Promise<NativeResult> {
    let lastErr: any = null;
    for (let attempt = 1; attempt <= SPOTIFY_ATTEMPTS; attempt++) {
        try {
            return await spotifyDaemon.requestFile(trackId, quality);
        } catch (e: any) {
            lastErr = e;
            console.warn(`[spotify-daemon] attempt ${attempt} quality=${quality}: ${e?.message ?? e}`);
            if (/BadCredentials|no_credentials|premium_required|bad_track_id|not connected/i.test(e?.message ?? '')) throw e;
            if (attempt < SPOTIFY_ATTEMPTS) await sleep(2000 * attempt);
        }
    }
    throw lastErr;
}

// Stream a Spotify track's decrypted OGG straight from the daemon — the live
// pipeline consumes bytes as librespot pulls them off the CDN.
export async function streamSpotifyNative(
    trackId: string,
    quality: 'normal' | 'high' | 'very_high' | 'lossless',
    signal?: AbortSignal
): Promise<{ stream: Readable; size: number; cleanup: () => void }> {
    let lastErr: any = null;
    for (let attempt = 1; attempt <= SPOTIFY_ATTEMPTS; attempt++) {
        try {
            return await spotifyDaemon.requestStream(trackId, quality, signal);
        } catch (e: any) {
            lastErr = e;
            if (/BadCredentials|no_credentials|premium_required|bad_track_id|not connected/i.test(e?.message ?? '')) throw e;
            if (attempt < SPOTIFY_ATTEMPTS) await sleep(1500 * attempt);
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

// True when the file head is an ISO-BMFF audio container (ALAC/AAC .m4a/.mp4).
function isM4aMagic(file: string): boolean {
    try {
        const fd = fs.openSync(file, 'r');
        const head = Buffer.alloc(12);
        fs.readSync(fd, head, 0, 12, 0);
        fs.closeSync(fd);
        return head.toString('latin1', 4, 8) === 'ftyp';
    } catch {
        return false;
    }
}

// Apple Music via amdl.exe — needs a running wrapper-lite service (user supplies Apple native
// libraries) plus the account's media-user-token. Produces ALAC/AAC from Apple's own CDN.
// Never crosses to another platform: region misses are remapped to the wrapper's
// storefront adamId (equivalents → ISRC → title), and CDN flake falls back ALAC→AAC
// (still Apple .m4a).
export async function downloadAppleNative(
    adamId: string,
    quality: 'alac-hi' | 'alac' | 'aac',
    tokens: { appleMediaToken?: string; appleWrapper?: string; isrc?: string; title?: string; artist?: string; signal?: AbortSignal }
): Promise<NativeResult> {
    const mediaToken = tokens.appleMediaToken || pickToken('apple') || process.env.APPLE_MEDIA_USER_TOKEN;
    if (!mediaToken) throw new Error('Apple Music requires a media-user-token — configure one in the admin panel');
    // Windows dev uses amdl.exe; Render/Linux workers carry the ELF build as bin/amdl
    const amdl = [path.join(process.cwd(), 'bin', 'amdl.exe'), path.join(process.cwd(), 'bin', 'amdl')].find((p) => fs.existsSync(p));
    if (!amdl) throw new Error('bin/amdl[.exe] missing');
    // Wrapper endpoints accept a comma-separated list — each instance may hold a
    // different-region Apple account, so probing the set covers more storefronts.
    // A request-supplied wrapper URL is otherwise a blind-SSRF primitive in a
    // multi-user deployment; production ignores it unless the operator explicitly
    // opts in with ALLOW_USER_APPLE_WRAPPER=1. Admin/env-configured wrappers are
    // trusted operator infrastructure.
    const allowUserWrapper = process.env.ALLOW_USER_APPLE_WRAPPER === '1' || process.env.NODE_ENV !== 'production';
    const configuredWrapper = getSetting('appleWrapperUrl') || process.env.APPLE_WRAPPER_URL || 'http://127.0.0.1:12340';
    const wrapperList = ((allowUserWrapper && tokens.appleWrapper) || configuredWrapper)
        .split(',')
        .map((u) => u.trim().replace(/\/$/, ''))
        .filter((u) => {
            try {
                const parsed = new URL(u);
                return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password;
            } catch {
                return false;
            }
        });
    type Wrapper = { url: string; regions: string[] };
    // probe all wrappers in parallel — sequential /status checks put N×20s on
    // the critical path when a wrapper is down (common: local wrapper off)
    const wrappers: Wrapper[] = (
        await Promise.all(
            wrapperList.map(async (u) => {
                try {
                    // TCG/QEMU wrappers on shared vCPUs burst past 8s — give a remote
                    // instance room before counting it out (inconclusive != locked).
                    const r = await fetch(`${u}/status`, { signal: AbortSignal.timeout(20000) });
                    const j = await r.json().catch(() => null);
                    return { url: u, regions: (j?.data?.regions ?? []).map((x: string) => String(x).toLowerCase()) } as Wrapper;
                } catch {
                    return null;
                }
            })
        )
    ).filter((w): w is Wrapper => !!w);
    if (!wrappers.length) throw new Error('Apple wrapper-lite is not reachable — start wrapper-lite-qemu.exe first, then retry');

    // find which wrapper can serve an adamId — returns the wrapper, 'no' when
    // every wrapper definitively rejected it, or null when probes were
    // inconclusive (TCG guests can be slow — don't misreport timeouts as locks).
    const wrapperFor = async (id: string): Promise<Wrapper | 'no' | null> => {
        const results = await Promise.all(
            [...wrappers]
                .sort(() => Math.random() - 0.5)
                .map(async (w) => {
                    const r = await fetch(`${w.url}/m3u8?adamId=${id}`, { signal: AbortSignal.timeout(25000) }).catch(() => null);
                    const j = await r?.json().catch(() => null);
                    return { w, ok: j?.code === 0, inconclusive: !j };
                })
        );
        return results.find((r) => r.ok)?.w ?? (results.some((r) => r.inconclusive) ? null : 'no');
    };

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amdl-'));
    const cleanupWork = () => {
        try {
            fs.rmSync(workDir, { recursive: true, force: true });
        } catch {}
    };

    // region-correct storefront: /v1/me/storefront (dev JWT + media-user-token); 'us' fallback
    const storefront = await appleStorefront(mediaToken).catch(() => 'us');
    const wrapperStorefronts = [...new Set(wrappers.flatMap((w) => w.regions).filter(Boolean))];
    // Always prefer the serving wrapper's regions first — a us adamId is useless
    // against a pk-only wrapper; equivalents/ISRC must be resolved in pk.
    const searchStorefronts = [...wrapperStorefronts, storefront, 'us'].filter((v, i, a) => v && a.indexOf(v) === i);

    const itunesSearch = (term: string, country: string) =>
        fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&country=${country}&limit=15`, { signal: AbortSignal.timeout(10000) })
            .then((r) => r.json())
            .catch(() => null);

    // Collect every plausible same-recording adamId in the wrapper's regions.
    const collectRegionCandidates = async (seedId: string): Promise<string[]> => {
        const ordered: string[] = [];
        const seen = new Set<string>([String(seedId)]);
        const push = (id: string | number | undefined | null) => {
            const s = String(id ?? '').trim();
            if (!s || seen.has(s)) return;
            seen.add(s);
            ordered.push(s);
        };
        let jwt = '';
        try {
            jwt = await appleDevToken();
        } catch {}

        // 1) Official equivalents API (best match per target storefront)
        if (jwt) {
            for (const sf of searchStorefronts) {
                for (const restrict of ['', 'explicit']) {
                    const qs = new URLSearchParams({ 'filter[equivalents]': seedId });
                    if (restrict) qs.set('restrict', restrict);
                    const res = await fetch(`https://amp-api.music.apple.com/v1/catalog/${sf}/songs?${qs}`, {
                        headers: { Authorization: `Bearer ${jwt}`, 'Media-User-Token': mediaToken, Origin: 'https://music.apple.com' },
                        signal: AbortSignal.timeout(10000)
                    }).catch(() => null);
                    const j = await res?.json().catch(() => null);
                    for (const s of j?.data ?? []) {
                        push(s?.id);
                        for (const e of s?.relationships?.equivalents?.data ?? []) push(e?.id);
                    }
                }
            }
        }

        // 2) Catalog ISRC filter — one ISRC → every edition in that storefront
        const isrc = tokens.isrc?.trim();
        if (jwt && isrc) {
            for (const sf of searchStorefronts) {
                const res = await fetch(`https://api.music.apple.com/v1/catalog/${sf}/songs?filter[isrc]=${encodeURIComponent(isrc)}`, {
                    headers: { Authorization: `Bearer ${jwt}`, Origin: 'https://music.apple.com' },
                    signal: AbortSignal.timeout(10000)
                }).catch(() => null);
                const j = await res?.json().catch(() => null);
                for (const s of j?.data ?? []) push(s?.id);
                for (const hit of j?.meta?.filters?.isrc?.[isrc] ?? []) push(hit?.id);
            }
        }

        // 3) Title+artist search in wrapper storefronts (strict title match)
        if (tokens.title || tokens.artist) {
            const q = [tokens.title, tokens.artist].filter(Boolean).join(' ');
            const wantTitle = (tokens.title ?? '').trim().toLowerCase();
            const wantArtist = (tokens.artist ?? '').split(/[,&]/)[0].trim().toLowerCase();
            for (const sf of searchStorefronts) {
                const byName = await itunesSearch(q, sf);
                for (const t of byName?.results ?? []) {
                    const name = (t.trackName ?? '').trim().toLowerCase();
                    const artist = (t.artistName ?? '').toLowerCase();
                    const titleOk = !wantTitle || name === wantTitle;
                    const artistOk = !wantArtist || artist.includes(wantArtist);
                    if (titleOk && artistOk) push(t.trackId);
                }
            }
        }
        return ordered;
    };

    // Preflight the requested adamId; on miss OR inconclusive probe, remap into
    // a wrapper-serveable id. Never proceed with a known-bad id.
    let useId = String(adamId);
    let chosen: Wrapper | 'no' | null = await wrapperFor(useId);
    if (chosen === 'no' || chosen === null) {
        const candidates = await collectRegionCandidates(useId);
        for (const cid of candidates) {
            const w = await wrapperFor(cid);
            if (w && w !== 'no') {
                useId = cid;
                chosen = w;
                break;
            }
        }
        // definitive miss after remapping → honest region error. Inconclusive
        // (chosen === null) falls through — TCG wrappers sometimes time out
        // /m3u8 but still serve /key during the amdl run.
        if (chosen === 'no') {
            cleanupWork();
            throw new Error(
                `track not available in the wrapper storefront (${wrapperStorefronts.join(',') || storefront}) — region-locked or removed from Apple Music`
            );
        }
    }
    const activeWrapper = chosen && typeof chosen === 'object' ? chosen : wrappers[0];
    // the serving wrapper's region drives storefront + lookup — a us-region
    // wrapper needs us-catalog URLs even when the account storefront is pk
    const useStorefront = activeWrapper.regions?.[0] || storefront;
    annotateToken('apple', mediaToken, {
        region: useStorefront,
        tier: 'unknown',
        tierLabel: 'plan not exposed by Apple media token; entitlement is learned from real downloads'
    });

    // amdl 404s on bare /song/<id> URLs — resolve the canonical album-style URL
    // (…/album/<slug>/<collectionId>?i=<trackId>) via iTunes lookup in the
    // serving storefront so region handling stays consistent.
    const resolveTrackUrl = async (id: string, sf: string): Promise<string> => {
        const lookup = await fetch(`https://itunes.apple.com/lookup?id=${id}&entity=song&country=${sf}`, { signal: AbortSignal.timeout(10000) })
            .then((r) => r.json())
            .catch(() => null);
        const trackViewUrl = lookup?.results?.find((x: any) => x?.trackViewUrl)?.trackViewUrl as string | undefined;
        if (trackViewUrl) return trackViewUrl;
        // catalog API as second chance — returns the region-correct share URL
        try {
            const jwt = await appleDevToken();
            const res = await fetch(`https://api.music.apple.com/v1/catalog/${sf}/songs/${id}`, {
                headers: { Authorization: `Bearer ${jwt}`, Origin: 'https://music.apple.com' },
                signal: AbortSignal.timeout(10000)
            });
            const j = await res.json().catch(() => null);
            const url = j?.data?.[0]?.attributes?.url as string | undefined;
            if (url) return url;
        } catch {}
        return `https://music.apple.com/${sf}/song/${id}`;
    };

    const trackUrl = await resolveTrackUrl(useId, useStorefront);
    const dirPosix = workDir.replace(/\\/g, '/');
    const writeConfig = (q: 'alac-hi' | 'alac' | 'aac') => {
        // convert.* must stay off — a global/default convert-to-mp3 would silently
        // destroy the native ALAC/AAC .m4a the rest of the pipeline expects.
        const config = [
            'general:',
            `  lite-server: "${activeWrapper.url}"`,
            `  media-user-token: "${mediaToken}"`,
            `  storefront: "${useStorefront}"`,
            `  max-memory-limit: ${AMDL_MAX_MEMORY_LIMIT_MB}`,
            '  exit-on-error: true',
            'media:',
            // 'all' mode avoids Invalid CKC / EOF — narrow manifests drop key streams
            '  get-m3u8-mode: "all"',
            '  alac-fix: true',
            `  alac-max: ${q === 'alac-hi' ? 192000 : 44100}`,
            '  aac-type: "aac-lc"',
            'paths:',
            `  alac: "${dirPosix}/alac"`,
            `  aac: "${dirPosix}/aac"`,
            `  atmos: "${dirPosix}/atmos"`,
            'convert:',
            '  after-download: false',
            '  keep-original: true',
            ''
        ].join('\n');
        const cfgPath = path.join(workDir, 'config.yaml');
        fs.writeFileSync(cfgPath, config, { mode: 0o600 });
        return cfgPath;
    };

    // Parse amdl --json success payload → absolute audio path (never .json/.lrc).
    const pickAudioFromOutput = (stdout: string): { file: string; size: number } | null => {
        const arrMatch = stdout.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (arrMatch) {
            try {
                const items: { path?: string }[] = JSON.parse(arrMatch[0]);
                for (const it of items) {
                    const p = it.path;
                    if (!p || !/\.(m4a|mp4|aac)$/i.test(p)) continue;
                    const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
                    if (fs.existsSync(abs) && fs.statSync(abs).size > 10_000) return { file: abs, size: fs.statSync(abs).size };
                }
            } catch {}
        }
        return findAudioFile(workDir);
    };

    // amdl's exit-on-error means a transient CDN reset kills a whole run —
    // retry network-class failures; on persistent ALAC flake, drop to AAC
    // (still Apple .m4a — never another platform).
    const AMDL_RETRYABLE =
        /wsarecv|forcibly closed|ECONNRESET|ECONNABORTED|ETIMEDOUT|i\/o timeout|unexpected EOF|read fragment|stream error|connection reset|failed to get token|decode mdat|Failed to run v4|TLS handshake|broken pipe/i;
    const qualityLadder: Array<'alac-hi' | 'alac' | 'aac'> =
        quality === 'aac' ? ['aac'] : quality === 'alac' ? ['alac', 'aac'] : ['alac-hi', 'alac', 'aac'];

    let found: { file: string; size: number } | null = null;
    let lastErr = '';
    for (const q of qualityLadder) {
        // wipe previous partials between quality tiers
        for (const sub of ['alac', 'aac', 'atmos']) {
            const p = path.join(workDir, sub);
            if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        }
        const cfgPath = writeConfig(q);
        const args = ['-c', cfgPath, '--json', ...(q === 'aac' ? ['--aac'] : []), trackUrl];
        // Two attempts per quality are enough: the quality ladder itself is the
        // next tier of retry. Burning four equal-quality retries on a repeatable
        // CDN/HTTP2 failure previously consumed the whole resolver deadline
        // before alac/aac ever got a chance.
        for (let attempt = 0; attempt < 2; attempt++) {
            if (tokens.signal?.aborted) throw new Error('cancelled');
            if (attempt) await sleep(800 * attempt);
            const childRef: { p?: any } = {};
            const killOnAbort = () => {
                try {
                    childRef.p?.kill?.('SIGKILL');
                } catch {}
            };
            tokens.signal?.addEventListener('abort', killOnAbort, { once: true });
            let run: { out: string; err: string; code: number | null };
            try {
                // Apple's CDN intermittently terminates long Go HTTP/2 streams
                // (GOAWAY/INTERNAL_ERROR) mid-fragment. amdl's Go transport can
                // use HTTP/1.1 instead; the byte-range requests remain the same,
                // but avoid that reproducible stream-reset failure mode.
                const godebug = [process.env.GODEBUG, 'http2client=0'].filter(Boolean).join(',');
                run = await runNativeToolFull(amdl, args, { GODEBUG: godebug }, TIMEOUT_MS, childRef);
            } finally {
                try {
                    tokens.signal?.removeEventListener('abort', killOnAbort);
                } catch {}
            }
            if (tokens.signal?.aborted) {
                const reason = (tokens.signal.reason as any)?.message;
                throw new Error(reason || 'cancelled');
            }
            const { out: o, err, code } = run;
            // Non-zero exits can leave a playable-looking truncated MP4 behind.
            // Never accept it as a successful full track — treat the run as failed
            // and let the retry/quality ladder decide whether it was transient.
            const picked = code === 0 ? pickAudioFromOutput(o) : null;
            if (picked && isM4aMagic(picked.file)) {
                found = picked;
                break;
            }
            // amdl sometimes writes the file but truncates JSON — trust the workdir
            const scanned = code === 0 ? findAudioFile(workDir) : null;
            if (scanned && isM4aMagic(scanned.file) && scanned.size > 10_000) {
                found = scanned;
                break;
            }
            lastErr = (err.trim() || o.trim() || `amdl exit code ${code}`).slice(-800);
            console.warn(`[apple] amdl ${q} attempt ${attempt + 1} failed: ${sanitizeToolLog(lastErr)}`);
            const hiResAssetStall = q === 'alac-hi' && /decode mdat pos \d+: response timed out/i.test(lastErr);
            if (hiResAssetStall) break;
            if (!AMDL_RETRYABLE.test(lastErr) && attempt >= 1) break; // non-network after a retry → next quality
            if (!AMDL_RETRYABLE.test(lastErr) && attempt === 0) break;
        }
        if (found) break;
    }

    if (!found) {
        cleanupWork();
        throw new Error(`amdl failed: ${lastErr || 'no audio produced'}`);
    }
    if (!isM4aMagic(found.file)) {
        cleanupWork();
        throw new Error('amdl produced a non-m4a file — refusing to serve (Apple audio must be .m4a)');
    }
    // Always ship as .m4a regardless of amdl's on-disk name (.mp4 / .m4a)
    const dest = tmpOutPath('apple-native', 'm4a');
    fs.renameSync(found.file, dest);
    cleanupWork();
    return { file: dest, size: fs.statSync(dest).size, format: 'm4a' };
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
        const detail = `${e?.response?.data?.detail?.code ?? ''} ${e?.response?.data?.detail?.message ?? ''}`;
        // Auth failures occasionally surface as 403 on the gateway. Refresh once
        // for all auth-class responses; repeated 403s then mean entitlement.
        if ((status === 401 || status === 422 || status === 403) && !retried) {
            const { refreshAmazonToken } = await import('./amazon');
            const fresh = await refreshAmazonToken(token);
            if (fresh && fresh !== token) return gwFetch(path, fresh, opts, true);
        }
        if (status === 401 || status === 422 || /session_(expired|invalid)|token.*(expired|invalid)/i.test(detail)) {
            throw new Error('Amazon token expired — get a fresh session JWT at amz.dezalty.com');
        }
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
    // Hosted workers receive the session export and device key as env vars; the
    // Python license helper expects real files under data/. Sessions can also be
    // imported through the web admin after this worker booted, so refresh the
    // Redis-backed copy before spending a license round-trip.
    materializeSessions();
    await hydrateSessionsFromRedis(true).catch(() => {});
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
const isAmazonIneligible = (e: any) => /CUSTOMER_NOT_ELIGIBLE|REQUEST_BLOCKED|customer is not eligible|not eligible|NOT_ELIGIBLE/i.test(e?.message ?? '');

// Resolve the chosen stream + its Widevine key. Amazon licenses carry the tier
// entitlement — a Free/SD-only account gets CUSTOMER_NOT_ELIGIBLE on HD/UHD at
// license time, so the ladder walks down until the account is actually served.
// The license must be proven here; the stream endpoint alone over-reports tiers
// that Amazon later refuses to license.
export async function resolveAmazonStreams(asin: string, quality: AmazonQuality, tokens: { amazonToken?: string }) {
    let token = tokens.amazonToken || pickToken('amazon') || process.env.AMAZON_MUSIC_TOKEN;
    if (!token) throw new Error('Amazon Music needs an account token — get one at amz.dezalty.com, then paste it in Settings → Service Tokens');
    const { amazonToken } = await import('./amazon');
    token = (await amazonToken({ tokens })) || token;
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
            return { picked, keyP: Promise.resolve(key), token };
        } catch (e: any) {
            if (isAmazonIneligible(e)) {
                lastErr = e;
                continue; // account can't license this tier — try the next one down
            }
            throw e;
        }
    }
    throw new Error(
        `Amazon did not license any stream tier for this track (Max/Normal/Free all denied) — the linked account may need Amazon Music Unlimited, or this track may not be available on its current plan. ${lastErr?.message?.slice(0, 120) ?? ''}`
    );
}

export async function downloadAmazonNative(asin: string, quality: AmazonQuality, tokens: { amazonToken?: string }): Promise<NativeResult> {
    const { picked, keyP } = await resolveAmazonStreams(asin, quality, tokens);

    // fetch encrypted bytes after the license round-trip has proven entitlement
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amz-'));
    const encPath = path.join(workDir, 'enc.mp4');
    try {
        const [, key] = await Promise.all([fetchAmazonStream(picked, encPath), keyP]);
        // decrypt + remux — try lossless stream copy, fall back to flac re-encode
        const isFlac = (picked.codecs ?? '').toLowerCase().includes('flac');
        const outExt = isFlac ? 'flac' : 'm4a';
        const dest = tmpOutPath('amazon-native', outExt);
        const ff = ffmpegBin();
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
