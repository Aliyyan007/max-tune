// Upstash/Redis-backed durable job queue.
//
// Design notes:
// - job state lives in `job:<id>` hashes; queues contain only ids
// - claiming and stale recovery are Lua scripts so a worker crash cannot strand
//   or duplicate the same state transition (at-least-once delivery remains, but
//   concurrent processors cannot both claim one queued id)
// - workers hold short leases in `q:dl:inflight`; heartbeats extend them and
//   expired leases are atomically requeued
// - payloads/results may be AES-GCM encrypted at rest when
//   JOB_PAYLOAD_ENCRYPTION_KEY is configured (provider tokens are carried in
//   DownloadSpec.tokens for compatibility, so this matters operationally)
import crypto from 'crypto';

const UPSTASH_URL = (process.env.UPSTASH_REDIS_URL ?? '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_TOKEN ?? '';

export const QUEUE_GENERIC = 'q:dl:generic';
export const QUEUE_APPLE = 'q:dl:apple';
export const INFLIGHT = 'q:dl:inflight';
export const DELAYED = 'q:dl:delayed';
export const LEASE_MS = Number(process.env.JOB_LEASE_MS ?? 120_000);

export function queueEnabled() {
    return !!(UPSTASH_URL && UPSTASH_TOKEN);
}

export function queueFor(source: string): string {
    return source === 'apple' || source === 'apple-native' ? QUEUE_APPLE : QUEUE_GENERIC;
}

async function commandOnce(args: (string | number)[], transport: 'post' | 'get'): Promise<any> {
    const headers: Record<string, string> = { Authorization: `Bearer ${UPSTASH_TOKEN}` };
    let res: Response;
    if (transport === 'post') {
        headers['Content-Type'] = 'application/json';
        res = await fetch(UPSTASH_URL, { method: 'POST', headers, body: JSON.stringify(args.map(String)) });
    } else {
        const path = args.map((a) => encodeURIComponent(String(a))).join('/');
        res = await fetch(`${UPSTASH_URL}/${path}`, { headers });
    }
    const text = await res.text();
    let data: any = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null;
    }
    if (!res.ok) {
        const err: any = new Error(data?.error ?? `upstash ${res.status}: ${text.slice(0, 160)}`);
        err.status = res.status;
        throw err;
    }
    if (data?.error) throw new Error(data.error);
    return data?.result;
}

// Low-level command helper. POST keeps long Lua scripts/payloads out of URLs;
// GET is retained as a compatibility fallback for older REST proxies.
export async function cmd(...args: (string | number)[]): Promise<any> {
    if (!queueEnabled()) throw new Error('queue not configured');
    let last: any;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            try {
                return await commandOnce(args, 'post');
            } catch (e: any) {
                if (![404, 405, 414].includes(Number(e?.status))) throw e;
                return await commandOnce(args, 'get');
            }
        } catch (e: any) {
            last = e;
            const status = Number(e?.status ?? 0);
            const retriable = !status || status >= 500 || /ECONNRESET|ETIMEDOUT|fetch failed|socket/i.test(String(e?.message ?? ''));
            if (!retriable || attempt === 2) throw e;
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        }
    }
    throw last;
}

// ---------------- optional payload encryption ----------------
const ENC_KEY = process.env.JOB_PAYLOAD_ENCRYPTION_KEY
    ? crypto.createHash('sha256').update(String(process.env.JOB_PAYLOAD_ENCRYPTION_KEY)).digest()
    : null;

function encryptText(s: string): string {
    if (!ENC_KEY) return s;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
    const data = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

function decryptText(s: string): string {
    if (!s.startsWith('enc1:')) return s;
    if (!ENC_KEY) throw new Error('encrypted job payload present but JOB_PAYLOAD_ENCRYPTION_KEY is not configured');
    const [, ivb, tagb, datab] = s.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivb, 'base64'));
    decipher.setAuthTag(Buffer.from(tagb, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(datab, 'base64')), decipher.final()]).toString('utf8');
}

const SENSITIVE_FIELDS = new Set(['payload', 'resultJson', 'resultUrl']);
function encodeField(key: string, value: any): string {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    // Errors are public diagnostics after credential/URL scrubbing. Keeping them
    // unencrypted lets users see an actionable configuration error even when a
    // deployment accidentally runs web and worker with mismatched payload keys.
    if (key === 'error') return publicErrorMessage(raw) ?? '';
    return ENC_KEY && SENSITIVE_FIELDS.has(key) ? encryptText(raw) : raw;
}
function decodeField(key: string, value: string): any {
    const raw = SENSITIVE_FIELDS.has(key) ? decryptText(value) : value;
    if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
        try {
            return JSON.parse(raw);
        } catch {}
    }
    return raw;
}

function flattenFields(fields: Record<string, any>): (string | number)[] {
    const flat: (string | number)[] = [];
    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === null) continue;
        flat.push(k, encodeField(k, v));
    }
    return flat;
}

// ---------------- job state ----------------
export async function jobSet(id: string, fields: Record<string, any>): Promise<void> {
    if (!queueEnabled()) return;
    const flat = flattenFields(fields);
    flat.push('at', Date.now());
    if (flat.length) await cmd('HSET', `job:${id}`, ...flat);
}

// Jobs normally receive their TTL in enqueueJob. Cache-hit jobs are born in a
// terminal state through jobSet instead, so routes must still expire them —
// otherwise every cache hit leaves a permanent Redis hash.
export async function jobExpire(id: string, seconds = 24 * 3600): Promise<void> {
    if (!queueEnabled()) return;
    await cmd('EXPIRE', `job:${id}`, seconds).catch(() => {});
}

function hashArrayToObject(arr: any): Record<string, any> {
    const out: Record<string, any> = {};
    if (Array.isArray(arr)) {
        for (let i = 0; i + 1 < arr.length; i += 2) out[String(arr[i])] = arr[i + 1];
    } else if (arr && typeof arr === 'object') {
        Object.assign(out, arr);
    }
    return out;
}

export async function jobGet(id: string): Promise<Record<string, any> | null> {
    if (!queueEnabled()) return null;
    const arr = await cmd('HGETALL', `job:${id}`);
    const raw = hashArrayToObject(arr);
    if (!Object.keys(raw).length) return null;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v !== 'string') {
            out[k] = v;
            continue;
        }
        try {
            out[k] = decodeField(k, v);
        } catch (e: any) {
            out[k] = `<undecodable:${e?.message ?? 'error'}>`;
        }
    }
    return out;
}

// Public queue-status views must not leak payloads, tokens, signed URLs, or
// credential-adjacent errors back to arbitrary browsers.
export function publicErrorMessage(error: unknown): string | undefined {
    if (error == null) return undefined;
    return String(error)
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
        .replace(/(media-user-token|access_token|refresh_token|id_token|client_secret|password|authorization|deviceId|customerId|requestId|request-id)["'\s:=]+[^,\s}\]"']+/gi, '$1=<redacted>')
        .replace(/(https?:\/\/[^\s?)]+)\?[^\s)]+/gi, '$1?<redacted>')
        .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '<redacted>')
        .slice(0, 300);
}

export function publicJobView(j: Record<string, any>): Record<string, any> {
    const {
        payload: _payload,
        resultJson: _resultJson,
        resultUrl: _resultUrl,
        resultB64: _resultB64,
        worker,
        ...safe
    } = j;
    return { ...safe, error: publicErrorMessage(safe.error), worker: worker ? String(worker).slice(0, 12) : undefined };
}

export async function enqueueJob(id: string, payload: string | object, source: string, kind: 'track' | 'zip' = 'track'): Promise<string> {
    const queue = queueFor(source);
    const rawPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
    await cmd(
        'HSET', `job:${id}`,
        'state', 'queued',
        'stage', 'queued',
        'kind', kind,
        'source', source,
        'queue', queue,
        'payload', encodeField('payload', rawPayload),
        'createdAt', Date.now(),
        'at', Date.now(),
        'attempt', 0,
        'received', 0,
        'sent', 0
    );
    await cmd('LPUSH', queue, id);
    await cmd('HINCRBY', 'stats:jobs', 'enqueued', 1).catch(() => {});
    await cmd('EXPIRE', `job:${id}`, 24 * 3600).catch(() => {});
    return queue;
}

const CLAIM_LUA = `
local q = KEYS[1]
local inflight = KEYS[2]
local worker = ARGV[1]
local now = tonumber(ARGV[2])
local lease = tonumber(ARGV[3])
local id = redis.call('RPOP', q)
if not id then return nil end
local key = 'job:' .. id
if redis.call('EXISTS', key) == 0 then
  redis.call('ZREM', inflight, id)
  return {id, 'missing'}
end
local state = redis.call('HGET', key, 'state') or ''
if state ~= 'queued' then
  return {id, 'skipped'}
end
local notbefore = tonumber(redis.call('HGET', key, 'retryNotBefore') or '0') or 0
if notbefore > now then
  redis.call('ZADD', 'q:dl:delayed', notbefore, id)
  return {id, 'delayed'}
end
local seq = redis.call('INCR', 'q:dl:claimseq')
local token = worker .. ':' .. seq
redis.call('HSET', key,
  'state', 'processing',
  'stage', 'resolving',
  'worker', worker,
  'claimToken', token,
  'startedAt', now,
  'leaseUntil', now + lease,
  'at', now
)
redis.call('HINCRBY', key, 'attempt', 1)
redis.call('ZADD', inflight, now, id)
redis.call('HINCRBY', 'stats:jobs', 'claimed', 1)
return {id, 'claimed', token}
`;

async function evalScript(script: string, keys: (string | number)[], args: (string | number)[]): Promise<any> {
    return cmd('EVAL', script, keys.length, ...keys, ...args);
}

const RECOVER_LUA = `
local q = KEYS[1]
local inflight = KEYS[2]
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local ids = redis.call('ZRANGEBYSCORE', inflight, '-inf', now, 'LIMIT', 0, limit)
local recovered = 0
for _, id in ipairs(ids) do
  local key = 'job:' .. id
  local state = redis.call('HGET', key, 'state') or ''
  local lease = tonumber(redis.call('HGET', key, 'leaseUntil') or '0') or 0
  if state == 'processing' and lease <= now then
    local cancelled = redis.call('HGET', key, 'cancelRequested') or ''
    local attempt = tonumber(redis.call('HGET', key, 'attempt') or '1') or 1
    local maxAttempts = tonumber(ARGV[3]) or 3
    if cancelled == '1' or cancelled == 'true' then
      redis.call('HSET', key,
        'state', 'error',
        'stage', 'error',
        'error', 'cancelled',
        'errorKind', 'cancelled',
        'worker', '',
        'leaseUntil', 0,
        'finishedAt', now,
        'at', now
      )
      redis.call('ZREM', inflight, id)
      redis.call('HINCRBY', 'stats:jobs', 'failed', 1)
    elseif attempt >= maxAttempts then
      redis.call('HSET', key,
        'state', 'error',
        'stage', 'error',
        'error', 'worker stopped repeatedly before producing the artifact',
        'errorKind', 'tool',
        'worker', '',
        'leaseUntil', 0,
        'finishedAt', now,
        'at', now
      )
      redis.call('ZREM', inflight, id)
      redis.call('HINCRBY', 'stats:jobs', 'failed', 1)
    else
      redis.call('HSET', key,
        'state', 'queued',
        'stage', 'queued',
        'worker', '',
        'leaseUntil', 0,
        'requeuedAt', now,
        'at', now
      )
      redis.call('HINCRBY', key, 'requeueCount', 1)
      local jobq = redis.call('HGET', key, 'queue') or q
      redis.call('ZREM', inflight, id)
      redis.call('LPUSH', jobq, id)
      redis.call('HINCRBY', 'stats:jobs', 'requeued', 1)
    end
    recovered = recovered + 1
  elseif state ~= 'processing' then
    redis.call('ZREM', inflight, id)
  end
end
return recovered
`;

export async function recoverStaleJobs(queue: string, limit = 20, maxAttempts = Number(process.env.JOB_MAX_ATTEMPTS ?? 3)): Promise<number> {
    if (!queueEnabled()) return 0;
    return Number((await evalScript(RECOVER_LUA, [queue, INFLIGHT], [Date.now(), limit, maxAttempts])) ?? 0);
}

const RECOVER_DELAYED_LUA = `
local delayed = KEYS[1]
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local ids = redis.call('ZRANGEBYSCORE', delayed, '-inf', now, 'LIMIT', 0, limit)
local moved = 0
for _, id in ipairs(ids) do
  local key = 'job:' .. id
  local state = redis.call('HGET', key, 'state') or ''
  local q = redis.call('HGET', key, 'queue') or 'q:dl:generic'
  redis.call('ZREM', delayed, id)
  if state == 'queued' then
    redis.call('LPUSH', q, id)
    moved = moved + 1
  end
end
return moved
`;

export async function recoverDelayedJobs(limit = 50): Promise<number> {
    if (!queueEnabled()) return 0;
    return Number((await evalScript(RECOVER_DELAYED_LUA, [DELAYED], [Date.now(), limit]).catch(() => 0)) ?? 0);
}

// Poll queues in priority order. Returns the decrypted payload plus claim metadata.
export type JobClaim = { id: string; payload: any; kind: string; attempt: number; queue: string; token: string };

export async function dequeueJob(queues: string[], workerId: string, leaseMs = LEASE_MS): Promise<JobClaim | null> {
    if (!queueEnabled()) return null;
    await recoverDelayedJobs().catch(() => 0);
    for (const q of queues) {
        await recoverStaleJobs(q, 10).catch(() => 0);
        // a skipped id can sit ahead of valid work after a previous crash — keep
        // popping until the queue is empty or a real claim is made
        for (let spins = 0; spins < 10; spins++) {
            const res = await evalScript(CLAIM_LUA, [q, INFLIGHT], [workerId, Date.now(), leaseMs]);
            if (!res) break;
            const [id, status, token] = res as [string, string, string?];
            if (status !== 'claimed') continue;
            const j = await jobGet(id);
            if (!j?.payload) {
                await jobDone(id, false, { error: 'claimed job payload missing' }, token);
                continue;
            }
            let payload = j.payload;
            if (typeof payload === 'string' && payload.startsWith('<undecodable:')) {
                await jobDone(id, false, {
                    error: 'deployment configuration error: the web service and worker are using different JOB_PAYLOAD_ENCRYPTION_KEY values. Remove service-level overrides or copy the exact shared key to both services, redeploy them, and retry with a new download.'
                }, token);
                continue;
            }
            if (typeof payload === 'string') {
                try {
                    payload = JSON.parse(payload);
                } catch {
                    await jobDone(id, false, { error: 'job payload is not valid JSON' }, token);
                    continue;
                }
            }
            return { id, payload, kind: String(j.kind ?? 'track'), attempt: Number(j.attempt ?? 1), queue: q, token: String(token ?? '') };
        }
    }
    return null;
}

const TOUCH_LUA = `
local inflight = KEYS[1]
local id = ARGV[1]
local worker = ARGV[2]
local now = tonumber(ARGV[3])
local lease = tonumber(ARGV[4])
local key = 'job:' .. id
local token = ARGV[5]
local state = redis.call('HGET', key, 'state') or ''
if state ~= 'processing' then return 0 end
if redis.call('ZSCORE', inflight, id) == false then return 0 end
if redis.call('HGET', key, 'worker') ~= worker then return 0 end
if token ~= '' and redis.call('HGET', key, 'claimToken') ~= token then return 0 end
redis.call('ZADD', inflight, now, id)
redis.call('HSET', key, 'leaseUntil', now + lease, 'heartbeatAt', now, 'at', now)
return 1
`;

export async function touchInflight(id: string, workerId: string, leaseMs = LEASE_MS, token = ''): Promise<boolean> {
    if (!queueEnabled()) return false;
    return Number(await evalScript(TOUCH_LUA, [INFLIGHT], [id, workerId, Date.now(), leaseMs, token])) === 1;
}

const TERMINAL_LUA = `
local inflight = KEYS[1]
local id = ARGV[1]
local token = ARGV[2]
local ok = ARGV[3]
local key = 'job:' .. id
if redis.call('HGET', key, 'claimToken') ~= token then return 0 end
for i = 5, #ARGV, 2 do
  redis.call('HSET', key, ARGV[i], ARGV[i + 1])
end
redis.call('ZREM', inflight, id)
if ok == '1' then
  redis.call('HINCRBY', 'stats:jobs', 'completed', 1)
else
  redis.call('HINCRBY', 'stats:jobs', 'failed', 1)
end
redis.call('EXPIRE', key, 86400)
return 1
`;

export async function jobDone(id: string, ok: boolean, fields: Record<string, any> = {}, token?: string): Promise<void> {
    if (!queueEnabled()) return;
    const now = Date.now();
    const flat = flattenFields({
        ...fields,
        state: ok ? 'done' : 'error',
        stage: ok ? 'done' : 'error',
        finishedAt: now,
        leaseUntil: 0,
        at: now
    });
    if (token) {
        const wrote = Number(await evalScript(TERMINAL_LUA, [INFLIGHT], [id, token, ok ? '1' : '0', now, ...flat]));
        if (wrote !== 1) throw new Error('job lease lost before terminal write');
        return;
    }
    // Compatibility path for administrative/test writers that do not own a claim.
    // Workers always pass the fencing token; this branch is not used for leased jobs.
    await cmd('HSET', `job:${id}`, ...flat);
    await cmd('ZREM', INFLIGHT, id).catch(() => {});
    await cmd('HINCRBY', 'stats:jobs', ok ? 'completed' : 'failed', 1).catch(() => {});
    await cmd('EXPIRE', `job:${id}`, 24 * 3600).catch(() => {});
}

const CANCEL_LUA = `
local id = ARGV[1]
local now = tonumber(ARGV[2])
local key = 'job:' .. id
local state = redis.call('HGET', key, 'state') or ''
if state == 'queued' then
  local q = redis.call('HGET', key, 'queue') or 'q:dl:generic'
  redis.call('LREM', q, 1, id)
  redis.call('ZREM', 'q:dl:delayed', id)
  redis.call('ZREM', 'q:dl:inflight', id)
  redis.call('HSET', key,
    'cancelRequested', '1', 'cancelled', '1',
    'state', 'error', 'stage', 'error', 'error', 'cancelled', 'errorKind', 'cancelled',
    'finishedAt', now, 'leaseUntil', 0, 'at', now
  )
  redis.call('HINCRBY', 'stats:jobs', 'failed', 1)
  redis.call('HINCRBY', 'stats:jobs', 'cancelled', 1)
  return 1
elseif state == 'processing' then
  redis.call('HSET', key, 'cancelRequested', '1', 'cancelled', '1', 'at', now)
  redis.call('HINCRBY', 'stats:jobs', 'cancelRequests', 1)
  return 2
end
return 0
`;

export async function requestCancel(id: string): Promise<void> {
    if (!queueEnabled()) return;
    await evalScript(CANCEL_LUA, [], [id, Date.now()]).catch(() => {});
}

export function cancelRequested(j: Record<string, any> | null | undefined): boolean {
    return j?.cancelRequested === '1' || j?.cancelRequested === 'true' || j?.cancelled === '1' || j?.cancelled === 'true';
}

const RETRY_LUA = `
local inflight = KEYS[1]
local delayed = KEYS[2]
local id = ARGV[1]
local token = ARGV[2]
local err = ARGV[3]
local now = tonumber(ARGV[4])
local notbefore = tonumber(ARGV[5])
local delay = tonumber(ARGV[6])
local key = 'job:' .. id
if redis.call('HGET', key, 'claimToken') ~= token then return 0 end
local q = redis.call('HGET', key, 'queue') or 'q:dl:generic'
redis.call('HSET', key,
  'state', 'queued', 'stage', 'queued', 'error', err,
  'retryNotBefore', notbefore, 'leaseUntil', 0, 'worker', '', 'at', now
)
redis.call('ZREM', inflight, id)
redis.call('ZREM', delayed, id)
if delay > 0 then
  redis.call('ZADD', delayed, notbefore, id)
else
  redis.call('LPUSH', q, id)
end
redis.call('HINCRBY', 'stats:jobs', 'retried', 1)
return 1
`;

export async function retryJob(id: string, error: string, delayMs = 0, token?: string): Promise<void> {
    // Delayed retry is represented as a normal requeue plus retryNotBefore; the
    // worker polls frequently enough that sub-minute precision is not critical.
    const now = Date.now();
    if (token) {
        const wrote = Number(await evalScript(
            RETRY_LUA,
            [INFLIGHT, DELAYED],
            [id, token, encodeField('error', error), now, now + delayMs, delayMs]
        ));
        if (wrote !== 1) throw new Error('job lease lost before retry write');
        return;
    }
    await jobSet(id, {
        state: 'queued',
        stage: 'queued',
        error,
        retryNotBefore: now + delayMs,
        leaseUntil: 0,
        worker: ''
    });
    await cmd('ZREM', INFLIGHT, id).catch(() => {});
    const j = await jobGet(id).catch(() => null);
    if (delayMs > 0) await cmd('ZADD', DELAYED, now + delayMs, id).catch(() => {});
    else await cmd('LPUSH', String(j?.queue ?? QUEUE_GENERIC), id).catch(() => {});
    await cmd('HINCRBY', 'stats:jobs', 'retried', 1).catch(() => {});
}

const QUEUE_POSITION_LUA = `
local q = KEYS[1]
local id = ARGV[1]
local idx = redis.call('LPOS', q, id)
if not idx then return nil end
local len = redis.call('LLEN', q)
return len - idx
`;

export async function queuePosition(id: string, queue: string): Promise<number | undefined> {
    if (!queueEnabled() || !queue) return undefined;
    const n = await evalScript(QUEUE_POSITION_LUA, [queue], [id]).catch(() => null);
    return n == null ? undefined : Number(n);
}

export async function queueDepths(): Promise<Record<string, number>> {
    if (!queueEnabled()) return {};
    const [generic, apple, inflight] = await Promise.all([
        cmd('LLEN', QUEUE_GENERIC).catch(() => 0),
        cmd('LLEN', QUEUE_APPLE).catch(() => 0),
        cmd('ZCARD', INFLIGHT).catch(() => 0)
    ]);
    return { generic: Number(generic ?? 0), apple: Number(apple ?? 0), inflight: Number(inflight ?? 0) };
}

export async function jobCounters(): Promise<Record<string, number>> {
    if (!queueEnabled()) return {};
    const raw = hashArrayToObject(await cmd('HGETALL', 'stats:jobs').catch(() => []));
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = Number(v ?? 0) || 0;
    return out;
}

// ---------------- generic server-side KV bridge ----------------
// Settings/session data use these keys so web and worker processes share state
// even though their local disks are private and ephemeral.
export async function kvGet(key: string): Promise<string | null> {
    if (!queueEnabled()) return null;
    const v = await cmd('GET', key);
    if (typeof v !== 'string') return v == null ? null : String(v);
    try {
        return decryptText(v);
    } catch {
        return null;
    }
}

export async function kvSet(key: string, value: string): Promise<void> {
    if (!queueEnabled()) return;
    await cmd('SET', key, encryptText(value));
}

export async function kvDel(key: string): Promise<void> {
    if (!queueEnabled()) return;
    await cmd('DEL', key);
}

// ---------------- cache index helpers ----------------
const CACHE_INDEX = 'cache:index';
const CACHE_TOTAL = 'cache:total';
const CACHE_META = (key: string) => `cache:meta:${key}`;

export async function cacheTouch(objectKey: string): Promise<void> {
    if (!queueEnabled()) return;
    await cmd('ZADD', CACHE_INDEX, Date.now(), objectKey);
}

export async function cacheOldest(n: number): Promise<string[]> {
    if (!queueEnabled()) return [];
    return (await cmd('ZRANGE', CACHE_INDEX, 0, n - 1)) ?? [];
}

export async function cacheIndexDel(objectKey: string): Promise<void> {
    if (!queueEnabled()) return;
    await cmd('ZREM', CACHE_INDEX, objectKey);
}

export async function cacheMetaSet(objectKey: string, size: number, extra: Record<string, string | number> = {}): Promise<void> {
    if (!queueEnabled()) return;
    const flat: (string | number)[] = ['size', size, 'createdAt', Date.now()];
    for (const [k, v] of Object.entries(extra)) flat.push(k, v);
    await cmd('HSET', CACHE_META(objectKey), ...flat);
    await cmd('EXPIRE', CACHE_META(objectKey), 30 * 24 * 3600).catch(() => {});
}

// Atomically reserve the accounting entry for an object. Only the first
// concurrent uploader receives true, preventing duplicate byte accounting when
// two workers race to produce the same cache key.
export async function cacheMetaReserve(objectKey: string, size: number, extra: Record<string, string | number> = {}): Promise<boolean> {
    if (!queueEnabled()) return false;
    const key = CACHE_META(objectKey);
    const created = Number(await cmd('HSETNX', key, 'size', size)) === 1;
    const flat: (string | number)[] = [];
    if (created) flat.push('createdAt', Date.now());
    for (const [k, v] of Object.entries(extra)) flat.push(k, v);
    if (flat.length) await cmd('HSET', key, ...flat);
    await cmd('EXPIRE', key, 30 * 24 * 3600).catch(() => {});
    return created;
}

export async function cacheMetaGet(objectKey: string): Promise<number> {
    if (!queueEnabled()) return 0;
    return Number((await cmd('HGET', CACHE_META(objectKey), 'size')) ?? 0);
}

export async function cacheMetaDel(objectKey: string): Promise<void> {
    if (!queueEnabled()) return;
    await cmd('DEL', CACHE_META(objectKey));
}

export async function cacheAddBytes(n: number): Promise<void> {
    if (!queueEnabled()) return;
    await cmd('INCRBY', CACHE_TOTAL, n);
}

export async function cacheSubBytes(n: number): Promise<void> {
    if (!queueEnabled()) return;
    await cmd('DECRBY', CACHE_TOTAL, n);
}

export async function cacheTotal(): Promise<number> {
    if (!queueEnabled()) return 0;
    return Number((await cmd('GET', CACHE_TOTAL)) ?? 0);
}
