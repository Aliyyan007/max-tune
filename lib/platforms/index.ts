import type { NextRequest } from 'next/server';
import http from 'http';
import https from 'https';
import axios from 'axios';
import { getAlbumInfo, getArtist, getArtistReleases, getDownloadURL, search } from '@/lib/qobuz-dl-server';
import deezerAdapter from './deezer';
import tidalAdapter from './tidal';
import spotifyAdapter from './spotify';
import appleAdapter from './apple';
import amazonAdapter from './amazon';
import type { DownloadInfo, PlatformAdapter, PlatformSource, RequestContext, ServiceTokens } from './types';

// Reuse TCP/TLS connections to platform APIs + CDNs — cuts a handshake per request.
axios.defaults.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

const qobuzAdapter: PlatformAdapter = {
    source: 'qobuz',
    search: (query, limit, offset, ctx) => search(query, limit, offset, ctx.country ? { country: ctx.country } : {}),
    getAlbumInfo: (albumId, ctx) => getAlbumInfo(albumId, ctx.country ? { country: ctx.country } : {}),
    getArtist: (artistId, ctx) => getArtist(artistId, ctx.country ? { country: ctx.country } : {}),
    getArtistReleases: (artistId, type, limit, offset, ctx) => getArtistReleases(artistId, type, limit, offset, 1000, ctx.country ? { country: ctx.country } : {}),
    getDownloadURL: async (trackId, quality, ctx): Promise<DownloadInfo> => ({
        url: await getDownloadURL(parseInt(trackId), quality, ctx.country ? { country: ctx.country } : {}),
        format: quality === '5' ? 'mp3' : 'flac'
    })
};

export const adapters: Record<PlatformSource, PlatformAdapter> = {
    qobuz: qobuzAdapter,
    deezer: deezerAdapter,
    tidal: tidalAdapter,
    spotify: spotifyAdapter,
    apple: appleAdapter,
    amazon: amazonAdapter
};

export const VALID_SOURCES = Object.keys(adapters) as PlatformSource[];

export function getSource(req: NextRequest): PlatformSource {
    const s = new URL(req.url).searchParams.get('source');
    return VALID_SOURCES.includes(s as PlatformSource) ? (s as PlatformSource) : 'qobuz';
}

export function getServiceTokens(req: NextRequest): ServiceTokens {
    try {
        const raw = req.headers.get('Service-Tokens');
        return raw ? (JSON.parse(decodeURIComponent(raw)) as ServiceTokens) : {};
    } catch {
        return {};
    }
}

export function getContext(req: NextRequest): RequestContext {
    return { tokens: getServiceTokens(req), country: req.headers.get('Token-Country') ?? undefined };
}

export function apiError(error: any, status = 400) {
    const message = error?.response?.data?.error?.message || error?.response?.data?.userMessage || error?.errors || error?.message || 'An error occurred.';
    return new Response(JSON.stringify({ success: false, error: typeof message === 'string' ? message : JSON.stringify(message) }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
