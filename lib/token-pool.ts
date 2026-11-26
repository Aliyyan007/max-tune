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

// reportToken fires per provider call — under a busy album download that's a
// full-sync JSON write per track. Debounce to one write per quiet period.
let saveTimer: NodeJS.Timeout | null = null;
let lastPoolMirror = 0;
function mirrorPoolToRedis(force = false) {
    // Token values are credentials — kvSet encrypts them when
    // JOB_PAYLOAD_ENCRYPTION_KEY is configured. The mirror is rate-limited so
    // per-track health accounting does not become a Redis write storm.
    const now = Date.now();
    if (!force && now - lastPoolMirror < 10_000) return;
    lastPoolMirror = now;
    import('./queue').then((q) => q.kvSet('pool:tokenPool', JSON.stringify(store.state))).catch(() => {});
}

function saveNow() {
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(store.state, null, 2), { mode: 0o600 });
    } catch {}
    mirrorPoolToRedis();
}
function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveNow();
    }, 2000);
    saveTimer.unref?.();
}
// structural mutations (admin add/remove/toggle) need durability NOW, not in 2s
function saveImmediate() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    saveNow();
    mirrorPoolToRedis(true);
}

/** Pull the shared credential pool into this process. Web/admin writes are the
 * authoritative copy; workers refresh this periodically because their local
 * filesystem is private and ephemeral. */
export async function hydrateTokenPoolFromRedis(): Promise<boolean> {
    try {
        const { kvGet } = await import('./queue');
        const raw = await kvGet('pool:tokenPool');
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            store.state = parsed;
            store.loaded = true;
            return true;
        }
    } catch {}
    return false;
}

const mask = (t: string) => (t.length <= 10 ? '•'.repeat(t.length) : t.slice(0, 6) + '…' + t.slice(-4));

// ---- server-side runtime settings (admin-managed, persisted) ----
// Non-token config that ops may change without a redeploy — e.g. the
// wrapper-lite URL amdl should call. Keys are plain strings, values persisted
// to data/settings.json.

const SETTINGS_FILE = path.join(process.cwd(), 'data', 'settings.json');
const settingsStore = ((globalThis as any).__serverSettings ??= { values: {} as Record<string, string>, loaded: false }) as {
    values: Record<string, string>;
    loaded: boolean;
};

function loadSettings() {
    if (settingsStore.loaded) return;
    settingsStore.loaded = true;
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
            if (parsed && typeof parsed === 'object') settingsStore.values = parsed;
        }
    } catch {}
}

export function getSetting(key: string): string | undefined {
    loadSettings();
    return settingsStore.values[key];
}

/** Keys admin is allowed to set remotely. */
export const SETTABLE_KEYS = new Set(['appleWrapperUrl', 'tidalRefreshToken']);

export function setSetting(key: string, value: string) {
    if (!SETTABLE_KEYS.has(key)) throw new Error(`unknown setting ${key}`);
    loadSettings();
    const v = value.trim();
    if (v) settingsStore.values[key] = v;
    else delete settingsStore.values[key];
    try {
        fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsStore.values, null, 2), { mode: 0o600 });
    } catch {}
    // Durable + shared with the worker — Redis survives Render restarts and is
    // visible to both processes (their disks are ephemeral and private).
    import('./queue').then((q) => q.kvSet(`setting:${key}`, v)).catch(() => {});
    return { [key]: settingsStore.values[key] ?? null };
}

/** Async read that checks the shared Redis store first (set by the web process),
 * then the local settings file — this is how the worker sees web-side changes. */
export async function getSettingShared(key: string): Promise<string | undefined> {
    try {
        const { kvGet } = await import('./queue');
        const v = await kvGet(`setting:${key}`);
        if (v !== null) return v;
    } catch {}
    return getSetting(key);
}

/** Pull admin-managed runtime settings into this process. Workers need the
 * synchronous `getSetting` fast path inside native download tools, so hydration
 * mirrors Redis values into the local in-memory/file-backed settings store. */
export async function hydrateSettingsFromRedis(): Promise<boolean> {
    loadSettings();
    let changed = false;
    try {
        const { kvGet } = await import('./queue');
        for (const key of SETTABLE_KEYS) {
            const v = await kvGet(`setting:${key}`);
            if (v !== null && settingsStore.values[key] !== v) {
                if (v) settingsStore.values[key] = v;
                else delete settingsStore.values[key];
                changed = true;
            }
        }
        if (changed) {
            try {
                fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
                fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsStore.values, null, 2), { mode: 0o600 });
            } catch {}
        }
        return changed;
    } catch {
        return false;
    }
}

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
            poolStats,
            settings: {
                appleWrapperUrl: getSetting('appleWrapperUrl') ?? null
            }
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
        saveImmediate();
        return { added: true };
    },
    remove(platform: string, tokenMaskedOrFull: string) {
        load();
        const list = store.state[platform] ?? [];
        const before = list.length;
        store.state[platform] = list.filter((e) => e.token !== tokenMaskedOrFull && mask(e.token) !== tokenMaskedOrFull);
        if (store.state[platform].length !== before) saveImmediate();
        return { removed: before - store.state[platform].length };
    },
    toggle(platform: string, tokenMaskedOrFull: string, disabled: boolean) {
        load();
        const e = (store.state[platform] ?? []).find((x) => x.token === tokenMaskedOrFull || mask(x.token) === tokenMaskedOrFull);
        if (e) {
            e.disabled = disabled;
            saveImmediate();
        }
        return { found: !!e };
    },
    setSetting(key: string, value: string) {
        return setSetting(key, value);
    }
};
