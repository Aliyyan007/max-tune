// Small fixed-window rate limiter for unauthenticated job-creation endpoints.
// Redis makes the limit shared across web replicas in queue mode; memory is the
// single-process development fallback.
import { cmd, queueEnabled } from './queue';

const memory = ((globalThis as any).__rateLimits ??= new Map<string, { count: number; resetAt: number }>()) as Map<string, { count: number; resetAt: number }>;

const LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local n = redis.call('INCR', key)
if n == 1 then redis.call('EXPIRE', key, window) end
if n > limit then return 0 end
return 1
`;

export async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
    if (queueEnabled()) {
        try {
            return Number(await cmd('EVAL', LUA, 1, `rl:${key}`, limit, windowSec)) === 1;
        } catch {
            // Fail open on a Redis control-plane blip rather than making every
            // download unavailable; the job queue itself already depends on Redis.
            return true;
        }
    }
    const now = Date.now();
    const r = memory.get(key) ?? { count: 0, resetAt: now + windowSec * 1000 };
    if (now > r.resetAt) {
        r.count = 0;
        r.resetAt = now + windowSec * 1000;
    }
    r.count++;
    memory.set(key, r);
    if (memory.size > 5000) {
        for (const [k, v] of memory) if (v.resetAt < now) memory.delete(k);
    }
    return r.count <= limit;
}

export async function rateLimitReset(key: string): Promise<void> {
    if (queueEnabled()) {
        await cmd('DEL', `rl:${key}`).catch(() => {});
        return;
    }
    memory.delete(key);
}

export function clientIp(headers: Headers): string {
    // Use the rightmost XFF hop: clients can prepend arbitrary entries to the
    // left side, while the edge/proxy closest to the server appends the peer it
    // actually observed. This is abuse-resistant on Render/Cloudflare-style
    // ingress; x-real-ip remains the single-proxy fallback.
    const xff = headers.get('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean);
    return xff?.length ? xff[xff.length - 1] : headers.get('x-real-ip') || 'local';
}
