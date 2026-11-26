import { NextRequest, NextResponse } from 'next/server';
import { getCache } from '@/lib/cache';
import { isAllowedArtworkUrl } from '@/lib/platforms/normalize';

export const runtime = 'nodejs';

// Artwork is immutable per URL and every search/browse re-requests the same covers —
// cache server-side (256MB LRU, 24h) so repeat views are instant.
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const imgCache = getCache<{ body: Buffer; contentType: string }>('images', 64 * 1024 * 1024, 24 * 60 * 60 * 1000);

async function fetchArtwork(url: string): Promise<{ body: Buffer; contentType: string }> {
    let current = url;
    for (let redirects = 0; redirects <= 5; redirects++) {
        const upstream = await fetch(current, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'manual' });
        if (upstream.status >= 300 && upstream.status < 400) {
            const loc = upstream.headers.get('location');
            await upstream.body?.cancel().catch(() => {});
            if (!loc) throw new Error('redirect without location');
            current = new URL(loc, current).toString();
            if (!isAllowedArtworkUrl(current)) throw new Error('redirect left allowed artwork hosts');
            continue;
        }
        if (!upstream.ok) throw Object.assign(new Error('upstream error'), { status: upstream.status });
        const contentType = upstream.headers.get('content-type') ?? 'image/jpeg';
        if (!contentType.toLowerCase().startsWith('image/')) throw new Error('upstream did not return an image');
        const declared = Number(upstream.headers.get('content-length') ?? 0);
        if (declared > IMAGE_MAX_BYTES) throw new Error('artwork too large');
        const reader = upstream.body?.getReader();
        if (!reader) throw new Error('empty upstream body');
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            size += value.byteLength;
            if (size > IMAGE_MAX_BYTES) {
                await reader.cancel().catch(() => {});
                throw new Error('artwork too large');
            }
            chunks.push(value);
        }
        return { body: Buffer.concat(chunks.map((c) => Buffer.from(c))), contentType };
    }
    throw new Error('too many redirects');
}

export async function GET(request: NextRequest) {
    const url = new URL(request.url).searchParams.get('url');
    if (!url || !/^https:\/\//.test(url)) return new NextResponse('Missing or invalid url', { status: 400 });
    if (!isAllowedArtworkUrl(url)) return new NextResponse('Host not allowed', { status: 403 });

    const cached = imgCache.get(url);
    if (cached) {
        return new NextResponse(new Uint8Array(cached.body), {
            status: 200,
            headers: imgHeaders(cached.contentType, cached.body.length)
        });
    }

    try {
        const { body, contentType } = await fetchArtwork(url);
        imgCache.set(url, { body, contentType }, body.length);
        return new NextResponse(new Uint8Array(body), { status: 200, headers: imgHeaders(contentType, body.length) });
    } catch (e: any) {
        const status = Number(e?.status ?? 0);
        return new NextResponse(status >= 400 && status < 600 ? 'Upstream error' : 'Fetch failed', { status: status >= 400 && status < 600 ? status : 502 });
    }
}

function imgHeaders(contentType: string, length: number) {
    return {
        'Content-Type': contentType,
        'Content-Length': String(length),
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin'
    };
}
