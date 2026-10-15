// Server-side credential pool: admin-managed tokens per platform with
// round-robin rotation + health tracking. Lives in data/token-pool.json so it
// survives restarts locally; on hosts, env vars act as the immutable fallback.
import fs from 'fs';
import path from 'path';

export interface PoolEntry {
    token: string; // full value — never leaves the server
    label?: string;
    addedAt: number;
    ok: number;
    fail: number;
    lastError?: string;
    lastOkAt?: number;
    lastUsedAt?: number;
    disabled?: boolean;
}

type PoolState = Record<string, PoolEntry[]>;

interface PoolStore {
    state: PoolState;
    counters: Record<string, number>;
    loaded: boolean;
}

const FILE = path.join(process.cwd(), 'data', 'token-pool.json');

const store: PoolStore = ((globalThis as any).__tokenPool ??= { state: {}, counters: {}, loaded: false }) as PoolStore;

function load() {
    if (store.loaded) return;
    store.loaded = true;
    try {
        if (fs.existsSync(FILE)) {
            const parsed = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
            if (parsed && typeof parsed === 'object') store.state = parsed;
        }
    } catch {}
}

function save() {
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(store.state, null, 2));
    } catch {}
}

const mask = (t: string) => (t.length <= 10 ? '•'.repeat(t.length) : t.slice(0, 6) + '…' + t.slice(-4));

/** Round-robin pick of a healthy (non-disabled) token for a platform. */
export function pickToken(platform: string): string | undefined {
    load();
    const list = (store.state[platform] ?? []).filter((e) => !e.disabled);
    if (!list.length) return undefined;
    const i = (store.counters[platform] = (store.counters[platform] ?? 0) + 1);
    const entry = list[i % list.length];
    entry.lastUsedAt = Date.now();
    return entry.token;
}

/** Record success/failure for a token so rotation skips dying credentials. */
export function reportToken(platform: string, token: string, ok: boolean, error?: string) {
    load();
    const entry = (store.state[platform] ?? []).find((e) => e.token === token);
    if (!entry) return;
    if (ok) {
        entry.ok++;
        entry.lastOkAt = Date.now();
        entry.lastError = undefined;
    } else {
        entry.fail++;
        entry.lastError = error?.slice(0, 200);
        // auth failures mean the credential is dead — stop rotating into it
        if (error && /401|403|expired|unauthor|invalid|denied|eligible/i.test(error)) entry.disabled = true;
    }
    save();
}

/** All usable tokens for a platform: pool entries, then env var as implicit last resort. */
export function tokensFor(platform: string, envVar?: string): string[] {
    load();
    const pool = (store.state[platform] ?? []).filter((e) => !e.disabled).map((e) => e.token);
    const env = envVar ? process.env[envVar] : undefined;
    if (env && !pool.includes(env)) pool.push(env);
    return pool;
}

export const admin = {
    stats(jobs: { active: number; total: number }) {
        load();
        const poolStats: Record<string, { total: number; active: number; disabled: number }> = {};
        for (const [plat, list] of Object.entries(store.state)) {
            poolStats[plat] = { total: list.length, active: list.filter((e) => !e.disabled).length, disabled: list.filter((e) => e.disabled).length };
        }
        const mem = process.memoryUsage();
        return {
            uptimeSec: Math.round(process.uptime()),
            memoryMB: Math.round(mem.rss / 1048576),
            jobs,
            poolStats
        };
    },
    list() {
        load();
        const out: Record<string, any[]> = {};
        for (const [plat, list] of Object.entries(store.state)) {
            out[plat] = list.map((e) => ({
                token: mask(e.token),
                label: e.label,
                addedAt: e.addedAt,
                ok: e.ok,
                fail: e.fail,
                lastError: e.lastError,
                lastOkAt: e.lastOkAt,
                lastUsedAt: e.lastUsedAt,
                disabled: !!e.disabled
            }));
        }
        return out;
    },
    add(platform: string, token: string, label?: string) {
        load();
        store.state[platform] ??= [];
        if (store.state[platform].some((e) => e.token === token)) return { added: false, reason: 'already exists' };
        store.state[platform].push({ token, label, addedAt: Date.now(), ok: 0, fail: 0 });
        save();
        return { added: true };
    },
    remove(platform: string, tokenMaskedOrFull: string) {
        load();
        const list = store.state[platform] ?? [];
        const before = list.length;
        store.state[platform] = list.filter((e) => e.token !== tokenMaskedOrFull && mask(e.token) !== tokenMaskedOrFull);
        if (store.state[platform].length !== before) save();
        return { removed: before - store.state[platform].length };
    },
    toggle(platform: string, tokenMaskedOrFull: string, disabled: boolean) {
        load();
        const e = (store.state[platform] ?? []).find((x) => x.token === tokenMaskedOrFull || mask(x.token) === tokenMaskedOrFull);
        if (e) {
            e.disabled = disabled;
            save();
        }
        return { found: !!e };
    }
};
