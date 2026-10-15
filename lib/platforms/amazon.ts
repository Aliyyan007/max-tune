import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { baseAlbum, baseArtist, baseTrack, emptyArtistResults, emptyResults, proxiedImg, toEpochSeconds, toDateString } from './normalize';
import type { DownloadHint, DownloadInfo, PlatformAdapter, RequestContext } from './types';
import type { FetchedQobuzAlbum, QobuzTrack } from '@/lib/qobuz-dl';

// Amazon Music Unlimited real audio: FLAC HD (16/44.1-48) up to UltraHD (24/96-192)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const GATEWAY = 'https://amz.dezalty.com'; // hosted Amazon Music API â€” the amz CLI's backend

type AmazonConfig = { accessToken: string; deviceId: string; sessionId: string; version: string; csrf: { token: string; ts: string; rnd: string }; at: number };
let cfg: AmazonConfig | null = null;

// Optional SOCKS5 proxy â€” Amazon's anonymous catalog API geo-rejects unsupported regions
function amazonAxiosOpts() {
    const proxy = process.env.SOCKS5_PROXY;
    if (proxy) {
        try {
            const agent = new SocksProxyAgent(proxy);
            return { httpAgent: agent, httpsAgent: agent };
        } catch {}
    }
    return {};
}

async function getConfig(): Promise<AmazonConfig> {
    if (cfg && Date.now() - cfg.at < 30 * 60 * 1000) return cfg;
    const res = await axios.get('https://music.amazon.com/config.json', {
        headers: { Origin: 'https://music.amazon.com', Referer: 'https://music.amazon.com/', 'User-Agent': UA },
        timeout: 15000,
        ...amazonAxiosOpts()
    });
    cfg = { ...res.data, at: Date.now() };
    return cfg!;
}

// ------------------ gateway (account token) ------------------

const amazonToken = (ctx: RequestContext) => ctx.tokens.amazonToken || process.env.AMAZON_MUSIC_TOKEN || '';

// The JWT caps at 30d, but the exported website cookies live for months — store the
// session export once (data/amazon-session.json) and re-mint fresh JWTs on 401s.
const SESSION_FILE = path.join(process.cwd(), 'data', 'amazon-session.json');
let refreshing: Promise<string | null> | null = null;

function storeToken(token: string) {
    process.env.AMAZON_MUSIC_TOKEN = token;
    try {
        const envPath = path.join(process.cwd(), '.env');
        let c = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
        if (/^AMAZON_MUSIC_TOKEN=/m.test(c)) c = c.replace(/^AMAZON_MUSIC_TOKEN=.*/m, `AMAZON_MUSIC_TOKEN=${token}`);
        else c = c.trimEnd() + `\nAMAZON_MUSIC_TOKEN=${token}\n`;
        fs.writeFileSync(envPath, c);
    } catch {}
}

export async function refreshAmazonToken(): Promise<string | null> {
    refreshing ??= (async () => {
        try {
            if (!fs.existsSync(SESSION_FILE)) return null;
            const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
            const cookies = session.website_cookies;
            if (!cookies || typeof cookies !== 'object') return null;
            const res = await axios.post(
                `${GATEWAY}/auth/login`,
                { content: JSON.stringify(cookies), format: 'json', expires_in: 2592000 },
                { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
            );
            const newToken = res.data?.data?.access_token ?? res.data?.access_token ?? res.data?.token;
            if (!newToken) return null;
            storeToken(String(newToken));
            return String(newToken);
        } catch {
            return null;
        } finally {
            // release the lock on the next tick so the in-flight retry uses the fresh token
            setTimeout(() => (refreshing = null), 0);
        }
    })();
    return refreshing;
}

// Snapshot the gateway's Amazon session once per token — the exported cookies
// are what let us re-mint JWTs long after the current one expires.
let sessionExportedFor: string | null = null;
async function ensureSessionExport(token: string) {
    if (sessionExportedFor === token || fs.existsSync(SESSION_FILE)) {
        sessionExportedFor ??= token;
        return;
    }
    try {
        const res = await axios.get(`${GATEWAY}/auth/export`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
        const data = res.data;
        if (data?.website_cookies || data?.refresh_token) {
            fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
            fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
            sessionExportedFor = token;
        }
    } catch {}
}

async function gwGet(path: string, params: Record<string, any>, token: string, retried = false): Promise<any> {
    try {
        const res = await axios.get(`${GATEWAY}${path}`, {
            params,
            headers: { Authorization: `Bearer ${token}` },
            timeout: 30000
        });
        const d = res.data;
        void ensureSessionExport(token);
        return d?.data ?? d; // gateway wraps payloads in {data: ...}
    } catch (e: any) {
        const status = e?.response?.status;
        if ((status === 401 || status === 422) && !retried) {
            const fresh = await refreshAmazonToken();
            if (fresh && fresh !== token) return gwGet(path, params, fresh, true);
            throw new Error('Amazon token expired — get a fresh session JWT at amz.dezalty.com');
        }
        if (status === 401 || status === 422) throw new Error('Amazon token expired — get a fresh session JWT at amz.dezalty.com');
        if (status === 403) throw new Error('Amazon rejected this token — the linked account needs Amazon Music Unlimited');
        throw new Error(`Amazon gateway error ${status ?? ''}: ${e?.response?.data?.detail?.message ?? e?.message ?? 'unknown'}`);
    }
}

// Honest per-item quality from the gateway's contentEncoding flags (real Amazon capabilities)
function amazonQuality(enc: string[] | undefined) {
    if (Array.isArray(enc) && enc.includes('uhdAvailable')) return { maximum_bit_depth: 24, maximum_sampling_rate: 192, hires: true, audio_label: 'FLAC UltraHD · up to 24-bit/192kHz' };
    if (Array.isArray(enc) && enc.includes('hdAvailable')) return { maximum_bit_depth: 16, maximum_sampling_rate: 44.1, hires: true, audio_label: 'FLAC HD · 16-bit/44.1kHz+' };
    return { maximum_bit_depth: 16, maximum_sampling_rate: 44.1, hires: false, audio_label: 'FLAC HD/UltraHD · up to 24-bit/192 kHz' };
}

function amazonGenre(g: any) {
    const name = typeof g === 'string' ? g : g?.name ?? '';
    return { path: [], color: '', name, id: 0 };
}

// Normalize any Amazon catalog object (gateway or widget-template item) into our track shape
function normAmazonTrack(t: any): QobuzTrack | null {
    // widget shape: primaryText.{text}, secondaryText (artist string), iconButton.observer.storageKey = "albumAsin:trackAsin"
    let asin = t.asin ?? t.ASIN ?? t.identifier ?? t.id;
    let albumAsin = t.albumAsin ?? t.album?.asin ?? t.album?.id;
    const storageKey = t.iconButton?.observer?.storageKey;
    if (!asin && storageKey) [albumAsin, asin] = String(storageKey).split(':');
    const title = t.title ?? t.trackTitle ?? t.name ?? t.primaryText?.text ?? t.primaryText;
    const artist = t.artist ?? t.artistName ?? t.artists?.[0]?.name ?? t.secondaryText?.text ?? t.secondaryText ?? '';
    // gateway shape guards: a real track has duration + its own artist/album context; albums
    // carry track_count/release_date, artists carry only name+image — reject those nodes
    const looksLikeTrack = t.duration != null || t.duration_seconds != null || t.track_num != null || t.trackNum != null || t.album != null || t.isrc != null || t.iconButton?.observer?.storageKey != null;
    const looksLikeContainer = t.track_count != null || t.tracks != null || (t.artist == null && t.artists == null && t.secondaryText == null && t.primaryText == null);
    if (!title || !asin || !looksLikeTrack || looksLikeContainer) return null;
    const artistName = typeof artist === 'string' ? artist : artist?.name ?? artist?.text ?? '';
    const artistId = t.artist?.asin ?? t.artist?.id ?? t.artists?.[0]?.asin ?? t.artists?.[0]?.id ?? t.secondaryLink?.deeplink?.split('/artists/')[1]?.split('/')[0] ?? 0;
    const dur =
        (t.duration ??
        t.duration_seconds ??
        t.durationInSeconds ??
        Math.round((t.durationMS ?? 0) / 1000)) ||
        (t.secondaryText3 ? String(t.secondaryText3).split(':').reduce((s: number, p: string) => s * 60 + (parseInt(p) || 0), 0) : 0);
    const art = t.image ?? t.albumArt ?? t.artwork ?? t.cover;
    const artUrl = typeof art === 'string' ? art : art?.url ?? art?.[0]?.url ?? '';
    const albumTitle = t.album?.title ?? t.album?.name ?? t.albumTitle ?? t.contextMenu?.options?.[0]?.onItemSelected?.[1]?.template?.headerText?.text ?? String(title);
    const releasedAt = toEpochSeconds(t.original_release_date ?? t.release_date ?? t.releaseDate);
    const album = baseAlbum({
        source: 'amazon',
        id: String(albumAsin ?? asin),
        title: albumTitle,
        released_at: releasedAt,
        artists: [{ id: artistId, name: artistName, roles: ['MainArtist'] }],
        artist: { image: null, name: artistName, id: artistId, albums_count: 0 },
        image: { small: proxiedImg(artUrl), thumbnail: proxiedImg(artUrl), large: proxiedImg(artUrl), back: null },
        genre: amazonGenre(t.genre),
        ...amazonQuality(t.contentEncoding)
    });
    return baseTrack({
        source: 'amazon',
        id: String(asin),
        title: String(title),
        duration: dur || 0,
        track_number: Number(t.track_num ?? t.trackNum ?? t.trackNumber ?? t.track_number ?? 0) || 0,
        media_number: Number(t.disc_num ?? t.discNum ?? t.discNumber ?? 1) || 1,
        parental_warning: Boolean(t.explicit ?? t.isExplicit ?? t.parental_warning),
        isrc: t.isrc ?? null,
        released_at: releasedAt,
        composer: Array.isArray(t.songWriters) && t.songWriters.length ? { name: t.songWriters.join(', '), id: 0 } : undefined,
        performer: { name: artistName || 'Unknown', id: artistId },
        album,
        ...amazonQuality(t.contentEncoding),
        streamable: true
    });
}

function normAmazonAlbum(a: any) {
    const asin = a.asin ?? a.id;
    const art = a.image ?? a.artwork ?? a.cover;
    const artUrl = typeof art === 'string' ? art : art?.url ?? art?.[0]?.url ?? '';
    const title = a.title ?? a.name ?? a.primaryText?.text ?? a.primaryText ?? '';
    const artistName = a.artist?.name ?? a.artists?.[0]?.name ?? a.artistName ?? a.secondaryText ?? '';
    const artistId = a.artist?.asin ?? a.artist?.id ?? a.artists?.[0]?.asin ?? a.artists?.[0]?.id ?? a.secondaryLink?.deeplink?.split('/artists/')[1]?.split('/')[0] ?? 0;
    // gateway albums have `title`+artist/track_count (and detail adds duration+tracks[]);
    // artist nodes (title:null, name only) and bare track nodes leak through collect() — reject both
    const looksLikeAlbum = a.title != null || a.primaryText != null || a.track_count != null || a.release_date != null || a.releaseDate != null;
    const isTrackNode = a.isrc != null || (a.duration != null && a.tracks == null && a.total_tracks == null && a.track_count == null);
    const isArtistNode = a.title == null && a.name != null && a.artist == null;
    if (!asin || !title || !looksLikeAlbum || isTrackNode || isArtistNode) return null;
    const releasedAt = toEpochSeconds(a.release_date ?? a.releaseDate);
    return baseAlbum({
        source: 'amazon',
        id: String(asin),
        title: String(title),
        tracks_count: Number(a.track_count ?? a.trackCount ?? a.total_tracks ?? (Array.isArray(a.tracks) ? a.tracks.length : 0)) || 0,
        released_at: releasedAt,
        release_date_original: toDateString(a.release_date ?? a.releaseDate),
        parental_warning: Boolean(a.explicit),
        genre: amazonGenre(a.genre),
        image: { small: proxiedImg(artUrl), thumbnail: proxiedImg(artUrl), large: proxiedImg(artUrl), back: null },
        artist: { image: null, name: String(artistName), id: artistId, albums_count: 0 },
        artists: [{ id: artistId, name: String(artistName), roles: ['MainArtist'] }],
        ...amazonQuality(a.contentEncoding)
    });
}

function normAmazonArtist(a: any) {
    const id = a.asin ?? a.id;
    const name = a.name ?? a.title ?? a.primaryText?.text ?? a.primaryText ?? '';
    const art = a.image ?? a.artwork;
    const artUrl = typeof art === 'string' ? art : art?.url ?? art?.[0]?.url ?? '';
    if (!id || !name) return null;
    return baseArtist({ source: 'amazon', id: String(id), name: String(name), albums_count: 0, image: artUrl ? { small: proxiedImg(artUrl), medium: proxiedImg(artUrl), large: proxiedImg(artUrl), extralarge: proxiedImg(artUrl), mega: proxiedImg(artUrl) } : null });
}

// Deep-walk any response shape and collect normalized items
function* walk(node: any): Generator<any> {
    if (!node || typeof node !== 'object') return;
    yield node;
    for (const v of Object.values(node)) {
        if (Array.isArray(v)) for (const item of v) yield* walk(item);
        else if (v && typeof v === 'object') yield* walk(v);
    }
}

function collect<T>(data: any, norm: (x: any) => T | null, cap = 50): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const node of walk(data)) {
        const t = norm(node);
        if (t) {
            const key = (t as any).id + ':' + ((t as any).title ?? (t as any).name ?? '');
            if (!seen.has(key)) {
                seen.add(key);
                out.push(t);
                if (out.length >= cap) break;
            }
        }
    }
    return out;
}

// ------------------ anonymous catalog API (region-dependent) ------------------

// Region hosts â€” mesk.skill works on eu; web.skill is the newer generation
const AMAZON_HOSTS = ['eu.mesk.skill.music.a2z.com', 'na.web.skill.music.a2z.com', 'eu.web.skill.music.a2z.com'];

function amznHeaders(c: AmazonConfig, pageUrl: string): string {
    const rand13 = () =>
        Array.from({ length: 13 }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)]).join('');
    return JSON.stringify({
        'x-amzn-authentication': JSON.stringify({ interface: 'ClientAuthenticationInterface.v1_0.ClientTokenElement', accessToken: c.accessToken }),
        'x-amzn-device-model': 'WEBPLAYER',
        'x-amzn-device-width': '1920',
        'x-amzn-device-family': 'WebPlayer',
        'x-amzn-device-id': c.deviceId,
        'x-amzn-user-agent': UA,
        'x-amzn-session-id': c.sessionId,
        'x-amzn-device-height': '1080',
        'x-amzn-request-id': rand13(),
        'x-amzn-device-language': 'en_US',
        'x-amzn-currency-of-preference': 'USD',
        'x-amzn-os-version': '1.0',
        'x-amzn-application-version': c.version ?? '',
        'x-amzn-device-time-zone': 'Asia/Calcutta',
        'x-amzn-timestamp': String(Date.now()),
        'x-amzn-csrf': JSON.stringify({
            interface: 'CSRFInterface.v1_0.CSRFHeaderElement',
            token: c.csrf?.token ?? '',
            timestamp: String(c.csrf?.ts ?? ''),
            rndNonce: String(c.csrf?.rnd ?? '')
        }),
        'x-amzn-music-domain': 'music.amazon.com',
        'x-amzn-referer': 'music.amazon.com',
        'x-amzn-affiliate-tags': '',
        'x-amzn-ref-marker': '',
        'x-amzn-page-url': pageUrl,
        'x-amzn-weblab-id-overrides': '',
        'x-amzn-video-player-token': '',
        'x-amzn-feature-flags': 'hd-supported,uhd-supported',
        'x-amzn-has-profile-id': '',
        'x-amzn-age-band': ''
    });
}

const ANON_HEADERS = {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'text/plain;charset=UTF-8',
    origin: 'https://music.amazon.com',
    priority: 'u=1, i',
    referer: 'https://music.amazon.com/',
    'sec-ch-ua': '"Chromium";v="125", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'user-agent': UA
};

async function amazonApi(endpoint: string, payload: Record<string, any>): Promise<any> {
    for (const host of AMAZON_HOSTS) {
        try {
            const res = await axios.post(`https://${host}/api/${endpoint}`, payload, {
                headers: { ...ANON_HEADERS, authority: host },
                timeout: 15000,
                ...amazonAxiosOpts()
            });
            const d = res.data;
            // "Service error" dialog template = rejection, not results
            const tpl = d?.methods?.[0]?.template;
            if (tpl?.interface?.includes('DialogTemplate')) continue;
            return d;
        } catch {
            continue;
        }
    }
    return null;
}

async function amazonSearchAnon(query: string, limit: number): Promise<QobuzTrack[]> {
    const c = await getConfig();
    const body = {
        keyword: query,
        userHash: JSON.stringify({ level: 'LIBRARY_MEMBER' }),
        headers: amznHeaders(c, `https://music.amazon.com/search/${encodeURIComponent(query)}/songs`)
    };
    const data = await amazonApi('searchCatalogTracks', body);
    const items = data?.methods?.[0]?.template?.widgets?.[0]?.items ?? data?.methods?.[0]?.items ?? [];
    const tracks: QobuzTrack[] = [];
    for (const item of items) {
        const t = normAmazonTrack(item);
        if (t && tracks.length < limit) tracks.push(t);
    }
    if (!tracks.length) for (const node of walk(data)) {
        const t = normAmazonTrack(node);
        if (t && tracks.length < limit) tracks.push(t);
    }
    return tracks;
}

// ------------------ adapter ------------------

export const amazonAdapter: PlatformAdapter = {
    source: 'amazon',

    async search(query, limit, offset, ctx) {
        const results = emptyResults(query);
        const token = amazonToken(ctx);
        if (token) {
            // account-backed catalog â€” full Amazon view incl. albums & artists
            const [tracks, albums, artists] = await Promise.allSettled([
                gwGet('/search', { query, content_type: 'track', max_results: Math.max(limit, 25) }, token),
                gwGet('/search', { query, content_type: 'album', max_results: Math.max(limit, 25) }, token),
                gwGet('/search', { query, content_type: 'artist', max_results: Math.max(limit, 25) }, token)
            ]);
            if (tracks.status === 'fulfilled' && tracks.value) {
                const items = collect(tracks.value, normAmazonTrack, 50);
                results.tracks = { limit, offset, total: items.length ? Math.max(items.length, offset + items.length + limit) : 0, items: items.slice(offset, offset + limit) };
            }
            if (albums.status === 'fulfilled' && albums.value) {
                const items = collect(albums.value, normAmazonAlbum, 50);
                results.albums = { limit, offset, total: items.length, items: items.slice(offset, offset + limit) };
            }
            if (artists.status === 'fulfilled' && artists.value) {
                const items = collect(artists.value, normAmazonArtist, 50);
                results.artists = { limit, offset, total: items.length, items: items.slice(offset, offset + limit) };
            }
            if (!results.tracks.items.length && tracks.status === 'rejected') throw tracks.reason;
            return results;
        }
        // anonymous widget-template API (geo-gated)
        const items = await amazonSearchAnon(query, limit + offset);
        if (!items.length)
            throw new Error(
                'Amazon Music search needs an account token in this region â€” get one at amz.dezalty.com (log in with your Amazon Music Unlimited account), then paste it in Settings â†’ Service Tokens'
            );
        results.tracks = { limit, offset, total: Math.max(items.length, offset + limit + 1), items: items.slice(offset, offset + limit) };
        return results;
    },

    async getAlbumInfo(albumId, ctx) {
        const token = amazonToken(ctx);
        if (!token) throw new Error('Amazon album details need an account token (Settings â†’ Service Tokens â†’ amz.dezalty.com)');
        const data = await gwGet(`/albums/${encodeURIComponent(albumId)}`, {}, token);
        // Gateway album detail: {asin, title, image, artist{name,asin}, explicit, genre, tracks[]}
        const album = (normAmazonAlbum(data) ?? baseAlbum({ source: 'amazon', id: albumId, title: String(data?.title ?? 'Amazon Album') })) as FetchedQobuzAlbum;
        const albumArt = album.image?.large ?? '';
        const albumAsin = String(albumId);
        const trackList: QobuzTrack[] = (Array.isArray(data?.tracks) ? data.tracks : collect(data, (x) => x, 400))
            .map((t: any) => {
                const tr = normAmazonTrack({ ...t, album: { asin: albumAsin, name: album.title, id: albumAsin } });
                if (tr) {
                    // detail tracks omit artwork — inherit the album cover so cards/dialogs render
                    if (albumArt && !tr.album?.image?.large) tr.album.image = { small: proxiedImg(albumArt), thumbnail: proxiedImg(albumArt), large: proxiedImg(albumArt), back: null };
                    if (!tr.performer?.name || tr.performer.name === 'Unknown') tr.performer.name = album.artist?.name ?? tr.performer.name;
                }
                return tr;
            })
            .filter(Boolean) as QobuzTrack[];
        album.full = true;
        album.id = albumAsin;
        album.tracks_count = trackList.length || album.tracks_count;
        album.duration = trackList.reduce((s, t) => s + (t.duration ?? 0), 0);
        if (!album.genre?.name && trackList[0]?.album?.genre?.name) album.genre = trackList[0].album.genre;
        album.tracks = { offset: 0, limit: trackList.length, total: trackList.length, items: trackList };
        return album;
    },

    async getArtist(artistId, ctx, artistName) {
        const token = amazonToken(ctx);
        const out = emptyArtistResults();
        out.id = artistId;
        if (!token) {
            out.name = { display: artistName ?? 'Amazon Artist' };
            return { artist: out };
        }
        // /artists/{asin} is unfinished upstream (returns nulls) — the card supplies the name;
        // search by it, then keep only releases/tracks whose artist id is this asin
        const name = artistName?.trim() || String(artistId);
        const [artistSearch, albums2, tracks2] = await Promise.allSettled([
            gwGet('/search', { query: name, content_type: 'artist', max_results: 50 }, token),
            gwGet('/search', { query: name, content_type: 'album', max_results: 100 }, token),
            gwGet('/search', { query: name, content_type: 'track', max_results: 50 }, token)
        ]);
        const artistsRaw = artistSearch.status === 'fulfilled' ? collect(artistSearch.value, normAmazonArtist, 50) : [];
        const me = artistsRaw.find(a => String(a.id) === String(artistId)) ?? artistsRaw.find(a => a.name === name) ?? artistsRaw[0];
        const byThisArtist = (x: any) => String(x?.artist?.id) === String(artistId) || String(x?.performer?.id) === String(artistId) || x?.artist?.name === me?.name;
        const albums = albums2.status === 'fulfilled' ? collect(albums2.value, normAmazonAlbum, 100).filter((a: any) => byThisArtist(a)) : [];
        const tracks = tracks2.status === 'fulfilled' ? collect(tracks2.value, normAmazonTrack, 50).filter((t: any) => byThisArtist(t)) : [];
        out.name = { display: me?.name ?? name };
        if (me?.image) out.image = me.image;
        out.albums_count = albums.length;
        out.top_tracks = tracks.slice(0, 10);
        out.releases.album = { has_more: false, items: albums.filter((a: any) => (a.tracks_count ?? 99) > 3) };
        out.releases.epSingle = { has_more: false, items: albums.filter((a: any) => (a.tracks_count ?? 99) <= 3) };
        return { artist: out };
    },

    async getArtistReleases(artistId, releaseType, limit, offset, ctx, artistName) {
        const { artist } = await this.getArtist(artistId, ctx, artistName);
        const items = releaseType === 'epSingle' ? artist.releases.epSingle.items : releaseType === 'album' ? artist.releases.album.items : [];
        return { items: items.slice(offset, offset + limit), has_more: offset + limit < items.length };
    },

    async getDownloadURL(trackId, quality, ctx, hint?: DownloadHint): Promise<DownloadInfo> {
        const token = amazonToken(ctx);
        if (!token) throw new Error('Amazon Music requires an account token â€” get one at amz.dezalty.com (log in with your Amazon account), then paste it in Settings â†’ Service Tokens');
        const params = new URLSearchParams({ source: 'amazon-native', id: trackId, quality, title: hint?.title ?? '', artist: hint?.artist ?? '' });
        if (hint?.duration) params.set('dur', String(hint.duration));
        return { url: `/api/stream-audio?${params}`, format: 'flac' };
    }
};

export default amazonAdapter;
