// Cloudflare R2 download cache — S3-compatible, hand-rolled SigV4 (no SDK dep).
// Finished, tagged files land here so a repeat download is a cheap cache hit
// instead of another provider call + decrypt + ffmpeg pass.
// Optional LRU: when Redis is configured, `cache:index`/`cache:total` track
// usage; PUTs over CACHE_MAX_BYTES evict least-recently-served objects.
import crypto from 'crypto';
import {
    queueEnabled, cacheTouch, cacheAddBytes, cacheSubBytes, cacheTotal,
    cacheMetaSet, cacheMetaGet, cacheMetaDel, cacheOldest, cacheIndexDel
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
const hmac = (key: Buffer | string, data: string) => crypto.createHmac('sha256', key).update(data).digest();
const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');
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
    const headers: Record<string, string> = { host, ...p.headers };
    const payloadHash = p.payloadHash ?? 'UNSIGNED-PAYLOAD';

    if (p.presign) {
        Object.assign(q, {
            'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
            'X-Amz-Credential': `${R2_KEY}/${scope}`,
            'X-Amz-Date': amzDate,
            'X-Amz-Expires': String(p.expires ?? 3600),
            'X-Amz-SignedHeaders': 'host'
        });
        q['X-Amz-Content-Sha256'] = payloadHash;
    } else {
        headers['x-amz-date'] = amzDate;
        headers['x-amz-content-sha256'] = payloadHash;
    }

    const signedKeys = p.presign ? ['host'] : Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const canonQs = Object.keys(q)
        .sort()
        .map((k) => `${enc(k)}=${enc(q[k])}`)
        .join('&');
    const canonHeaders = p.presign
        ? `host:${host}\n`
        : signedKeys.map((k) => `${k}:${String(headers[k] ?? headers[Object.keys(headers).find((h) => h.toLowerCase() === k)!]).trim().replace(/\s+/g, ' ')}\n`).join('');

    const canonReq = [p.method, canonUri, canonQs, canonHeaders, signedKeys.join(';'), payloadHash].join('\n');
    const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonReq)].join('\n');

    const kDate = hmac(`AWS4${R2_SECRET}`, dateStamp);
    const kRegion = hmac(kDate, R2_REGION);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const sig = crypto.createHmac('sha256', kSigning).update(sts).digest('hex');

    const url = `${R2_ENDPOINT}${canonUri}?${canonQs}${p.presign ? `&X-Amz-Signature=${sig}` : ''}`;
    if (p.presign) return { url, headers: {} };
    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${R2_KEY}/${scope}, SignedHeaders=${signedKeys.join(';')}, Signature=${sig}`;
    return { url, headers };
}

// ---------------- public API ----------------

// What a repeat request key looks like — same track on the same platform in the
// same output shape is byte-identical after tagging, so this is a stable key.
export function cacheKeyFor(spec: { source: string; id: string; codec?: string; quality?: string }): string {
    return `t/${spec.source}/${spec.id}/${spec.codec ?? 'SOURCE'}-${spec.quality ?? '27'}`;
}

// Object key is the cache key plus the discovered extension — set after producing.
export function objectKey(cacheKey: string, ext: string): string {
    return `${cacheKey}.${ext}`;
}

const MIME: Record<string, string> = {
    flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4',
    webm: 'audio/webm', opus: 'audio/webm', ogg: 'audio/ogg', wav: 'audio/wav'
};

// Returns { objectKey, ext, presigned } on a hit — caller redirects. Null on miss.
export async function cacheGet(cacheKey: string): Promise<{ objectKey: string; ext: string; size: number } | null> {
    if (!cacheEnabled()) return null;
    // list objects with the key prefix — hits return the extension-carrying key
    const { url, headers } = signedRequest({ method: 'GET', key: '', query: { 'list-type': '2', prefix: `${cacheKey}.`, 'max-keys': '5' } });
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const xml = await r.text();
    const m = xml.match(/<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/);
    if (!m) return null;
    const objectKey = m[1];
    const ext = objectKey.slice(objectKey.lastIndexOf('.') + 1);
    if (queueEnabled()) cacheTouch(objectKey).catch(() => {});
    return { objectKey, ext, size: Number(m[2]) };
}

export function presignGet(objectKey: string, filename?: string, ttl = 3600): string {
    const query: Record<string, string> = {};
    if (filename) query['response-content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
    const { url } = signedRequest({ method: 'GET', key: objectKey, query, presign: true, expires: ttl });
    return url;
}

export async function cachePut(objectKey: string, body: Buffer): Promise<void> {
    if (!cacheEnabled()) return;
    const ext = objectKey.slice(objectKey.lastIndexOf('.') + 1);
    const payloadHash = sha256(body);
    const { url, headers } = signedRequest({
        method: 'PUT',
        key: objectKey,
        headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' },
        payloadHash
    });
    const r = await fetch(url, { method: 'PUT', headers, body: new Uint8Array(body) });
    if (!r.ok) throw new Error(`r2 put ${r.status}: ${(await r.text()).slice(0, 200)}`);
    if (!queueEnabled()) return;
    await cacheMetaSet(objectKey, body.length);
    await cacheAddBytes(body.length);
    await cacheTouch(objectKey);
    // LRU prune — evict coldest objects until under the byte budget
    const total = await cacheTotal();
    if (total > CACHE_MAX_BYTES) {
        const victims = await cacheOldest(Math.min(50, Math.ceil((total - CACHE_MAX_BYTES) / (30 * 1024 * 1024))));
        for (const k of victims) {
            const size = await cacheMetaGet(k);
            await objectDelete(k).catch(() => {});
            await cacheMetaDel(k);
            await cacheIndexDel(k);
            if (size) await cacheSubBytes(size);
        }
    }
}

export async function objectDelete(key: string): Promise<void> {
    const { url, headers } = signedRequest({ method: 'DELETE', key });
    await fetch(url, { method: 'DELETE', headers });
}
