import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { pickToken, reportToken, tokensFor, getSetting, admin } from '@/lib/token-pool';
import { baseAlbum, baseArtist, baseTrack, emptyArtistResults, emptyResults, proxiedImg, toDateString, toEpochSeconds } from './normalize';
import type { DownloadHint, DownloadInfo, PlatformAdapter, QualityId, RequestContext } from './types';
import type { FetchedQobuzAlbum, QobuzAlbum, QobuzTrack } from '@/lib/qobuz-dl';

const BASE = 'https://api.tidal.com/v1';
const ANON_CLIENT_ID = 'CzET4vdadNUFQ5JU'; // web-player client id — anonymous catalog calls
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sessionCache = new Map<string, { countryCode: string; userId: number; at: number }>();

function tidalImg(uuid: string | undefined, size: number): string {
    if (!uuid) return '';
    return proxiedImg(`https://resources.tidal.com/images/${uuid.replace(/-/g, '/')}/${size}x${size}.jpg`);
}

function qualityDisplay(tags: string[] | undefined, audioQuality: string | undefined): { depth: number; rate: number; hires: boolean; label: string } {
    const t = [...(tags ?? []), audioQuality ?? ''].join(' ');
    if (t.includes('HIRES')) return { depth: 24, rate: 96, hires: true, label: 'FLAC Hi-Res' };
    if (t.includes('LOSSLESS')) return { depth: 16, rate: 44.1, hires: false, label: 'FLAC 16/44.1' };
    return { depth: 16, rate: 44.1, hires: false, label: 'AAC / FLAC by plan' };
}

function normAlbum(a: any): QobuzAlbum {
    const q = qualityDisplay(a.mediaMetadata?.tags, a.audioQuality);
    return baseAlbum({
        source: 'tidal',
        id: String(a.id),
        title: a.title ?? '',
        version: a.version ?? null,
        duration: a.duration ?? 0,
        tracks_count: a.numberOfTracks ?? a.numTracks ?? 0,
        released_at: toEpochSeconds(a.releaseDate ?? a.streamStartDate),
        release_date_original: toDateString(a.releaseDate),
        parental_warning: !!a.explicit,
        image: {
            small: tidalImg(a.cover, 320),
            thumbnail: tidalImg(a.cover, 160),
            large: tidalImg(a.cover, 1280),
            back: null
        },
        artist: { image: null, name: a.artist?.name ?? a.artists?.[0]?.name ?? '', id: a.artist?.id ?? a.artists?.[0]?.id ?? 0, albums_count: 0 },
        artists: (a.artists ?? []).filter((x: any) => x.type === 'MAIN' || !x.type).map((x: any) => ({ id: x.id, name: x.name, roles: [x.type ?? 'MainArtist'] })),
        genre: { path: [], color: '', name: '', id: 0 },
        label: { name: a.provider ?? a.copyright ?? '', id: 0, albums_count: 0 },
        upc: a.upc ?? '',
        maximum_bit_depth: q.depth,
        maximum_sampling_rate: q.rate,
        hires: q.hires,
        audio_label: q.label,
        streamable: a.streamReady !== false
    });
}

function normTrack(t: any, album?: QobuzAlbum): QobuzTrack {
    const q = qualityDisplay(t.mediaMetadata?.tags, t.audioQuality);
    const albumObj =
        album ??
        baseAlbum({
            source: 'tidal',
            id: String(t.album?.id ?? ''),
            title: t.album?.title ?? '',
            image: { small: tidalImg(t.album?.cover, 320), thumbnail: tidalImg(t.album?.cover, 160), large: tidalImg(t.album?.cover, 1280), back: null },
            artist: { image: null, name: t.artist?.name ?? t.artists?.[0]?.name ?? '', id: t.artist?.id ?? t.artists?.[0]?.id ?? 0, albums_count: 0 },
            artists: (t.artists ?? []).map((x: any) => ({ id: x.id, name: x.name, roles: [x.type ?? 'MainArtist'] })),
            released_at: toEpochSeconds(t.album?.releaseDate ?? t.streamStartDate),
            release_date_original: toDateString(t.album?.releaseDate),
            upc: t.album?.upc ?? ''
        });
    return baseTrack({
        source: 'tidal',
        id: t.id,
        title: t.title ?? '',
        version: t.version ?? null,
        duration: t.duration ?? 0,
        track_number: t.trackNumber ?? t.track_number ?? 0,
        media_number: t.volumeNumber ?? t.media_number ?? 1,
        isrc: t.isrc ?? null,
        copyright: t.copyright ?? '',
        parental_warning: !!t.explicit,
        performer: { name: t.artists?.[0]?.name ?? t.artist?.name ?? 'Unknown', id: t.artists?.[0]?.id ?? t.artist?.id ?? 0 },
        released_at: albumObj.released_at,
        album: albumObj,
        maximum_bit_depth: q.depth,
        maximum_sampling_rate: q.rate,
        hires: q.hires,
        audio_label: q.label,
        streamable: t.streamReady !== false && t.allowStreaming !== false
    });
}

function normArtist(a: any) {
    return baseArtist({
        source: 'tidal',
        id: a.id,
        name: a.name ?? '',
        image: a.picture ? { small: tidalImg(a.picture, 320), medium: tidalImg(a.picture, 320), large: tidalImg(a.picture, 750), extralarge: tidalImg(a.picture, 750), mega: tidalImg(a.picture, 750) } : null
    });
}

// Bounded parallelism for per-item detail enrichment.
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

// Tracks embed a light album stub — fetch the detail once per unique album and
// patch duration/releaseDate/tracks_count/copyright/upc into every referencing
// track so cards/dialogs render the same stats Qobuz cards do.
async function enrichTrackAlbums(items: any[], countryCode: string, ctx: RequestContext): Promise<void> {
    const byAlbum = new Map<string, any>();
    for (const t of items) if (t?.album?.id && !byAlbum.has(String(t.album.id))) byAlbum.set(String(t.album.id), t.album);
    await mapLimit([...byAlbum.keys()], 4, async (id) => {
        const alb = byAlbum.get(id)!;
        const d = await axios.get(`${BASE}/albums/${id}`, { params: { countryCode }, headers: headers(ctx), timeout: 15000 }).then((r) => r.data).catch(() => null);
        if (!d?.id) return;
        alb.duration = d.duration || alb.duration;
        alb.tracks_count = d.numberOfTracks ?? d.numTracks ?? alb.tracks_count;
        alb.released_at = toEpochSeconds(d.releaseDate ?? d.streamStartDate) || alb.released_at;
        alb.release_date_original = toDateString(d.releaseDate) || alb.release_date_original;
        alb.label = { name: d.copyright ?? d.provider ?? '', id: 0, albums_count: 0 };
        alb.upc = d.upc ?? alb.upc;
        if (d.explicit !== undefined) alb.parental_warning = !!d.explicit;
    });
    for (const t of items) if (t?.album?.released_at && !t.released_at) t.released_at = t.album.released_at;
}

// tokens that failed the sessions probe — skip them so metadata keeps working anonymously
const badTokens = new Set<string>();

// ---------------- token refresh ----------------
// The Bearer JWT caps at ~7 days, but the OAuth session behind it carries a
// refresh token (browser localStorage on listen.tidal.com — same DevTools trip
// the user already makes for the Bearer). Store it once and we mint fresh
// access tokens indefinitely; Tidal rotates refresh tokens so each mint
// persists the replacement.
const TIDAL_SESSION_FILE = path.join(process.cwd(), 'data', 'tidal-session.json');
const TIDAL_CLIENT_ID = '8049';
let tidalRefreshing: Promise<string | null> | null = null;

function tidalSessionLoad(): { refresh_token?: string } | null {
    const raw = process.env.TIDAL_SESSION_JSON || (fs.existsSync(TIDAL_SESSION_FILE) ? fs.readFileSync(TIDAL_SESSION_FILE, 'utf-8') : null);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return { refresh_token: raw.trim().replace(/^"|"$/g, '') };
    }
}

function tidalSessionStore(fields: Record<string, string>) {
    try {
        fs.mkdirSync(path.dirname(TIDAL_SESSION_FILE), { recursive: true });
        fs.writeFileSync(TIDAL_SESSION_FILE, JSON.stringify(fields, null, 2));
    } catch {}
    // rotated refresh token persists in the settings store so restarts keep the session
    if (fields.refresh_token) {
        try {
            admin.setSetting('tidalRefreshToken', fields.refresh_token);
        } catch {}
        process.env.TIDAL_REFRESH_TOKEN = fields.refresh_token;
    }
    if (fields.access_token) {
        process.env.TIDAL_ACCESS_TOKEN = fields.access_token;
        try {
            admin.add('tidal', fields.access_token, 'auto-refresh');
        } catch {}
    }
}

export async function refreshTidalToken(): Promise<string | null> {
    tidalRefreshing ??= (async () => {
        try {
            const session = tidalSessionLoad();
            const refreshToken = getSetting('tidalRefreshToken') || session?.refresh_token || process.env.TIDAL_REFRESH_TOKEN;
            if (!refreshToken) return null;
            const res = await axios.post(
                'https://auth.tidal.com/v1/oauth2/token',
                new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: TIDAL_CLIENT_ID, scope: 'r_usr w_usr' }),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 }
            );
            const { access_token, refresh_token: newRefresh, expires_in } = res.data ?? {};
            if (!access_token) return null;
            badTokens.delete(access_token);
            tidalSessionStore({ access_token, refresh_token: newRefresh ?? refreshToken, expires_at: String(Date.now() + (expires_in ?? 0) * 1000) });
            return String(access_token);
        } catch {
            return null;
        } finally {
            setTimeout(() => (tidalRefreshing = null), 0);
        }
    })();
    return tidalRefreshing;
}

function headers(ctx: RequestContext): Record<string, string> {
    const token = pickToken('tidal') || ctx.tokens.tidalToken || process.env.TIDAL_ACCESS_TOKEN;
    if (token && !badTokens.has(token)) return { authorization: `Bearer ${token}`, 'User-Agent': UA };
    return { 'x-tidal-token': ANON_CLIENT_ID, 'User-Agent': UA };
}

export async function getTidalSession(ctx: RequestContext): Promise<{ countryCode: string; userId: number }> {
    // Round-robin through the server pool first, then any caller-supplied/env
    // token — a stale token shouldn't mask healthy ones behind it.
    const candidates = [pickToken('tidal'), ...tokensFor('tidal', 'TIDAL_ACCESS_TOKEN'), ctx.tokens.tidalToken].filter(
        (t, i, a): t is string => !!t && a.indexOf(t) === i
    );
    if (!candidates.length) throw new Error('Tidal requires your access token — add it in Settings → Service Tokens (or TIDAL_ACCESS_TOKEN env)');
    let expired = false;
    for (const token of candidates) {
        if (badTokens.has(token)) continue;
        const cached = sessionCache.get(token);
        if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached;
        try {
            const res = await axios.get(`${BASE}/sessions`, { headers: { authorization: `Bearer ${token}`, 'User-Agent': UA }, timeout: 15000 });
            const session = { countryCode: res.data.countryCode ?? 'US', userId: res.data.userId, at: Date.now() };
            sessionCache.set(token, session);
            ctx.tokens.tidalToken = token; // pin the working token for this request
            reportToken('tidal', token, true);
            return session;
        } catch (e: any) {
            if (e?.response?.status === 401 || /expired/i.test(e?.response?.data?.userMessage ?? '')) {
                badTokens.add(token);
                reportToken('tidal', token, false, 'token expired/invalid');
                expired = true;
                continue;
            }
            throw e;
        }
    }
    if (expired) {
        // Bearer died — mint a fresh one from the stored OAuth refresh token
        const fresh = await refreshTidalToken();
        if (fresh) {
            ctx.tokens.tidalToken = fresh;
            try {
                const res = await axios.get(`${BASE}/sessions`, { headers: { authorization: `Bearer ${fresh}`, 'User-Agent': UA }, timeout: 15000 });
                const session = { countryCode: res.data.countryCode ?? 'US', userId: res.data.userId, at: Date.now() };
                sessionCache.set(fresh, session);
                return session;
            } catch {
                // refresh produced a token the sessions endpoint rejected — fall through
            }
        }
        throw new Error("Tidal token expired — grab a fresh Bearer + the session's refresh token from listen.tidal.com DevTools (Application → Local Storage → oauth entry), and add it in the admin panel (double-click the corner dot)");
    }
    throw new Error('Tidal returned no usable session — add a Bearer token in the admin panel (double-click the corner dot)');
}

export async function resolveTidalTrack(trackId: string, quality: QualityId, ctx: RequestContext) {
    const { countryCode } = await getTidalSession(ctx);
    const wanted = quality === '27' ? ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'] : quality === '7' ? ['LOSSLESS', 'HIGH', 'LOW'] : ['HIGH', 'LOW'];
    let lastErr: any = null;
    for (const aq of wanted) {
        try {
            const res = await axios.get(`${BASE}/tracks/${trackId}/playbackinfopostpaywall/v4`, {
                params: { audioquality: aq, playbackmode: 'STREAM', assetpresentation: 'FULL', countryCode, prefetch: 'false' },
                headers: headers(ctx),
                timeout: 20000
            });
            const info = res.data;
            const raw = Buffer.from(info.manifest, 'base64').toString('utf8');
            if (info.manifestMimeType === 'application/vnd.tidal.bts') {
                const m = JSON.parse(raw);
                if (m.encryptionType && m.encryptionType !== 'NONE') continue;
                const url = m.urls?.[0];
                if (!url) continue;
                // mimeType says 'audio/mp4' even when the codec is FLAC inside
                // the container — trust the codecs field for the real format.
                const codecs = m.codecs ?? m.mimeType ?? '';
                const isFlac = /flac/i.test(codecs);
                return { url, format: (isFlac ? 'flac' : 'm4a') as 'flac' | 'm4a', direct: true };
            }
            if (info.manifestMimeType === 'application/dash+xml') {
                // fMP4 DASH container — but the codec may be FLAC (ffmpeg can't
                // remux that into mp4/ipod). Report the real codec as the format
                // so downstream picks .flac; demuxing fMP4→flac just works.
                const codec = raw.match(/codecs="([^"]+)"/)?.[1] ?? '';
                const fmt = /flac/i.test(codec) ? ('flac' as const) : ('mp4' as const);
                return { dashManifest: raw, format: fmt, direct: false };
            }
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr ?? new Error('Tidal returned no playable stream');
}

// Anonymous free-tier asset: Tidal's web player serves an mp3 preview without any
// account (the PREVIEW asset via the older v1 playbackinfo endpoint — postpaywall
// demands auth). Used when no session token exists — honest degraded quality.
export async function resolveTidalPreview(trackId: string): Promise<{ url: string; format: 'mp3' }> {
    const res = await axios.get(`${BASE}/tracks/${trackId}/playbackinfo`, {
        params: { assetpresentation: 'FULL', audioquality: 'LOW', playbackmode: 'STREAM', countryCode: 'US' },
        headers: { 'x-tidal-token': ANON_CLIENT_ID, 'User-Agent': UA },
        timeout: 15000
    });
    const info = res.data;
    const m = JSON.parse(Buffer.from(info.manifest, 'base64').toString('utf8'));
    const url = m.urls?.[0];
    if (!url) throw new Error('no anonymous Tidal preview for this track');
    return { url, format: 'mp3' };
}

export const tidalAdapter: PlatformAdapter = {
    source: 'tidal',

    async search(query, limit, offset, ctx) {
        const results = emptyResults(query);
        let countryCode = 'US';
        const token = ctx.tokens.tidalToken || process.env.TIDAL_ACCESS_TOKEN;
        if (token) countryCode = (await getTidalSession(ctx).catch(() => ({ countryCode: 'US' }))).countryCode;
        const m = query.match(/tidal\.com\/(?:browse\/)?(track|album|artist)\/(\d+)/);
        if (m) {
            try {
                if (m[1] === 'track') {
                    const t = (await axios.get(`${BASE}/tracks/${m[2]}`, { params: { countryCode }, headers: headers(ctx), timeout: 15000 })).data;
                    results.tracks = { limit, offset: 0, total: 1, items: [normTrack(t)] };
                } else if (m[1] === 'album') {
                    const a = (await axios.get(`${BASE}/albums/${m[2]}`, { params: { countryCode }, headers: headers(ctx), timeout: 15000 })).data;
                    results.albums = { limit, offset: 0, total: 1, items: [normAlbum(a)] };
                } else {
                    const a = (await axios.get(`${BASE}/artists/${m[2]}`, { params: { countryCode }, headers: headers(ctx), timeout: 15000 })).data;
                    results.artists = { limit, offset: 0, total: 1, items: [normArtist(a)] };
                }
                (results as any).switchTo = m[1] === 'track' ? 'tracks' : m[1] === 'album' ? 'albums' : 'artists';
                return results;
            } catch {}
        }
        const res = await axios.get(`${BASE}/search`, {
            params: { query, types: 'ARTISTS,ALBUMS,TRACKS', countryCode, limit, offset },
            headers: headers(ctx),
            timeout: 15000
        });
        const d = res.data;
        const trackItems = (d.tracks?.items ?? []).map((t: any) => normTrack(t));
        await enrichTrackAlbums(trackItems, countryCode, ctx);
        results.tracks = { limit, offset, total: d.tracks?.totalNumberOfItems ?? 0, items: trackItems };
        results.albums = { limit, offset, total: d.albums?.totalNumberOfItems ?? 0, items: (d.albums?.items ?? []).map((a: any) => normAlbum(a)) };
        const artistItems = (d.artists?.items ?? []).map((a: any) => normArtist(a));
        // search artist nodes carry no release count — one light call per card
        await mapLimit(artistItems, 4, async (a: any) => {
            const r = await axios
                .get(`${BASE}/artists/${a.id}/albums`, { params: { countryCode, limit: 1 }, headers: headers(ctx), timeout: 15000 })
                .catch(() => null);
            if (r?.data?.totalNumberOfItems != null) a.albums_count = r.data.totalNumberOfItems;
        });
        results.artists = { limit, offset, total: d.artists?.totalNumberOfItems ?? 0, items: artistItems };
        if (m) (results as any).switchTo = m[1] === 'track' ? 'tracks' : m[1] === 'album' ? 'albums' : 'artists';
        return results;
    },

    async getAlbumInfo(albumId, ctx) {
        const session = await getTidalSession(ctx).catch(() => ({ countryCode: ctx.country ?? 'US', userId: 0 }));
        const [a, t] = await Promise.all([
            axios.get(`${BASE}/albums/${albumId}`, { params: { countryCode: session.countryCode }, headers: headers(ctx), timeout: 15000 }),
            axios.get(`${BASE}/albums/${albumId}/tracks`, { params: { countryCode: session.countryCode, limit: 100 }, headers: headers(ctx), timeout: 15000 })
        ]);
        const album = normAlbum(a.data) as FetchedQobuzAlbum;
        album.full = true;
        let items = t.data?.items ?? [];
        let offset = items.length;
        while (items.length < (t.data?.totalNumberOfItems ?? 0) && offset < 500) {
            const page = await axios
                .get(`${BASE}/albums/${albumId}/tracks`, { params: { countryCode: session.countryCode, limit: 100, offset }, headers: headers(ctx), timeout: 15000 })
                .catch(() => null);
            if (!page?.data?.items?.length) break;
            items = items.concat(page.data.items);
            offset += page.data.items.length;
        }
        album.tracks = { offset: 0, limit: items.length, total: items.length, items: items.map((x: any) => normTrack(x, normAlbum(a.data))) };
        return album;
    },

    async getArtist(artistId, ctx) {
        const session = await getTidalSession(ctx).catch(() => ({ countryCode: ctx.country ?? 'US', userId: 0 }));
        const res = await axios.get(`${BASE}/artists/${artistId}`, { params: { countryCode: session.countryCode }, headers: headers(ctx), timeout: 15000 });
        const a = res.data;
        const out = emptyArtistResults();
        out.id = a.id;
        out.name = { display: a.name };
        out.image = a.picture ? { small: tidalImg(a.picture, 320) } : null;
        const top = await axios.get(`${BASE}/artists/${artistId}/toptracks`, { params: { countryCode: session.countryCode, limit: 50 }, headers: headers(ctx), timeout: 15000 }).catch(() => null);
        out.top_tracks = (top?.data?.items ?? []).map((t: any) => normTrack(t));
        const rel = await axios.get(`${BASE}/artists/${artistId}/albums`, { params: { countryCode: session.countryCode, limit: 100 }, headers: headers(ctx), timeout: 15000 }).catch(() => null);
        out.releases.album = { has_more: (rel?.data?.totalNumberOfItems ?? 0) > (rel?.data?.items?.length ?? 0), items: (rel?.data?.items ?? []).map((x: any) => normAlbum(x)) };
        out.albums_count = rel?.data?.totalNumberOfItems ?? 0;
        return { artist: out };
    },

    async getArtistReleases(artistId, releaseType, limit, offset, ctx) {
        const session = await getTidalSession(ctx).catch(() => ({ countryCode: ctx.country ?? 'US', userId: 0 }));
        const filter = releaseType === 'epSingle' ? 'EPSANDSINGLES' : releaseType === 'compilation' ? 'COMPILATIONS' : 'ALBUMS';
        const res = await axios.get(`${BASE}/artists/${artistId}/albums`, {
            params: { countryCode: session.countryCode, limit, offset, filter },
            headers: headers(ctx),
            timeout: 15000
        });
        return { items: (res.data?.items ?? []).map((a: any) => normAlbum(a)), has_more: (res.data?.totalNumberOfItems ?? 0) > offset + limit };
    },

    async getDownloadURL(trackId, quality, _ctx, _hint?: DownloadHint): Promise<DownloadInfo> {
        return { url: `/api/stream-audio?source=tidal&id=${encodeURIComponent(trackId)}&quality=${quality}` };
    }
};

export default tidalAdapter;
