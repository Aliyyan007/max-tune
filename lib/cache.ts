// Tiny in-memory LRU + TTL cache for API responses — server-side only.
// Survives across requests via globalThis (Next dev HMR resets modules otherwise).
interface CacheEntry<T> {
    value: T;
    at: number;
    bytes: number;
}

export class ApiCache<T = any> {
    private map: Map<string, CacheEntry<T>>;
    private bytes = 0;
    constructor(
        private maxBytes: number,
        private ttlMs: number
    ) {
        this.map = new Map();
    }

    get(key: string): T | undefined {
        const e = this.map.get(key);
        if (!e) return undefined;
        if (Date.now() - e.at > this.ttlMs) {
            this.map.delete(key);
            this.bytes -= e.bytes;
            return undefined;
        }
        // LRU touch
        this.map.delete(key);
        this.map.set(key, e);
        return e.value;
    }

    set(key: string, value: T, bytes = 4096) {
        const old = this.map.get(key);
        if (old) this.bytes -= old.bytes;
        this.map.set(key, { value, at: Date.now(), bytes });
        this.bytes += bytes;
        while (this.bytes > this.maxBytes && this.map.size) {
            const oldest = this.map.keys().next().value!;
            const e = this.map.get(oldest)!;
            this.bytes -= e.bytes;
            this.map.delete(oldest);
        }
    }

    async wrap(key: string, fn: () => Promise<T>, bytes?: number): Promise<T> {
        const hit = this.get(key);
        if (hit !== undefined) return hit;
        const v = await fn();
        this.set(key, v, bytes);
        return v;
    }
}

declare global {
    var __apiCaches: Map<string, ApiCache<any>> | undefined;
}
const registry: Map<string, ApiCache<any>> = (globalThis.__apiCaches ??= new Map());

export function getCache<T = any>(name: string, maxBytes = 32 * 1024 * 1024, ttlMs = 2 * 60 * 1000): ApiCache<T> {
    let c = registry.get(name);
    if (!c) {
        c = new ApiCache<T>(maxBytes, ttlMs);
        registry.set(name, c);
    }
    return c;
}
