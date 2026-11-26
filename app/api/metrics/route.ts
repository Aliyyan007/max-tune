import { NextRequest, NextResponse } from 'next/server';
import { jobStats } from '@/lib/server-download';
import { queueEnabled, queueDepths, jobCounters, cacheTotal, cmd } from '@/lib/queue';
import { cacheEnabled } from '@/lib/download-cache';

export const runtime = 'nodejs';

function objectFromHash(result: any): Record<string, any> {
    const out: Record<string, any> = {};
    if (Array.isArray(result)) {
        for (let i = 0; i + 1 < result.length; i += 2) out[String(result[i])] = result[i + 1];
    }
    return out;
}

// Aggregate operational metrics. Values are counts and timestamps only — no
// provider tokens, job payloads, signed URLs, or user credentials are exposed.
export async function GET(request: NextRequest) {
    const requiredToken = process.env.METRICS_TOKEN;
    if (requiredToken && request.headers.get('authorization') !== `Bearer ${requiredToken}`) {
        return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
    }
    const q = queueEnabled();
    const [depths, counters, workersRaw, cacheBytes] = q
        ? await Promise.all([
              queueDepths().catch(() => ({})),
              jobCounters().catch(() => ({})),
              cmd('HGETALL', 'workers').catch(() => []),
              cacheTotal().catch(() => 0)
          ])
        : [{}, {}, [], 0];
    const now = Date.now();
    const workerEntries = Object.entries(objectFromHash(workersRaw))
        .map(([key, v]) => {
            try {
                return { key, worker: JSON.parse(String(v)) };
            } catch {
                return { key, worker: null };
            }
        })
        .filter((x) => !!x.worker);
    // Ephemeral workers otherwise accumulate forever in the registry. Keep a
    // day of history for debugging, prune older heartbeat entries on reads.
    const pruneKeys = workerEntries.filter((x) => !x.worker.at || now - Number(x.worker.at) > 24 * 3600_000).map((x) => x.key);
    if (q && pruneKeys.length) void cmd('HDEL', 'workers', ...pruneKeys).catch(() => {});
    const workers = workerEntries
        .filter((x) => !pruneKeys.includes(x.key))
        .map(({ worker: w }) => ({
            id: String(w.id ?? '').slice(0, 24),
            caps: w.caps,
            active: w.active,
            concurrency: w.concurrency,
            uptime: w.uptime,
            completed: w.metrics?.completed ?? 0,
            failed: w.metrics?.failed ?? 0,
            retried: w.metrics?.retried ?? 0,
            stale: !w.at || now - Number(w.at) > 60_000
        }));
    const mem = process.memoryUsage();
    return NextResponse.json(
        {
            success: true,
            data: {
                web: {
                    uptimeSec: Math.round(process.uptime()),
                    memoryMB: Math.round(mem.rss / 1048576),
                    localJobs: jobStats()
                },
                mode: q ? 'queue' : 'local',
                queue: depths,
                counters,
                workers,
                artifactStore: { type: cacheEnabled() ? 'r2' : q ? 'inline-dev' : 'local-stream', trackedBytes: cacheBytes }
            }
        },
        { headers: { 'Cache-Control': 'no-store' } }
    );
}
