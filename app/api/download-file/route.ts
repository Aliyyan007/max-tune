import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { apiError } from '@/lib/platforms';
import { createJob, takeJob, streamTaggedTrack, setProgress, type DownloadSpec } from '@/lib/server-download';
import { queueEnabled, enqueueJob, jobGet, jobSet } from '@/lib/queue';
import { cacheEnabled, cacheGet, presignGet, cacheKeyFor } from '@/lib/download-cache';

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
        const spec = (await request.json()) as DownloadSpec;
        if (!spec?.source || !spec?.id || !spec?.filename) throw new Error('incomplete download spec');

        if (queueEnabled()) {
            const job = crypto.randomBytes(16).toString('hex');
            // cache hit → job is born finished; GET will redirect to the presigned R2 URL
            if (cacheEnabled()) {
                const hit = await cacheGet(cacheKeyFor(spec)).catch(() => null);
                if (hit) {
                    const filename = spec.filename.toLowerCase().endsWith(`.${hit.ext}`) ? spec.filename : `${spec.filename}.${hit.ext}`;
                    await jobSet(job, {
                        stage: 'done', resultUrl: presignGet(hit.objectKey, filename, 6 * 3600),
                        resultExt: hit.ext, resultName: filename, at: Date.now()
                    });
                    return NextResponse.json({ success: true, data: { job, cached: true } });
                }
            }
            await enqueueJob(job, JSON.stringify(spec), spec.source);
            return NextResponse.json({ success: true, data: { job } });
        }

        const job = createJob(spec);
        setProgress(job, { stage: 'queued' });
        return NextResponse.json({ success: true, data: { job } });
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
            // Wait on the worker's result, then hand the browser a presigned R2 URL.
            // Blocking long-poll keeps the client's a[download] flow unchanged.
            const deadline = Date.now() + 240_000;
            while (Date.now() < deadline) {
                const j = await jobGet(id);
                if (!j) return apiError(new Error('download job expired — retry'), 410);
                if (j.stage === 'error') return apiError(new Error(j.error ?? 'download failed'), 502);
                if (j.stage === 'done') {
                    if (j.resultUrl) return NextResponse.redirect(j.resultUrl, 302);
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
                }
                await new Promise((r) => setTimeout(r, 1500));
            }
            return apiError(new Error('worker timeout — job still queued'), 504);
        }

        const job = takeJob(id);
        if (!job) return apiError(new Error('download job expired — retry'), 410);
        const { spec } = job;

        const { body, ext, contentLength, cleanup } = await streamTaggedTrack(spec, id);

        const filename = spec.filename.toLowerCase().endsWith(`.${ext}`) ? spec.filename : `${spec.filename}.${ext}`;
        const headers: Record<string, string> = {
            'Content-Type': MIME[ext] ?? 'application/octet-stream',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
            'X-Audio-Format': ext,
            'Cache-Control': 'no-store'
        };
        if (contentLength) headers['Content-Length'] = String(contentLength);

        // Instrumented relay — count what actually reaches the response body so
        // Render logs show exactly where a transfer stalls or dies.
        let relayed = 0;
        let dead = false; // guard: enqueue/close on an aborted controller throws ERR_INVALID_STATE (uncaught = process crash)
        const tee = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    for await (const chunk of body as any) {
                        if (dead) break;
                        try {
                            controller.enqueue(chunk as Uint8Array);
                        } catch {
                            dead = true;
                            break;
                        }
                        relayed += (chunk as Buffer).length;
                    }
                    if (!dead) {
                        dead = true;
                        try {
                            controller.close();
                        } catch {}
                        setProgress(id, { stage: 'done' });
                        console.log(`[download-file ${id.slice(0, 8)}] response finished — ${relayed}B relayed`);
                    }
                } catch (e: any) {
                    console.log(`[download-file ${id.slice(0, 8)}] response broke after ${relayed}B: ${e?.message}`);
                    if (!dead) {
                        dead = true;
                        setProgress(id, { stage: 'error', error: e?.message ?? 'stream failed' });
                        try {
                            controller.error(e);
                        } catch {}
                    }
                }
            }
        });
        request.signal.addEventListener('abort', () => {
            console.log(`[download-file ${id.slice(0, 8)}] client aborted after ${relayed}B`);
            dead = true;
            setProgress(id, { stage: 'error', error: 'client disconnected' });
            try {
                cleanup?.();
            } catch {}
            try {
                (body as any)?.destroy?.();
            } catch {}
        });
        return new NextResponse(tee, { headers });
    } catch (e: any) {
        const jid = new URL(request.url).searchParams.get('job') ?? '';
        if (jid) setProgress(jid, { stage: 'error', error: e?.message ?? 'download failed' });
        return apiError(e, 502);
    }
}
