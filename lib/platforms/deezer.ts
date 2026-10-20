import axios from 'axios';
import { pickToken, reportToken } from '@/lib/token-pool';
import crypto from 'node:crypto';
import { Blowfish } from 'egoroof-blowfish';
import { baseAlbum, baseArtist, baseTrack, emptyArtistResults, emptyResults, proxiedImg, toDateString, toEpochSeconds } from './normalize';
import type { DownloadHint, DownloadInfo, PlatformAdapter, QualityId, RequestContext } from './types';
import type { FetchedQobuzAlbum, QobuzAlbum, QobuzTrack } from '@/lib/qobuz-dl';

const PUBLIC_API = 'https://api.deezer.com';
const GW = 'https://www.deezer.com/ajax/gw-light.php';
const BLOWFISH_SECRET = 'g4el58wc0zvf9na1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

type DeezerSession = {
    arl: string;
    checkForm: string;
    licenseToken: string;
    country: string;
    webHq: boolean;
    webLossless: boolean;
    cookies: Map<string, string>;
    expiresAt: number;
};

const sessions = new Map<string, Promise<DeezerSession>>();

function coverUrl(md5: string | undefined, size: string): string {
    if (!md5) return '';
    return proxiedImg(`https://cdn-images.dzcdn.net/images/cover/${md5}/${size}-000000-80-0-0.jpg`);
}

// Bounded parallelism for per-item detail fetches (search payloads are light —
// release_date/duration/genre live on the album detail object).
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

// Search album nodes lack release_date/duration/genre — one detail call per
// card, bounded, so the UI shows the same stats Qobuz cards do.
const albumDetail = async (id: string) =>
    (await axios.get(`${PUBLIC_API}/album/${id}`, { timeout: 15000 }).catch(() => null))?.data;
async function enrichAlbum(alb: any): Promise<void> {
    const d = await albumDetail(alb.id);
    if (!d?.id) return;
    alb.duration = parseInt(d.duration) || alb.duration;
    alb.released_at = toEpochSeconds(d.release_date) || alb.released_at;
    alb.release_date_original = toDateString(d.release_date) || alb.release_date_original;
    alb.tracks_count = d.nb_tracks || alb.tracks_count;
    if (d.genres?.data?.[0]?.name) alb.genre = { path: [], color: '', name: d.genres.data[0].name, id: 0 };
    if (d.label) alb.label = { name: d.label, id: 0, albums_count: 0 };
    if (d.upc) alb.upc = d.upc;
    if (d.explicit_lyrics !== undefined) alb.parental_warning = !!d.explicit_lyrics;
}
// Tracks embed a light album stub (cover+title only) — patch the same stats in
// so track cards/dialogs render complete metadata.
async function enrichTrackAlbums(items: any[]): Promise<void> {
    const byAlbum = new Map<string, any>();
    for (const t of items) if (t?.album?.id && !byAlbum.has(String(t.album.id))) byAlbum.set(String(t.album.id), t.album);
    await mapLimit([...byAlbum.keys()], 4, async (id) => {
        const alb = byAlbum.get(id)!;
        await enrichAlbum(alb);
    });
    for (const t of items) if (t?.album?.released_at && !t.released_at) t.released_at = t.album.released_at;
}

function normAlbum(a: any): QobuzAlbum {
    return baseAlbum({
        source: 'deezer',
        id: String(a.id ?? a.ALB_ID ?? ''),
        title: a.title ?? a.ALB_TITLE ?? '',
        version: null,
        duration: parseInt(a.duration ?? a.DURATION ?? '0') || 0,
        tracks_count: a.nb_tracks ?? a.NUMBER_TRACK ?? 0,
        released_at: toEpochSeconds(a.release_date ?? a.PHYSICAL_RELEASE_DATE),
        release_date_original: toDateString(a.release_date ?? a.PHYSICAL_RELEASE_DATE),
        parental_warning: !!(a.explicit_lyrics ?? a.EXPLICIT_LYRICS),
        image: {
            small: a.cover_medium ? proxiedImg(a.cover_medium) : coverUrl(a.md5_image ?? a.ALB_PICTURE, '250x250'),
            thumbnail: a.cover_small ? proxiedImg(a.cover_small) : coverUrl(a.md5_image ?? a.ALB_PICTURE, '56x56'),
            large: a.cover_xl ? proxiedImg(a.cover_xl) : coverUrl(a.md5_image ?? a.ALB_PICTURE, '1000x1000'),
            back: null
        },
        artist: {
            image: null,
            name: a.artist?.name ?? a.ART_NAME ?? '',
            id: a.artist?.id ?? a.ART_ID ?? 0,
            albums_count: 0
        },
        artists: a.artist
            ? [{ id: a.artist.id, name: a.artist.name, roles: ['MainArtist'] }]
            : (a.contributors ?? []).map((c: any) => ({ id: c.id, name: c.name, roles: [c.role ?? 'MainArtist'] })),
        genre: { path: [], color: '', name: a.genres?.data?.[0]?.name ?? a.genre_name ?? '', id: 0 },
        label: { name: a.label ?? '', id: 0, albums_count: 0 },
        upc: a.upc ?? '',
        hires: false,
        audio_label: 'FLAC / MP3 by plan',
        streamable: true,
        _type: a.record_type
    });
}

function normTrack(t: any, album?: QobuzAlbum): QobuzTrack {
    const albumObj =
        album ??
        baseAlbum({
            source: 'deezer',
            id: String(t.album?.id ?? ''),
            title: t.album?.title ?? '',
            image: {
                small: t.album?.cover_medium ? proxiedImg(t.album.cover_medium) : coverUrl(t.album?.md5_image ?? t.md5_image, '250x250'),
                thumbnail: t.album?.cover_small ? proxiedImg(t.album.cover_small) : '',
                large: t.album?.cover_xl ? proxiedImg(t.album.cover_xl) : coverUrl(t.album?.md5_image ?? t.md5_image, '1000x1000'),
                back: null
            },
            artist: { image: null, name: t.artist?.name ?? '', id: t.artist?.id ?? 0, albums_count: 0 },
            artists: t.artist ? [{ id: t.artist.id, name: t.artist.name, roles: ['MainArtist'] }] : [],
            released_at: toEpochSeconds(t.album?.release_date),
            release_date_original: toDateString(t.album?.release_date)
        });
    return baseTrack({
        source: 'deezer',
        id: t.id,
        title: t.title_short ?? t.title ?? '',
        version: t.title_version ? t.title_version.replace(/^\(|\)$/g, '') : null,
        duration: parseInt(t.duration) || 0,
        track_number: t.track_position ?? t.track_number ?? 0,
        media_number: t.disk_number ?? t.media_number ?? 1,
        isrc: t.isrc ?? null,
        parental_warning: !!(t.explicit_lyrics || t.explicit_content_lyrics === 1),
        performer: { name: t.artist?.name ?? 'Unknown', id: t.artist?.id ?? 0 },
        released_at: albumObj.released_at,
        album: albumObj,
        audio_label: 'FLAC / MP3 by plan',
        streamable: t.readable !== false
    });
}

function normArtist(a: any) {
    return baseArtist({
        source: 'deezer',
        id: a.id,
        name: a.name ?? '',
        albums_count: a.nb_album ?? undefined,
        image: a.picture_medium ? { small: proxiedImg(a.picture_medium), medium: proxiedImg(a.picture_medium), large: proxiedImg(a.picture_big), extralarge: proxiedImg(a.picture_xl), mega: proxiedImg(a.picture_xl) } : null
    });
}

// ---------- gateway / session ----------

function cookieHeader(cookies: Map<string, string>): string {
    return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function mergeCookies(cookies: Map<string, string>, setCookie: string[] | undefined) {
    for (const c of setCookie ?? []) {
        const eq = c.indexOf('=');
        if (eq > 0) cookies.set(c.slice(0, eq), c.slice(eq + 1, c.indexOf(';') > 0 ? c.indexOf(';') : c.length));
    }
}

async function gwCall(method: string, body: any, session: DeezerSession) {
    const url = `${GW}?method=${method}&api_version=1.0&api_token=${session.checkForm}&input=3&cid=${Math.floor(Math.random() * 1e9)}`;
    const res = await axios.post(url, body, {
        headers: { Cookie: cookieHeader(session.cookies), 'User-Agent': UA, Origin: 'https://www.deezer.com', Referer: 'https://www.deezer.com/' },
        timeout: 20000
    });
    mergeCookies(session.cookies, res.headers['set-cookie']);
    if (res.data?.error && Object.keys(res.data.error).length) {
        const code = JSON.stringify(res.data.error);
        if (code.includes('VALID_TOKEN') || code.includes('NEED_API_AUTH')) sessions.delete(session.arl);
        throw new Error(`Deezer gateway error (${method}): ${code}`);
    }
    return res.data?.results ?? res.data;
}

async function createSession(arl: string): Promise<DeezerSession> {
    const session: DeezerSession = {
        arl,
        checkForm: '',
        licenseToken: '',
        country: 'US',
        webHq: false,
        webLossless: false,
        cookies: new Map([['arl', arl]]),
        expiresAt: Date.now() + 55 * 60 * 1000
    };
    const results = await gwCall('deezer.getUserData', {}, session); // returns checkForm + sets sid cookie via jar
    const user = results?.USER;
    if (!user?.USER_ID || user.USER_ID === 0) throw new Error('Invalid Deezer ARL — log in to deezer.com and copy the arl cookie');
    session.checkForm = results.checkForm;
    session.licenseToken = user.OPTIONS?.license_token ?? '';
    session.country = results.COUNTRY ?? 'US';
    session.webHq = !!user.OPTIONS?.web_hq;
    session.webLossless = !!user.OPTIONS?.web_lossless;
    return session;
}

export function getSession(arl: string): Promise<DeezerSession> {
    const cached = sessions.get(arl);
    if (cached) {
        return cached.then((s) => {
            if (s.expiresAt > Date.now()) return s;
            sessions.delete(arl);
            return getSession(arl);
        });
    }
    const p = createSession(arl);
    sessions.set(arl, p);
    p.catch(() => sessions.delete(arl));
    return p;
}

// ---------- anonymous gw-light session for metadata ----------
// deezer.com's own web client API (gw-light.php): pageSearch/pageAlbum/
// pageArtist return complete objects in one call — genres (STYLE_NAME),
// labels, UPC, physical dates, positioned tracklists, fan counts, bios —
// none of the per-item enrichment api.deezer.com forces on us. Anonymous
// sessions get a checkForm via getUserData without login (USER_ID:0).
let metaSessionP: Promise<DeezerSession> | null = null;

function metaSession(): Promise<DeezerSession> {
    if (metaSessionP) {
        return metaSessionP.then((s) => (s.expiresAt > Date.now() ? s : ((metaSessionP = null), metaSession())));
    }
    metaSessionP = (async () => {
        const session: DeezerSession = {
            arl: '',
            checkForm: '',
            licenseToken: '',
            country: 'US',
            webHq: false,
            webLossless: false,
            cookies: new Map(),
            expiresAt: Date.now() + 55 * 60 * 1000
        };
        await gwCall('deezer.ping', {}, session); // plants the sid cookie
        const results = await gwCall('deezer.getUserData', {}, session);
        session.checkForm = results?.checkForm ?? '';
        session.country = results?.COUNTRY ?? 'US';
        if (!session.checkForm) throw new Error('Deezer anonymous session rejected (no checkForm)');
        return session;
    })();
    metaSessionP.catch(() => (metaSessionP = null));
    return metaSessionP;
}

// gw metadata call — refreshes the anon session once on token errors
async function gwMeta(method: string, body: any, retried = false): Promise<any> {
    const session = await metaSession();
    try {
        return await gwCall(method, body, session);
    } catch (e: any) {
        if (!retried && (String(e?.message ?? '').includes('VALID_TOKEN') || String(e?.message ?? '').includes('NEED_API_AUTH') || String(e?.message ?? '').includes('CSRF'))) {
            metaSessionP = null;
            return gwMeta(method, body, true);
        }
        throw e;
    }
}

// pageSearch album nodes + track album stubs carry no duration/genre/label —
// one bounded pageAlbum per unique id fills them (same pattern the public-API
// path uses for api.deezer.com details).
async function enrichGwAlbum(alb: any): Promise<void> {
    const p = await gwMeta('deezer.pageAlbum', { alb_id: alb.id, lang: 'en', header: true, tab: 0 }).catch(() => null);
    const d = p?.DATA;
    if (!d) return;
    if (!alb.duration && d.DURATION) alb.duration = parseInt(d.DURATION) || alb.duration;
    if (!alb.released_at && (d.PHYSICAL_RELEASE_DATE ?? d.DIGITAL_RELEASE_DATE)) {
        alb.released_at = toEpochSeconds(d.PHYSICAL_RELEASE_DATE ?? d.DIGITAL_RELEASE_DATE) || alb.released_at;
        alb.release_date_original = toDateString(d.PHYSICAL_RELEASE_DATE ?? d.DIGITAL_RELEASE_DATE) || alb.release_date_original;
    }
    if (!alb.tracks_count && d.NUMBER_TRACK) alb.tracks_count = Number(d.NUMBER_TRACK) || alb.tracks_count;
    if (!alb.genre?.name && d.STYLE_NAME) alb.genre = { path: [], color: '', name: d.STYLE_NAME, id: 0 };
    if (!alb.label?.name && d.LABEL_NAME) alb.label = { name: d.LABEL_NAME, id: 0, albums_count: 0 };
    if (!alb.upc && d.UPC) alb.upc = d.UPC;
    // gw pageAlbum omits genre on many records — the public REST detail carries
    // `genres.data`, so take a second pass only when the card would show blank
    if (!alb.genre?.name) {
        const pub = await albumDetail(alb.id);
        if (pub?.genres?.data?.[0]?.name) alb.genre = { path: [], color: '', name: pub.genres.data[0].name, id: 0 };
    }
}

async function enrichGwTrackAlbums(items: any[]): Promise<void> {
    const byAlbum = new Map<string, any>();
    for (const t of items) if (t?.album?.id && !byAlbum.has(String(t.album.id))) byAlbum.set(String(t.album.id), t.album);
    await mapLimit([...byAlbum.keys()], 4, async (id) => enrichGwAlbum(byAlbum.get(id)!));
    for (const t of items) if (t?.album?.released_at && !t.released_at) t.released_at = t.album.released_at;
}

// ---------- gw-light (SCREAMING_SNAKE) normalizers ----------

// Deezer's explicit flag is '1' | '0' | boolean — compare loosely
const gwExplicit = (v: any) => v === true || v === '1' || v === 1;
// TYPE/SUBTYPES → release bucket ('1'=album,'0'=single-ish, isCompilation/isLive flags)
const gwReleaseType = (a: any): string => {
    const st = a?.SUBTYPES;
    if (st?.isCompilation) return 'compilation';
    if (st?.isLive) return 'live';
    if (a?.TYPE === '1') return 'album';
    if (a?.TYPE === '0' || (a?.NUMBER_TRACK != null && Number(a.NUMBER_TRACK) <= 3)) return 'single';
    return 'album';
};

function normGwAlbum(a: any): QobuzAlbum {
    const artists = (a.ARTISTS ?? []).map((c: any) => ({ id: c.ART_ID ?? 0, name: c.ART_NAME ?? '', roles: ['MainArtist'] }));
    const dateStr = a.PHYSICAL_RELEASE_DATE ?? a.ORIGINAL_RELEASE_DATE;
    return baseAlbum({
        source: 'deezer',
        id: String(a.ALB_ID ?? ''),
        title: a.ALB_TITLE ?? '',
        version: a.VERSION ?? null,
        duration: parseInt(a.DURATION) || 0,
        tracks_count: Number(a.NUMBER_TRACK) || (Array.isArray(a.SONGS?.data) ? a.SONGS.data.length : 0),
        released_at: toEpochSeconds(dateStr),
        release_date_original: toDateString(dateStr),
        parental_warning: gwExplicit(a.EXPLICIT_ALBUM_CONTENT ?? a.EXPLICIT_LYRICS),
        image: {
            small: coverUrl(a.ALB_PICTURE, '250x250'),
            thumbnail: coverUrl(a.ALB_PICTURE, '56x56'),
            large: coverUrl(a.ALB_PICTURE, '1000x1000'),
            back: null
        },
        artist: { image: null, name: a.ART_NAME ?? artists[0]?.name ?? '', id: a.ART_ID ?? artists[0]?.id ?? 0, albums_count: 0 },
        artists: artists.length ? artists : [{ id: a.ART_ID ?? 0, name: a.ART_NAME ?? '', roles: ['MainArtist'] }],
        genre: { path: [], color: '', name: a.STYLE_NAME ?? '', id: 0 },
        label: { name: a.LABEL_NAME ?? a.PRODUCER_LINE ?? '', id: 0, albums_count: 0 },
        upc: a.UPC ?? '',
        hires: false,
        audio_label: 'FLAC / MP3 by plan',
        streamable: a.AVAILABLE !== false,
        _type: gwReleaseType(a)
    });
}

function normGwTrack(t: any, album?: QobuzAlbum): QobuzTrack {
    const artists = (t.ARTISTS ?? []).map((c: any) => ({ id: c.ART_ID ?? 0, name: c.ART_NAME ?? '', roles: ['MainArtist'] }));
    const albumObj =
        album ??
        baseAlbum({
            source: 'deezer',
            id: String(t.ALB_ID ?? ''),
            title: t.ALB_TITLE ?? '',
            image: {
                small: coverUrl(t.ALB_PICTURE, '250x250'),
                thumbnail: coverUrl(t.ALB_PICTURE, '56x56'),
                large: coverUrl(t.ALB_PICTURE, '1000x1000'),
                back: null
            },
            artist: { image: null, name: t.ART_NAME ?? '', id: t.ART_ID ?? 0, albums_count: 0 },
            artists: artists.length ? artists : [{ id: t.ART_ID ?? 0, name: t.ART_NAME ?? '', roles: ['MainArtist'] }]
        });
    return baseTrack({
        source: 'deezer',
        id: t.SNG_ID,
        title: t.SNG_TITLE ?? '',
        version: t.VERSION ?? null,
        duration: parseInt(t.DURATION) || 0,
        track_number: Number(t.TRACK_NUMBER) || 0,
        media_number: Number(t.DISK_NUMBER) || 1,
        isrc: t.ISRC ?? null,
        parental_warning: gwExplicit(t.EXPLICIT_LYRICS),
        performer: { name: t.ART_NAME ?? 'Unknown', id: t.ART_ID ?? 0 },
        released_at: toEpochSeconds(t.DATE_START) || albumObj.released_at,
        album: albumObj,
        audio_label: 'FLAC / MP3 by plan',
        streamable: t.STATUS !== 2 && t.STATUS !== '2'
    });
}

function normGwArtist(a: any) {
    return baseArtist({
        source: 'deezer',
        id: a.ART_ID,
        name: a.ART_NAME ?? '',
        albums_count: a.NB_ALBUM != null ? Number(a.NB_ALBUM) : undefined,
        image: a.ART_PICTURE ? { small: proxiedImg(`https://cdn-images.dzcdn.net/images/artist/${a.ART_PICTURE}/250x250-000000-80-0-0.jpg`), medium: proxiedImg(`https://cdn-images.dzcdn.net/images/artist/${a.ART_PICTURE}/500x500-000000-80-0-0.jpg`), large: proxiedImg(`https://cdn-images.dzcdn.net/images/artist/${a.ART_PICTURE}/1000x1000-000000-80-0-0.jpg`), extralarge: proxiedImg(`https://cdn-images.dzcdn.net/images/artist/${a.ART_PICTURE}/1000x1000-000000-80-0-0.jpg`), mega: proxiedImg(`https://cdn-images.dzcdn.net/images/artist/${a.ART_PICTURE}/1000x1000-000000-80-0-0.jpg`) } : null
    });
}

// ---------- track token + download url ----------

async function getTrackData(sngId: string, session: DeezerSession) {
    const results = await gwCall('song.getData', { sng_id: parseInt(sngId) }, session);
    const data = results?.SNG_ID ? results : results?.data?.[0];
    if (!data) throw new Error('Deezer returned no track data');
    // geo-blocked tracks carry a FALLBACK twin — swap ids + token
    if (data.FALLBACK?.TRACK_TOKEN) return { ...data.FALLBACK, _id: data.FALLBACK.SNG_ID ?? sngId };
    return data;
}

// one bounded retry for network stalls — deezer's media gateway occasionally
// hangs past the 20s timeout; a second shot costs nothing vs a dead download
async function resilient<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e: any) {
        if (e?.code === 'ECONNABORTED' || e?.message?.includes('timeout') || !e?.response) return fn();
        throw e;
    }
}

export async function resolveDeezerTrack(sngId: string, quality: QualityId, ctx: RequestContext) {
    const arl = pickToken('deezer') || ctx.tokens.deezerArl || process.env.DEEZER_ARL || '';
    if (!arl) throw new Error('Deezer requires an ARL cookie — configure one in the admin panel (or DEEZER_ARL env)');
    const session = await resilient(() => getSession(arl)).catch((e: any) => {
        reportToken('deezer', arl, false, e?.message);
        throw e;
    });
    reportToken('deezer', arl, true);
    const data = await resilient(() => getTrackData(sngId, session));
    const trackToken = data.TRACK_TOKEN;
    if (!trackToken) throw new Error('Deezer did not return a track token (track unavailable or ARL expired)');

    const wants = quality === '27' || quality === '7' ? ['FLAC', 'MP3_320', 'MP3_128'] : quality === '6' ? ['MP3_320', 'MP3_128'] : ['MP3_320', 'MP3_128'];
    const allowed = (fmt: string) =>
        (fmt === 'MP3_128') || (fmt === 'MP3_320' && session.webHq) || (fmt === 'FLAC' && session.webLossless);
    const hasSize = (fmt: string) => parseInt(data[`FILESIZE_${fmt}`] ?? '0') > 0;
    const format = wants.find((f) => allowed(f) && hasSize(f)) ?? wants.find(allowed) ?? 'MP3_128';

    const res = await resilient(() =>
        axios.post(
            'https://media.deezer.com/v1/get_url',
            {
                license_token: session.licenseToken,
                media: [{ type: 'FULL', formats: [{ cipher: 'BF_CBC_STRIPE', format }] }],
                track_tokens: [trackToken]
            },
            { headers: { 'User-Agent': UA, Origin: 'https://www.deezer.com', Referer: 'https://www.deezer.com/', 'Content-Type': 'application/json' }, timeout: 20000 }
        )
    );
    const media = res.data?.data?.[0];
    const url = media?.media?.[0]?.sources?.map((s: any) => s.url).find(Boolean);
    if (!url) {
        const err = media?.errors?.[0];
        throw new Error(`Deezer get_url failed${err ? `: ${JSON.stringify(err)}` : ' — format likely above account tier'}`);
    }
    return { url, format: format === 'FLAC' ? ('flac' as const) : ('mp3' as const), sngId: data.SNG_ID ?? sngId, fileSize: parseInt(data[`FILESIZE_${format}`] ?? '0') || 0 };
}

// ---------- blowfish decryption ----------

export function blowfishKey(sngId: string): Uint8Array {
    const md5hex = crypto.createHash('md5').update(String(sngId), 'ascii').digest('hex');
    const key = new Uint8Array(16);
    for (let i = 0; i < 16; i++) key[i] = md5hex.charCodeAt(i) ^ md5hex.charCodeAt(i + 16) ^ BLOWFISH_SECRET.charCodeAt(i);
    return key;
}

export function decryptDeezerFile(encrypted: ArrayBuffer | Buffer, sngId: string): Buffer {
    const input = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted as ArrayBuffer);
    const bf = new Blowfish(blowfishKey(sngId), Blowfish.MODE.CBC, Blowfish.PADDING.NULL);
    const iv = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const out = Buffer.allocUnsafe(input.length);
    for (let i = 0; i * 2048 < input.length; i++) {
        const chunk = input.subarray(i * 2048, Math.min((i + 1) * 2048, input.length));
        if (i % 3 === 0 && chunk.length === 2048) {
            bf.setIv(iv);
            const dec = bf.decode(new Uint8Array(chunk), Blowfish.TYPE.UINT8_ARRAY);
            Buffer.from(dec).copy(out, i * 2048);
        } else {
            chunk.copy(out, i * 2048);
        }
    }
    return out;
}

// ---------- adapter ----------

export const deezerAdapter: PlatformAdapter = {
    source: 'deezer',

    async search(query, limit, offset, _ctx) {
        const results = emptyResults(query);
        // pasted deezer/open links → direct entity lookup
        const m = query.match(/deezer\.com\/(?:\w+\/)?(track|album|artist)\/(\d+)/);
        if (m) {
            const id = m[2];
            const kind = m[1] === 'track' ? 'tracks' : m[1] === 'album' ? 'albums' : 'artists';
            try {
                if (m[1] === 'track') {
                    const t = (await axios.get(`${PUBLIC_API}/track/${id}`, { timeout: 15000 })).data;
                    results.tracks = { limit, offset: 0, total: 1, items: [normTrack(t)] };
                } else if (m[1] === 'album') {
                    const a = (await axios.get(`${PUBLIC_API}/album/${id}`, { timeout: 15000 })).data;
                    results.albums = { limit, offset: 0, total: 1, items: [normAlbum(a)] };
                } else {
                    const a = (await axios.get(`${PUBLIC_API}/artist/${id}`, { timeout: 15000 })).data;
                    results.artists = { limit, offset: 0, total: 1, items: [normArtist(a)] };
                }
                (results as any).switchTo = kind;
                return results;
            } catch {}
        }
        // ---- primary: deezer.pageSearch (gw-light) — one call, complete
        // metadata (ISRC, positions, explicit flags, dates, track counts,
        // fan counts) — no per-item enrichment needed.
        try {
            const s = await gwMeta('deezer.pageSearch', { query, start: offset, nb: limit, lang: 'en', tab: 0, filter: 'ALL' });
            if (s && (s.TRACK || s.ALBUM || s.ARTIST)) {
                const gwTracks = (s.TRACK?.data ?? []).map((t: any) => normGwTrack(t));
                const gwAlbums = (s.ALBUM?.data ?? []).map((a: any) => normGwAlbum(a));
                const gwArtists = (s.ARTIST?.data ?? []).map((a: any) => normGwArtist(a));
                // fill album stats + artist release counts via bounded detail calls
                await Promise.all([
                    enrichGwTrackAlbums(gwTracks),
                    mapLimit(gwAlbums, 4, enrichGwAlbum),
                    // pageSearch ARTIST nodes may omit NB_ALBUM — public /artist
                    // answers with nb_album in one cheap call (bounded)
                    mapLimit(
                        gwArtists.filter((a: any) => a.albums_count == null).slice(0, 12),
                        4,
                        async (a: any) => {
                            const n = (await axios.get(`${PUBLIC_API}/artist/${a.id}`, { timeout: 8000 }).catch(() => null))?.data?.nb_album;
                            if (n != null) a.albums_count = n;
                        }
                    )
                ]);
                results.tracks = { limit, offset, total: s.TRACK?.total ?? s.TRACK?.count ?? 0, items: gwTracks };
                results.albums = { limit, offset, total: s.ALBUM?.total ?? s.ALBUM?.count ?? 0, items: gwAlbums };
                results.artists = { limit, offset, total: s.ARTIST?.total ?? s.ARTIST?.count ?? 0, items: gwArtists };
                if (m) (results as any).switchTo = m[1] === 'track' ? 'tracks' : m[1] === 'album' ? 'albums' : 'artists';
                return results;
            }
        } catch {}
        const [tracks, albums, artists] = await Promise.allSettled([
            axios.get(`${PUBLIC_API}/search/track`, { params: { q: query, limit, index: offset }, timeout: 15000 }),
            axios.get(`${PUBLIC_API}/search/album`, { params: { q: query, limit, index: offset }, timeout: 15000 }),
            axios.get(`${PUBLIC_API}/search/artist`, { params: { q: query, limit, index: offset }, timeout: 15000 })
        ]);
        if (tracks.status === 'fulfilled') {
            const items = (tracks.value.data.data ?? []).map((t: any) => normTrack(t));
            await enrichTrackAlbums(items);
            results.tracks = {
                limit,
                offset,
                total: tracks.value.data.total ?? tracks.value.data.data?.length ?? 0,
                items
            };
        }
        if (albums.status === 'fulfilled') {
            const items = (albums.value.data.data ?? []).map((a: any) => normAlbum(a));
            await mapLimit(items, 4, enrichAlbum);
            results.albums = {
                limit,
                offset,
                total: albums.value.data.total ?? items.length,
                items
            };
        }
        if (artists.status === 'fulfilled') {
            results.artists = {
                limit,
                offset,
                total: artists.value.data.total ?? artists.value.data.data?.length ?? 0,
                items: (artists.value.data.data ?? []).map((a: any) => normArtist(a))
            };
        }
        if (m) {
            const kind = m[1] === 'track' ? 'tracks' : m[1] === 'album' ? 'albums' : 'artists';
            (results as any).switchTo = kind;
        }
        return results;
    },

    async getAlbumInfo(albumId, _ctx) {
        // ---- primary: deezer.pageAlbum — DATA carries label/genre/UPC/dates
        // + SONGS has the full positioned tracklist in one response
        try {
            const p = await gwMeta('deezer.pageAlbum', { alb_id: albumId, lang: 'en', header: true, tab: 0 });
            const d = p?.DATA;
            if (d?.ALB_ID) {
                const album = normGwAlbum(d) as FetchedQobuzAlbum;
                album.full = true;
                if (!album.genre?.name) {
                    const pub = await albumDetail(albumId);
                    if (pub?.genres?.data?.[0]?.name) album.genre = { path: [], color: '', name: pub.genres.data[0].name, id: 0 };
                }
                const songs = p.SONGS?.data ?? [];
                const albumRef = normGwAlbum(d);
                if (!albumRef.genre?.name && album.genre?.name) albumRef.genre = album.genre;
                album.tracks = { offset: 0, limit: songs.length, total: songs.length, items: songs.map((t: any, i: number) => ({ ...normGwTrack(t, albumRef), track_number: Number(t.TRACK_NUMBER) || i + 1 })) };
                if (!album.duration) album.duration = songs.reduce((s: number, t: any) => s + (parseInt(t.DURATION) || 0), 0);
                return album;
            }
        } catch {}
        const res = await axios.get(`${PUBLIC_API}/album/${albumId}`, { timeout: 15000 });
        const a = res.data;
        const album = normAlbum(a) as FetchedQobuzAlbum;
        album.full = true;
        let tracks = a.tracks?.data ?? [];
        // paginate if needed
        let index = tracks.length;
        while (tracks.length < (a.nb_tracks ?? 0) && index < 500) {
            const page = await axios.get(`${PUBLIC_API}/album/${albumId}/tracks`, { params: { index, limit: 100 }, timeout: 15000 }).catch(() => null);
            if (!page?.data?.data?.length) break;
            tracks = tracks.concat(page.data.data);
            index += page.data.data.length;
        }
        // album/tracks nodes carry no position field — order is the position
        const norm = tracks.map((t: any, i: number) => ({ ...normTrack(t, normAlbum(a)), track_number: t.track_position ?? i + 1 }));
        album.tracks = { offset: 0, limit: norm.length, total: norm.length, items: norm };
        return album;
    },

    async getArtist(artistId, _ctx) {
        // ---- primary: deezer.pageArtist — profile+bio+fans+top tracks+
        // discography (embedded tracklists → durations) in one response
        try {
            const p = await gwMeta('deezer.pageArtist', { art_id: artistId, lang: 'en', header: true, tab: 0 });
            const d = p?.DATA;
            if (d?.ART_ID) {
                const out = emptyArtistResults();
                out.id = d.ART_ID;
                out.name = { display: d.ART_NAME ?? '' };
                out.image = d.ART_PICTURE ? { small: proxiedImg(`https://cdn-images.dzcdn.net/images/artist/${d.ART_PICTURE}/250x250-000000-80-0-0.jpg`) } : null;
                if (p.BIO?.BIO) out.biography = { content: p.BIO.BIO, source: 'deezer', language: 'en' };
                out.top_tracks = (p.TOP?.data ?? []).map((t: any) => normGwTrack(t));
                const albums = p.ALBUMS;
                const relItems = (albums?.data ?? []).map((a: any) => {
                    const alb = normGwAlbum(a);
                    // each discography node embeds SONGS.data — sum durations + count
                    const songs = a.SONGS?.data ?? [];
                    if (!alb.duration && songs.length) alb.duration = songs.reduce((s: number, t: any) => s + (parseInt(t.DURATION) || 0), 0);
                    if (!alb.tracks_count && songs.length) alb.tracks_count = songs.length;
                    return alb;
                });
                const total = albums?.total ?? relItems.length;
                const bucket = (pred: (x: any) => boolean) => relItems.filter(pred);
                out.releases.album = { has_more: total > relItems.length, items: bucket((x: any) => x._type === 'album') };
                out.releases.epSingle = { has_more: total > relItems.length, items: bucket((x: any) => x._type === 'single' || x._type === 'ep') };
                out.releases.compilation = { has_more: total > relItems.length, items: bucket((x: any) => x._type === 'compilation') };
                out.releases.live = { has_more: false, items: bucket((x: any) => x._type === 'live') };
                out.albums_count = total;
                return { artist: out };
            }
        } catch {}
        // Deezer public API is occasionally slow — 25s + one retry on timeout,
        // and run detail/top/releases in parallel instead of serially.
        const get = (url: string, params: Record<string, any> = {}) =>
            resilient(() => axios.get(`${PUBLIC_API}${url}`, { params, timeout: 25000 }));
        const [res, top, releases] = await Promise.all([
            get(`/artist/${artistId}`),
            get(`/artist/${artistId}/top`, { limit: 50 }).catch(() => null),
            get(`/artist/${artistId}/albums`, { limit: 100 }).catch(() => null)
        ]);
        const a = res.data;
        const out = emptyArtistResults();
        out.id = a.id;
        out.name = { display: a.name };
        out.albums_count = a.nb_album ?? 0;
        out.image = a.picture_medium ? { small: proxiedImg(a.picture_medium) } : null;
        out.top_tracks = (top?.data?.data ?? []).map((t: any) => normTrack(t));
        const items = (releases?.data?.data ?? []).map((al: any) => normAlbum(al));
        // detail fields (duration/genre) are absent from artist album lists too —
        // enrich the page the dialog will actually show
        await mapLimit(items, 6, enrichAlbum);
        out.releases.album = { has_more: (releases?.data?.total ?? items.length) > items.length, items: items.filter((x: any) => !x._type || x._type === 'album') };
        out.releases.epSingle = { has_more: false, items: items.filter((x: any) => x._type === 'ep' || x._type === 'single') };
        out.releases.compilation = { has_more: false, items: items.filter((x: any) => x._type === 'compile') };
        return { artist: out };
    },

    async getArtistReleases(artistId, releaseType, limit, offset, _ctx) {
        const res = await resilient(() => axios.get(`${PUBLIC_API}/artist/${artistId}/albums`, { params: { limit: 100, index: 0 }, timeout: 25000 }));
        const all = (res.data?.data ?? []).map((a: any) => ({ ...normAlbum(a), _type: a.record_type }));
        const wanted = releaseType === 'epSingle' ? ['ep', 'single'] : releaseType === 'compilation' ? ['compile'] : releaseType === 'live' ? [] : ['album'];
        const page = all.filter((a: any) => wanted.includes(a._type));
        const items = page.slice(offset, offset + limit);
        await mapLimit(items, 4, enrichAlbum);
        return { items, has_more: offset + limit < page.length };
    },

    async getDownloadURL(trackId, quality, _ctx, _hint?: DownloadHint): Promise<DownloadInfo> {
        // resolution happens in the stream route (keeps tokens server-side)
        return { url: `/api/stream-audio?source=deezer&id=${encodeURIComponent(trackId)}&quality=${quality}` };
    }
};

export default deezerAdapter;
