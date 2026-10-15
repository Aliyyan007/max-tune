import { NextRequest, NextResponse } from 'next/server';
import { getProgress, setProgress } from '@/lib/server-download';
import { apiError } from '@/lib/platforms';

export const runtime = 'nodejs';

// Client polls this while a download job runs: reports which stage the server
// is in (resolving → downloading → processing/sending → done) plus byte counts.
export async function GET(request: NextRequest) {
    try {
        const id = new URL(request.url).searchParams.get('id') ?? '';
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
        if (id) setProgress(id, { cancelled: true });
        return NextResponse.json({ success: true });
    } catch (e: any) {
        return apiError(e);
    }
}
