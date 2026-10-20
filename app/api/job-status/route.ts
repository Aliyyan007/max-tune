import { NextRequest, NextResponse } from 'next/server';
import { getProgress, setProgress } from '@/lib/server-download';
import { queueEnabled, jobGet, jobSet } from '@/lib/queue';
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
            const data = {
                stage: j.stage ?? 'queued',
                received: Number(j.received ?? 0),
                sent: Number(j.sent ?? 0),
                total: j.total ? Number(j.total) : undefined,
                label: j.label,
                error: j.error,
                cancelled: j.cancelled === '1' || j.cancelled === 'true',
                at: Number(j.at ?? Date.now())
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
            if (queueEnabled()) await jobSet(id, { cancelled: '1' });
            else setProgress(id, { cancelled: true });
        }
        return NextResponse.json({ success: true });
    } catch (e: any) {
        return apiError(e);
    }
}
