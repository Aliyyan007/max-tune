// Queue worker — polls Upstash, produces artifacts to local temp files, verifies
// them, uploads them to R2, and only then marks jobs complete. The web process
// orchestrates and redirects; it never buffers or transcodes queue-mode media.
//
//   WORKER_CAPS=generic          poll only the generic queue
//   WORKER_CAPS=generic,apple    also poll apple (needs APPLE_WRAPPER_URL reachable)
//   WORKER_CONCURRENCY=1         jobs per worker process (scale workers horizontally)
//
// Bundled to worker.mjs via `npm run build:worker` — no runtime dependency on next.
import http from 'http';
import https from 'https';
import os from 'os';
import fs from 'fs';
import axios from 'axios';
import {
    dequeueJob, jobDone, jobGet, jobSet, queueEnabled, touchInflight, retryJob,
    cancelRequested, QUEUE_APPLE, QUEUE_GENERIC, queueDepths, jobCounters, cmd, LEASE_MS, publicErrorMessage
} from '../lib/queue';
import { cacheEnabled, cachePutFile, presignGet, cacheKeyFor, previewCacheKeyFor, objectKey, zipCacheKeyFor, previewZipCacheKeyFor } from '../lib/download-cache';
import { stageToFile, probeFileDuration, classifyDlError, pipelineSlots, artifactFilename, setProgress, type DownloadSpec } from '../lib/server-download';
import { produceAlbumZipFile, type AlbumZipSpec } from '../lib/album-zip-produce';
import { hydrateSessionsFromRedis } from '../lib/platforms/native-tools';
import { hydrateTokenPoolFromRedis, hydrateSettingsFromRedis } from '../lib/token-pool';
import { liveDownloadsEnabled, validLiveToken } from '../lib/live-download';

// NOTE: the bundle never imports lib/platforms/index (the module that sets
// axios keep-alive) — without this every upstream call pays a fresh TCP+TLS.
axios.defaults.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

const CAPS = (process.env.WORKER_CAPS ?? 'generic').split(',').map((s) => s.trim()).filter(Boolean);
const QUEUES = [...(CAPS.includes('apple') ? [QUEUE_APPLE] : []), ...(CAPS.includes('generic') ? [QUEUE_GENERIC] : [])];
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 500);
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.JOB_MAX_ATTEMPTS ?? 3));
const INLINE_RESULT_MAX = 8 * 1024 * 1024;
const WORKER_ID = `${os.hostname()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let stopping = false;
let active = 0;
const metrics = {
    claimed: 0,
    completed: 0,
    failed: 0,
    retried: 0,
    cancelled: 0,
    bytesProduced: 0,
    lastError: '',
    lastJobAt: 0
};

// Terminal-state writes must survive transient Redis blips — otherwise a job
// remains leased as processing and users see a false "stuck" download.
async function finishJob(id: string, ok: boolean, patch: Record<string, any>, token: string, tries = 6): Promise<void> {
    let lastErr: any;
    for (let i = 0; i < tries; i++) {
        try {
            await jobDone(id, ok, patch, token);
            return;
        } catch (e: any) {
            lastErr = e;
            if (/lease lost/i.test(String(e?.message ?? e))) break;
            await sleep(1000 * (i + 1));
        }
    }
    console.error(`[worker] ${id.slice(0, 8)} terminal write failed: ${lastErr?.message ?? lastErr}`);
}

function retriableFailure(e: any): boolean {
    const kind = classifyDlError(e);
    const msg = `${e?.message ?? e} ${e?.code ?? ''}`;
    if (/cancelled|abort/i.test(msg)) return false;
    if (kind === 'network') return true;
    if (kind === 'tool' && /ffmpeg timed out|timed out|spawn|enoent|socket|econnreset|epipe/i.test(msg)) return true;
    return /r2 put|verification failed|fetch failed|ECONNRESET|ETIMEDOUT|ENETRESET|EPIPE|429|5\d\d/i.test(msg);
}

function validateTrackSpec(spec: any): asserts spec is DownloadSpec {
    if (!spec || typeof spec !== 'object') throw new Error('invalid job payload');
    if (!spec.source || !spec.id || !spec.filename) throw new Error('job payload missing source/id/filename');
    if (typeof spec.title !== 'string' || typeof spec.artist !== 'string') throw new Error('job payload missing track metadata');
}

function validateZipSpec(spec: any): asserts spec is AlbumZipSpec {
    if (!spec || typeof spec !== 'object') throw new Error('invalid zip payload');
    if (!spec.source || !spec.albumId || !spec.zipName) throw new Error('zip payload missing source/albumId/zipName');
}

// Complete-artifact live sessions: once validation has produced a real file,
// the browser can read that file directly while the normal R2 upload runs in
// parallel. This preserves final-size/integrity guarantees without exposing a
// partially produced object.
type LiveSession = {
    id: string;
    file: string;
    dir: string;
    ext: string;
    filename: string;
    size: number;
    expiresAt: number;
    activeStreams: number;
    uploadDone: boolean;
    cleanupTimer?: NodeJS.Timeout;
};
const liveSessions = new Map<string, LiveSession>();
const LIVE_SESSION_TTL_MS = Number(process.env.LIVE_SESSION_TTL_MS ?? 10 * 60 * 1000);
const LIVE_IDLE_CLEANUP_MS = Number(process.env.LIVE_IDLE_CLEANUP_MS ?? 45 * 1000);
const LIVE_MAX_STREAMS = Math.max(1, Number(process.env.LIVE_MAX_STREAMS ?? 6));

function activeLiveStreams(): number {
    let n = 0;
    for (const session of liveSessions.values()) n += session.activeStreams;
    return n;
}

function clearLiveTimer(session: LiveSession) {
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    session.cleanupTimer = undefined;
}

function destroyLiveSession(session: LiveSession) {
    if (liveSessions.get(session.id) === session) liveSessions.delete(session.id);
    clearLiveTimer(session);
    fs.rmSync(session.dir, { recursive: true, force: true });
}

function scheduleLiveCleanup(session: LiveSession, delay = LIVE_IDLE_CLEANUP_MS) {
    clearLiveTimer(session);
    session.cleanupTimer = setTimeout(() => {
        if (session.activeStreams > 0) return;
        destroyLiveSession(session);
    }, delay);
    session.cleanupTimer.unref?.();
}

function registerLiveSession(args: { id: string; file: string; dir: string; ext: string; filename: string; size: number }): LiveSession {
    const previous = liveSessions.get(args.id);
    if (previous) destroyLiveSession(previous);
    const session: LiveSession = {
        ...args,
        expiresAt: Date.now() + LIVE_SESSION_TTL_MS,
        activeStreams: 0,
        uploadDone: false
    };
    liveSessions.set(args.id, session);
    return session;
}

function finishLiveArtifact(session: LiveSession) {
    session.uploadDone = true;
    if (session.activeStreams === 0) scheduleLiveCleanup(session);
}

function releaseLiveStream(session: LiveSession) {
    session.activeStreams = Math.max(0, session.activeStreams - 1);
    if (session.uploadDone || Date.now() >= session.expiresAt) scheduleLiveCleanup(session, 1000);
}

const LIVE_MIME: Record<string, string> = {
    flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4',
    webm: 'audio/webm', opus: 'audio/webm', ogg: 'audio/ogg', wav: 'audio/wav'
};

function liveCorsHeaders(): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Disposition',
        'Cache-Control': 'no-store'
    };
}

function sendLiveJson(res: http.ServerResponse, status: number, body: Record<string, any>) {
    res.writeHead(status, { ...liveCorsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

async function handleLiveRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, liveCorsHeaders());
        res.end();
        return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendLiveJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
    }
    const id = decodeURIComponent(url.pathname.split('/')[2] ?? '');
    if (!liveDownloadsEnabled() || !validLiveToken(id, url.searchParams.get('token') ?? '')) {
        sendLiveJson(res, 403, { ok: false, error: 'invalid live download token' });
        return;
    }
    const session = liveSessions.get(id);
    if (!session || Date.now() >= session.expiresAt || !fs.existsSync(session.file)) {
        const j = await jobGet(id).catch(() => null);
        const terminal = j?.stage === 'done' || j?.stage === 'error';
        sendLiveJson(res, terminal ? 410 : 202, {
            ok: false,
            error: terminal ? 'live artifact expired — use the published artifact' : 'live artifact is not ready yet'
        });
        return;
    }

    if (activeLiveStreams() >= LIVE_MAX_STREAMS) {
        sendLiveJson(res, 429, { ok: false, error: 'too many live artifact streams — use the published artifact when ready' });
        return;
    }

    const total = session.size;
    let start = 0;
    let end = total - 1;
    let status = 200;
    const range = typeof req.headers.range === 'string' ? req.headers.range : '';
    if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (!m || (!m[1] && !m[2])) {
            res.writeHead(416, { ...liveCorsHeaders(), 'Content-Range': `bytes */${total}` });
            res.end();
            return;
        }
        if (!m[1]) {
            const suffix = Number(m[2]);
            start = Math.max(0, total - suffix);
            end = total - 1;
        } else {
            start = Number(m[1]);
            end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || end < start) {
            res.writeHead(416, { ...liveCorsHeaders(), 'Content-Range': `bytes */${total}` });
            res.end();
            return;
        }
        status = 206;
    }

    const headers: Record<string, string | number> = {
        ...liveCorsHeaders(),
        'Content-Type': LIVE_MIME[session.ext] ?? 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(session.filename)}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'X-Live-Artifact': 'worker'
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    if (req.method === 'HEAD') {
        res.writeHead(status, headers);
        res.end();
        return;
    }

    session.activeStreams++;
    clearLiveTimer(session);
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        releaseLiveStream(session);
    };
    res.on('close', release);
    res.setTimeout(LIVE_SESSION_TTL_MS, () => res.destroy(new Error('live stream timeout')));
    const body = fs.createReadStream(session.file, { start, end, highWaterMark: 1 << 20 });
    body.on('error', () => res.destroy());
    res.writeHead(status, headers);
    body.pipe(res);
}

async function uploadArtifact(args: {
    id: string;
    file: string;
    ext: string;
    filename: string;
    cacheKey: string;
    extra?: Record<string, any>;
}): Promise<Record<string, any>> {
    const size = fs.statSync(args.file).size;
    if (!size) throw new Error('produced artifact is empty');
    if (cacheEnabled()) {
        const key = objectKey(args.cacheKey, args.ext);
        setProgress(args.id, { stage: 'uploading', label: 'Uploading artifact', sent: 0, total: size });
        let maxUploaded = 0;
        const uploaded = await cachePutFile(key, args.file, size, (bytes, total) => {
            maxUploaded = Math.max(maxUploaded, bytes);
            setProgress(args.id, { stage: 'uploading', sent: maxUploaded, total });
        });
        return {
            sent: size,
            total: size,
            resultUrl: presignGet(key, args.filename, 6 * 3600),
            resultExt: args.ext,
            resultName: args.filename,
            resultJson: {
                objectKey: key,
                size: uploaded.size,
                sha256: uploaded.sha256,
                etag: uploaded.etag,
                ...args.extra
            }
        };
    }

    // Development fallback only. Redis inline values are deliberately capped;
    // production must configure R2 rather than pushing media through the broker.
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_INLINE_RESULTS !== '1') {
        throw new Error('R2 artifact storage is required in production queue mode');
    }
    if (size > INLINE_RESULT_MAX) throw new Error('R2 bucket not configured — cannot deliver >8MB result');
    const buf = fs.readFileSync(args.file);
    return {
        sent: size,
        total: size,
        resultB64: buf.toString('base64'),
        resultExt: args.ext,
        resultName: args.filename,
        resultJson: { size, inline: true, ...args.extra }
    };
}

async function processTrack(id: string, spec: DownloadSpec, signal: AbortSignal): Promise<Record<string, any>> {
    validateTrackSpec(spec);
    await jobSet(id, { stage: 'resolving', label: `${spec.title} — ${spec.artist}` }).catch(() => {});
    const release = await pipelineSlots.acquire();
    let staged: Awaited<ReturnType<typeof stageToFile>> | null = null;
    try {
        staged = await stageToFile(spec, id, signal);
    } finally {
        release();
    }
    let liveSession: LiveSession | null = null;
    try {
        if (!fs.existsSync(staged.file) || fs.statSync(staged.file).size !== staged.size || staged.size <= 0) {
            throw new Error('produced track artifact failed size validation');
        }

        // Explicit provider previews are legitimate degraded artifacts. Hidden
        // short files are still rejected — only a resolver that proved and
        // labeled the provider-owned preview may take this path.
        const gotDuration = await probeFileDuration(staged.file);
        if (gotDuration <= 0) throw new Error('produced track artifact is not a valid/audio-parseable media file');
        if (!staged.isPreview && spec.duration && gotDuration < spec.duration * 0.6) {
            throw new Error(`${spec.source} only served a ${Math.round(gotDuration)}s clip of a ${spec.duration}s track — refusing to deliver`);
        }

        const filename = artifactFilename(spec.filename, staged.ext, staged.isPreview);
        if (liveDownloadsEnabled()) {
            liveSession = registerLiveSession({ id, file: staged.file, dir: staged.dir, ext: staged.ext, filename, size: staged.size });
            await jobSet(id, { liveReady: '1', liveExpiresAt: liveSession.expiresAt }).catch(() => {});
        }
        try {
            return await uploadArtifact({
                id,
                file: staged.file,
                ext: staged.ext,
                filename,
                // Preview artifacts are deliverable but deliberately non-reusable:
                // keying them by job id prevents a free-tier artifact from becoming
                // a stale cache hit after the account later gains entitlement.
                cacheKey: staged.isPreview ? `${previewCacheKeyFor(spec)}/job-${id}` : cacheKeyFor(spec),
                extra: {
                    kind: 'track',
                    source: spec.source,
                    trackId: spec.id,
                    servedBy: staged.servedBy,
                    isPreview: !!staged.isPreview,
                    previewDuration: staged.isPreview ? Math.round(gotDuration * 10) / 10 : undefined
                }
            });
        } finally {
            if (liveSession) finishLiveArtifact(liveSession);
        }
    } finally {
        // A registered live session owns the staged directory until the direct
        // browser stream and/or grace period finishes. Non-live jobs keep the
        // original immediate cleanup behavior.
        if (!liveSession) fs.rmSync(staged.dir, { recursive: true, force: true });
    }
}

async function processZip(id: string, spec: AlbumZipSpec, isCancelled: () => boolean): Promise<Record<string, any>> {
    validateZipSpec(spec);
    const produced = await produceAlbumZipFile(spec, id, isCancelled);
    try {
        const zipName = spec.zipName.toLowerCase().endsWith('.zip') ? spec.zipName : `${spec.zipName}.zip`;
        return await uploadArtifact({
            id,
            file: produced.file,
            ext: 'zip',
            filename: zipName,
            cacheKey: produced.previewCount ? `${previewZipCacheKeyFor(spec)}/job-${id}` : zipCacheKeyFor(spec),
            extra: { kind: 'zip', source: spec.source, albumId: spec.albumId, trackCount: produced.trackCount, failedCount: produced.failedCount, previewCount: produced.previewCount, containsPreviews: produced.previewCount > 0 }
        });
    } finally {
        fs.rmSync(produced.dir, { recursive: true, force: true });
    }
}

async function processClaim(claim: NonNullable<Awaited<ReturnType<typeof dequeueJob>>>): Promise<void> {
    const { id, payload, kind, attempt, token } = claim;
    metrics.claimed++;
    metrics.lastJobAt = Date.now();
    const short = id.slice(0, 8);
    const ac = new AbortController();
    let sawCancel = false;
    const cancelPoll = setInterval(() => {
        jobGet(id)
            .then((j) => {
                if (cancelRequested(j)) {
                    sawCancel = true;
                    ac.abort();
                }
            })
            .catch(() => {});
    }, 2000);
    const hb = setInterval(() => {
        touchInflight(id, WORKER_ID, LEASE_MS, token).then((ok) => {
            // If the lease was lost, another worker may legitimately own the job
            // now. Abort local work instead of racing a duplicate terminal write.
            if (!ok) ac.abort();
        }).catch(() => {});
    }, Math.max(10_000, Math.floor(LEASE_MS / 4)));

    try {
        console.log(`[worker] ${short} ${kind} attempt=${attempt} ${payload?.source ?? ''} ${payload?.title ?? payload?.zipName ?? ''}`);
        const result = kind === 'zip'
            ? await processZip(id, payload, () => sawCancel)
            : await processTrack(id, payload as DownloadSpec, ac.signal);
        if (sawCancel || ac.signal.aborted) throw new Error('cancelled');
        await finishJob(id, true, result, token);
        metrics.completed++;
        metrics.bytesProduced += Number(result.sent ?? 0);
        console.log(`[worker] ${short} done (${result.sent ?? 0}B)`);
    } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 500);
        const cancelled = sawCancel || /cancelled/i.test(msg);
        if (cancelled) {
            metrics.cancelled++;
            await finishJob(id, false, { error: 'cancelled', errorKind: 'cancelled' }, token);
            console.log(`[worker] ${short} cancelled`);
        } else if (attempt < MAX_ATTEMPTS && retriableFailure(e)) {
            metrics.retried++;
            const backoff = Math.min(30_000, 2000 * 2 ** Math.max(0, attempt - 1));
            await retryJob(id, msg, backoff, token).catch(async () => {
                await finishJob(id, false, { error: msg, errorKind: classifyDlError(e) }, token);
            });
            console.log(`[worker] ${short} retrying in ${backoff}ms: ${msg.slice(0, 160)}`);
        } else {
            metrics.failed++;
            metrics.lastError = publicErrorMessage(msg) ?? '';
            const errorKind = classifyDlError(e);
            await finishJob(id, false, { error: msg, errorKind }, token);
            console.log(`[worker] ${short} failed (${errorKind}): ${msg.slice(0, 200)}`);
        }
    } finally {
        clearInterval(cancelPoll);
        clearInterval(hb);
    }
}

async function workerRegistryHeartbeat() {
    await cmd('HSET', 'workers', WORKER_ID, JSON.stringify({
        id: WORKER_ID,
        host: os.hostname(),
        pid: process.pid,
        caps: CAPS,
        active,
        concurrency: CONCURRENCY,
        uptime: Math.floor(process.uptime()),
        metrics,
        at: Date.now()
    })).catch(() => {});
}

// Render free tier only offers web services — the worker must bind a port or
// the platform kills it after the port-scan timeout. The listener doubles as
// liveness/readiness/metrics for operators and external pingers.
const PORT = Number(process.env.PORT ?? 3101);
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname.startsWith('/live/')) {
            await handleLiveRequest(req, res, url);
            return;
        }
        if (url.pathname === '/metrics') {
            const [depths, counters] = await Promise.all([queueDepths().catch(() => ({})), jobCounters().catch(() => ({}))]);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: true, worker: WORKER_ID, caps: CAPS, active, concurrency: CONCURRENCY, live: { sessions: liveSessions.size, streams: activeLiveStreams(), maxStreams: LIVE_MAX_STREAMS }, up: Math.floor(process.uptime()), metrics, queue: depths, counters }));
            return;
        }
        if (url.pathname === '/ready') {
            const ok = queueEnabled() && QUEUES.length > 0 && !stopping;
            res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok, queueEnabled: queueEnabled(), queues: QUEUES, cache: cacheEnabled() ? 'r2' : 'inline-dev' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, worker: WORKER_ID, caps: CAPS, active, up: Math.floor(process.uptime()) }));
    } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e?.message ?? 'worker health error' }));
    }
});

async function main() {
    if (!queueEnabled()) {
        console.error('UPSTASH_REDIS_URL/UPSTASH_REDIS_TOKEN not set — worker cannot start');
        process.exit(1);
    }
    if (!QUEUES.length) {
        console.error(`WORKER_CAPS=${CAPS.join(',')} does not include generic or apple`);
        process.exit(1);
    }
    server.listen(PORT, () => console.log(`[worker] health on :${PORT}`));
    // Pull provider sessions written by the web process's connect flows — the
    // two disks don't share storage, Redis is the bridge.
    await hydrateSessionsFromRedis().catch(() => {});
    await hydrateTokenPoolFromRedis().catch(() => false);
    await hydrateSettingsFromRedis().catch(() => false);
    setInterval(() => {
        hydrateSessionsFromRedis().catch(() => {});
        hydrateTokenPoolFromRedis().catch(() => false);
        hydrateSettingsFromRedis().catch(() => false);
    }, 30_000).unref();
    await workerRegistryHeartbeat();
    setInterval(workerRegistryHeartbeat, 15_000).unref();
    console.log(`[worker] up — id=${WORKER_ID} caps=${CAPS.join('+')} queues=${QUEUES.join('+')} concurrency=${CONCURRENCY} cache=${cacheEnabled() ? 'r2' : 'inline-dev'}`);

    let idle = 0;
    while (!stopping) {
        try {
            if (active >= CONCURRENCY) {
                await sleep(150);
                continue;
            }
            const claim = await dequeueJob(QUEUES, WORKER_ID, LEASE_MS);
            if (!claim) {
                idle++;
                await sleep(Math.min(POLL_MS * Math.ceil(idle / 4), 2_000));
                continue;
            }
            idle = 0;
            active++;
            void processClaim(claim).finally(() => active--);
        } catch (e: any) {
            metrics.lastError = publicErrorMessage(String(e?.message ?? e)) ?? '';
            console.log(`[worker] poll error: ${metrics.lastError}${e?.cause?.code ? ` cause=${e.cause.code}` : ''}`);
            await sleep(5000);
        }
    }

    const drainDeadline = Date.now() + 30_000;
    while (active && Date.now() < drainDeadline) await sleep(250);
    server.close();
    console.log(`[worker] stopped — active=${active}`);
    process.exit(active ? 1 : 0);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
        if (!stopping) console.log(`[worker] ${sig} received — draining`);
        stopping = true;
    });
}

main().catch((e) => {
    console.error(`[worker] fatal: ${e?.message ?? e}`);
    process.exit(1);
});
