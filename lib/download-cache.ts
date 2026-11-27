// Cloudflare R2 download cache — S3-compatible, hand-rolled SigV4 (no SDK dep).
// Finished, tagged files land here so a repeat download is a cheap cache hit
// instead of another provider call + decrypt + ffmpeg pass.
// Optional LRU: when Redis is configured, `cache:index`/`cache:total` track
// usage; PUTs over CACHE_MAX_BYTES evict least-recently-served objects.
import crypto from 'crypto';
import fs from 'fs';
import { Transform, pipeline } from 'stream';
import {
    queueEnabled, cacheTouch, cacheAddBytes, cacheSubBytes, cacheTotal,
    cacheMetaReserve, cacheMetaGet, cacheMetaDel, cacheOldest, cacheIndexDel
} from './queue';

const R2_ENDPOINT = (process.env.R2_ENDPOINT ?? '').replace(/\/$/, ''); // https://<acct>.r2.cloudflarestorage.com
const R2_BUCKET = process.env.R2_BUCKET ?? '';
const R2_KEY = process.env.R2_ACCESS_KEY_ID ?? '';
const R2_SECRET = process.env.R2_SECRET_ACCESS_KEY ?? '';
const R2_REGION = 'auto';

// free tier is 10GB — leave headroom; a hot ~300-track cache is the sweet spot
const CACHE_MAX_BYTES = Number(process.env.R2_CACHE_MAX_BYTES ?? 9 * 1024 * 1024 * 1024);

export const cacheEnabled = () => !!(R2_ENDPOINT && R2_BUCKET && R2_KEY && R2_SECRET);

// ---------------- SigV4 ----------------
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();
const sha256 = (data: crypto.BinaryLike) => crypto.createHash('sha256').update(data).digest('hex');
const enc = (s: string) =>
    encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

interface SignParams {
    method: string;
    key: string; // object key within bucket
    query?: Record<string, string>;
    headers?: Record<string, string>;
    payloadHash?: string;
    expires?: number; // presign seconds — presign uses query auth instead of headers
    presign?: boolean;
}

function signedRequest(p: SignParams): { url: string; headers: Record<string, string> } {
    const host = new URL(R2_ENDPOINT).host;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${R2_REGION}/s3/aws4_request`;
    const canonUri = `/${R2_BUCKET}${p.key ? '/' + p.key.split('/').map((s) => enc(s)).join('/') : ''}`;

    const q: Record<string, string> = { ...(p.query ?? {}) };
    const headers: Record<string, string> = { host };
    for (const [k, v] of Object.entries(p.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const payloadHash = p.payloadHash ?? 'UNSIGNED-PAYLOAD';

    if (p.presign) {
        Object.assign(q, {
            'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
            'X-Amz-Credential': `${R2_KEY}/${scope}`,
            'X-Amz-Date': amzDate,
            'X-Amz-Expires': String(p.expires ?? 3600),
            'X-Amz-SignedHeaders': 'host'
        });
    } else {
        headers['x-amz-date'] = amzDate;
        headers['x-amz-content-sha256'] = payloadHash;
    }

    const signedKeys = p.presign ? ['host'] : Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const canonQs = Object.keys(q)
        .sort()
        .map((k) => `${enc(k)}=${enc(q[k])}`)
        .join('&');
    const canonHeaders = signedKeys.map((k) => `${k}:${String(headers[k] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');

    const canonReq = [p.method, canonUri, canonQs, canonHeaders, signedKeys.join(';'), payloadHash].join('\n');
    const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonReq)].join('\n');

    const kDate = hmac(`AWS4${R2_SECRET}`, dateStamp);
    const kRegion = hmac(kDate, R2_REGION);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const sig = crypto.createHmac('sha256', kSigning).update(sts).digest('hex');

    const url = `${R2_ENDPOINT}${canonUri}?${canonQs}${p.presign ? `${canonQs ? '&' : ''}X-Amz-Signature=${sig}` : ''}`;
    if (p.presign) return { url, headers: {} };
    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${R2_KEY}/${scope}, SignedHeaders=${signedKeys.join(';')}, Signature=${sig}`;
    return { url, headers };
}

// ---------------- deterministic recipe keys ----------------
function stableNormalize(v: any): any {
    if (Array.isArray(v)) return v.map(stableNormalize);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) {
        if (v[k] !== undefined) out[k] = stableNormalize(v[k]);
    }
    return out;
}

// Cache identity is the *output recipe*, not merely provider+track+codec. Tags,
// artwork, bitrate and container choices all change bytes and therefore must
// change the key. Filename/country do not participate. User-supplied audio
// credentials do participate as an opaque scope hash: an artifact produced with
// one person's entitlement must not become a cache hit for a different user.
// Jobs using the deployment's shared credential pool intentionally share the
// pool-scoped cache.
function credentialScope(source: string, tokens?: Record<string, string>): string {
    const t = tokens ?? {};
    let material = '';
    if (source === 'deezer') material = t.deezerArl ?? '';
    else if (source === 'tidal') material = t.tidalToken ?? '';
    else if (source === 'apple' || source === 'apple-native' || source === 'apple-preview') material = `${t.appleMediaToken ?? ''}\n${t.appleWrapper ?? ''}`;
    else if (source === 'amazon' || source === 'amazon-native') material = t.amazonToken ?? '';
    // Spotify's user token fields configure metadata API access; native audio
    // still uses the deployment's authenticated librespot session.
    if (!material) return 'pool';
    return `u:${sha256(`${source}\n${material}`).slice(0, 24)}`;
}

export function cacheKeyFor(spec: {
    source: string;
    id: string;
    codec?: string;
    quality?: string;
    bitrate?: number;
    applyMeta?: boolean;
    title?: string;
    artist?: string;
    album?: string;
    trackNum?: number;
    totalTracks?: number;
    discNum?: number;
    genre?: string;
    date?: string;
    year?: string;
    label?: string;
    copyright?: string;
    isrc?: string;
    upc?: string;
    artUrl?: string;
    tokens?: Record<string, string>;
}): string {
    const recipe = stableNormalize({
        v: 4,
        source: spec.source,
        credentialScope: credentialScope(spec.source, spec.tokens),
        id: String(spec.id),
        codec: spec.codec ?? 'SOURCE',
        quality: spec.quality ?? '27',
        bitrate: spec.bitrate,
        applyMeta: spec.applyMeta !== false,
        title: spec.title,
        artist: spec.artist,
        album: spec.album,
        trackNum: spec.trackNum,
        totalTracks: spec.totalTracks,
        discNum: spec.discNum,
        genre: spec.genre,
        date: spec.date,
        year: spec.year,
        label: spec.label,
        copyright: spec.copyright,
        isrc: spec.isrc,
        upc: spec.upc,
        artUrl: spec.artUrl
    });
    const digest = sha256(JSON.stringify(recipe)).slice(0, 32);
    return `t/v3/${spec.source}/${spec.id}/${digest}`;
}

// Preview artifacts share the same output recipe but live in a distinct cache
// namespace. Otherwise a free-tier clip could poison the cache entry for a
// later entitled full-track download (or vice versa).
export function previewCacheKeyFor(spec: Parameters<typeof cacheKeyFor>[0]): string {
    return `${cacheKeyFor(spec)}/preview`;
}

// Album zip recipes are deliberately separate from track objects. Keep this
// projection explicit — spreading the request object once accidentally mixed
// secrets and presentation-only filenames into cache identity.
export function zipCacheKeyFor(spec: {
    source: string;
    albumId: string;
    codec?: string;
    quality?: string;
    bitrate?: number;
    applyMeta?: boolean;
    trackNamePattern?: string;
    tokens?: Record<string, string>;
}): string {
    const recipe = stableNormalize({
        v: 2,
        source: spec.source,
        albumId: String(spec.albumId),
        credentialScope: credentialScope(spec.source, spec.tokens),
        codec: spec.codec ?? 'SOURCE',
        quality: spec.quality ?? '27',
        bitrate: spec.bitrate,
        applyMeta: spec.applyMeta !== false,
        trackNamePattern: spec.trackNamePattern
    });
    const digest = sha256(JSON.stringify(recipe)).slice(0, 32);
    return `z/v2/${spec.source}/${spec.albumId}/${digest}`;
}

export function previewZipCacheKeyFor(spec: Parameters<typeof zipCacheKeyFor>[0]): string {
    return `${zipCacheKeyFor(spec)}/previewmix`;
}

// Object key is the cache key plus the discovered extension — set after producing.
export function objectKey(cacheKey: string, ext: string): string {
    return `${cacheKey}.${ext}`;
}

const MIME: Record<string, string> = {
    flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4',
    webm: 'audio/webm', opus: 'audio/webm', ogg: 'audio/ogg', wav: 'audio/wav',
    zip: 'application/zip'
};

function xmlDecode(s: string): string {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// Returns { objectKey, ext, size } on a hit — caller redirects. Null on miss.
export async function cacheGet(cacheKey: string): Promise<{ objectKey: string; ext: string; size: number } | null> {
    if (!cacheEnabled()) return null;
    // list objects with the key prefix — hits return the extension-carrying key
    const { url, headers } = signedRequest({ method: 'GET', key: '', query: { 'list-type': '2', prefix: `${cacheKey}.`, 'max-keys': '10' } });
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const xml = await r.text();
    const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)]
        .map((m) => {
            const body = m[1];
            const key = xmlDecode(body.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? '');
            const size = Number(body.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0);
            const modified = Date.parse(body.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? '') || 0;
            return { key, size, modified };
        })
        .filter((o) => o.key.startsWith(`${cacheKey}.`) && o.size >= 0)
        .sort((a, b) => b.modified - a.modified);
    const hit = objects[0];
    if (!hit) return null;
    const ext = hit.key.slice(hit.key.lastIndexOf('.') + 1);
    if (queueEnabled()) cacheTouch(hit.key).catch(() => {});
    return { objectKey: hit.key, ext, size: hit.size };
}

export function presignGet(objectKey: string, filename?: string, ttl = 3600): string {
    const query: Record<string, string> = {};
    if (filename) query['response-content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
    const { url } = signedRequest({ method: 'GET', key: objectKey, query, presign: true, expires: ttl });
    return url;
}

export async function objectHead(key: string): Promise<{ size: number; etag?: string } | null> {
    if (!cacheEnabled()) return null;
    const { url, headers } = signedRequest({ method: 'HEAD', key });
    const r = await fetch(url, { method: 'HEAD', headers }).catch(() => null);
    if (!r?.ok) return null;
    return { size: Number(r.headers.get('content-length') ?? 0), etag: r.headers.get('etag')?.replace(/^"|"$/g, '') ?? undefined };
}

export async function fileHashes(file: string): Promise<{ sha256: string; md5: string; size: number }> {
    const sha = crypto.createHash('sha256');
    const md5 = crypto.createHash('md5');
    let size = 0;
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
        const b = chunk as Buffer;
        size += b.length;
        sha.update(b);
        md5.update(b);
    }
    return { sha256: sha.digest('hex'), md5: md5.digest('hex'), size };
}

async function registerAndPrune(objectKey: string, size: number, sha256Hex?: string): Promise<void> {
    if (!queueEnabled()) return;
    const firstRegistration = await cacheMetaReserve(objectKey, size, sha256Hex ? { sha256: sha256Hex } : {});
    if (firstRegistration) await cacheAddBytes(size);
    await cacheTouch(objectKey);
    // LRU prune — evict coldest objects until under the byte budget
    const total = await cacheTotal();
    if (total > CACHE_MAX_BYTES) {
        const victims = await cacheOldest(Math.min(50, Math.ceil((total - CACHE_MAX_BYTES) / (30 * 1024 * 1024))));
        for (const k of victims) {
            if (k === objectKey) continue;
            const victimSize = await cacheMetaGet(k);
            try {
                await objectDelete(k);
            } catch {
                continue; // keep metadata/accounting if the object could not be removed
            }
            await cacheMetaDel(k);
            await cacheIndexDel(k);
            if (victimSize) await cacheSubBytes(victimSize);
        }
    }
}

async function putWithRetry(args: {
    objectKey: string;
    size: number;
    payloadHash: string;
    makeBody: () => BodyInit;
}): Promise<void> {
    const ext = args.objectKey.slice(args.objectKey.lastIndexOf('.') + 1);
    let ok = false;
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
            // Sign inside the retry loop: x-amz-date is part of the signature.
            const { url, headers } = signedRequest({
                method: 'PUT',
                key: args.objectKey,
                headers: {
                    'content-type': MIME[ext] ?? 'application/octet-stream',
                    'content-length': String(args.size)
                },
                payloadHash: args.payloadHash
            });
            const init: RequestInit & { duplex?: 'half' } = { method: 'PUT', headers, body: args.makeBody(), duplex: 'half' };
            const r = await fetch(url, init);
            if (r.ok) {
                ok = true;
                break;
            }
            lastErr = new Error(`r2 put ${r.status}: ${(await r.text()).slice(0, 200)}`);
            if (r.status < 500) throw lastErr; // 4xx won't heal by retrying
        } catch (e: any) {
            if (e === lastErr && Number(String(lastErr?.message).match(/r2 put (\d+)/)?.[1] ?? 0) < 500) throw e;
            lastErr = e;
        }
        await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
    if (!ok) throw lastErr ?? new Error('r2 put failed');
}

export async function cachePutFile(
    objectKey: string,
    file: string,
    expectedSize?: number,
    onProgress?: (uploaded: number, total: number) => void
): Promise<{ size: number; sha256: string; etag?: string }> {
    if (!cacheEnabled()) throw new Error('r2 cache not configured');
    const hashes = await fileHashes(file);
    if (expectedSize !== undefined && hashes.size !== expectedSize) throw new Error(`staged artifact size mismatch: ${hashes.size} != ${expectedSize}`);
    await putWithRetry({
        objectKey,
        size: hashes.size,
        payloadHash: hashes.sha256,
        makeBody: () => {
            const source = fs.createReadStream(file, { highWaterMark: 1 << 20 });
            if (!onProgress) return source as any;
            let uploaded = 0;
            const counter = new Transform({
                highWaterMark: 1 << 20,
                transform(chunk: Buffer, _enc, cb) {
                    uploaded += chunk.length;
                    onProgress(uploaded, hashes.size);
                    this.push(chunk);
                    cb();
                }
            });
            pipeline(source, counter, (err) => {
                if (err) counter.destroy(err);
            });
            return counter as any;
        }
    });
    const head = await objectHead(objectKey);
    if (!head || head.size !== hashes.size) {
        await objectDelete(objectKey).catch(() => {});
        throw new Error(`r2 verification failed for ${objectKey}`);
    }
    // Single-part S3/R2 PUTs normally expose an MD5 ETag. Treat it as a strong
    // check when present in that form, but don't fail providers that use another
    // opaque entity-tag construction.
    if (head.etag && !head.etag.includes('-') && /^[a-f0-9]{32}$/i.test(head.etag) && head.etag.toLowerCase() !== hashes.md5) {
        await objectDelete(objectKey).catch(() => {});
        throw new Error(`r2 checksum mismatch for ${objectKey}`);
    }
    await registerAndPrune(objectKey, hashes.size, hashes.sha256);
    return { size: hashes.size, sha256: hashes.sha256, etag: head.etag };
}

// Buffered compatibility path for small/legacy callers. New workers should use
// cachePutFile so artifacts never need to reside fully in memory.
export async function cachePut(objectKey: string, body: Buffer): Promise<void> {
    if (!cacheEnabled()) return;
    await putWithRetry({
        objectKey,
        size: body.length,
        payloadHash: sha256(body),
        makeBody: () => new Uint8Array(body)
    });
    const head = await objectHead(objectKey);
    if (!head || head.size !== body.length) throw new Error(`r2 verification failed for ${objectKey}`);
    await registerAndPrune(objectKey, body.length, sha256(body));
}

export async function objectDelete(key: string): Promise<void> {
    const { url, headers } = signedRequest({ method: 'DELETE', key });
    const r = await fetch(url, { method: 'DELETE', headers });
    if (!r.ok && r.status !== 404) throw new Error(`r2 delete ${r.status}: ${(await r.text()).slice(0, 160)}`);
}
