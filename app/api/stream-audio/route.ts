import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import fs from 'fs';
import { apiError, getServiceTokens } from '@/lib/platforms';
import { decryptDeezerFile, resolveDeezerTrack } from '@/lib/platforms/deezer';
import { resolveTidalTrack } from '@/lib/platforms/tidal';
import { downloadSpotifyNative, downloadAppleNative, downloadAmazonNative } from '@/lib/platforms/native-tools';
import type { QualityId } from '@/lib/platforms/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MIME: Record<string, string> = {
    flac: 'audio/flac',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    webm: 'audio/webm',
    opus: 'audio/webm',
    ogg: 'audio/ogg'
};

function baseHeaders(format: string, size?: number) {
    const h: Record<string, string> = {
        'Content-Type': MIME[format] ?? 'application/octet-stream',
        'X-Audio-Format': format,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-Audio-Format, Content-Length',
        'Cache-Control': 'no-store'
    };
    if (size && size > 0) h['Content-Length'] = String(size);
    return h;
}

async function fetchUpstream(url: string, extraHeaders: Record<string, string> = {}) {
    return axios.get(url, { responseType: 'stream', headers: extraHeaders, timeout: 120000, maxRedirects: 5 });
}

async function headSize(url: string, extraHeaders: Record<string, string> = {}) {
    try {
        const r = await axios.head(url, { headers: extraHeaders, timeout: 20000, maxRedirects: 5 });
        return parseInt(r.headers['content-length'] ?? '0') || 0;
    } catch {
        return 0;
    }
}

// Assemble a fMP4 DASH stream (tidal hi-res): init segment + numbered media segments
async function assembleDash(mpd: string): Promise<Buffer> {
    const initMatch = mpd.match(/initialization="([^"]+)"/);
    const mediaMatch = mpd.match(/media="([^"]+)"/);
    if (!initMatch || !mediaMatch) throw new Error('Unparseable Tidal DASH manifest');
    const init = initMatch[1].replace(/&amp;/g, '&');
    const mediaTemplate = mediaMatch[1].replace(/&amp;/g, '&');
    // collect segment urls from SegmentTimeline if present, else numbered fallback
    const tlDur = mpd.match(/<SegmentTimeline[^>]*>([\s\S]*?)<\/SegmentTimeline>/);
    const segUrls: string[] = [];
    if (tlDur) {
        // <S d=".." r=".."/> entries
        const sEntries = [...tlDur[1].matchAll(/<S[^>]*d="(\d+)"[^>]*(?:r="(\d+)")?/g)];
        let idx = 1;
        for (const e of sEntries) {
            const rep = parseInt(e[2] ?? '0') + 1;
            for (let i = 0; i < rep; i++) segUrls.push(mediaTemplate.replace(/\$(?:Number|num)\$/g, String(idx++)));
        }
    } else {
        // fallback: try numbered segments until 404 (cap 1000)
        for (let i = 1; i <= 1000; i++) segUrls.push(mediaTemplate.replace(/\$(?:Number|num)\$/g, String(i)));
    }
    const parts: Buffer[] = [(await axios.get(init, { responseType: 'arraybuffer', timeout: 30000 })).data];
    let done = false;
    for (let i = 0; i < segUrls.length && !done; i++) {
        try {
            const r = await axios.get(segUrls[i], { responseType: 'arraybuffer', timeout: 30000 });
            parts.push(Buffer.from(r.data));
        } catch {
            done = true; // ran past the last segment
        }
    }
    return Buffer.concat(parts);
}

// ---------------------------------------------------------------
// Native-download cache — the HEAD size-probe used to re-run the
// entire native download, then the GET ran it again. Instead we
// cache the produced file briefly: HEAD warms it (and reports the
// true size), the GET serves it instantly and evicts.
// ---------------------------------------------------------------
type CachedFile = { file: string; format: string; size: number; at: number; pending?: Promise<CachedFile> };
const nativeCache = new Map<string, CachedFile>();
const NATIVE_CACHE_TTL = 10 * 60 * 1000;

async function ensureNativeFile(key: string, producer: () => Promise<{ file: string; size: number; format: string }>): Promise<CachedFile> {
    const existing = nativeCache.get(key);
    if (existing?.pending) return existing.pending;
    if (existing && Date.now() - existing.at < NATIVE_CACHE_TTL && fs.existsSync(existing.file)) return existing;
    const pending = producer().then((r) => {
        const entry: CachedFile = { ...r, at: Date.now() };
        nativeCache.set(key, entry);
        return entry;
    });
    nativeCache.set(key, { file: '', format: '', size: 0, at: Date.now(), pending });
    try {
        return await pending;
    } finally {
        const cur = nativeCache.get(key);
        if (cur?.pending === pending) delete cur.pending;
    }
}

function serveNativeEntry(entry: CachedFile, headOnly: boolean): NextResponse {
    if (headOnly) return new NextResponse(null, { headers: baseHeaders(entry.format, entry.size) });
    const data = fs.readFileSync(entry.file);
    fs.unlink(entry.file, () => {});
    return new NextResponse(new Uint8Array(data), { headers: baseHeaders(entry.format, data.length) });
}

async function resolveAndFetch(request: NextRequest, headOnly: boolean): Promise<NextResponse> {
    const p = new URL(request.url).searchParams;
    const source = p.get('source') ?? '';
    const ctx = { tokens: getServiceTokens(request), country: request.headers.get('Token-Country') ?? undefined };

    if (source === 'deezer') {
        const id = p.get('id');
        if (!id) return new NextResponse('Missing id', { status: 400 });
        const info = await resolveDeezerTrack(id, (p.get('quality') as QualityId) ?? '7', ctx);
        if (headOnly) return new NextResponse(null, { headers: baseHeaders(info.format, info.fileSize) });
        const encrypted = (await axios.get(info.url, { responseType: 'arraybuffer', timeout: 120000 })).data;
        const decrypted = decryptDeezerFile(encrypted, String(info.sngId));
        return new NextResponse(new Uint8Array(decrypted), { headers: baseHeaders(info.format, decrypted.length) });
    }

    if (source === 'tidal') {
        const id = p.get('id');
        if (!id) return new NextResponse('Missing id', { status: 400 });
        const info = await resolveTidalTrack(id, (p.get('quality') as QualityId) ?? '7', ctx);
        if (info.dashManifest) {
            const buf = await assembleDash(info.dashManifest);
            if (headOnly) return new NextResponse(null, { headers: baseHeaders('mp4', buf.length) });
            return new NextResponse(new Uint8Array(buf), { headers: baseHeaders('mp4', buf.length) });
        }
        if (headOnly) {
            const size = await headSize(info.url!, { 'User-Agent': 'Mozilla/5.0' });
            return new NextResponse(null, { headers: baseHeaders(info.format!, size) });
        }
        const upstream = await fetchUpstream(info.url!, { 'User-Agent': 'Mozilla/5.0' });
        const size = parseInt(upstream.headers['content-length'] ?? '0') || 0;
        return new NextResponse(upstream.data as any, { headers: baseHeaders(info.format!, size) });
    }

    if (source === 'spotify-native') {
        const id = p.get('id');
        if (!id) return new NextResponse('Missing id', { status: 400 });
        const qMap: Record<string, 'normal' | 'high' | 'very_high' | 'lossless'> = { '27': 'lossless', '7': 'very_high', '6': 'high', '5': 'normal' };
        const quality = qMap[p.get('quality') ?? '7'] ?? 'very_high';
        // graceful degradation: requested → very_high → high → normal
        const ladder: ('normal' | 'high' | 'very_high' | 'lossless')[] = [quality, 'very_high', 'high', 'normal'];
        let lastErr: any = null;
        let entry: CachedFile | null = null;
        for (const q of [...new Set(ladder)]) {
            try {
                entry = await ensureNativeFile(`spotify:${id}:${q}`, () => downloadSpotifyNative(id, q));
                break;
            } catch (e: any) {
                lastErr = e;
                if (/premium_required/i.test(e?.message ?? '')) throw e;
            }
        }
        if (!entry) throw lastErr ?? new Error('spotify download failed');
        return serveNativeEntry(entry, headOnly);
    }

    if (source === 'apple-preview') {
        const id = p.get('id');
        if (!id) return new NextResponse('Missing id', { status: 400 });
        // iTunes lookup exposes a free 30s preview AAC for every track — no subscription needed
        const res = await axios.get('https://itunes.apple.com/lookup', { params: { id }, timeout: 15000 });
        const t = (res.data.results ?? []).find((r: any) => r.wrapperType === 'track');
        const previewUrl = t?.previewUrl;
        if (!previewUrl) throw new Error('no preview available for this track');
        if (headOnly) {
            const size = await headSize(previewUrl, { 'User-Agent': 'Mozilla/5.0' });
            return new NextResponse(null, { headers: baseHeaders('m4a', size) });
        }
        const upstream = await fetchUpstream(previewUrl, { 'User-Agent': 'Mozilla/5.0' });
        const size = parseInt(upstream.headers['content-length'] ?? '0') || 0;
        return new NextResponse(upstream.data as any, { headers: baseHeaders('m4a', size) });
    }

    if (source === 'apple-native' || source === 'amazon-native') {
        const id = p.get('id');
        if (!id) return new NextResponse('Missing id', { status: 400 });
        const q = p.get('quality') ?? '7';
        let entry: CachedFile;
        if (source === 'apple-native') {
            const aQ = q === '27' ? 'alac-hi' : q === '5' ? 'aac' : 'alac';
            entry = await ensureNativeFile(`apple:${id}:${aQ}`, () => downloadAppleNative(id, aQ, ctx.tokens));
        } else {
            const zQ = q === '27' ? 'Max' : q === '7' ? 'Master' : q === '6' ? 'High' : 'Normal';
            entry = await ensureNativeFile(`amazon:${id}:${zQ}`, () => downloadAmazonNative(id, zQ, ctx.tokens));
        }
        const fmt = entry.format === 'mp4' ? 'm4a' : entry.format;
        if (headOnly) return new NextResponse(null, { headers: baseHeaders(fmt, entry.size) });
        const data = fs.readFileSync(entry.file);
        fs.unlink(entry.file, () => {});
        return new NextResponse(new Uint8Array(data), { headers: baseHeaders(fmt, data.length) });
    }

    return new NextResponse('Unknown source', { status: 400 });
}

export async function GET(request: NextRequest) {
    try {
        return await resolveAndFetch(request, false);
    } catch (e: any) {
        return apiError(e, 502);
    }
}

export async function HEAD(request: NextRequest) {
    try {
        return await resolveAndFetch(request, true);
    } catch (e: any) {
        return apiError(e, 502);
    }
}
