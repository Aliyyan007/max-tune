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
        genre: { path: [], color: '', name: a.genres?.data?.[0]?.name ?? '', id: 0 },
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
        parental_warning: !!(t.explicit_lyrics ?? t.explicit_content_lyrics === 1),
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
        albums_count: a.nb_album ?? 0,
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

// ---------- track token + download url ----------

async function getTrackData(sngId: string, session: DeezerSession) {
    const results = await gwCall('song.getData', { sng_id: parseInt(sngId) }, session);
    const data = results?.SNG_ID ? results : results?.data?.[0];
    if (!data) throw new Error('Deezer returned no track data');
    // geo-blocked tracks carry a FALLBACK twin — swap ids + token
    if (data.FALLBACK?.TRACK_TOKEN) return { ...data.FALLBACK, _id: data.FALLBACK.SNG_ID ?? sngId };
    return data;
}

export async function resolveDeezerTrack(sngId: string, quality: QualityId, ctx: RequestContext) {
    const arl = pickToken('deezer') || ctx.tokens.deezerArl || process.env.DEEZER_ARL || '';
    if (!arl) throw new Error('Deezer requires an ARL cookie — configure one in the admin panel (or DEEZER_ARL env)');
    const session = await getSession(arl).catch((e: any) => {
        reportToken('deezer', arl, false, e?.message);
        throw e;
    });
    reportToken('deezer', arl, true);
    const data = await getTrackData(sngId, session);
    const trackToken = data.TRACK_TOKEN;
    if (!trackToken) throw new Error('Deezer did not return a track token (track unavailable or ARL expired)');

    const wants = quality === '27' || quality === '7' ? ['FLAC', 'MP3_320', 'MP3_128'] : quality === '6' ? ['MP3_320', 'MP3_128'] : ['MP3_320', 'MP3_128'];
    const allowed = (fmt: string) =>
        (fmt === 'MP3_128') || (fmt === 'MP3_320' && session.webHq) || (fmt === 'FLAC' && session.webLossless);
    const hasSize = (fmt: string) => parseInt(data[`FILESIZE_${fmt}`] ?? '0') > 0;
    const format = wants.find((f) => allowed(f) && hasSize(f)) ?? wants.find(allowed) ?? 'MP3_128';

    const res = await axios.post(
        'https://media.deezer.com/v1/get_url',
        {
            license_token: session.licenseToken,
            media: [{ type: 'FULL', formats: [{ cipher: 'BF_CBC_STRIPE', format }] }],
            track_tokens: [trackToken]
        },
        { headers: { 'User-Agent': UA, Origin: 'https://www.deezer.com', Referer: 'https://www.deezer.com/', 'Content-Type': 'application/json' }, timeout: 20000 }
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
        const [tracks, albums, artists] = await Promise.allSettled([
            axios.get(`${PUBLIC_API}/search/track`, { params: { q: query, limit, index: offset }, timeout: 15000 }),
            axios.get(`${PUBLIC_API}/search/album`, { params: { q: query, limit, index: offset }, timeout: 15000 }),
            axios.get(`${PUBLIC_API}/search/artist`, { params: { q: query, limit, index: offset }, timeout: 15000 })
        ]);
        if (tracks.status === 'fulfilled') {
            results.tracks = {
                limit,
                offset,
                total: tracks.value.data.total ?? tracks.value.data.data?.length ?? 0,
                items: (tracks.value.data.data ?? []).map((t: any) => normTrack(t))
            };
        }
        if (albums.status === 'fulfilled') {
            results.albums = {
                limit,
                offset,
                total: albums.value.data.total ?? albums.value.data.data?.length ?? 0,
                items: (albums.value.data.data ?? []).map((a: any) => normAlbum(a))
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
        album.tracks = { offset: 0, limit: tracks.length, total: tracks.length, items: tracks.map((t: any) => normTrack(t, normAlbum(a))) };
        return album;
    },

    async getArtist(artistId, _ctx) {
        const res = await axios.get(`${PUBLIC_API}/artist/${artistId}`, { timeout: 15000 });
        const a = res.data;
        const out = emptyArtistResults();
        out.id = a.id;
        out.name = { display: a.name };
        out.image = a.picture_medium ? { small: proxiedImg(a.picture_medium) } : null;
        const top = await axios.get(`${PUBLIC_API}/artist/${artistId}/top`, { params: { limit: 50 }, timeout: 15000 }).catch(() => null);
        out.top_tracks = (top?.data?.data ?? []).map((t: any) => normTrack(t));
        const releases = await axios.get(`${PUBLIC_API}/artist/${artistId}/albums`, { params: { limit: 100 }, timeout: 15000 }).catch(() => null);
        const items = (releases?.data?.data ?? []).map((al: any) => normAlbum(al));
        out.releases.album = { has_more: (releases?.data?.total ?? items.length) > items.length, items: items.filter((x: any) => !x._type || x._type === 'album') };
        out.releases.epSingle = { has_more: false, items: items.filter((x: any) => x._type === 'ep' || x._type === 'single') };
        out.releases.compilation = { has_more: false, items: items.filter((x: any) => x._type === 'compile') };
        return { artist: out };
    },

    async getArtistReleases(artistId, releaseType, limit, offset, _ctx) {
        const res = await axios.get(`${PUBLIC_API}/artist/${artistId}/albums`, { params: { limit: 100, index: 0 }, timeout: 15000 });
        const all = (res.data?.data ?? []).map((a: any) => ({ ...normAlbum(a), _type: a.record_type }));
        const wanted = releaseType === 'epSingle' ? ['ep', 'single'] : releaseType === 'compilation' ? ['compile'] : releaseType === 'live' ? [] : ['album'];
        const items = all.filter((a: any) => wanted.includes(a._type)).slice(offset, offset + limit);
        return { items, has_more: offset + limit < all.filter((a: any) => wanted.includes(a._type)).length };
    },

    async getDownloadURL(trackId, quality, _ctx, _hint?: DownloadHint): Promise<DownloadInfo> {
        // resolution happens in the stream route (keeps tokens server-side)
        return { url: `/api/stream-audio?source=deezer&id=${encodeURIComponent(trackId)}&quality=${quality}` };
    }
};

export default deezerAdapter;
