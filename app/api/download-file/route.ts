import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/platforms';
import { createJob, takeJob, streamTaggedTrack, setProgress, type DownloadSpec } from '@/lib/server-download';

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
        const tee = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    for await (const chunk of body as any) {
                        relayed += (chunk as Buffer).length;
                        controller.enqueue(chunk as Uint8Array);
                    }
                    controller.close();
                    setProgress(id, { stage: 'done' });
                    console.log(`[download-file ${id.slice(0, 8)}] response finished — ${relayed}B relayed`);
                } catch (e: any) {
                    console.log(`[download-file ${id.slice(0, 8)}] response broke after ${relayed}B: ${e?.message}`);
                    setProgress(id, { stage: 'error', error: e?.message ?? 'stream failed' });
                    controller.error(e);
                }
            }
        });
        request.signal.addEventListener('abort', () => {
            console.log(`[download-file ${id.slice(0, 8)}] client aborted after ${relayed}B`);
            try {
                cleanup?.();
            } catch {}
        });
        return new NextResponse(tee, { headers });
    } catch (e: any) {
        const jid = new URL(request.url).searchParams.get('job') ?? '';
        if (jid) setProgress(jid, { stage: 'error', error: e?.message ?? 'download failed' });
        return apiError(e, 502);
    }
}
