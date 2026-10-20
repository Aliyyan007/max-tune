// Upstash-backed job queue — plain REST calls (no redis client dep), so this
// also works from edge/serverless contexts. When env is absent every helper
// reports disabled and callers keep the in-process path.
const UPSTASH_URL = process.env.UPSTASH_REDIS_URL?.replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_TOKEN;

export const queueEnabled = () => !!(UPSTASH_URL && UPSTASH_TOKEN);

async function cmd(...args: (string | number)[]): Promise<any> {
    const r = await fetch(`${UPSTASH_URL}/${args.map((a) => encodeURIComponent(String(a))).join('/')}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`upstash ${args[0]}: ${r.status} ${JSON.stringify(j)}`);
    return j?.result;
}

// ---------------- queues ----------------
// Capability routing: apple jobs need a wrapper-adjacent worker; everything
// else is generic. Two lists keep it explicit — a worker's caps decide which
// it polls (apple-capable workers poll both, apple first).
export const QUEUE_GENERIC = 'q:dl:generic';
export const QUEUE_APPLE = 'q:dl:apple';

export function queueFor(source: string): string {
    return source === 'apple' || source === 'apple-native' ? QUEUE_APPLE : QUEUE_GENERIC;
}

export async function enqueueJob(id: string, specJson: string, source: string): Promise<void> {
    await cmd('HSET', `job:${id}`, 'spec', specJson, 'stage', 'queued', 'at', Date.now());
    await cmd('EXPIRE', `job:${id}`, 3600);
    await cmd('LPUSH', queueFor(source), id);
}

// caps: ['generic'] | ['apple'] | ['generic','apple'] — returns a job id or null.
// Inflight lease: a claimed job lands in `inflight` (ZSET scored by claim time);
// a worker that dies mid-job strands it — jobs stale >120s get requeued on the
// next dequeue, and workers only hold their claim while actually running.
const INFLIGHT = 'q:dl:inflight';
const CLAIM_STALE_MS = 120_000;

async function requeueStale(caps: string[]): Promise<void> {
    const stale = (await cmd('ZRANGEBYSCORE', INFLIGHT, 0, Date.now() - CLAIM_STALE_MS)) ?? [];
    for (const id of stale) {
        const job = await jobGet(String(id));
        const source = job?.spec ? (JSON.parse(job.spec).source ?? '') : '';
        const q = queueFor(source);
        // only requeue what this worker can serve; leave apple jobs for apple-capable workers
        if ((q === QUEUE_APPLE && !caps.includes('apple')) || (q === QUEUE_GENERIC && !caps.includes('generic'))) continue;
        await cmd('LPUSH', q, String(id));
        await jobSet(String(id), { stage: 'queued' });
        await cmd('ZREM', INFLIGHT, String(id));
    }
}

export async function dequeueJob(caps: string[]): Promise<string | null> {
    await requeueStale(caps).catch(() => {});
    for (const cap of ['apple', 'generic']) {
        if (!caps.includes(cap)) continue;
        const id = await cmd('RPOP', cap === 'apple' ? QUEUE_APPLE : QUEUE_GENERIC);
        if (id) {
            await cmd('ZADD', INFLIGHT, Date.now(), String(id));
            return String(id);
        }
    }
    return null;
}

// Call when a job reaches a terminal state (done/error) — clears the lease.
export async function jobDone(id: string): Promise<void> {
    await cmd('ZREM', INFLIGHT, String(id));
}

// ---------------- job state ----------------
export interface RemoteJob {
    spec?: string;
    stage?: string;
    received?: string;
    sent?: string;
    total?: string;
    label?: string;
    error?: string;
    resultUrl?: string;
    resultExt?: string;
    resultName?: string;
    cancelled?: string;
    taken?: string;
    at?: string;
}

export async function jobSet(id: string, fields: Record<string, string | number>): Promise<void> {
    const flat: (string | number)[] = [];
    for (const [k, v] of Object.entries(fields)) flat.push(k, v);
    await cmd('HSET', `job:${id}`, ...flat);
    await cmd('EXPIRE', `job:${id}`, 3600);
}

export async function jobGet(id: string): Promise<RemoteJob | null> {
    const arr = await cmd('HGETALL', `job:${id}`);
    if (!arr || !arr.length) return null;
    const out: Record<string, string> = {};
    for (let i = 0; i < arr.length; i += 2) out[String(arr[i])] = String(arr[i + 1]);
    return out as RemoteJob;
}

// ---------------- cache index (shared with download-cache) ----------------
// `cache:index` — ZSET member=object-key score=lastAccess; `cache:total` — INT bytes.
export async function cacheTouch(key: string): Promise<void> {
    await cmd('ZADD', 'cache:index', Date.now(), key);
}

export async function cacheAddBytes(n: number): Promise<number> {
    return Number(await cmd('INCRBY', 'cache:total', n));
}

export async function cacheSubBytes(n: number): Promise<number> {
    return Number(await cmd('INCRBY', 'cache:total', -n));
}

export async function cacheTotal(): Promise<number> {
    return Number((await cmd('GET', 'cache:total')) ?? 0);
}

export async function cacheMetaSet(key: string, size: number): Promise<void> {
    await cmd('HSET', `cache:meta:${key}`, 'size', size);
}

export async function cacheMetaGet(key: string): Promise<number> {
    return Number((await cmd('HGET', `cache:meta:${key}`, 'size')) ?? 0);
}

export async function cacheMetaDel(key: string): Promise<void> {
    await cmd('DEL', `cache:meta:${key}`);
}

// Oldest N members of the LRU index.
export async function cacheOldest(n: number): Promise<string[]> {
    return (await cmd('ZRANGE', 'cache:index', 0, n - 1)) ?? [];
}

export async function cacheIndexDel(key: string): Promise<void> {
    await cmd('ZREM', 'cache:index', key);
}
