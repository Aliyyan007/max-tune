import { NextRequest, NextResponse } from 'next/server';
import { getProgress, setProgress } from '@/lib/server-download';
import { queueEnabled, jobGet, requestCancel, publicJobView, cancelRequested } from '@/lib/queue';
import { apiError } from '@/lib/platforms';

export const runtime = 'nodejs';

// Client polls this while a download job runs: reports which stage the server
// is in (resolving → downloading → processing/sending → done) plus byte counts.
// In queue mode the same shape comes from the worker-written Redis job hash.
export async function GET(request: NextRequest) {
    try {
        const id = new URL(request.url).searchParams.get('id') ?? '';
        if (queueEnabled()) {
            const j = await jobGet(id);
            if (!j) return NextResponse.json({ success: false, error: 'unknown job' }, { status: 404 });
            const safe = publicJobView(j);
            const resultMeta = j.resultJson && typeof j.resultJson === 'object' ? j.resultJson : {};
            const isPreview = resultMeta.isPreview === true || resultMeta.isPreview === '1' || resultMeta.isPreview === 'true';
            const data = {
                stage: safe.stage ?? 'queued',
                state: safe.state ?? safe.stage ?? 'queued',
                kind: safe.kind,
                received: Number(safe.received ?? 0),
                sent: Number(safe.sent ?? 0),
                total: safe.total ? Number(safe.total) : undefined,
                label: safe.label,
                error: safe.error,
                errorKind: safe.errorKind,
                attempt: safe.attempt ? Number(safe.attempt) : undefined,
                requeueCount: safe.requeueCount ? Number(safe.requeueCount) : undefined,
                worker: safe.worker,
                resultReady: safe.stage === 'done' && (!!j.resultUrl || !!j.resultB64 || !!j.resultJson),
                resultExt: safe.stage === 'done' ? safe.resultExt : undefined,
                resultName: safe.stage === 'done' ? safe.resultName : undefined,
                cacheHit: safe.cacheHit === '1' || safe.cacheHit === 'true',
                isPreview: safe.stage === 'done' ? isPreview : undefined,
                previewDuration: safe.stage === 'done' && isPreview && resultMeta.previewDuration ? Number(resultMeta.previewDuration) : undefined,
                containsPreviews: safe.stage === 'done' && resultMeta.containsPreviews ? true : undefined,
                previewCount: safe.stage === 'done' && resultMeta.previewCount ? Number(resultMeta.previewCount) : undefined,
                cancelled: cancelRequested(safe),
                at: Number(safe.at ?? Date.now())
            };
            return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
        }
        const p = getProgress(id);
        if (!p) return NextResponse.json({ success: false, error: 'unknown job' }, { status: 404 });
        return NextResponse.json({ success: true, data: p }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (e: any) {
        return apiError(e);
    }
}

// Cancel — the running producer checks the flag per-chunk and dies.
export async function POST(request: NextRequest) {
    try {
        const { id } = await request.json();
        if (id) {
            if (queueEnabled()) await requestCancel(id);
            else setProgress(id, { cancelled: true });
        }
        return NextResponse.json({ success: true });
    } catch (e: any) {
        return apiError(e);
    }
}
