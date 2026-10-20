import axios from 'axios';
import { pickToken } from '@/lib/token-pool';
import { baseAlbum, baseArtist, baseTrack, emptyArtistResults, emptyResults, proxiedImg, toDateString, toEpochSeconds } from './normalize';
import type { DownloadHint, DownloadInfo, PlatformAdapter, QualityId, RequestContext } from './types';
import type { FetchedQobuzAlbum, QobuzAlbum, QobuzTrack } from '@/lib/qobuz-dl';

// ---------------------------------------------------------------
// Primary path: the OFFICIAL Apple Music Catalog API
// (api.music.apple.com) — the same API music.apple.com + MusicKit use.
// Real cursors, durations, ISRC, genres, trackNumbers, labels, UPC,
// explicit ratings — everything the legacy iTunes Search API lacks.
// The developer JWT is the web player's own public token, scraped
// from music.apple.com's JS bundle and refreshed by its embedded exp.
// Fallback: itunes.apple.com (previous implementation).
// ---------------------------------------------------------------

const API = 'https://api.music.apple.com/v1';
const ITUNES = 'https://itunes.apple.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

let devToken: { token: string; exp: number } | null = null;
let devTokenPending: Promise<string> | null = null;

async function getDevToken(): Promise<string> {
    if (devToken && devToken.exp * 1000 > Date.now() + 60_000) return devToken.token;
    devTokenPending ??= (async () => {
        const page = await axios.get('https://music.apple.com/us/browse', { headers: { 'User-Agent': UA }, timeout: 15000 });
        const asset = String(page.data).match(/(?:src|href)="(\/assets\/index~[^"]+\.js)"/)?.[1];
        if (!asset) throw new Error('apple dev token: index asset not found');
        const js = await axios.get(`https://music.apple.com${asset}`, { headers: { 'User-Agent': UA }, timeout: 20000 });
        const token = String(js.data).match(/eyJ0eXAiOiJKV1Qi[A-Za-z0-9_\-.]+/)?.[0];
        if (!token) throw new Error('apple dev token: JWT not found in bundle');
        // the JWT carries its own expiry — honor it instead of a fixed TTL
        let exp = 0;
        try {
            exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))?.exp ?? 0;
        } catch {}
        devToken = { token, exp: exp || Math.floor(Date.now() / 1000) + 30 * 60 };
        devTokenPending = null;
        return token;
    })().catch((e) => {
        devTokenPending = null;
        throw e;
    });
    return devTokenPending;
}

const storefront = (ctx?: RequestContext) => (ctx?.country ?? process.env.APPLE_STOREFRONT ?? 'us').toLowerCase();

async function am(path: string, params: Record<string, any> = {}, ctx?: RequestContext): Promise<any> {
    const token = await getDevToken();
    return (
        await axios.get(`${API}/catalog/${storefront(ctx)}${path}`, {
            params,
            headers: { Authorization: `Bearer ${token}`, Origin: 'https://music.apple.com', 'User-Agent': UA },
            timeout: 15000
        })
    ).data;
}

// ---------------------------------------------------------------
// Catalog API normalizers — resource {id, attributes{...}} shapes
// ---------------------------------------------------------------

// artwork.url carries {w}x{h} placeholders
const amArt = (art: any, w: number, h: number) => (art?.url ? proxiedImg(String(art.url).replace('{w}', String(w)).replace('{h}', String(h))) : '');
const amExplicit = (attrs: any) => attrs?.contentRating === 'explicit';
const amArtistId = (attrs: any) => attrs?.artistUrl?.match(/\/artist\/[^/]*\/(\d+)/)?.[1] ?? attrs?.relationships?.artists?.data?.[0]?.id ?? 0;
// a song's url embeds its album: /album/<slug>/<albId>?i=<songId>
const amAlbumIdOf = (attrs: any) => String(attrs?.url ?? attrs?.albumInfo?.url ?? '').match(/\/album\/[^/]+\/(\d+)/)?.[1] ?? '';

// Catalog albums carry no aggregate duration — the album detail's track list
// must be summed. The catalog API batches: /albums?ids=a,b,c (≤100/call) — one
// request fills every card on the page instead of ~25 serial round-trips.
const amAlbumCache = new Map<string, { dur: number; artistId?: string; at: number }>();
const ALB_BATCH = 30; // Apple throttles huge id sets — small parallel chunks stay fast cold
async function amAlbumDetails(ids: string[], ctx?: RequestContext): Promise<Map<string, { dur: number; artistId?: string }>> {
    const out = new Map<string, { dur: number; artistId?: string }>();
    const need = ids.filter((id) => {
        const hit = amAlbumCache.get(id);
        if (hit && Date.now() - hit.at < 5 * 60 * 1000) {
            out.set(id, { dur: hit.dur, artistId: hit.artistId });
            return false;
        }
        return true;
    });
    const chunks: string[][] = [];
    for (let i = 0; i < need.length; i += ALB_BATCH) chunks.push(need.slice(i, i + ALB_BATCH));
    await mapLimit(chunks, 3, async (chunk) => {
        const r = await am(`/albums`, { ids: chunk.join(',') }, ctx).catch(() => null);
        for (const rec of r?.data ?? []) {
            const items = rec?.relationships?.tracks?.data ?? [];
            const v = {
                dur: Math.round(items.reduce((s: number, t: any) => s + (t?.attributes?.durationInMillis ?? 0), 0) / 1000),
                artistId: rec?.relationships?.artists?.data?.[0]?.id
            };
            out.set(String(rec.id), v);
            amAlbumCache.set(String(rec.id), { ...v, at: Date.now() });
        }
    });
    if (amAlbumCache.size > 800) amAlbumCache.delete(amAlbumCache.keys().next().value!);
    return out;
}
async function enrichAmAlbumBatch(albs: any[], ctx?: RequestContext): Promise<void> {
    const need = albs.filter((a) => a?.id && (!a.duration || !Number(a.artist?.id)));
    if (!need.length) return;
    const details = await amAlbumDetails(need.map((a) => String(a.id)), ctx).catch(() => new Map());
    for (const alb of need) {
        const v = details.get(String(alb.id));
        if (!v) continue;
        if (v.dur && !alb.duration) alb.duration = v.dur;
        if (v.artistId) {
            if (!Number(alb.artist?.id)) alb.artist.id = v.artistId;
            for (const a of alb.artists ?? []) if (!Number(a.id)) a.id = v.artistId;
        }
    }
}

async function enrichAmTrackAlbums(items: any[], ctx?: RequestContext): Promise<void> {
    const byAlbum = new Map<string, any>();
    for (const t of items) if (t?.album?.id && !byAlbum.has(String(t.album.id))) byAlbum.set(String(t.album.id), t.album);
    await enrichAmAlbumBatch([...byAlbum.values()], ctx);
    for (const t of items) if (t?.album?.released_at && !t.released_at) t.released_at = t.album.released_at;
}

// search rows expose no artist id — the artist-icon click needs it. Batch
// /songs?ids=...&include=artists resolves them all in one call.
async function enrichAmArtistIds(items: any[], ctx?: RequestContext): Promise<void> {
    const need = items.filter((t) => t?.id && !Number(t?.performer?.id));
    if (!need.length) return;
    for (let i = 0; i < need.length; i += 30) {
        const r = await am(`/songs`, { ids: need.slice(i, i + 30).map((t) => t.id).join(','), include: 'artists' }, ctx).catch(() => null);
        const byId = new Map((r?.data ?? []).map((x: any) => [String(x.id), x?.relationships?.artists?.data?.[0]?.id]));
        for (const t of need.slice(i, i + 30)) {
            const aid = byId.get(String(t.id));
            if (!aid) continue;
            t.performer.id = aid;
            if (t?.album?.artist && !Number(t.album.artist.id)) t.album.artist.id = aid;
            for (const a of t?.album?.artists ?? []) if (!Number(a.id)) a.id = aid;
            for (const a of t?.artists ?? []) if (!Number(a.id)) a.id = aid;
        }
    }
}

function normAmAlbum(r: any): QobuzAlbum {
    const a = r?.attributes ?? r;
    const dateStr = a?.releaseDate;
    return baseAlbum({
        source: 'apple',
        id: String(r?.id ?? a?.id ?? ''),
        title: a?.name ?? '',
        version: a?.name?.includes(' - Single') ? 'Single' : null,
        duration: 0,
        tracks_count: a?.trackCount ?? 0,
        released_at: toEpochSeconds(dateStr),
        release_date_original: toDateString(dateStr),
        parental_warning: amExplicit(a),
        image: { small: amArt(a?.artwork, 300, 300), thumbnail: amArt(a?.artwork, 100, 100), large: amArt(a?.artwork, 1400, 1400), back: null },
        artist: { image: null, name: a?.artistName ?? '', id: amArtistId(a), albums_count: 0 },
        artists: [{ id: amArtistId(a), name: a?.artistName ?? '', roles: ['MainArtist'] }],
        genre: { path: [], color: '', name: a?.genreNames?.[0] ?? '', id: 0 },
        label: { name: a?.recordLabel ?? '', id: 0, albums_count: 0 },
        upc: a?.upc ?? '',
        hires: false,
        audio_label: 'ALAC / AAC in .m4a',
        streamable: true,
        _type: a?.isSingle ? 'single' : a?.isCompilation ? 'compilation' : 'album'
    });
}

function normAmTrack(r: any, album?: QobuzAlbum): QobuzTrack {
    const a = r?.attributes ?? r;
    const albumObj =
        album ??
        baseAlbum({
            source: 'apple',
            id: amAlbumIdOf(a) || String(a?.albumInfo?.id ?? r?.relationships?.album?.data?.[0]?.id ?? ''),
            title: a?.albumName ?? '',
            image: { small: amArt(a?.artwork, 300, 300), thumbnail: amArt(a?.artwork, 100, 100), large: amArt(a?.artwork, 1400, 1400), back: null },
            artist: { image: null, name: a?.artistName ?? '', id: amArtistId(a), albums_count: 0 },
            artists: [{ id: amArtistId(a), name: a?.artistName ?? '', roles: ['MainArtist'] }],
            genre: { path: [], color: '', name: a?.genreNames?.[0] ?? '', id: 0 },
            released_at: toEpochSeconds(a?.releaseDate),
            release_date_original: toDateString(a?.releaseDate)
        });
    return baseTrack({
        source: 'apple',
        id: String(r?.id ?? a?.id ?? ''),
        title: a?.name ?? '',
        duration: Math.round((a?.durationInMillis ?? 0) / 1000),
        track_number: a?.trackNumber ?? 0,
        media_number: a?.discNumber ?? 1,
        isrc: a?.isrc ?? null,
        parental_warning: amExplicit(a),
        composer: a?.composerName ? { name: a.composerName, id: 0 } : undefined,
        performer: { name: a?.artistName ?? 'Unknown', id: amArtistId(a) },
        released_at: albumObj.released_at,
        album: albumObj,
        audio_label: 'ALAC / AAC in .m4a',
        streamable: true
    });
}

function normAmArtist(r: any, releaseCount?: number) {
    return baseArtist({
        source: 'apple',
        id: r?.id,
        name: r?.attributes?.name ?? r?.name ?? '',
        albums_count: releaseCount,
        image: null // Apple exposes artist images nowhere — honest placeholder
    });
}

// `next` cursor → "has more" + running total estimate
const amTotal = (bucket: any, items: number, offset: number, limit: number) => (bucket?.next ? offset + items + limit : offset + items);

// ---------------------------------------------------------------
// iTunes fallback helpers (previous implementation, kept for resilience)
// ---------------------------------------------------------------
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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
const isExplicit = (v: any) => String(v ?? '').toLowerCase() === 'explicit';
function art(url: string | undefined, size: number): string {
    if (!url) return '';
    return proxiedImg(url.replace(/\/\d+x\d+(bb)?\./, `/${size}x${size}bb.`));
}
async function albumDuration(collectionId: string): Promise<number> {
    const res = await axios.get(`${ITUNES}/lookup`, { params: { id: collectionId, entity: 'song', limit: 200 }, timeout: 15000 }).catch(() => null);
    const songs = (res?.data?.results ?? []).filter((r: any) => r.wrapperType === 'track');
    return Math.round(songs.reduce((s: number, t: any) => s + (t.trackTimeMillis ?? 0), 0) / 1000);
}

function normAlbum(a: any): QobuzAlbum {
    return baseAlbum({
        source: 'apple',
        id: String(a.collectionId),
        title: a.collectionName ?? '',
        tracks_count: a.trackCount ?? 0,
        released_at: toEpochSeconds(a.releaseDate),
        release_date_original: toDateString(a.releaseDate),
        parental_warning: isExplicit(a.collectionExplicitness),
        image: { small: art(a.artworkUrl100, 600), thumbnail: art(a.artworkUrl100, 100), large: art(a.artworkUrl100, 1400), back: null },
        artist: { image: null, name: a.artistName ?? '', id: a.artistId ?? 0, albums_count: 0 },
        artists: a.artistName ? [{ id: a.artistId ?? 0, name: a.artistName, roles: ['MainArtist'] }] : [],
        genre: { path: [], color: '', name: a.primaryGenreName ?? '', id: 0 },
        label: { name: a.copyright ?? '', id: 0, albums_count: 0 },
        audio_label: 'ALAC / AAC in .m4a',
        streamable: true
    });
}

function normTrack(t: any, album?: QobuzAlbum): QobuzTrack {
    const albumObj =
        album ??
        baseAlbum({
            source: 'apple',
            id: String(t.collectionId ?? ''),
            title: t.collectionName ?? '',
            tracks_count: t.trackCount ?? 0,
            released_at: toEpochSeconds(t.releaseDate),
            release_date_original: toDateString(t.releaseDate),
            image: { small: art(t.artworkUrl100, 600), thumbnail: art(t.artworkUrl100, 100), large: art(t.artworkUrl100, 1400), back: null },
            artist: { image: null, name: t.artistName ?? '', id: t.artistId ?? 0, albums_count: 0 },
            artists: t.artistName ? [{ id: t.artistId ?? 0, name: t.artistName, roles: ['MainArtist'] }] : [],
            genre: { path: [], color: '', name: t.primaryGenreName ?? '', id: 0 },
            parental_warning: isExplicit(t.collectionExplicitness)
        });
    return baseTrack({
        source: 'apple',
        id: String(t.trackId),
        title: t.trackName ?? '',
        duration: Math.round((t.trackTimeMillis ?? 0) / 1000),
        track_number: t.trackNumber ?? 0,
        media_number: t.discNumber ?? 1,
        isrc: null,
        parental_warning: isExplicit(t.trackExplicitness),
        performer: { name: t.artistName ?? 'Unknown', id: t.artistId ?? 0 },
        released_at: albumObj.released_at,
        album: albumObj,
        audio_label: 'ALAC / AAC in .m4a',
        streamable: true
    });
}

const totalHint = (count: number, limit: number, offset: number) => (count === limit ? offset + count + limit : offset + count);

export const appleAdapter: PlatformAdapter = {
    source: 'apple',

    async search(query, limit, offset, ctx) {
        const results = emptyResults(query);
        const m = query.match(/music\.apple\.com\/\w+\/(album|song|artist)(?:\/[^/]+)?\/(\d+)/);
        if (m && offset === 0) {
            // ---- catalog path for pasted URLs ----
            try {
                if (m[1] === 'song') {
                    const r = await am(`/songs/${m[2]}`, {}, ctx);
                    const item = r?.data?.[0];
                    if (item) results.tracks = { limit, offset: 0, total: 1, items: [normAmTrack(item)] };
                } else if (m[1] === 'album') {
                    const r = await am(`/albums/${m[2]}`, {}, ctx);
                    const item = r?.data?.[0];
                    if (item) results.albums = { limit, offset: 0, total: 1, items: [normAmAlbum(item)] };
                } else {
                    const r = await am(`/artists/${m[2]}`, {}, ctx);
                    const item = r?.data?.[0];
                    if (item) results.artists = { limit, offset: 0, total: 1, items: [normAmArtist(item)] };
                }
                if (results.tracks.items.length || results.albums.items.length || results.artists.items.length) {
                    (results as any).switchTo = m[1] === 'song' ? 'tracks' : m[1] === 'album' ? 'albums' : 'artists';
                    return results;
                }
            } catch {}
            try {
                const res = await axios.get(`${ITUNES}/lookup`, { params: { id: m[2] }, timeout: 15000 });
                const item = (res.data.results ?? [])[0];
                if (item) {
                    if (m[1] === 'song' && item.wrapperType === 'track') results.tracks = { limit, offset: 0, total: 1, items: [normTrack(item)] };
                    else if (m[1] === 'album' && item.wrapperType === 'collection') results.albums = { limit, offset: 0, total: 1, items: [normAlbum(item)] };
                    else if (m[1] === 'artist')
                        results.artists = { limit, offset: 0, total: 1, items: [baseArtist({ source: 'apple', id: item.artistId, name: item.artistName ?? '', albums_count: 0, image: null })] };
                    (results as any).switchTo = m[1] === 'song' ? 'tracks' : m[1] === 'album' ? 'albums' : 'artists';
                    return results;
                }
            } catch {}
        }
        // ---- catalog search: one call → songs/albums/artists with real cursors ----
        try {
            const s = await am('/search', { term: query, types: 'songs,albums,artists', limit, offset }, ctx);
            const rs = s?.results;
            if (rs) {
                const amTracks = (rs.songs?.data ?? []).map((x: any) => normAmTrack(x));
                const amAlbums = (rs.albums?.data ?? []).map((x: any) => normAmAlbum(x));
                const amArtists = (rs.artists?.data ?? []).map((x: any) => normAmArtist(x));
                // catalog items carry no album duration/artist ids — bounded detail fills
                await Promise.all([
                    enrichAmTrackAlbums(amTracks, ctx),
                    enrichAmArtistIds(amTracks, ctx),
                    enrichAmAlbumBatch(amAlbums, ctx),
                    // artist release counts: the albums relationship page is the
                    // count source (≤2 pages) — bounded per card like Qobuz
                    mapLimit(amArtists.slice(0, 10), 3, async (a: any) => {
                        const r = await am(`/artists/${a.id}/albums`, { limit: 100 }, ctx).catch(() => null);
                        let n = r?.data?.length;
                        let next = r?.next;
                        if (next && n != null) {
                            const p2 = await am(next.replace(`/v1/catalog/${storefront(ctx)}`, ''), {}, ctx).catch(() => null);
                            n += p2?.data?.length ?? 0;
                            next = p2?.next;
                        }
                        if (n != null) a.albums_count = n;
                    })
                ]);
                results.tracks = { limit, offset, total: amTotal(rs.songs, amTracks.length, offset, limit), items: amTracks };
                results.albums = { limit, offset, total: amTotal(rs.albums, amAlbums.length, offset, limit), items: amAlbums };
                results.artists = { limit, offset, total: amTotal(rs.artists, amArtists.length, offset, limit), items: amArtists };
                return results;
            }
        } catch {}
        // ---- iTunes fallback ----
        const itunes = async (entity: string) => {
            const params = { term: query, media: 'music', entity, limit, offset };
            try {
                return await axios.get(`${ITUNES}/search`, { params, timeout: 25000 });
            } catch (e: any) {
                if (e?.code === 'ECONNABORTED' || e?.message?.includes('timeout')) return axios.get(`${ITUNES}/search`, { params, timeout: 25000 });
                throw e;
            }
        };
        const [songs, albums, artists] = await Promise.allSettled([itunes('song'), itunes('album'), itunes('musicArtist')]);
        if (songs.status === 'fulfilled') {
            const items = (songs.value.data.results ?? []).filter((r: any) => r.wrapperType === 'track').map((t: any) => normTrack(t));
            const trackAlbums = new Map<string, any>();
            for (const t of items) if (t?.album?.id && !trackAlbums.has(String(t.album.id))) trackAlbums.set(String(t.album.id), t.album);
            await mapLimit([...trackAlbums.keys()], 4, async (id) => {
                const alb = trackAlbums.get(id)!;
                alb.duration = await albumDuration(id).catch(() => 0);
            });
            results.tracks = { limit, offset, total: totalHint(items.length, limit, offset), items };
        }
        if (albums.status === 'fulfilled') {
            const items = (albums.value.data.results ?? []).filter((r: any) => r.collectionType === 'Album').map((a: any) => normAlbum(a));
            await mapLimit(items, 4, async (alb: any) => {
                alb.duration = await albumDuration(alb.id).catch(() => 0);
            });
            results.albums = { limit, offset, total: totalHint(items.length, limit, offset), items };
        }
        if (artists.status === 'fulfilled') {
            const items = (artists.value.data.results ?? []).map((a: any) =>
                baseArtist({ source: 'apple', id: a.artistId, name: a.artistName ?? '', image: null })
            );
            await mapLimit(items, 4, async (a: any) => {
                const r = await axios.get(`${ITUNES}/lookup`, { params: { id: a.id, entity: 'album', limit: 200 }, timeout: 15000 }).catch(() => null);
                const n = (r?.data?.results ?? []).filter((x: any) => x.wrapperType === 'collection').length;
                if (n) a.albums_count = n;
            });
            results.artists = { limit, offset, total: totalHint(items.length, limit, offset), items };
        }
        if (m) (results as any).switchTo = m[1] === 'song' ? 'tracks' : m[1] === 'album' ? 'albums' : 'artists';
        return results;
    },

    async getAlbumInfo(albumId, ctx) {
        // ---- catalog: /albums/{id} returns attributes + tracks relationship ----
        try {
            const r = await am(`/albums/${albumId}`, {}, ctx);
            const data = r?.data?.[0];
            if (data?.attributes) {
                const album = normAmAlbum(data) as FetchedQobuzAlbum;
                album.full = true;
                let items = data.relationships?.tracks?.data ?? [];
                let next = data.relationships?.tracks?.next as string | undefined;
                while (next && items.length < 500) {
                    const page = await am(next.replace(`/v1/catalog/${storefront(ctx)}`, ''), {}, ctx).catch(() => null);
                    const more = page?.data ?? [];
                    if (!more.length) break;
                    items = items.concat(more);
                    next = page?.next;
                }
                album.duration = Math.round(items.reduce((s: number, t: any) => s + (t?.attributes?.durationInMillis ?? 0), 0) / 1000);
                album.tracks_count = album.tracks_count || items.length;
                const { tracks: _omit, ...albumRef } = album as any;
                album.tracks = { offset: 0, limit: items.length, total: items.length, items: items.map((t: any) => normAmTrack(t, albumRef)) };
                return album;
            }
        } catch {}
        const res = await axios.get(`${ITUNES}/lookup`, { params: { id: albumId, entity: 'song', limit: 200 }, timeout: 15000 });
        const items = res.data.results ?? [];
        const coll = items.find((r: any) => r.wrapperType === 'collection');
        if (!coll) throw new Error('Album not found on Apple Music');
        const songs = items.filter((r: any) => r.wrapperType === 'track');
        const album = normAlbum(coll) as FetchedQobuzAlbum;
        album.full = true;
        album.duration = Math.round(songs.reduce((s: number, t: any) => s + (t.trackTimeMillis ?? 0), 0) / 1000);
        const { tracks: _omit, ...albumRef } = album as any;
        album.tracks = { offset: 0, limit: songs.length, total: songs.length, items: songs.map((t: any) => normTrack(t, albumRef)) };
        return album;
    },

    async getArtist(artistId, ctx, artistName) {
        // ---- catalog: /artists/{id} + /albums + /view/top-songs — 3 calls,
        // real isSingle/isCompilation typing, genres on everything ----
        try {
            const [artist, albums, topSongs] = await Promise.all([
                am(`/artists/${artistId}`, {}, ctx).catch(() => null),
                am(`/artists/${artistId}/albums`, { limit: 100 }, ctx).catch(() => null),
                am(`/artists/${artistId}/view/top-songs`, { limit: 10 }, ctx).catch(() => null)
            ]);
            if (artist?.data?.[0] || albums?.data?.length) {
                const out = emptyArtistResults();
                const ar = artist?.data?.[0];
                out.id = artistId;
                out.name = { display: ar?.attributes?.name ?? artistName ?? '' };
                out.artist_category = ar?.attributes?.genreNames?.[0] ?? '';
                const items = (albums?.data ?? []).map((x: any) => normAmAlbum(x));
                await enrichAmAlbumBatch(items, ctx);
                const hasMore = !!albums?.next;
                out.releases.album = { has_more: hasMore, items: items.filter((x: any) => x._type === 'album') };
                out.releases.epSingle = { has_more: hasMore, items: items.filter((x: any) => x._type === 'single' || x._type === 'ep') };
                out.releases.compilation = { has_more: hasMore, items: items.filter((x: any) => x._type === 'compilation') };
                out.albums_count = items.length + (hasMore ? 1 : 0);
                out.top_tracks = (topSongs?.data ?? []).map((t: any) => normAmTrack(t));
                return { artist: out };
            }
        } catch {}
        const out = emptyArtistResults();
        const res = await axios.get(`${ITUNES}/lookup`, { params: { id: artistId }, timeout: 15000 });
        const artist = (res.data.results ?? []).find((r: any) => r.wrapperType === 'artist');
        const name = artist?.artistName ?? artistName ?? '';
        out.id = artistId;
        out.name = { display: name };
        const [albums, topSongs] = await Promise.allSettled([
            axios.get(`${ITUNES}/lookup`, { params: { id: artistId, entity: 'album', limit: 200 }, timeout: 15000 }),
            name ? axios.get(`${ITUNES}/search`, { params: { term: name, media: 'music', entity: 'song', attribute: 'artistTerm', limit: 10 }, timeout: 15000 }) : Promise.resolve(null)
        ]);
        const items =
            albums.status === 'fulfilled' ? (albums.value?.data.results ?? []).filter((r: any) => r.wrapperType === 'collection').map((a: any) => normAlbum(a)) : [];
        await mapLimit(items, 6, async (a: any) => {
            a.duration = await albumDuration(a.id).catch(() => 0);
        });
        out.releases.album = { has_more: false, items: items.filter((a: any) => a.tracks_count > 3) };
        out.releases.epSingle = { has_more: false, items: items.filter((a: any) => a.tracks_count <= 3) };
        out.albums_count = items.length;
        if (topSongs.status === 'fulfilled' && topSongs.value) {
            out.top_tracks = (topSongs.value.data.results ?? [])
                .filter((r: any) => r.wrapperType === 'track' && (r.artistId === artist?.artistId || (r.artistName ?? '').toLowerCase() === name.toLowerCase()))
                .map((t: any) => normTrack(t));
        }
        return { artist: out };
    },

    async getArtistReleases(artistId, releaseType, limit, offset, ctx) {
        // ---- catalog: real limit/offset pagination + real release types ----
        try {
            let items: any[] = [];
            let hasMore = false;
            // catalog paginates per-offset — fetch a wide window then filter by real type
            const r = await am(`/artists/${artistId}/albums`, { limit: 100, offset: 0 }, ctx);
            items = (r?.data ?? []).map((x: any) => normAmAlbum(x));
            let next = r?.next;
            while (next && items.length < 400) {
                const page = await am(next.replace(`/v1/catalog/${storefront(ctx)}`, ''), {}, ctx).catch(() => null);
                const more = page?.data ?? [];
                if (!more.length) break;
                items = items.concat(more.map((x: any) => normAmAlbum(x)));
                next = page?.next;
            }
            const wanted = releaseType === 'epSingle' ? ['single', 'ep'] : releaseType === 'compilation' ? ['compilation'] : releaseType === 'live' ? [] : ['album'];
            const filtered = items.filter((a: any) => wanted.includes(a._type));
            hasMore = offset + limit < filtered.length;
            const page = filtered.slice(offset, offset + limit);
            await enrichAmAlbumBatch(page, ctx);
            return { items: page, has_more: hasMore };
        } catch {}
        const res = await axios.get(`${ITUNES}/lookup`, { params: { id: artistId, entity: 'album', limit: 200 }, timeout: 25000 });
        const items = (res.data.results ?? []).filter((r: any) => r.wrapperType === 'collection').map((a: any) => normAlbum(a));
        const filtered = releaseType === 'epSingle' ? items.filter((a: QobuzAlbum) => a.tracks_count <= 3) : releaseType === 'album' ? items.filter((a: QobuzAlbum) => a.tracks_count > 3) : [];
        const page = filtered.slice(offset, offset + limit);
        await mapLimit(page, 4, async (alb: any) => {
            alb.duration = await albumDuration(alb.id).catch(() => 0);
        });
        return { items: page, has_more: offset + limit < filtered.length };
    },

    async getDownloadURL(trackId: string, quality: QualityId, ctx: RequestContext, hint?: DownloadHint): Promise<DownloadInfo> {
        let title = hint?.title ?? '';
        let artist = hint?.artist ?? '';
        let duration = hint?.duration;
        try {
            const r = await am(`/songs/${trackId}`, {}, ctx);
            const a = r?.data?.[0]?.attributes;
            if (a) {
                title = a.name ?? title;
                artist = a.artistName ?? artist;
                duration = Math.round((a.durationInMillis ?? 0) / 1000) || duration;
            }
        } catch {
            try {
                const res = await axios.get(`${ITUNES}/lookup`, { params: { id: trackId }, timeout: 15000 });
                const t = (res.data.results ?? []).find((r: any) => r.wrapperType === 'track');
                title = t?.trackName ?? title;
                artist = t?.artistName ?? artist;
                duration = Math.round((t?.trackTimeMillis ?? 0) / 1000) || duration;
            } catch {}
        }
        // Real ALAC/AAC via amdl + wrapper — requires a media-user-token
        if (pickToken('apple') || ctx.tokens.appleMediaToken || process.env.APPLE_MEDIA_USER_TOKEN) {
            const params = new URLSearchParams({ source: 'apple-native', id: trackId, quality, title, artist });
            if (duration) params.set('dur', String(duration));
            return { url: `/api/stream-audio?${params}`, format: 'm4a' };
        }
        // No subscription token — serve the free 30s preview every Apple track exposes.
        const params = new URLSearchParams({ source: 'apple-preview', id: trackId, quality, title, artist });
        if (duration) params.set('dur', String(duration));
        return { url: `/api/stream-audio?${params}`, format: 'm4a' };
    }
};

export default appleAdapter;
