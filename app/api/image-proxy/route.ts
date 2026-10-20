import { NextRequest, NextResponse } from 'next/server';
import { getCache } from '@/lib/cache';

export const runtime = 'nodejs';

const ALLOWED = ['dzcdn.net', 'scdn.co', 'mzstatic.com', 'tidal.com', 'qobuz.com', 'media-amazon.com', 'ssl-images-amazon.com', 'images-amazon.com'];

// Artwork is immutable per URL and every search/browse re-requests the same covers —
// cache server-side (256MB LRU, 24h) so repeat views are instant.
const imgCache = getCache<{ body: Buffer; contentType: string }>('images', 256 * 1024 * 1024, 24 * 60 * 60 * 1000);

export async function GET(request: NextRequest) {
    const url = new URL(request.url).searchParams.get('url');
    if (!url || !/^https:\/\//.test(url)) return new NextResponse('Missing or invalid url', { status: 400 });
    let host: string;
    try {
        host = new URL(url).hostname;
    } catch {
        return new NextResponse('Invalid url', { status: 400 });
    }
    if (!ALLOWED.some((h) => host === h || host.endsWith('.' + h))) return new NextResponse('Host not allowed', { status: 403 });

    const cached = imgCache.get(url);
    if (cached) {
        return new NextResponse(new Uint8Array(cached.body), {
            status: 200,
            headers: imgHeaders(cached.contentType, cached.body.length)
        });
    }

    try {
        const upstream = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!upstream.ok) return new NextResponse('Upstream error', { status: upstream.status });
        const body = Buffer.from(await upstream.arrayBuffer());
        const contentType = upstream.headers.get('content-type') ?? 'image/jpeg';
        imgCache.set(url, { body, contentType }, body.length);
        return new NextResponse(new Uint8Array(body), { status: 200, headers: imgHeaders(contentType, body.length) });
    } catch {
        return new NextResponse('Fetch failed', { status: 502 });
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
