import type { QobuzAlbum, QobuzArtist, QobuzSearchResults, QobuzTrack } from '@/lib/qobuz-dl';
import type { PlatformSource } from './types';

// Routes external artwork through the local image proxy so canvases (resizeImage),
// axios cover fetches and <img> tags never hit third-party CORS walls.
export function proxiedImg(url: string | null | undefined): string {
    if (!url) return '';
    return `/api/image-proxy?url=${encodeURIComponent(url)}`;
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
        albums_count: 0,
        ...partial
    } as QobuzArtist;
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
