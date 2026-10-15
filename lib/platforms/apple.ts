import axios from 'axios';
import { pickToken } from '@/lib/token-pool';
import { baseAlbum, baseArtist, baseTrack, emptyArtistResults, emptyResults, proxiedImg, toDateString, toEpochSeconds } from './normalize';
import type { DownloadHint, DownloadInfo, PlatformAdapter, QualityId, RequestContext } from './types';
import type { FetchedQobuzAlbum, QobuzAlbum, QobuzTrack } from '@/lib/qobuz-dl';

const API = 'https://itunes.apple.com';

function art(url: string | undefined, size: number): string {
    if (!url) return '';
    // apple artwork urls carry the size in the path — swap to requested
    return proxiedImg(url.replace(/\/\d+x\d+(bb)?\./, `/${size}x${size}bb.`));
}

function normAlbum(a: any): QobuzAlbum {
    return baseAlbum({
        source: 'apple',
        id: String(a.collectionId),
        title: a.collectionName ?? '',
        tracks_count: a.trackCount ?? 0,
        released_at: toEpochSeconds(a.releaseDate),
        release_date_original: toDateString(a.releaseDate),
        parental_warning: (a.collectionExplicitness ?? '').toLowerCase().includes('explicit'),
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
            parental_warning: (t.collectionExplicitness ?? '').toLowerCase().includes('explicit')
        });
    return baseTrack({
        source: 'apple',
        id: String(t.trackId),
        title: t.trackName ?? '',
        duration: Math.round((t.trackTimeMillis ?? 0) / 1000),
        track_number: t.trackNumber ?? 0,
        media_number: t.discNumber ?? 1,
        isrc: null,
        parental_warning: (t.trackExplicitness ?? '').toLowerCase().includes('explicit'),
        performer: { name: t.artistName ?? 'Unknown', id: t.artistId ?? 0 },
        released_at: albumObj.released_at,
        album: albumObj,
        audio_label: 'ALAC / AAC in .m4a',
        streamable: true
    });
}

export const appleAdapter: PlatformAdapter = {
    source: 'apple',

    async search(query, limit, offset, _ctx) {
        const results = emptyResults(query);
        const m = query.match(/music\.apple\.com\/\w+\/(album|song|artist)(?:\/[^/]+)?\/(\d+)/);
        if (m) {
            try {
                const res = await axios.get(`${API}/lookup`, { params: { id: m[2] }, timeout: 15000 });
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
        const [songs, albums, artists] = await Promise.allSettled([
            axios.get(`${API}/search`, { params: { term: query, media: 'music', entity: 'song', limit, offset }, timeout: 15000 }),
            axios.get(`${API}/search`, { params: { term: query, media: 'music', entity: 'album', limit, offset }, timeout: 15000 }),
            axios.get(`${API}/search`, { params: { term: query, media: 'music', entity: 'musicArtist', limit, offset }, timeout: 15000 })
        ]);
        if (songs.status === 'fulfilled')
            results.tracks = {
                limit,
                offset,
                total: songs.value.data.resultCount ?? 0,
                items: (songs.value.data.results ?? []).filter((r: any) => r.wrapperType === 'track').map((t: any) => normTrack(t))
            };
        if (albums.status === 'fulfilled')
            results.albums = {
                limit,
                offset,
                total: albums.value.data.resultCount ?? 0,
                items: (albums.value.data.results ?? []).filter((r: any) => r.collectionType === 'Album').map((a: any) => normAlbum(a))
            };
        if (artists.status === 'fulfilled')
            results.artists = {
                limit,
                offset,
                total: artists.value.data.resultCount ?? 0,
                items: (artists.value.data.results ?? []).map((a: any) =>
                    baseArtist({ source: 'apple', id: a.artistId, name: a.artistName ?? '', albums_count: 0, image: null })
                )
            };
        if (m) (results as any).switchTo = m[1] === 'song' ? 'tracks' : m[1] === 'album' ? 'albums' : 'artists';
        return results;
    },

    async getAlbumInfo(albumId, _ctx) {
        const res = await axios.get(`${API}/lookup`, { params: { id: albumId, entity: 'song', limit: 200 }, timeout: 15000 });
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

    async getArtist(artistId, _ctx) {
        const out = emptyArtistResults();
        const res = await axios.get(`${API}/lookup`, { params: { id: artistId }, timeout: 15000 });
        const artist = (res.data.results ?? []).find((r: any) => r.wrapperType === 'artist');
        const artistName = artist?.artistName ?? '';
        out.id = artistId;
        out.name = { display: artistName };
        const [albums, topSongs] = await Promise.allSettled([
            axios.get(`${API}/lookup`, { params: { id: artistId, entity: 'album', limit: 200 }, timeout: 15000 }),
            artistName ? axios.get(`${API}/search`, { params: { term: artistName, media: 'music', entity: 'song', attribute: 'artistTerm', limit: 10 }, timeout: 15000 }) : Promise.resolve(null)
        ]);
        const items =
            albums.status === 'fulfilled' ? (albums.value?.data.results ?? []).filter((r: any) => r.wrapperType === 'collection').map((a: any) => normAlbum(a)) : [];
        // iTunes exposes no discography grouping — heuristic: >3 tracks = album, else single/EP
        out.releases.album = { has_more: false, items: items.filter((a: any) => a.tracks_count > 3) };
        out.releases.epSingle = { has_more: false, items: items.filter((a: any) => a.tracks_count <= 3) };
        if (topSongs.status === 'fulfilled' && topSongs.value) {
            out.top_tracks = (topSongs.value.data.results ?? [])
                .filter((r: any) => r.wrapperType === 'track' && (r.artistId === artist?.artistId || (r.artistName ?? '').toLowerCase() === artistName.toLowerCase()))
                .map((t: any) => normTrack(t));
        }
        return { artist: out };
    },

    async getArtistReleases(artistId, releaseType, limit, offset, _ctx) {
        const res = await axios.get(`${API}/lookup`, { params: { id: artistId, entity: 'album', limit: 200 }, timeout: 15000 });
        const items = (res.data.results ?? []).filter((r: any) => r.wrapperType === 'collection').map((a: any) => normAlbum(a));
        const filtered = releaseType === 'epSingle' ? items.filter((a: QobuzAlbum) => a.tracks_count <= 3) : releaseType === 'album' ? items.filter((a: QobuzAlbum) => a.tracks_count > 3) : [];
        return { items: filtered.slice(offset, offset + limit), has_more: offset + limit < filtered.length };
    },

    async getDownloadURL(trackId: string, quality: QualityId, ctx: RequestContext, hint?: DownloadHint): Promise<DownloadInfo> {
        let title = hint?.title ?? '';
        let artist = hint?.artist ?? '';
        let duration = hint?.duration;
        try {
            const res = await axios.get(`${API}/lookup`, { params: { id: trackId }, timeout: 15000 });
            const t = (res.data.results ?? []).find((r: any) => r.wrapperType === 'track');
            title = t?.trackName ?? title;
            artist = t?.artistName ?? artist;
            duration = Math.round((t?.trackTimeMillis ?? 0) / 1000) || duration;
        } catch {}
        // Real ALAC/AAC via amdl + wrapper — requires a media-user-token
        if (pickToken('apple') || ctx.tokens.appleMediaToken || process.env.APPLE_MEDIA_USER_TOKEN) {
            const params = new URLSearchParams({ source: 'apple-native', id: trackId, quality, title, artist });
            if (duration) params.set('dur', String(duration));
            return { url: `/api/stream-audio?${params}`, format: 'm4a' };
        }
        // No subscription token — serve the free 30s preview every Apple track exposes.
        // The download flow already flags short files as previews to the user.
        const params = new URLSearchParams({ source: 'apple-preview', id: trackId, quality, title, artist });
        if (duration) params.set('dur', String(duration));
        return { url: `/api/stream-audio?${params}`, format: 'm4a' };
    }
};

export default appleAdapter;
