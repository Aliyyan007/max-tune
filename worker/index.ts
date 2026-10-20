// Queue worker — polls the Upstash job queue, runs the same produce→tag pipeline
// the web process uses, uploads the result to R2, and marks the job with a
// presigned URL. The web's /api/download-file just waits for resultUrl and
// redirects — so the whole transfer cost of downloads lands on this process,
// never on the web dyno.
//
//   WORKER_CAPS=generic          poll only the generic queue
//   WORKER_CAPS=generic,apple    also poll apple (needs APPLE_WRAPPER_URL reachable)
//
// Bundled to worker.cjs via `npm run build:worker` — no runtime deps on next.
import http from 'http';
import { dequeueJob, jobDone, jobGet, jobSet, queueEnabled } from '../lib/queue';
import { cacheEnabled, cachePut, presignGet, cacheKeyFor, objectKey } from '../lib/download-cache';
import { produceTrackBytes, tagAndEncode, type DownloadSpec } from '../lib/server-download';

// Render free tier only offers web services — the worker must bind a port or
// the platform kills it after the port-scan timeout. This tiny listener doubles
// as the health check + external-pinger target.
const PORT = Number(process.env.PORT ?? 3101);
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, caps: CAPS, up: Math.floor(process.uptime()) }));
}).listen(PORT, () => console.log(`[worker] health on :${PORT}`));

const CAPS = (process.env.WORKER_CAPS ?? 'generic').split(',').map((s) => s.trim()).filter(Boolean);
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2500);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runJob(id: string): Promise<void> {
    const job = await jobGet(id);
    if (!job?.spec) {
        await jobSet(id, { stage: 'error', error: 'job payload missing' });
        return;
    }
    if (job.cancelled) {
        await jobSet(id, { stage: 'error', error: 'cancelled' });
        return;
    }
    const spec = JSON.parse(job.spec) as DownloadSpec;
    console.log(`[worker] ${id.slice(0, 8)} ${spec.source} ${spec.title} — ${spec.artist}`);
    await jobSet(id, { stage: 'resolving', at: Date.now() });
    const { data, format } = await produceTrackBytes(spec);
    await jobSet(id, { stage: 'processing', received: data.length, total: data.length });
    const { data: out, ext } = await tagAndEncode(data, format, spec);
    const filename = spec.filename.toLowerCase().endsWith(`.${ext}`) ? spec.filename : `${spec.filename}.${ext}`;

    if (cacheEnabled()) {
        const key = objectKey(cacheKeyFor(spec), ext);
        await cachePut(key, out);
        await jobSet(id, {
            stage: 'done', sent: out.length, at: Date.now(),
            resultUrl: presignGet(key, filename, 6 * 3600), resultExt: ext, resultName: filename
        });
        console.log(`[worker] ${id.slice(0, 8)} done → r2 ${key} (${out.length}B)`);
    } else {
        // no bucket configured — stash bytes on the job directly (small tracks only;
        // redis value limit is 100MB but Upstash free tier is far tighter)
        if (out.length > 8 * 1024 * 1024) {
            await jobSet(id, { stage: 'error', error: 'R2 bucket not configured — cannot deliver >8MB result' });
            return;
        }
        await jobSet(id, {
            stage: 'done', sent: out.length, at: Date.now(),
            resultB64: out.toString('base64'), resultExt: ext, resultName: filename
        } as any);
        console.log(`[worker] ${id.slice(0, 8)} done → inline (${out.length}B)`);
    }
}

async function main() {
    if (!queueEnabled()) {
        console.error('UPSTASH_REDIS_URL/UPSTASH_REDIS_TOKEN not set — worker cannot start');
        process.exit(1);
    }
    console.log(`[worker] up — caps=${CAPS.join('+')} cache=${cacheEnabled() ? 'r2' : 'inline'}`);
    let idle = 0;
    for (;;) {
        try {
            const id = await dequeueJob(CAPS);
            if (!id) {
                idle++;
                // exponential-ish backoff: 2.5s → max 30s when starving
                await sleep(Math.min(POLL_MS * Math.ceil(idle / 8), 30000));
                continue;
            }
            idle = 0;
            try {
                await runJob(id);
            } catch (e: any) {
                console.log(`[worker] ${id.slice(0, 8)} failed: ${e?.message?.slice(0, 200) ?? e}`);
                await jobSet(id, { stage: 'error', error: String(e?.message ?? e).slice(0, 500), at: Date.now() }).catch(() => {});
            } finally {
                await jobDone(id).catch(() => {});
            }
        } catch (e: any) {
            console.log(`[worker] poll error: ${e?.message?.slice(0, 160) ?? e}`);
            await sleep(5000);
        }
    }
}

main();
