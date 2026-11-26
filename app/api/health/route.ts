import { NextResponse } from 'next/server';
import { queueEnabled, queueDepths } from '@/lib/queue';
import { cacheEnabled } from '@/lib/download-cache';

export const runtime = 'nodejs';

// Cheap liveness endpoint for load balancers and uptime checks. No provider
// calls are made here — deep platform capability belongs to /api/platform-health.
export async function GET() {
    const depths = queueEnabled() ? await queueDepths().catch(() => ({})) : {};
    return NextResponse.json(
        {
            success: true,
            data: {
                ok: true,
                uptimeSec: Math.round(process.uptime()),
                mode: queueEnabled() ? 'queue' : 'local',
                queue: depths,
                artifactStore: cacheEnabled() ? 'r2' : queueEnabled() ? 'inline-dev' : 'local-stream'
            }
        },
        { headers: { 'Cache-Control': 'no-store' } }
    );
}
