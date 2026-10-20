import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { tokensFor } from '@/lib/token-pool';
import { baseAlbum, baseArtist, baseTrack, emptyArtistResults, emptyResults, proxiedImg, toDateString, toEpochSeconds } from './normalize';
import { hasSpotifyNativeCreds } from './native-tools';
import { markPfOpDead, pathfinder, PF_HASH, pfOpDead } from './spotify-partner';
import type { DownloadHint, DownloadInfo, PlatformAdapter, RequestContext } from './types';
import type { FetchedQobuzAlbum, QobuzAlbum, QobuzTrack } from '@/lib/qobuz-dl';

const API = 'https://api.spotify.com/v1';
const MARKET = 'US';
const AUDIO_LABEL = 'OGG · up to 320 kbps';

// ---------------------------------------------------------------
// Primary path: Spotify Web Player's own API (api-partner pathfinder
// GraphQL) via anonymous session token — the exact same calls the
// open.spotify.com player makes. Complete objects in one request
// (album + positioned tracklist, artist + discography + top tracks),
// real totals, and none of the dev-app `client_credentials` 429
// cooldowns. Fallback: the official Web API with pooled dev-app creds.
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// Fallback path: Web API client_credentials (dev apps get hours-long
// 429s — kept strictly as the rescue path when pathfinder's
// persisted-query hashes rotate or the anon token flow fails).
// ---------------------------------------------------------------
const rateLimitedUntil = new Map<string, number>();
const endpointFamily = (path: string) => (path.match(/^\/([a-z]+)/i)?.[1] ?? 'misc').toLowerCase();

function credList(ctx: RequestContext): { id: string; secret: string }[] {
    const out: { id: string; secret: string }[] = [];
    const add = (id?: string, secret?: string) => {
        if (id && secret && !out.some((c) => c.id === id)) out.push({ id, secret });
    };
    add(ctx.tokens.spotifyId, ctx.tokens.spotifySecret);
    for (const t of tokensFor('spotify')) {
        if (t.includes(':')) {
            const [id, ...rest] = t.split(':');
            add(id, rest.join(':'));
        }
    }
    add(process.env.SPOTIFY_CLIENT_ID, process.env.SPOTIFY_CLIENT_SECRET);
    return out;
}

const appTokens = new Map<string, { token: string; expiresAt: number }>();

async function getAppToken(ctx: RequestContext, cred: { id: string; secret: string }): Promise<string> {
    const cached = appTokens.get(cred.id);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const res = await axios
        .post('https://accounts.spotify.com/api/token', new URLSearchParams({ grant_type: 'client_credentials' }).toString(), {
            headers: { Authorization: `Basic ${Buffer.from(`${cred.id}:${cred.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15000
        })
        .catch((e: any) => {
            if (e?.response?.status === 400) throw new Error('Spotify dev credentials invalid — check Client ID + Secret');
            throw e;
        });
    const entry = { token: res.data.access_token, expiresAt: Date.now() + (res.data.expires_in ?? 3600) * 1000 };
    appTokens.set(cred.id, entry);
    return entry.token;
}

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

async function api(path: string, params: Record<string, any> = {}, ctx: RequestContext, maxRetries = 3): Promise<any> {
    const family = endpointFamily(path);
    const creds = credList(ctx);
    if (!creds.length) throw new Error('Spotify Client ID + Secret required — set them in Settings → Service Tokens (developer.spotify.com app)');
    let lastErr: Error | null = null;
    for (const cred of creds) {
        const key = `${family}:${cred.id}`;
        const blocked = rateLimitedUntil.get(key) ?? 0;
        if (Date.now() < blocked) {
            lastErr = new Error(`Spotify ${family} rate-limited — dev app cooldown (~${Math.ceil((blocked - Date.now()) / 60000)}min left)`);
            continue;
        }
        let token: string;
        try {
            token = await getAppToken(ctx, cred);
        } catch (e: any) {
            lastErr = e;
            continue;
        }
        for (let attempt = 0; ; attempt++) {
            try {
                return (await axios.get(`${API}${path}`, { params: { market: MARKET, ...params }, headers: { Authorization: `Bearer ${token}` }, timeout: 15000 })).data;
            } catch (e: any) {
                if (e?.response?.status === 401 && attempt === 0) {
                    appTokens.delete(cred.id);
                    token = await getAppToken(ctx, cred);
                    continue;
                }
                if (e?.response?.status === 403)
                    throw new Error('Spotify dev app forbidden — the app owner needs a Premium account (developer.spotify.com).');
                if (e?.response?.status === 429) {
                    const raw = parseInt(e.response.headers?.['retry-after'] ?? '5') || 5;
                    if (attempt < maxRetries && raw <= 10) {
                        await new Promise((r) => setTimeout(r, raw * 1000));
                        continue;
                    }
                    rateLimitedUntil.set(key, Date.now() + raw * 1000);
                    lastErr = new Error(`Spotify ${family} rate-limited — retry in ~${Math.ceil(raw / 60)}min`);
                    break;
                }
                throw e;
            }
        }
    }
    throw lastErr ?? new Error('Spotify API request failed');
}

// ---------------------------------------------------------------
// Pathfinder (Web Player GraphQL) helpers
// ---------------------------------------------------------------

const pfId = (uri?: string) => (uri ?? '').split(':').pop() ?? '';
const pfExplicit = (label?: string) => String(label ?? '').toUpperCase().startsWith('EXPLICIT');

function pfCover(sources?: any[]) {
    const s = [...(sources ?? [])].sort((a: any, b: any) => (a?.width ?? 0) - (b?.width ?? 0));
    return {
        small: proxiedImg(s[0]?.url),
        thumbnail: proxiedImg(s[Math.min(1, s.length - 1)]?.url ?? s[0]?.url),
        large: proxiedImg(s[s.length - 1]?.url),
        back: null
    };
}

function pfDateStr(d: any): string | undefined {
    if (!d) return undefined;
    if (d.isoString) return toDateString(d.isoString);
    if (typeof d.year === 'number') return `${d.year}-${String(d.month ?? 1).padStart(2, '0')}-${String(d.day ?? 1).padStart(2, '0')}`;
    return undefined;
}

const pfArtists = (node: any) =>
    (node?.artists?.items ?? []).map((x: any) => ({ id: pfId(x.uri) || x.id || 0, name: x.profile?.name ?? x.name ?? '', roles: ['MainArtist'] }));

// searchDesktop / getAlbum / discography shapes → qobuz models
function normPfAlbum(node: any): QobuzAlbum {
    // discography items wrap each release as {releases:{items:[{...}]}}
    const rel = node?.releases?.items?.[0] ?? node;
    const artists = pfArtists(rel.artists ? rel : node);
    const dateStr = pfDateStr(rel.date);
    return baseAlbum({
        source: 'spotify',
        id: pfId(rel.uri) || String(rel.id ?? ''),
        title: rel.name ?? '',
        tracks_count: rel.tracks?.totalCount ?? node?.tracksV2?.totalCount ?? 0,
        released_at: toEpochSeconds(dateStr),
        release_date_original: dateStr,
        parental_warning: pfExplicit(rel.contentRating?.label ?? rel.copyright?.label),
        image: pfCover(rel.coverArt?.sources),
        artist: { image: null, name: artists[0]?.name ?? '', id: artists[0]?.id ?? 0, albums_count: 0 },
        artists,
        genre: { path: [], color: '', name: '', id: 0 }, // Spotify removed genres from its data model entirely
        label: { name: typeof rel.label === 'string' ? rel.label : '', id: 0, albums_count: 0 },
        _type: String(rel.type ?? '').toLowerCase() || undefined, // ALBUM/EP/SINGLE
        audio_label: AUDIO_LABEL,
        streamable: rel.playability?.playable !== false
    });
}

function normPfTrack(node: any, album?: QobuzAlbum): QobuzTrack {
    const t = node?.track ?? node?.data ?? node;
    const artists = pfArtists(t);
    const albumObj =
        album ??
        baseAlbum({
            source: 'spotify',
            id: pfId(t.album?.uri) || String(t.album?.id ?? ''),
            title: t.album?.name ?? '',
            image: pfCover(t.album?.coverArt?.sources),
            artist: { image: null, name: artists[0]?.name ?? '', id: artists[0]?.id ?? 0, albums_count: 0 },
            artists
        });
    return baseTrack({
        source: 'spotify',
        id: pfId(t.uri) || String(t.id ?? ''),
        title: t.name ?? '',
        duration: Math.round((t.duration?.totalMilliseconds ?? t.trackDuration?.totalMilliseconds ?? 0) / 1000),
        track_number: t.trackNumber ?? 0,
        media_number: t.discNumber ?? 1,
        isrc: t.isrc ?? null,
        parental_warning: pfExplicit(t.contentRating?.label),
        performer: { name: artists[0]?.name ?? 'Unknown', id: artists[0]?.id ?? 0 },
        released_at: albumObj.released_at,
        album: albumObj,
        maximum_sampling_rate: 44.1,
        audio_label: AUDIO_LABEL,
        streamable: t.playability?.playable !== false
    });
}

// discography/search album nodes lack durations — a bounded getAlbum fill on
// the visible window (cap) keeps latency sane while cards stay real.
async function enrichPfAlbumDurations(items: any[], cap = 12): Promise<void> {
    const todo = items.filter((a) => a?.id && !a.duration).slice(0, cap);
    await mapLimit(todo, 4, async (alb: any) => {
        const d = await pf('getAlbum', { uri: `spotify:album:${alb.id}`, locale: '', offset: 0, limit: 50 }).catch(() => null);
        const tl = d?.data?.albumUnion?.tracksV2?.items ?? [];
        if (tl.length) alb.duration = Math.round(tl.reduce((s: number, x: any) => s + (x?.track?.duration?.totalMilliseconds ?? 0), 0) / 1000);
        if (!alb.tracks_count) alb.tracks_count = d?.data?.albumUnion?.tracksV2?.totalCount ?? tl.length;
    });
}

function normPfArtist(a: any, releaseCount?: number) {
    const s = [...(a.visuals?.avatarImage?.sources ?? a.images ?? [])].sort((x: any, y: any) => (x?.width ?? 0) - (y?.width ?? 0));
    // cards render ~225px tiles — feed the largest source, not the 160px thumbnail
    const best = s[s.length - 1]?.url;
    return baseArtist({
        source: 'spotify',
        id: pfId(a.uri) || a.id,
        name: a.profile?.name ?? a.name ?? '',
        albums_count: releaseCount,
        image: s.length ? ({ small: proxiedImg(best), medium: proxiedImg(best), large: proxiedImg(best), extralarge: proxiedImg(best), mega: proxiedImg(best) } as any) : null
    });
}

// call pathfinder unless the op is flagged dead; throws through on real errors
async function pf(op: keyof typeof PF_HASH, variables: Record<string, any>): Promise<any> {
    if (pfOpDead(op)) throw new Error(`pathfinder op ${op} disabled`);
    try {
        return await pathfinder(op, PF_HASH[op], variables);
    } catch (e: any) {
        const msg = String(e?.response?.data?.errors?.[0]?.message ?? e?.message ?? '');
        try {
            fs.appendFileSync(path.join(process.cwd(), '.tmp', 'pf-errors.log'), `${new Date().toISOString()} ${op}: ${msg.slice(0, 300)} | status=${e?.response?.status}\n`);
        } catch {}
        if (/query hash|Unknown operation|persisted/i.test(msg)) markPfOpDead(op);
        throw e;
    }
}

// discography sections: {releases:{items:[...]}} per item → flat release list
const flatReleases = (section: any) => (section?.items ?? []).flatMap((i: any) => i?.releases?.items ?? []);

// ---------------------------------------------------------------
// Web API fallback path (pre-pathfinder implementation, unchanged)
// ---------------------------------------------------------------
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const genreLabel = (genres?: string[]) => (genres?.[0] ? titleCase(genres[0]) : '');

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
        genre: { path: [], color: '', name: genreLabel(genres), id: 0 },
        label: { name: a.label ?? '', id: 0, albums_count: 0 },
        upc: a.external_ids?.upc ?? '',
        _type: a.album_type,
        audio_label: AUDIO_LABEL,
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
            genre: { path: [], color: '', name: genreLabel(genres), id: 0 },
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
        audio_label: AUDIO_LABEL,
        streamable: t.is_playable !== false
    });
}

function normArtist(a: any, releaseCount?: number) {
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
// Adapter
// ---------------------------------------------------------------
const spotifyAdapter: PlatformAdapter = {
    source: 'spotify',

    async search(query, limit, offset, ctx) {
        const results = emptyResults(query);
        const urlMatch = query.match(/open\.spotify\.com\/(track|album|artist)\/([A-Za-z0-9]+)/);
        if (urlMatch && offset === 0) {
            const [, type, id] = urlMatch;
            if (!pfOpDead('getTrack') && !pfOpDead('getAlbum') && !pfOpDead('queryArtistOverview')) {
                try {
                    if (type === 'track') {
                        const r = await pf('getTrack', { uri: `spotify:track:${id}`, locale: '' });
                        const t = r?.data?.trackUnion;
                        if (t) results.tracks = { limit, offset: 0, total: 1, items: [normPfTrack(t)] };
                    } else if (type === 'album') {
                        const r = await pf('getAlbum', { uri: `spotify:album:${id}`, locale: '', offset: 0, limit: 50 });
                        const a = r?.data?.albumUnion;
                        if (a) results.albums = { limit, offset: 0, total: 1, items: [normPfAlbum(a)] };
                    } else {
                        const r = await pf('queryArtistOverview', { uri: `spotify:artist:${id}`, locale: '', includePrerelease: true });
                        const a = r?.data?.artistUnion;
                        if (a) {
                            const total = (a.discography?.albums?.totalCount ?? 0) + (a.discography?.singles?.totalCount ?? 0) + (a.discography?.compilations?.totalCount ?? 0);
                            results.artists = { limit, offset: 0, total: 1, items: [normPfArtist(a, total)] };
                        }
                    }
                    if (results.tracks.items.length || results.albums.items.length || results.artists.items.length) return results;
                } catch {}
            }
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

        // ---- pathfinder searchDesktop: one request → all typed buckets ----
        if (!pfOpDead('searchDesktop')) {
            try {
                const r = await pf('searchDesktop', {
                    searchTerm: query,
                    offset,
                    limit: Math.min(limit, 10),
                    numberOfTopResults: 5,
                    includeArtistHasConcertsField: false,
                    includeAudiobooks: false,
                    includeAuthors: false,
                    includePreReleases: false,
                    includeLocalFiles: false
                });
                const sk = r?.data?.search;
                if (sk) {
                    const trackItems = (sk.tracks?.items ?? []).map((t: any) => normPfTrack(t));
                    // search rows carry no album stats or track positions — the
                    // bounded getAlbum calls already needed for album duration
                    // also hand back the full tracklist: piggyback positions.
                    const trackAlbums = new Map<string, any>();
                    for (const t of trackItems) if (t?.album?.id && !trackAlbums.has(String(t.album.id))) trackAlbums.set(String(t.album.id), t.album);
                    await mapLimit([...trackAlbums.keys()], 4, async (id) => {
                        const alb = trackAlbums.get(id)!;
                        const d = await pf('getAlbum', { uri: `spotify:album:${id}`, locale: '', offset: 0, limit: 50 }).catch(() => null);
                        const au = d?.data?.albumUnion;
                        if (!au) return;
                        const tl = au.tracksV2?.items ?? [];
                        if (tl.length) alb.duration = Math.round(tl.reduce((s: number, x: any) => s + (x?.track?.duration?.totalMilliseconds ?? 0), 0) / 1000);
                        alb.tracks_count = au.tracksV2?.totalCount ?? tl.length ?? alb.tracks_count;
                        const ds = pfDateStr(au.date);
                        if (ds) { alb.released_at = toEpochSeconds(ds); alb.release_date_original = ds; }
                        if (au.label) alb.label = { name: typeof au.label === 'string' ? au.label : '', id: 0, albums_count: 0 };
                        // uri → position/isrc map applied to the page's tracks
                        const byUri = new Map<string, any>(tl.map((x: any) => [pfId(x?.track?.uri ?? x?.uri), x?.track ?? x]));
                        for (const t of trackItems) {
                            const m = byUri.get(String(t.id));
                            if (!m) continue;
                            if (!t.track_number && m.trackNumber) t.track_number = m.trackNumber;
                            if ((!t.media_number || t.media_number === 1) && m.discNumber) t.media_number = m.discNumber;
                            if (!t.isrc && m.externalIds?.isrc) t.isrc = m.externalIds.isrc;
                            if (!t.parental_warning && pfExplicit(m.contentRating?.label)) t.parental_warning = pfExplicit(m.contentRating?.label);
                        }
                    });
                    for (const t of trackItems) if (t?.album?.released_at && !t.released_at) t.released_at = t.album.released_at;
                    results.tracks = { limit, offset, total: sk.tracks?.totalCount ?? 0, items: trackItems };
                    const albumItems = (sk.albums?.items ?? []).map((a: any) => normPfAlbum(a));
                    await mapLimit(albumItems, 4, async (alb: any) => {
                        const d = await pf('getAlbum', { uri: `spotify:album:${alb.id}`, locale: '', offset: 0, limit: 50 }).catch(() => null);
                        const au = d?.data?.albumUnion;
                        const tl = au?.tracksV2?.items ?? [];
                        if (tl.length) alb.duration = Math.round(tl.reduce((s: number, x: any) => s + (x?.track?.duration?.totalMilliseconds ?? 0), 0) / 1000);
                        if (!alb.tracks_count) alb.tracks_count = au?.tracksV2?.totalCount ?? tl.length;
                        const ds = pfDateStr(au?.date);
                        if (ds && String(alb.release_date_original ?? '').length < 10) { alb.released_at = toEpochSeconds(ds); alb.release_date_original = ds; }
                        if (au?.label && !alb.label?.name) alb.label = { name: typeof au.label === 'string' ? au.label : '', id: 0, albums_count: 0 };
                    });
                    results.albums = { limit, offset, total: sk.albums?.totalCount ?? 0, items: albumItems };
                    const artistItems = (sk.artists?.items ?? []).map((a: any) => normPfArtist(a));
                    // release counts are one queryArtistOverview call each — bounded
                    // so cards can show "N Releases" like Qobuz instead of "Releases"
                    if (!pfOpDead('queryArtistOverview')) {
                        await mapLimit(artistItems.slice(0, 12), 3, async (a: any) => {
                            const r = await pf('queryArtistOverview', { uri: `spotify:artist:${a.id}`, locale: '', includePrerelease: false }).catch(() => null);
                            const d = r?.data?.artistUnion?.discography;
                            if (d) a.albums_count = (d.albums?.totalCount ?? 0) + (d.singles?.totalCount ?? 0) + (d.compilations?.totalCount ?? 0);
                        });
                    }
                    results.artists = { limit, offset, total: sk.artists?.totalCount ?? 0, items: artistItems };
                    return results;
                }
            } catch (e: any) {
                if (!pfOpDead('searchDesktop')) {
                    // real error (not hash rot) — try the Web API path before surfacing
                    if (!credList(ctx).length) throw e;
                }
            }
        }

        // ---- Web API fallback ----
        const data = await api('/search', { q: query, type: 'track,album,artist', limit: Math.min(limit, 10), offset }, ctx);
        const tracks = data?.tracks?.items ?? [];
        const albums = data?.albums?.items ?? [];
        const artists = data?.artists?.items ?? [];
        const trackItems = tracks.map((t: any) => normTrack(t));
        const trackAlbums = new Map<string, any>();
        for (const t of trackItems) if (t?.album?.id && !trackAlbums.has(String(t.album.id))) trackAlbums.set(String(t.album.id), t.album);
        await mapLimit([...trackAlbums.keys()], 4, async (id) => {
            const alb = trackAlbums.get(id)!;
            const a = await api(`/albums/${id}`, {}, ctx, 0).catch(() => null);
            if (!a?.id) return;
            if (a.tracks?.items) alb.duration = Math.round(a.tracks.items.reduce((s: number, t: any) => s + (t?.duration_ms ?? 0), 0) / 1000);
            alb.released_at = toEpochSeconds(a.release_date) || alb.released_at;
            alb.release_date_original = toDateString(a.release_date) || alb.release_date_original;
            alb.tracks_count = a.total_tracks ?? alb.tracks_count;
            if (a.label) alb.label = { name: a.label, id: 0, albums_count: 0 };
            if (a.external_ids?.upc) alb.upc = a.external_ids.upc;
        });
        for (const t of trackItems) if (t?.album?.released_at && !t.released_at) t.released_at = t.album.released_at;
        results.tracks = { limit, offset, total: data?.tracks?.total ?? 0, items: trackItems };
        const albumItems = albums.map((a: any) => normAlbum(a));
        await mapLimit(albumItems, 4, async (alb: any) => {
            const a = await api(`/albums/${alb.id}`, {}, ctx, 0).catch(() => null);
            if (a?.tracks?.items) alb.duration = Math.round(a.tracks.items.reduce((s: number, t: any) => s + (t?.duration_ms ?? 0), 0) / 1000);
        });
        results.albums = { limit, offset, total: data?.albums?.total ?? 0, items: albumItems };
        const artistItems = artists.map((a: any) => normArtist(a));
        await mapLimit(artistItems, 4, async (a: any) => {
            const r = await api(`/artists/${a.id}/albums`, { limit: 1 }, ctx).catch(() => null);
            if (r?.total != null) a.albums_count = r.total;
        });
        results.artists = { limit, offset, total: data?.artists?.total ?? 0, items: artistItems };
        return results;
    },

    async getAlbumInfo(albumId, ctx) {
        if (!pfOpDead('getAlbum')) {
            try {
                const first = await pf('getAlbum', { uri: `spotify:album:${albumId}`, locale: '', offset: 0, limit: 50 });
                const au = first?.data?.albumUnion;
                if (au) {
                    let items = au.tracksV2?.items ?? [];
                    const total = au.tracksV2?.totalCount ?? items.length;
                    while (items.length < total && items.length < 500) {
                        const page = await pf('getAlbum', { uri: `spotify:album:${albumId}`, locale: '', offset: items.length, limit: 50 }).catch(() => null);
                        const more = page?.data?.albumUnion?.tracksV2?.items;
                        if (!more?.length) break;
                        items = items.concat(more);
                    }
                    const album = normPfAlbum(au) as FetchedQobuzAlbum;
                    album.full = true;
                    const dateStr = pfDateStr(au.date);
                    if (dateStr) { album.released_at = toEpochSeconds(dateStr); album.release_date_original = dateStr; }
                    if (au.label) album.label = { name: typeof au.label === 'string' ? au.label : '', id: 0, albums_count: 0 };
                    album.duration = Math.round(items.reduce((s: number, x: any) => s + (x?.track?.duration?.totalMilliseconds ?? 0), 0) / 1000);
                    const { tracks: _omit, ...albumRef } = album as any;
                    album.tracks = { offset: 0, limit: items.length, total: items.length, items: items.map((x: any, i: number) => ({ ...normPfTrack(x?.track ?? x, albumRef), track_number: x?.track?.trackNumber ?? i + 1 })) };
                    return album;
                }
            } catch {}
        }
        const a = await api(`/albums/${albumId}`, {}, ctx);
        const album = normAlbum({ ...a, genres: undefined }) as FetchedQobuzAlbum;
        album.full = true;
        let items = a.tracks?.items ?? [];
        let next = a.tracks?.next as string | null;
        const pageCred = credList(ctx)[0];
        while (next && items.length < 500 && pageCred) {
            const page = await axios
                .get(next, { headers: { Authorization: `Bearer ${await getAppToken(ctx, pageCred).catch(() => '')}` }, timeout: 15000 })
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
            items: items.map((t: any) => normTrack(t, albumRef))
        };
        album.duration = Math.round(items.reduce((s: number, t: any) => s + (t?.duration_ms ?? 0), 0) / 1000);
        return album;
    },

    async getArtist(artistId, ctx) {
        if (!pfOpDead('queryArtistOverview')) {
            try {
                const r = await pf('queryArtistOverview', { uri: `spotify:artist:${artistId}`, locale: '', includePrerelease: true });
                const au = r?.data?.artistUnion;
                if (au) {
                    const out = emptyArtistResults();
                    out.id = artistId;
                    out.name = { display: au.profile?.name ?? '' };
                    const s = [...(au.visuals?.avatarImage?.sources ?? [])].sort((x: any, y: any) => (x?.width ?? 0) - (y?.width ?? 0));
                    out.image = s.length ? { small: proxiedImg(s[0]?.url) } : null;
                    const top = (au.discography?.topTracks?.items ?? []).map((t: any) => normPfTrack(t));
                    out.top_tracks = top;
                    const disco = au.discography ?? {};
                    const relA = flatReleases(disco.albums).map(normPfAlbum);
                    const relS = flatReleases(disco.singles).map(normPfAlbum);
                    const relC = flatReleases(disco.compilations).map(normPfAlbum);
                    await enrichPfAlbumDurations([...relA, ...relS, ...relC], 24);
                    out.releases.album = { has_more: (disco.albums?.totalCount ?? 0) > relA.length, items: relA };
                    out.releases.epSingle = { has_more: (disco.singles?.totalCount ?? 0) > relS.length, items: relS };
                    out.releases.compilation = { has_more: (disco.compilations?.totalCount ?? 0) > relC.length, items: relC };
                    out.albums_count = (disco.albums?.totalCount ?? 0) + (disco.singles?.totalCount ?? 0) + (disco.compilations?.totalCount ?? 0);
                    return { artist: out };
                }
            } catch (e: any) {
                try {
                    fs.appendFileSync(path.join(process.cwd(), '.tmp', 'pf-errors.log'), `${new Date().toISOString()} getArtist-catch: ${String(e?.message ?? e).slice(0, 300)}\n`);
                } catch {}
            }
        }
        const a = await api(`/artists/${artistId}`, {}, ctx);
        const out = emptyArtistResults();
        out.id = a.id;
        out.name = { display: a.name };
        const images = a.images ?? [];
        out.image = images.length ? { small: proxiedImg(images[1]?.url ?? images[0]?.url) } : null;
        out.artist_category = genreLabel(a.genres);
        let topTracks: any[] = [];
        try {
            const top = await api(`/artists/${artistId}/top-tracks`, {}, ctx);
            topTracks = top?.tracks ?? [];
        } catch {
            const s = await api('/search', { q: `artist:"${a.name}"`, type: 'track', limit: 10 }, ctx).catch(() => null);
            topTracks = s?.tracks?.items ?? [];
        }
        out.top_tracks = topTracks.map((t: any) => normTrack(t, undefined, a.genres));
        const relAlbums = await api(`/artists/${artistId}/albums`, { include_groups: 'album', limit: 10 }, ctx).catch(() => null);
        const relSingles = await api(`/artists/${artistId}/albums`, { include_groups: 'single', limit: 10 }, ctx).catch(() => null);
        const relCompilations = await api(`/artists/${artistId}/albums`, { include_groups: 'compilation', limit: 10 }, ctx).catch(() => null);
        const enrichDur = async (items: any[]) =>
            mapLimit(items, 4, async (alb: any) => {
                const d = await api(`/albums/${alb.id}`, {}, ctx, 0).catch(() => null);
                if (d?.tracks?.items) alb.duration = Math.round(d.tracks.items.reduce((s: number, t: any) => s + (t?.duration_ms ?? 0), 0) / 1000);
            });
        const relItems = {
            album: (relAlbums?.items ?? []).map((x: any) => normAlbum(x, a.genres)),
            epSingle: (relSingles?.items ?? []).map((x: any) => normAlbum(x, a.genres)),
            compilation: (relCompilations?.items ?? []).map((x: any) => normAlbum(x, a.genres))
        };
        await Promise.all([enrichDur(relItems.album), enrichDur(relItems.epSingle), enrichDur(relItems.compilation)]);
        out.releases.album = { has_more: !!relAlbums?.next, items: relItems.album };
        out.releases.epSingle = { has_more: !!relSingles?.next, items: relItems.epSingle };
        out.releases.compilation = { has_more: !!relCompilations?.next, items: relItems.compilation };
        out.albums_count = (relAlbums?.total ?? 0) + (relSingles?.total ?? 0) + (relCompilations?.total ?? 0);
        return { artist: out };
    },

    async getArtistReleases(artistId, releaseType, limit, offset, ctx) {
        const sectionKey = releaseType === 'epSingle' ? 'singles' : releaseType === 'compilation' ? 'compilations' : releaseType === 'live' ? null : 'albums';
        if (sectionKey && !pfOpDead('queryArtistDiscography')) {
            try {
                const r = await pf('queryArtistDiscography', { uri: `spotify:artist:${artistId}`, locale: '', offset: 0, limit: 300 });
                const sec = r?.data?.artist?.discography?.[sectionKey] ?? r?.data?.artistUnion?.discography?.[sectionKey];
                if (sec) {
                    const all = flatReleases(sec).map(normPfAlbum);
                    const page = all.slice(offset, offset + limit);
                    await enrichPfAlbumDurations(page, limit);
                    return { items: page, has_more: offset + limit < all.length || offset + limit < (sec.totalCount ?? 0) };
                }
            } catch {}
        }
        if (!sectionKey) return { items: [], has_more: false };
        const groups: Record<string, string> = {
            album: 'album',
            epSingle: 'single',
            compilation: 'compilation',
            live: 'appears_on'
        };
        const a = await api(`/artists/${artistId}`, {}, ctx).catch(() => null);
        const data = await api(`/artists/${artistId}/albums`, { include_groups: groups[releaseType] ?? 'album', limit: Math.min(limit, 10), offset }, ctx);
        const items = (data?.items ?? []).map((x: any) => normAlbum(x, a?.genres));
        await mapLimit(items, 4, async (alb: any) => {
            const d = await api(`/albums/${alb.id}`, {}, ctx, 0).catch(() => null);
            if (d?.tracks?.items) alb.duration = Math.round(d.tracks.items.reduce((s: number, t: any) => s + (t?.duration_ms ?? 0), 0) / 1000);
        });
        return { items, has_more: !!data?.next };
    },

    async getDownloadURL(trackId, quality, ctx, hint?: DownloadHint): Promise<DownloadInfo> {
        if (!hasSpotifyNativeCreds())
            throw new Error('Spotify account not connected — use Settings → Connect Spotify to link an account (Premium streams real OGG audio)');
        let title = hint?.title ?? '';
        let artist = hint?.artist ?? '';
        let duration = hint?.duration;
        let isrc: string | null = null;
        if (!title || !artist) {
            if (!pfOpDead('getTrack')) {
                try {
                    const r = await pf('getTrack', { uri: `spotify:track:${trackId}`, locale: '' });
                    const t = r?.data?.trackUnion;
                    if (t) {
                        title = t.name ?? title;
                        artist = (t.artists?.items ?? []).map((x: any) => x.profile?.name).join(', ') || artist;
                        duration = Math.round((t.duration?.totalMilliseconds ?? 0) / 1000) || duration;
                    }
                } catch {}
            }
            if (!title) {
                const t = await api(`/tracks/${trackId}`, {}, ctx).catch(() => null);
                title = t?.name ?? title;
                artist = (t?.artists ?? []).map((x: any) => x.name).join(', ') || artist;
                duration = Math.round((t?.duration_ms ?? 0) / 1000) || duration;
                isrc = t?.external_ids?.isrc ?? null;
            }
        }
        const params = new URLSearchParams({ source: 'spotify-native', id: trackId, quality, title, artist });
        if (duration) params.set('dur', String(duration));
        if (isrc) params.set('isrc', isrc);
        return { url: `/api/stream-audio?${params}`, format: 'ogg' };
    }
};

export default spotifyAdapter;
