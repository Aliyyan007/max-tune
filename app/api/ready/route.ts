import { NextResponse } from 'next/server';
import { queueEnabled, queueDepths } from '@/lib/queue';
import { cacheEnabled } from '@/lib/download-cache';

export const runtime = 'nodejs';

// Readiness is stricter than liveness: in queue mode the web must be able to
// reach Redis, and production artifact delivery should have object storage.
// Inline Redis results are accepted only when explicitly enabled for development.
export async function GET() {
    const q = queueEnabled();
    const depths = q ? await queueDepths().catch(() => null) : {};
    const redisOk = !q || depths !== null;
    const inlineOk = process.env.ALLOW_INLINE_RESULTS === '1' || process.env.NODE_ENV !== 'production';
    const artifactsOk = !q || cacheEnabled() || inlineOk;
    const ok = redisOk && artifactsOk;
    return NextResponse.json(
        {
            success: ok,
            data: {
                ok,
                redis: redisOk,
                artifactStore: cacheEnabled() ? 'r2' : q ? (inlineOk ? 'inline-dev' : 'missing') : 'local-stream',
                mode: q ? 'queue' : 'local'
            }
        },
        { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } }
    );
}
