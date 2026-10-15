import axios from 'axios';
import { baseAlbum, baseArtist, baseTrack, emptyArtistResults, emptyResults, proxiedImg, toDateString, toEpochSeconds } from './normalize';
import { hasSpotifyNativeCreds } from './native-tools';
import type { DownloadHint, DownloadInfo, PlatformAdapter, RequestContext } from './types';
import type { FetchedQobuzAlbum, QobuzAlbum, QobuzTrack } from '@/lib/qobuz-dl';

const API = 'https://api.spotify.com/v1';
const MARKET = 'US';

// ---------------------------------------------------------------
// Auth: developer-app client_credentials — the official, sanctioned
// metadata path. Requires a Premium-owned dev app (free-owner apps
// get 403 "premium subscription required" from Spotify).
// ---------------------------------------------------------------
let appToken: { token: string; expiresAt: number } | null = null;

function creds(ctx: RequestContext): { id?: string; secret?: string } {
    return {
        id: ctx.tokens.spotifyId || process.env.SPOTIFY_CLIENT_ID,
        secret: ctx.tokens.spotifySecret || process.env.SPOTIFY_CLIENT_SECRET
    };
}

async function getAppToken(ctx: RequestContext): Promise<string> {
    if (appToken && appToken.expiresAt > Date.now() + 60_000) return appToken.token;
    const { id, secret } = creds(ctx);
    if (!id || !secret)
        throw new Error('Spotify Client ID + Secret required — set them in Settings → Service Tokens (developer.spotify.com app)');
    const res = await axios
        .post('https://accounts.spotify.com/api/token', new URLSearchParams({ grant_type: 'client_credentials' }).toString(), {
            headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15000
        })
        .catch((e: any) => {
            if (e?.response?.status === 400) throw new Error('Spotify dev credentials invalid — check Client ID + Secret');
            throw e;
        });
    appToken = { token: res.data.access_token, expiresAt: Date.now() + (res.data.expires_in ?? 3600) * 1000 };
    return appToken.token;
}

async function api(path: string, params: Record<string, any> = {}, ctx: RequestContext): Promise<any> {
    const req = () =>
        axios.get(`${API}${path}`, {
            params: { market: MARKET, ...params },
            headers: { Authorization: `Bearer ${appToken!.token}` },
            timeout: 15000
        });
    if (!appToken || appToken.expiresAt <= Date.now()) await getAppToken(ctx);
    try {
        return (await req()).data;
    } catch (e: any) {
        if (e?.response?.status === 401) {
            appToken = null;
            await getAppToken(ctx);
            return (await req()).data;
        }
        if (e?.response?.status === 403)
            throw new Error('Spotify dev app forbidden — the app owner needs a Premium account (developer.spotify.com). Check Client ID/Secret in Settings.');
        if (e?.response?.status === 429) {
            const wait = Math.min(parseInt(e.response.headers?.['retry-after'] ?? '5') || 5, 30);
            await new Promise((r) => setTimeout(r, wait * 1000));
            return (await req()).data;
        }
        throw e;
    }
}

// ---------------------------------------------------------------
// Normalizers — official Web API shapes -> Qobuz-compatible models
// ---------------------------------------------------------------
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const genreLabel = (genres?: string[]) => (genres?.[0] ? titleCase(genres[0]) : '');
// Spotify's catalog model no longer serves release genres — the top line shows the
// real release type (Album / EP / Single / Compilation) unless a genre is present.
const typeLabel = (t?: string) => (t === 'single' ? 'Single' : t === 'ep' ? 'EP' : t === 'compilation' ? 'Compilation' : t ? 'Album' : '');

function normAlbum(a: any, genres?: string[]): QobuzAlbum {
    const images = a.images ?? [];
    return baseAlbum({
        source: 'spotify',
        id: String(a.id),
        title: a.name ?? '',
        duration: 0,
        tracks_count: a.total_tracks ?? 0,
        released_at: toEpochSeconds(a.release_date),
        release_date_original: toDateString(a.release_date),
        parental_warning: false,
        image: {
            small: proxiedImg(images[1]?.url ?? images[0]?.url),
            thumbnail: proxiedImg(images[2]?.url ?? images[0]?.url),
            large: proxiedImg(images[0]?.url),
            back: null
        },
        artist: { image: null, name: a.artists?.[0]?.name ?? '', id: a.artists?.[0]?.id ?? 0, albums_count: 0 },
        artists: (a.artists ?? []).map((x: any) => ({ id: x.id, name: x.name, roles: ['MainArtist'] })),
        genre: { path: [], color: '', name: genreLabel(genres) || typeLabel(a.album_type), id: 0 },
        label: { name: a.label ?? '', id: 0, albums_count: 0 },
        upc: a.external_ids?.upc ?? '',
        _type: a.album_type,
        audio_label: 'OGG · up to 320 kbps',
        streamable: true
    });
}

function normTrack(t: any, album?: QobuzAlbum, genres?: string[]): QobuzTrack {
    const albumObj =
        album ??
        baseAlbum({
            source: 'spotify',
            id: String(t.album?.id ?? ''),
            title: t.album?.name ?? '',
            tracks_count: t.album?.total_tracks ?? 0,
            released_at: toEpochSeconds(t.album?.release_date),
            release_date_original: toDateString(t.album?.release_date),
            image: {
                small: proxiedImg(t.album?.images?.[1]?.url ?? t.album?.images?.[0]?.url),
                thumbnail: proxiedImg(t.album?.images?.[2]?.url ?? t.album?.images?.[0]?.url),
                large: proxiedImg(t.album?.images?.[0]?.url),
                back: null
            },
            artist: { image: null, name: t.artists?.[0]?.name ?? t.album?.artists?.[0]?.name ?? '', id: t.artists?.[0]?.id ?? t.album?.artists?.[0]?.id ?? 0, albums_count: 0 },
            artists: (t.album?.artists ?? t.artists ?? []).map((x: any) => ({ id: x.id, name: x.name, roles: ['MainArtist'] })),
            genre: { path: [], color: '', name: genreLabel(genres) || typeLabel(t.album?.album_type), id: 0 },
            upc: t.album?.external_ids?.upc ?? ''
        });
    return baseTrack({
        source: 'spotify',
        id: String(t.id),
        title: t.name ?? '',
        duration: Math.round((t.duration_ms ?? 0) / 1000),
        track_number: t.track_number ?? 0,
        media_number: t.disc_number ?? 1,
        isrc: t.external_ids?.isrc ?? null,
        parental_warning: !!t.explicit,
        performer: { name: t.artists?.[0]?.name ?? 'Unknown', id: t.artists?.[0]?.id ?? 0 },
        released_at: albumObj.released_at,
        album: albumObj,
        maximum_sampling_rate: 44.1,
        audio_label: 'OGG · up to 320 kbps',
        streamable: t.is_playable !== false
    });
}

function normArtist(a: any, releaseCount = 0) {
    const images = a.images ?? [];
    return baseArtist({
        source: 'spotify',
        id: a.id,
        name: a.name ?? '',
        albums_count: releaseCount,
        image: images.length ? ({ small: proxiedImg(images[1]?.url ?? images[0]?.url), medium: '', large: '', extralarge: '', mega: '' } as any) : null
    });
}

// ---------------------------------------------------------------
// Genre enrichment — the Web API keeps genres on artists, not
// releases. One batched /artists?ids= call fills every card's genre.
// ---------------------------------------------------------------
// NOTE: the batched /artists?ids= endpoint is 403-gated for free-owner dev apps,
// but single /artists/{id} is not — fetch in parallel (deduped, one round-trip).
async function artistGenreMap(ids: string[], ctx: RequestContext): Promise<Map<string, string[]>> {
    const unique = [...new Set(ids.filter(Boolean))].slice(0, 30);
    const map = new Map<string, string[]>();
    await Promise.all(
        unique.map(async (id) => {
            const a = await api(`/artists/${id}`, {}, ctx).catch(() => null);
            if (a?.id) map.set(a.id, a.genres ?? []);
        })
    );
    return map;
}

// ---------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------
const spotifyAdapter: PlatformAdapter = {
    source: 'spotify',

    async search(query, limit, offset, ctx) {
        const results = emptyResults(query);
        // paste a spotify URL -> resolve the entity directly
        const urlMatch = query.match(/open\.spotify\.com\/(track|album|artist)\/([A-Za-z0-9]+)/);
        if (urlMatch && offset === 0) {
            const [, type, id] = urlMatch;
            if (type === 'track') {
                const t = await api(`/tracks/${id}`, {}, ctx);
                results.tracks = { limit, offset: 0, total: 1, items: [normTrack(t)] };
            } else if (type === 'album') {
                const a = await api(`/albums/${id}`, {}, ctx);
                results.albums = { limit, offset: 0, total: 1, items: [normAlbum(a)] };
            } else {
                const a = await api(`/artists/${id}`, {}, ctx);
                results.artists = { limit, offset: 0, total: 1, items: [normArtist(a)] };
            }
            return results;
        }
        const data = await api('/search', { q: query, type: 'track,album,artist', limit: Math.min(limit, 10), offset }, ctx);
        const tracks = data?.tracks?.items ?? [];
        const albums = data?.albums?.items ?? [];
        const artists = data?.artists?.items ?? [];

        results.tracks = {
            limit,
            offset,
            total: data?.tracks?.total ?? 0,
            items: tracks.map((t: any) => normTrack(t))
        };
        const albumItems = albums.map((a: any) => normAlbum(a));
        // search nodes lack album duration — parallel-fetch detail for the page's albums
        await Promise.all(
            albumItems.map(async (alb: any) => {
                const a = await api(`/albums/${alb.id}`, {}, ctx).catch(() => null);
                if (a?.tracks?.items) alb.duration = Math.round(a.tracks.items.reduce((s: number, t: any) => s + (t?.duration_ms ?? 0), 0) / 1000);
            })
        );
        results.albums = {
            limit,
            offset,
            total: data?.albums?.total ?? 0,
            items: albumItems
        };
        results.artists = {
            limit,
            offset,
            total: data?.artists?.total ?? 0,
            items: artists.map((a: any) => normArtist(a, 0))
        };
        return results;
    },

    async getAlbumInfo(albumId, ctx) {
        const a = await api(`/albums/${albumId}`, {}, ctx);
        const genres = await artistGenreMap([(a.artists ?? [])[0]?.id].filter(Boolean), ctx);
        const album = normAlbum({ ...a, genres: undefined }, undefined) as FetchedQobuzAlbum;
        album.genre.name = genreLabel(genres.get(a.artists?.[0]?.id)) || (a.genres ?? [])[0] || typeLabel(a.album_type);
        album.full = true;

        // collect every track page — Web API caps at 50/page
        let items = a.tracks?.items ?? [];
        let next = a.tracks?.next as string | null;
        while (next && items.length < 500) {
            const page = await axios
                .get(next, { headers: { Authorization: `Bearer ${await getAppToken(ctx)}` }, timeout: 15000 })
                .catch(() => null);
            if (!page?.data?.items?.length) break;
            items = items.concat(page.data.items);
            next = page.data.next;
        }
        const { tracks: _omit, ...albumRef } = album as any;
        album.tracks = {
            offset: 0,
            limit: items.length,
            total: items.length,
            items: items.map((t: any) => normTrack(t, albumRef, genres.get(a.artists?.[0]?.id)))
        };
        album.duration = Math.round(items.reduce((s: number, t: any) => s + (t?.duration_ms ?? 0), 0) / 1000);
        return album;
    },

    async getArtist(artistId, ctx) {
        const a = await api(`/artists/${artistId}`, {}, ctx);
        const out = emptyArtistResults();
        out.id = a.id;
        out.name = { display: a.name };
        const images = a.images ?? [];
        out.image = images.length ? { small: proxiedImg(images[1]?.url ?? images[0]?.url) } : null;
        out.artist_category = genreLabel(a.genres);

        // /top-tracks is gated for free-owner dev apps — fall back to a track search scoped to the artist
        let topTracks: any[] = [];
        try {
            const top = await api(`/artists/${artistId}/top-tracks`, {}, ctx);
            topTracks = top?.tracks ?? [];
        } catch {
            const s = await api('/search', { q: `artist:"${a.name}"`, type: 'track', limit: 10 }, ctx).catch(() => null);
            topTracks = s?.tracks?.items ?? [];
        }
        out.top_tracks = topTracks.map((t: any) => normTrack(t, undefined, a.genres));

        // free-owner dev apps are capped at limit=10 on this endpoint
        const relAlbums = await api(`/artists/${artistId}/albums`, { include_groups: 'album', limit: 10 }, ctx).catch(() => null);
        const relSingles = await api(`/artists/${artistId}/albums`, { include_groups: 'single', limit: 10 }, ctx).catch(() => null);
        const relCompilations = await api(`/artists/${artistId}/albums`, { include_groups: 'compilation', limit: 10 }, ctx).catch(() => null);

        out.releases.album = { has_more: !!relAlbums?.next, items: (relAlbums?.items ?? []).map((x: any) => normAlbum(x, a.genres)) };
        out.releases.epSingle = { has_more: !!relSingles?.next, items: (relSingles?.items ?? []).map((x: any) => normAlbum(x, a.genres)) };
        out.releases.compilation = { has_more: !!relCompilations?.next, items: (relCompilations?.items ?? []).map((x: any) => normAlbum(x, a.genres)) };
        return { artist: out };
    },

    async getArtistReleases(artistId, releaseType, limit, offset, ctx) {
        const groups: Record<string, string> = {
            album: 'album',
            epSingle: 'single',
            compilation: 'compilation',
            live: 'appears_on'
        };
        const a = await api(`/artists/${artistId}`, {}, ctx).catch(() => null);
        const data = await api(`/artists/${artistId}/albums`, { include_groups: groups[releaseType] ?? 'album', limit: Math.min(limit, 10), offset }, ctx);
        return { items: (data?.items ?? []).map((x: any) => normAlbum(x, a?.genres)), has_more: !!data?.next };
    },

    async getDownloadURL(trackId, quality, ctx, hint?: DownloadHint): Promise<DownloadInfo> {
        if (!hasSpotifyNativeCreds())
            throw new Error('Spotify account not connected — use Settings → Connect Spotify to link an account (Premium streams real OGG audio)');
        // resolve real metadata for accurate headers (skipped when the card hint covers it)
        let title = hint?.title ?? '';
        let artist = hint?.artist ?? '';
        let duration = hint?.duration;
        let isrc: string | null = null;
        if (!title || !artist) {
            const t = await api(`/tracks/${trackId}`, {}, ctx).catch(() => null);
            title = t?.name ?? title;
            artist = (t?.artists ?? []).map((x: any) => x.name).join(', ') || artist;
            duration = Math.round((t?.duration_ms ?? 0) / 1000) || duration;
            isrc = t?.external_ids?.isrc ?? null;
        }
        const params = new URLSearchParams({ source: 'spotify-native', id: trackId, quality, title, artist });
        if (duration) params.set('dur', String(duration));
        if (isrc) params.set('isrc', isrc);
        return { url: `/api/stream-audio?${params}`, format: 'ogg' };
    }
};

export default spotifyAdapter;
