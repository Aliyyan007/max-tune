import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { apiError } from '@/lib/platforms';
import { createJob, claimJob, streamTaggedTrack, setProgress, stagedFileFor, registerStaged, artifactFilename } from '@/lib/server-download';
import { queueEnabled, enqueueJob, jobGet, jobSet, jobExpire, publicJobView, cmd } from '@/lib/queue';
import { cacheEnabled, cacheGet, presignGet, cacheKeyFor } from '@/lib/download-cache';
import { parseDownloadSpec } from '@/lib/download-spec';
import { rateLimit, clientIp } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MIME: Record<string, string> = {
    flac: 'audio/flac',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    webm: 'audio/webm',
    opus: 'audio/webm',
    ogg: 'audio/ogg',
    wav: 'audio/wav'
};

// POST: client submits the full download spec (settings + service tokens) → {job}
// so the GET can be a plain <a download> navigation that Chrome owns end-to-end.
export async function POST(request: NextRequest) {
    try {
        const contentLength = Number(request.headers.get('content-length') ?? 0);
        if (contentLength > 64 * 1024) return apiError(new Error('download spec too large'), 413);
        if (!(await rateLimit(`dl:${clientIp(request.headers)}`, 30, 60))) {
            return apiError(new Error('too many download jobs — slow down'), 429);
        }
        const spec = parseDownloadSpec(await request.json());

        if (queueEnabled()) {
            let job = crypto.randomBytes(16).toString('hex');
            // cache hit → job is born finished; GET will redirect to the presigned R2 URL
            if (cacheEnabled()) {
                // Only full-track artifacts are cacheable. Preview objects are
                // job-scoped because a later entitled account must be allowed
                // to re-resolve the full recording instead of hitting a stale
                // free-tier artifact.
                const hit = await cacheGet(cacheKeyFor(spec)).catch(() => null);
                if (hit) {
                    const filename = artifactFilename(spec.filename, hit.ext, false);
                    await jobSet(job, {
                        state: 'done', stage: 'done', kind: 'track', cacheHit: '1',
                        resultUrl: presignGet(hit.objectKey, filename, 6 * 3600),
                        resultExt: hit.ext, resultName: filename,
                        resultJson: { objectKey: hit.objectKey, size: hit.size, cacheHit: true, isPreview: false },
                        received: hit.size, sent: hit.size, total: hit.size, at: Date.now()
                    });
                    await jobExpire(job);
                    return NextResponse.json({ success: true, data: { job, cached: true, mode: 'queue' } });
                }
            }

            const recipeHash = crypto.createHash('sha256').update(cacheKeyFor(spec)).digest('hex');
            const dedupeKey = `dedupe:track:${recipeHash}`;
            let deduped = false;
            for (let attempt = 0; attempt < 2; attempt++) {
                const existing = await cmd('GET', dedupeKey).catch(() => null);
                if (existing) {
                    const [existingJob, existingAtRaw] = String(existing).split(':');
                    const existingAt = Number(existingAtRaw ?? 0);
                    const prior = await jobGet(existingJob).catch(() => null);
                    const priorState = String(prior?.state ?? prior?.stage ?? '');
                    const freshMissing = !prior && Date.now() - existingAt < 10_000;
                    if ((prior && priorState !== 'error') || freshMissing) {
                        job = existingJob;
                        deduped = true;
                        break;
                    }
                    await cmd('DEL', dedupeKey).catch(() => {});
                }
                const reserved = await cmd('SET', dedupeKey, `${job}:${Date.now()}`, 'PX', 30 * 60 * 1000, 'NX').catch(() => null);
                if (reserved) break;
                const winner = await cmd('GET', dedupeKey).catch(() => null);
                if (winner) {
                    job = String(winner).split(':')[0];
                    deduped = true;
                    break;
                }
            }
            if (!deduped) {
                try {
                    await enqueueJob(job, spec, spec.source, 'track');
                } catch (e) {
                    await cmd('DEL', dedupeKey).catch(() => {});
                    throw e;
                }
            }
            return NextResponse.json({ success: true, data: { job, mode: 'queue', deduped } });
        }

        const job = createJob(spec);
        setProgress(job, { stage: 'queued' });
        return NextResponse.json({ success: true, data: { job, mode: 'local' } });
    } catch (e: any) {
        return apiError(e);
    }
}

// GET ?job=<id>: streams platform bytes → ffmpeg → response so Chrome's download
// manager shows real progress while the file is still being fetched+tagged.
export async function GET(request: NextRequest) {
    try {
        const id = new URL(request.url).searchParams.get('job') ?? '';

        if (queueEnabled()) {
            // Queue mode is deliberately non-blocking: web/serverless requests
            // must not sit open for the whole production. Clients poll job-status
            // and only navigate here once the worker has published the artifact.
            const j = await jobGet(id);
            if (!j) return failResponse(request, 'download job expired — retry', 410);
            if (j.stage === 'error') return failResponse(request, publicJobView(j).error ?? 'download failed', 502);
            if (j.stage !== 'done') {
                return NextResponse.json({ success: false, error: 'job not ready', stage: j.stage ?? 'queued' }, { status: 202, headers: { 'Retry-After': '2', 'Cache-Control': 'no-store' } });
            }
            const objectKey = j.resultJson?.objectKey;
            const resultUrl = objectKey && j.resultName ? presignGet(objectKey, j.resultName, 6 * 3600) : j.resultUrl;
            if (resultUrl) return NextResponse.redirect(resultUrl, 302);
            if ((j as any).resultB64) {
                const buf = Buffer.from((j as any).resultB64, 'base64');
                const ext = j.resultExt ?? 'flac';
                const filename = j.resultName ?? `track.${ext}`;
                return new NextResponse(buf as any, {
                    headers: {
                        'Content-Type': MIME[ext] ?? 'application/octet-stream',
                        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
                        'Content-Length': String(buf.length)
                    }
                });
            }
            return failResponse(request, 'download result missing — retry', 410);
        }

        const job = claimJob(id);
        if (!job) {
            // already claimed → this is a retry; if a staged file was produced
            // a Range request can resume it instead of re-running the pipeline
            const st = stagedFileFor(id);
            const range = request.headers.get('range');
            const m = st && range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
            if (st && m && (m[1] || m[2]) && fs.existsSync(st.file)) {
                const size = st.size;
                const start = m[1] ? parseInt(m[1]) : Math.max(0, size - parseInt(m[2]));
                const end = m[1] && m[2] ? Math.min(parseInt(m[2]), size - 1) : size - 1;
                if (start < size && end >= start) {
                    const ranged = fs.createReadStream(st.file, { start, end });
                    request.signal.addEventListener('abort', () => ranged.destroy(), { once: true });
                    return new NextResponse(Readable.toWeb(ranged) as ReadableStream, {
                        status: 206,
                        headers: {
                            'Content-Type': MIME[path.extname(st.file).slice(1)] ?? 'application/octet-stream',
                            'Content-Length': String(end - start + 1),
                            'Content-Range': `bytes ${start}-${end}/${size}`,
                            'Accept-Ranges': 'bytes',
                            'Cache-Control': 'no-store'
                        }
                    });
                }
            }
            return failResponse(request, 'download job expired — retry', 410);
        }
        const { spec } = job;

        // Wire client disconnect → job abort BEFORE producing — the old code
        // attached the listener only after resolution, so aborting during the
        // (often longest) resolve/download phase did nothing.
        const abort = new AbortController();
        request.signal.addEventListener('abort', () => abort.abort(), { once: true });
        if (request.signal.aborted) abort.abort();

        const { body, ext, contentLength, stagedFile, stagedDir, servedBy, isPreview, cleanup } = await streamTaggedTrack(spec, id, abort.signal);

        const filename = artifactFilename(spec.filename, ext, isPreview);
        const headers: Record<string, string> = {
            'Content-Type': MIME[ext] ?? 'application/octet-stream',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
            'X-Audio-Format': ext,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        };
        if (servedBy) headers['X-Resolved-Source'] = servedBy;
        if (isPreview) headers['X-Preview'] = '1';

        // Staged files support resume — honor single-range requests (browser
        // retry / download managers) instead of replaying the pipeline.
        const range = request.headers.get('range');
        if (stagedFile && range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
            if (m && (m[1] || m[2])) {
                const size = contentLength ?? fs.statSync(stagedFile).size;
                const start = m[1] ? parseInt(m[1]) : Math.max(0, size - parseInt(m[2]));
                const end = m[1] && m[2] ? Math.min(parseInt(m[2]), size - 1) : size - 1;
                if (start < size && end >= start) {
                    // the pipeline produced `body` for this job — discard it
                    // (fd + semaphore slot) and pin the staged file for resume
                    try {
                        (body as any)?.destroy?.();
                    } catch {}
                    cleanup?.();
                    if (stagedDir) registerStaged(id, stagedFile, stagedDir, size);
                    const ranged = fs.createReadStream(stagedFile, { start, end });
                    abort.signal.addEventListener('abort', () => ranged.destroy(), { once: true });
                    return new NextResponse(Readable.toWeb(ranged) as ReadableStream, {
                        status: 206,
                        headers: {
                            ...headers,
                            'Content-Length': String(end - start + 1),
                            'Content-Range': `bytes ${start}-${end}/${size}`,
                            'Accept-Ranges': 'bytes'
                        }
                    });
                }
            }
        }

        if (contentLength) headers['Content-Length'] = String(contentLength);
        if (stagedFile) headers['Accept-Ranges'] = 'bytes';

        // Readable.toWeb gives true backpressure — the old manual relay pushed
        // chunks into the response regardless of client read speed (memory).
        let relayed = 0;
        body.on('data', (c: Buffer) => (relayed += c.length));
        body.on('end', () => setProgress(id, { stage: 'done' }));
        body.on('error', (e: any) => {
            setProgress(id, { stage: 'error', error: e?.message ?? 'stream failed' });
            console.log(`[download-file ${id.slice(0, 8)}] broke after ${relayed}B: ${e?.message}`);
        });
        request.signal.addEventListener('abort', () => {
            setProgress(id, { stage: 'error', error: 'client disconnected' });
            try {
                cleanup?.();
            } catch {}
            try {
                (body as any)?.destroy?.();
            } catch {}
        });
        return new NextResponse(Readable.toWeb(body) as ReadableStream, { headers });
    } catch (e: any) {
        const jid = new URL(request.url).searchParams.get('job') ?? '';
        if (jid) setProgress(jid, { stage: 'error', error: e?.message ?? 'download failed' });
        return failResponse(request, e?.message ?? 'download failed', 502);
    }
}

// When the request came from a browser NAVIGATION (a[download] click / address
// bar), a bare JSON error body gets saved as a junk file — return a readable
// HTML page instead. fetch() callers still get the JSON error object.
function failResponse(request: NextRequest, message: string, status: number) {
    const wantsHtml = (request.headers.get('accept') ?? '').includes('text/html');
    if (wantsHtml) {
        const html = `<!doctype html><html><body style="font-family:system-ui;padding:3rem;background:#111;color:#eee">
<h2 style="margin:0 0 .5rem">Download failed</h2><p>${message.replace(/</g, '&lt;')}</p>
<p style="opacity:.6;font-size:.85rem">You can close this tab — the app is still open in your other tab.</p></body></html>`;
        return new NextResponse(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return apiError(new Error(message), status);
}
