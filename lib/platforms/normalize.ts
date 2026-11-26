import type { QobuzAlbum, QobuzArtist, QobuzSearchResults, QobuzTrack } from '@/lib/qobuz-dl';
import type { PlatformSource } from './types';

// Routes external artwork through the local image proxy so canvases (resizeImage),
// axios cover fetches and <img> tags never hit third-party CORS walls.
export function proxiedImg(url: string | null | undefined): string {
    if (!url) return '';
    return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

// Provider artwork CDN suffixes. Shared by the image proxy and the download
// pipeline's direct artwork fetch — accepting arbitrary user-supplied URLs here
// would turn the server into an authenticated internal-network fetcher (SSRF).
export const ARTWORK_HOST_SUFFIXES = [
    'dzcdn.net',
    'scdn.co',
    'spotifycdn.com',
    'mzstatic.com',
    'tidal.com',
    'qobuz.com',
    'media-amazon.com',
    'ssl-images-amazon.com',
    'images-amazon.com'
];

export function isAllowedArtworkUrl(url: string): boolean {
    try {
        const u = new URL(url);
        if (u.protocol !== 'https:' || u.username || u.password) return false;
        const host = u.hostname.toLowerCase();
        return ARTWORK_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith('.' + suffix));
    } catch {
        return false;
    }
}

export function emptyResults(query: string): QobuzSearchResults {
    return {
        query,
        switchTo: null,
        albums: { limit: 10, offset: 0, total: 0, items: [] },
        tracks: { limit: 10, offset: 0, total: 0, items: [] },
        artists: { limit: 10, offset: 0, total: 0, items: [] }
    };
}

export function emptyArtistResults(): any {
    return {
        id: 0,
        name: { display: '' },
        artist_category: '',
        biography: { content: '', source: null, language: '' },
        images: { portrait: { hash: '', format: '' } },
        image: null,
        top_tracks: [],
        releases: {
            album: { has_more: false, items: [] },
            live: { has_more: false, items: [] },
            compilation: { has_more: false, items: [] },
            epSingle: { has_more: false, items: [] }
        }
    };
}

export function baseAlbum(partial: Partial<QobuzAlbum> & { source?: PlatformSource; full?: boolean }): QobuzAlbum {
    return {
        maximum_bit_depth: 16,
        maximum_sampling_rate: 44.1,
        audio_label: undefined,
        image: { small: '', thumbnail: '', large: '', back: null },
        artist: { image: null, name: '', id: 0, albums_count: 0 },
        artists: [],
        released_at: 0,
        label: { name: '', id: 0, albums_count: 0 },
        title: '',
        qobuz_id: 0,
        version: null,
        duration: 0,
        parental_warning: false,
        tracks_count: 0,
        genre: { path: [], color: '', name: '', id: 0 },
        id: '',
        release_date_original: '',
        hires: false,
        upc: '',
        streamable: true,
        ...partial
    } as QobuzAlbum;
}

export function baseTrack(partial: Partial<QobuzTrack> & { album: QobuzAlbum; source?: PlatformSource }): QobuzTrack {
    return {
        isrc: null,
        copyright: '',
        maximum_bit_depth: 16,
        maximum_sampling_rate: 44.1,
        audio_label: undefined,
        performer: { name: '', id: 0 },
        track_number: 0,
        released_at: partial.album.released_at,
        title: '',
        version: null,
        duration: 0,
        parental_warning: false,
        id: 0,
        hires: false,
        streamable: true,
        media_number: 1,
        ...partial
    } as QobuzTrack;
}

export function baseArtist(partial: Partial<QobuzArtist> & { source?: PlatformSource }): QobuzArtist {
    return {
        image: null,
        name: '',
        id: 0,
        // undefined = "count not known" — cards show 'Releases'; a real 0 shows '0 Releases'
        albums_count: undefined,
        ...partial
    } as QobuzArtist;
}

// Bounded parallelism — identical copies used to live in every adapter.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let i = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (i < items.length) {
                const idx = i++;
                out[idx] = await fn(items[idx]);
            }
        })
    );
    return out;
}

// Date helpers — platforms return ISO strings or year-only values
export function toEpochSeconds(dateStr: string | number | undefined | null): number {
    if (!dateStr) return 0;
    if (typeof dateStr === 'number') return dateStr > 1e12 ? Math.floor(dateStr / 1000) : dateStr;
    const t = Date.parse(dateStr.length === 4 ? `${dateStr}-01-01` : dateStr.length === 7 ? `${dateStr}-01` : dateStr);
    return isNaN(t) ? 0 : Math.floor(t / 1000);
}

export function toDateString(dateStr: string | number | undefined | null): string {
    if (!dateStr) return '';
    if (typeof dateStr === 'number') return new Date(dateStr > 1e12 ? dateStr : dateStr * 1000).toISOString().slice(0, 10);
    const t = Date.parse(dateStr.length === 4 ? `${dateStr}-01-01` : dateStr.length === 7 ? `${dateStr}-01` : dateStr);
    return isNaN(t) ? String(dateStr) : new Date(t).toISOString().slice(0, 10);
}
