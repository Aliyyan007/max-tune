import type { FetchedQobuzAlbum, QobuzSearchResults } from '@/lib/qobuz-dl';

export type PlatformSource = 'qobuz' | 'deezer' | 'tidal' | 'spotify' | 'apple' | 'amazon';
export type QualityId = '27' | '7' | '6' | '5';
export type AudioFormat = 'flac' | 'mp3' | 'm4a' | 'mp4' | 'webm' | 'opus' | 'ogg';

// User-supplied per-platform credentials (sent by the client via header, falls back to env vars)
export type ServiceTokens = {
    deezerArl?: string;
    tidalToken?: string;
    spotifyId?: string;
    spotifySecret?: string;
    appleMediaToken?: string;
    appleWrapper?: string;
    amazonToken?: string;
};

export interface RequestContext {
    tokens: ServiceTokens;
    country?: string;
}

export interface DownloadInfo {
    url: string;
    format?: AudioFormat;
}

export interface PlatformAdapter {
    source: PlatformSource;
    search(query: string, limit: number, offset: number, ctx: RequestContext): Promise<QobuzSearchResults>;
    getAlbumInfo(albumId: string, ctx: RequestContext): Promise<FetchedQobuzAlbum>;
    getArtist(artistId: string, ctx: RequestContext, artistName?: string): Promise<any>;
    getArtistReleases(artistId: string, releaseType: string, limit: number, offset: number, ctx: RequestContext, artistName?: string): Promise<any>;
    getDownloadURL(trackId: string, quality: QualityId, ctx: RequestContext, hint?: DownloadHint): Promise<DownloadInfo>;
}

// Track metadata the client already knows (from the search result) — lets sources
// skip a metadata re-fetch or recover when a platform lookup fails.
export interface DownloadHint {
    title?: string;
    artist?: string;
    duration?: number;
}

export const PLATFORMS: { id: PlatformSource; label: string; needsToken: string | string[] | null }[] = [
    { id: 'qobuz', label: 'Qobuz', needsToken: null },
    { id: 'deezer', label: 'Deezer', needsToken: 'deezerArl' },
    { id: 'tidal', label: 'Tidal', needsToken: 'tidalToken' },
    { id: 'spotify', label: 'Spotify', needsToken: 'spotifyId' },
    { id: 'apple', label: 'Apple Music', needsToken: null },
    { id: 'amazon', label: 'Amazon Music', needsToken: null }
];
