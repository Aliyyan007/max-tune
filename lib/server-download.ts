// Server-side download pipeline: resolve platform audio → ffmpeg-static tags/art/codec →
// bytes the browser can take over natively (a[download] → Chrome download manager).
// Replaces the old client-side ffmpeg.wasm + in-memory blob flow.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { Readable, Transform } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import ffmpegPath from 'ffmpeg-static';
import { adapters } from './platforms';
import { resolveDeezerTrack, decryptDeezerFile, blowfishKey } from './platforms/deezer';
import { resolveTidalTrack } from './platforms/tidal';
import { downloadSpotifyNative, downloadAppleNative, downloadAmazonNative, resolveAmazonStream, PY_ENV, PY_BIN, withLibrespotLock, materializeSessions } from './platforms/native-tools';
import { Blowfish } from 'egoroof-blowfish';
import type { PlatformSource, RequestContext } from './platforms/types';

export interface DownloadSpec {
    source: PlatformSource | 'apple-preview' | 'spotify-native' | 'apple-native' | 'amazon-native';
    id: string;
    quality: string;
    title: string;
    artist: string;
    album: string;
    trackNum?: number;
    totalTracks?: number;
    discNum?: number;
    genre?: string;
    date?: string;
    year?: string;
    label?: string;
    copyright?: string;
    isrc?: string;
    upc?: string;
    artUrl?: string;
    filename: string;
    applyMeta: boolean;
    codec: string; // SOURCE | FLAC | WAV | ALAC | MP3 | AAC | OGG | OPUS
    bitrate?: number;
    tokens?: Record<string, string>;
    country?: string;
    duration?: number;
}

const CODEC: Record<string, { ext: string; codec: string }> = {
    FLAC: { ext: 'flac', codec: 'flac' },
    WAV: { ext: 'wav', codec: 'pcm_s16le' },
    ALAC: { ext: 'm4a', codec: 'alac' },
    MP3: { ext: 'mp3', codec: 'libmp3lame' },
    AAC: { ext: 'm4a', codec: 'aac' },
    OGG: { ext: 'ogg', codec: 'libvorbis' },
    OPUS: { ext: 'opus', codec: 'libopus' }
};

const EXT_OF_FORMAT: Record<string, string> = { flac: 'flac', mp3: 'mp3', m4a: 'm4a', mp4: 'm4a', aac: 'm4a', webm: 'webm', opus: 'webm', ogg: 'ogg' };

// Bump artwork to its largest fetchable size — iTunes uses /NxNbb.jpg in the
// path, qobuz uses _N.jpg. Other CDNs are passed through untouched.
export function normalizeArtUrl(url?: string): string | undefined {
    if (!url) return undefined;
    // unwrap our own image proxy — the inner URL is the real CDN artwork
    const proxyMatch = url.match(/\/api\/image-proxy\?url=([^&]+)/);
    if (proxyMatch) url = decodeURIComponent(proxyMatch[1]);
    if (!url.startsWith('http')) return undefined;
    if (/\/\d+x\d+(bb)?\./.test(url)) return url.replace(/\/\d+x\d+(bb)?\./, '/1400x1400bb.');
    if (/_\d+\.jpg$/.test(url)) return url.replace(/_\d+\.jpg$/, '_org.jpg');
    return url;
}

// Escape for FFMETADATA1 format (\ = ; # and newlines are reserved)
const metaEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, ' ').replace(/([=;#])/g, '\\$1');

async function fetchBuf(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 300000, headers, maxRedirects: 5 });
    return Buffer.from(r.data);
}

// Assemble a fMP4 DASH stream (tidal hi-res): init segment + numbered media segments
async function assembleDash(mpd: string): Promise<Buffer> {
    const initMatch = mpd.match(/initialization="([^"]+)"/);
    const mediaMatch = mpd.match(/media="([^"]+)"/);
    if (!initMatch || !mediaMatch) throw new Error('Unparseable Tidal DASH manifest');
    const init = initMatch[1].replace(/&amp;/g, '&');
    const mediaTemplate = mediaMatch[1].replace(/&amp;/g, '&');
    const tlDur = mpd.match(/<SegmentTimeline[^>]*>([\s\S]*?)<\/SegmentTimeline>/);
    const segUrls: string[] = [];
    if (tlDur) {
        const sEntries = [...tlDur[1].matchAll(/<S[^>]*d="(\d+)"[^>]*(?:r="(\d+)")?/g)];
        let idx = 1;
        for (const e of sEntries) {
            const rep = parseInt(e[2] ?? '0') + 1;
            for (let i = 0; i < rep; i++) segUrls.push(mediaTemplate.replace(/\$(?:Number|num)\$/g, String(idx++)));
        }
    } else {
        for (let i = 1; i <= 1000; i++) segUrls.push(mediaTemplate.replace(/\$(?:Number|num)\$/g, String(i)));
    }
    const parts: Buffer[] = [(await axios.get(init, { responseType: 'arraybuffer', timeout: 30000 })).data];
    let done = false;
    for (let i = 0; i < segUrls.length && !done; i++) {
        try {
            const r = await axios.get(segUrls[i], { responseType: 'arraybuffer', timeout: 30000 });
            parts.push(Buffer.from(r.data));
        } catch {
            done = true;
        }
    }
    return Buffer.concat(parts);
}

// Produce the raw (decrypted) audio bytes for any source — mirrors stream-audio's branches
export async function produceTrackBytes(spec: DownloadSpec): Promise<{ data: Buffer; format: string }> {
    const ctx: RequestContext = { tokens: (spec.tokens ?? {}) as any, country: spec.country };
    const { source, id, quality } = spec;

    if (source === 'deezer') {
        const info = await resolveDeezerTrack(id, quality as any, ctx);
        const enc = (await axios.get(info.url, { responseType: 'arraybuffer', timeout: 300000 })).data;
        return { data: decryptDeezerFile(enc, String(info.sngId)), format: info.format };
    }

    if (source === 'tidal') {
        const info = await resolveTidalTrack(id, quality as any, ctx);
        if (info.dashManifest) return { data: await assembleDash(info.dashManifest), format: 'mp4' };
        return { data: await fetchBuf(info.url!, { 'User-Agent': 'Mozilla/5.0' }), format: info.format ?? 'flac' };
    }

    if (source === 'qobuz') {
        const info = await adapters.qobuz.getDownloadURL(id, quality as any, ctx);
        return { data: await fetchBuf(info.url, { 'User-Agent': 'Mozilla/5.0' }), format: info.format ?? 'flac' };
    }

    if (source === 'spotify' || source === 'spotify-native') {
        const qMap: Record<string, 'normal' | 'high' | 'very_high' | 'lossless'> = { '27': 'lossless', '7': 'very_high', '6': 'high', '5': 'normal' };
        const ladder: ('normal' | 'high' | 'very_high' | 'lossless')[] = [qMap[quality] ?? 'very_high', 'very_high', 'high', 'normal'];
        let lastErr: any = null;
        for (const q of [...new Set(ladder)]) {
            try {
                const r = await downloadSpotifyNative(id, q);
                const data = fs.readFileSync(r.file);
                fs.unlink(r.file, () => {});
                return { data, format: 'ogg' };
            } catch (e: any) {
                lastErr = e;
                if (/premium_required/i.test(e?.message ?? '')) throw e;
            }
        }
        throw lastErr ?? new Error('spotify download failed');
    }

    if (source === 'apple-preview') {
        const res = await axios.get('https://itunes.apple.com/lookup', { params: { id }, timeout: 15000 });
        const t = (res.data.results ?? []).find((r: any) => r.wrapperType === 'track');
        if (!t?.previewUrl) throw new Error('no preview available for this track');
        return { data: await fetchBuf(t.previewUrl, { 'User-Agent': 'Mozilla/5.0' }), format: 'm4a' };
    }

    if (source === 'apple' || source === 'apple-native') {
        if (!spec.tokens?.appleMediaToken && !process.env.APPLE_MEDIA_USER_TOKEN) {
            // no subscription token — the free 30s iTunes preview is what this
            // account can legally fetch; the file gets tagged like a normal track.
            const res = await axios.get('https://itunes.apple.com/lookup', { params: { id }, timeout: 15000 });
            const t = (res.data.results ?? []).find((r: any) => r.wrapperType === 'track');
            if (!t?.previewUrl) throw new Error('no preview available for this track');
            return { data: await fetchBuf(t.previewUrl, { 'User-Agent': 'Mozilla/5.0' }), format: 'm4a' };
        }
        const aQ = quality === '27' ? 'alac-hi' : quality === '5' ? 'aac' : 'alac';
        const r = await downloadAppleNative(id, aQ, { appleMediaToken: spec.tokens?.appleMediaToken, appleWrapper: spec.tokens?.appleWrapper });
        const data = fs.readFileSync(r.file);
        fs.unlink(r.file, () => {});
        return { data, format: r.format === 'mp4' ? 'm4a' : r.format };
    }

    if (source === 'amazon' || source === 'amazon-native') {
        const zQ = quality === '27' ? 'Max' : quality === '7' ? 'Master' : quality === '6' ? 'High' : 'Normal';
        const r = await downloadAmazonNative(id, zQ as any, { amazonToken: spec.tokens?.amazonToken });
        const data = fs.readFileSync(r.file);
        fs.unlink(r.file, () => {});
        return { data, format: r.format === 'mp4' ? 'm4a' : r.format };
    }

    throw new Error(`unsupported source: ${source}`);
}

// ffmpeg-static's exported path can point into .next/vendor-chunks when bundled —
// fall back to the real node_modules location.
function ffmpegBin(): string {
    const bundled = ffmpegPath as unknown as string;
    if (bundled && fs.existsSync(bundled)) return bundled;
    const direct = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
    if (fs.existsSync(direct)) return direct;
    if (bundled) return bundled;
    throw new Error('ffmpeg binary not found — run npm install');
}

function runFfmpeg(args: string[], timeoutMs = 300000): Promise<void> {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpegBin(), args, { windowsHide: true });
        let err = '';
        const kill = setTimeout(() => {
            p.kill('SIGKILL');
            reject(new Error('ffmpeg timed out'));
        }, timeoutMs);
        p.stderr.on('data', (d) => (err += d.toString()));
        p.on('error', (e) => {
            clearTimeout(kill);
            reject(e);
        });
        p.on('close', (code) => {
            clearTimeout(kill);
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exit ${code}: ${err.slice(-800)}`));
        });
    });
}

// Apply FFMETADATA tags + cover art + optional transcode — server-side port of applyMetadata
export async function tagAndEncode(input: Buffer, inputFormat: string, spec: DownloadSpec): Promise<{ data: Buffer; ext: string }> {
    const inExt = EXT_OF_FORMAT[inputFormat] ?? 'flac';
    const sourceMode = spec.codec === 'SOURCE';
    const outExt = sourceMode ? inExt : (CODEC[spec.codec]?.ext ?? inExt);
    const skipRecode =
        sourceMode ||
        inExt === outExt ||
        (inExt === 'flac' && spec.codec === 'FLAC') ||
        (inExt === 'mp3' && spec.codec === 'MP3' && spec.bitrate === 320);
    const doTags = spec.applyMeta && outExt !== 'wav';

    if (skipRecode && !doTags) return { data: input, ext: outExt };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-'));
    const src = path.join(dir, `in.${inExt}`);
    fs.writeFileSync(src, input);
    let cur = src;
    try {
        if (!skipRecode) {
            const enc = path.join(dir, `enc.${outExt}`);
            const args = ['-y', '-i', cur, '-c:a', CODEC[spec.codec]?.codec ?? 'copy'];
            if (spec.bitrate) args.push('-b:a', `${spec.bitrate}k`);
            if (spec.codec === 'OPUS') args.push('-vbr', 'on');
            args.push(enc);
            await runFfmpeg(args);
            cur = enc;
        }

        if (doTags) {
            const artists = spec.artist || 'Various Artists';
            let meta = ';FFMETADATA1';
            meta += `\ntitle=${metaEsc(spec.title)}`;
            meta += `\nartist=${metaEsc(artists)}`;
            meta += `\nalbum_artist=${metaEsc(artists)}`;
            meta += `\nalbum=${metaEsc(spec.album || spec.title)}`;
            if (spec.genre) meta += `\ngenre=${metaEsc(spec.genre)}`;
            if (spec.date) meta += `\ndate=${metaEsc(spec.date)}`;
            if (spec.year) meta += `\nyear=${metaEsc(spec.year)}`;
            if (spec.label) meta += `\nlabel=${metaEsc(spec.label)}`;
            if (spec.copyright) meta += `\ncopyright=${metaEsc(spec.copyright)}`;
            if (spec.isrc) meta += `\nisrc=${metaEsc(spec.isrc)}`;
            if (spec.upc) meta += `\nbarcode=${metaEsc(spec.upc)}`;
            if (spec.trackNum) meta += `\ntrack=${spec.totalTracks ? `${spec.trackNum}/${spec.totalTracks}` : spec.trackNum}`;
            if (spec.discNum) meta += `\ndisc=${spec.discNum}`;
            const metaFile = path.join(dir, 'meta.txt');
            fs.writeFileSync(metaFile, meta, 'utf-8');
            const tagged = path.join(dir, `tagged.${outExt}`);
            await runFfmpeg(['-y', '-i', cur, '-i', metaFile, '-map_metadata', '1', '-codec', 'copy', tagged]);
            cur = tagged;
        }

        // cover art embed — not for wav/ogg-family containers
        if (doTags && spec.artUrl && !['wav', 'webm'].includes(outExt)) {
            try {
                const art = await fetchBuf(normalizeArtUrl(spec.artUrl)!, { 'User-Agent': 'Mozilla/5.0' });
                const artFile = path.join(dir, 'art.jpg');
                fs.writeFileSync(artFile, art);
                const fin = path.join(dir, `out.${outExt}`);
                await runFfmpeg(['-y', '-i', cur, '-i', artFile, '-c', 'copy', '-map', '0', '-map', '1', '-disposition:v:0', 'attached_pic', fin]);
                cur = fin;
            } catch {
                // art fetch/embed failure is non-fatal — tagged file still goes out
            }
        }

        return { data: fs.readFileSync(cur), ext: outExt };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// Build a DownloadSpec from a normalized track (+ its album) — mirrors what the
// client used to feed applyMetadata: FFMETADATA fields + filename pattern.
export function specFromTrack(track: any, base: Omit<DownloadSpec, 'id' | 'title' | 'artist' | 'album' | 'filename'> & { trackNamePattern?: string }): DownloadSpec {
    const album = track.album ?? track;
    const artists = album?.artists?.length ? album.artists.map((a: any) => a.name).join(', ') : track.performer?.name || 'Various Artists';
    const title = `${track.title ?? ''}${track.version ? ` (${track.version})` : ''}`.trim();
    const albumTitle = `${album?.title ?? title}${album?.version ? ` (${album.version})` : ''}`.trim();
    const year = album?.release_date_original ? String(new Date(album.release_date_original).getFullYear()) : album?.released_at ? String(new Date(album.released_at * 1000).getFullYear()) : undefined;
    const pattern = base.trackNamePattern ?? '{artists} - {name}';
    const filename = pattern
        .replaceAll('{artists}', artists)
        .replaceAll('{name}', title)
        .replaceAll('{year}', year ?? '')
        .replaceAll('{duration}', String(track.duration ?? ''))
        .replace(/[\/\\?:"*<>|]/g, '_')
        .trim();
    const art = album?.image?.large ?? track.image?.large;
    const artUrl = normalizeArtUrl(typeof art === 'string' ? art : undefined);
    return {
        ...base,
        id: String(track.id),
        title,
        artist: artists,
        album: albumTitle,
        trackNum: track.track_number,
        totalTracks: album?.tracks_count ?? undefined,
        discNum: track.media_number,
        genre: album?.genre?.name,
        date: album?.release_date_original,
        year,
        label: album?.label?.name,
        copyright: track.copyright,
        isrc: track.isrc,
        upc: album?.upc,
        artUrl,
        filename: filename || title
    };
}

// ================= STREAMING PIPELINE =================
// Bytes flow platform → ffmpeg → HTTP response, so Chrome's download manager shows
// real progress instead of a silent buffer-then-save.

// Deezer stripes: every 3rd 2048-byte block is blowfish-CBC'd with a per-stripe IV reset,
// so each stripe decrypts independently — safe to decrypt chunk-by-chunk.
function deezerDecryptStream(sngId: string): Transform {
    const bf = new Blowfish(blowfishKey(sngId), Blowfish.MODE.CBC, Blowfish.PADDING.NULL);
    const iv = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    let carry = Buffer.alloc(0);
    let block = 0;
    return new Transform({
        transform(chunk: Buffer, _enc, cb) {
            carry = Buffer.concat([carry, chunk]);
            while (carry.length >= 2048) {
                const b = carry.subarray(0, 2048);
                carry = carry.subarray(2048);
                if (block % 3 === 0) {
                    bf.setIv(iv);
                    this.push(Buffer.from(bf.decode(new Uint8Array(b), Blowfish.TYPE.UINT8_ARRAY)));
                } else {
                    this.push(b);
                }
                block++;
            }
            cb();
        },
        flush(cb) {
            if (carry.length) this.push(carry);
            cb();
        }
    });
}

interface Upstream {
    stream: Readable;
    format: string;
    decryptKey?: string;
    contentLength?: number;
    cleanup?: () => void;
}

async function axiosStream(url: string, headers: Record<string, string> = {}): Promise<{ stream: Readable; length: number; contentType: string }> {
    const r = await axios.get(url, { responseType: 'stream', timeout: 300000, headers, maxRedirects: 5 });
    return { stream: r.data as Readable, length: parseInt(r.headers['content-length'] ?? '0') || 0, contentType: String(r.headers['content-type'] ?? '') };
}

// Declared formats lie (qobuz says flac for mp3 tiers) — the upstream content-type is truth.
const CT_FORMAT: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/x-m4p': 'm4a',
    'audio/aac': 'm4a',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm',
    'audio/wav': 'wav'
};

// Sequential range fetcher → Readable for Amazon's segmented fMP4
async function* amazonRangeGen(baseUrl: string, segments: { initialization_range?: string | null; media_range?: string | null }[]): AsyncGenerator<Buffer> {
    const ranges = segments.map((s) => s.media_range ?? s.initialization_range).filter((r): r is string => !!r && /^\d+-\d+$/.test(r));
    if (ranges.length > 1) {
        // prefetch window keeps throughput high without a giant buffer
        const WIN = 4;
        for (let i = 0; i < ranges.length; i += WIN) {
            const batch = ranges.slice(i, i + WIN);
            const parts = await Promise.all(batch.map((r) => axios.get(baseUrl, { headers: { Range: `bytes=${r}` }, responseType: 'arraybuffer', timeout: 120000 })));
            for (const p of parts) yield Buffer.from(p.data);
        }
    } else {
        const r = await axios.get(baseUrl, { responseType: 'arraybuffer', timeout: 300000 });
        yield Buffer.from(r.data);
    }
}

// Tidal DASH → sequential segment Readable
async function* dashGen(mpd: string): AsyncGenerator<Buffer> {
    const initMatch = mpd.match(/initialization="([^"]+)"/);
    const mediaMatch = mpd.match(/media="([^"]+)"/);
    if (!initMatch || !mediaMatch) throw new Error('Unparseable Tidal DASH manifest');
    const init = initMatch[1].replace(/&amp;/g, '&');
    const mediaTemplate = mediaMatch[1].replace(/&amp;/g, '&');
    const tlDur = mpd.match(/<SegmentTimeline[^>]*>([\s\S]*?)<\/SegmentTimeline>/);
    const segUrls: string[] = [];
    if (tlDur) {
        const sEntries = [...tlDur[1].matchAll(/<S[^>]*d="(\d+)"[^>]*(?:r="(\d+)")?/g)];
        let idx = 1;
        for (const e of sEntries) {
            const rep = parseInt(e[2] ?? '0') + 1;
            for (let i = 0; i < rep; i++) segUrls.push(mediaTemplate.replace(/\$(?:Number|num)\$/g, String(idx++)));
        }
    } else {
        for (let i = 1; i <= 1000; i++) segUrls.push(mediaTemplate.replace(/\$(?:Number|num)\$/g, String(i)));
    }
    yield Buffer.from((await axios.get(init, { responseType: 'arraybuffer', timeout: 30000 })).data);
    for (const u of segUrls) {
        try {
            yield Buffer.from((await axios.get(u, { responseType: 'arraybuffer', timeout: 30000 })).data);
        } catch {
            break;
        }
    }
}

// Spawn a librespot session streaming straight to stdout (spotify-native.py '-' mode)
function spotifyStdout(trackId: string, quality: string, creds: string): ChildProcessWithoutNullStreams {
    const args = [path.join(process.cwd(), 'tools', 'spotify-native.py'), trackId, '-', '--quality', quality, '--creds', creds];
    return spawn(PY_BIN, args, { env: { ...process.env, ...PY_ENV }, windowsHide: true });
}

// Resolve the raw audio stream for a source. Returns null for file-based natives
// (apple amdl) → caller uses the buffered path.
async function produceTrackStream(spec: DownloadSpec): Promise<Upstream | null> {
    const ctx: RequestContext = { tokens: (spec.tokens ?? {}) as any, country: spec.country };
    const { source, id, quality } = spec;

    if (source === 'deezer') {
        const info = await resolveDeezerTrack(id, quality as any, ctx);
        const up = await axiosStream(info.url);
        return { stream: up.stream.pipe(deezerDecryptStream(String(info.sngId))), format: CT_FORMAT[up.contentType] ?? info.format, contentLength: up.length };
    }

    if (source === 'tidal') {
        const info = await resolveTidalTrack(id, quality as any, ctx);
        if (info.dashManifest) return { stream: Readable.from(dashGen(info.dashManifest)), format: 'mp4' };
        const up = await axiosStream(info.url!, { 'User-Agent': 'Mozilla/5.0' });
        return { stream: up.stream, format: CT_FORMAT[up.contentType] ?? info.format ?? 'flac', contentLength: up.length };
    }

    if (source === 'qobuz') {
        const info = await adapters.qobuz.getDownloadURL(id, quality as any, ctx);
        const up = await axiosStream(info.url, { 'User-Agent': 'Mozilla/5.0' });
        return { stream: up.stream, format: CT_FORMAT[up.contentType] ?? info.format ?? 'flac', contentLength: up.length };
    }

    if (source === 'apple-preview' || ((source === 'apple' || source === 'apple-native') && !spec.tokens?.appleMediaToken && !process.env.APPLE_MEDIA_USER_TOKEN)) {
        const res = await axios.get('https://itunes.apple.com/lookup', { params: { id }, timeout: 15000 });
        const t = (res.data.results ?? []).find((r: any) => r.wrapperType === 'track');
        if (!t?.previewUrl) throw new Error('no preview available for this track');
        const up = await axiosStream(t.previewUrl, { 'User-Agent': 'Mozilla/5.0' });
        return { stream: up.stream, format: CT_FORMAT[up.contentType] ?? 'm4a', contentLength: up.length };
    }

    if (source === 'spotify' || source === 'spotify-native') {
        // stream via spotify-native.py '-' — real bytes flow as librespot fetches them
        materializeSessions();
        const credDir = path.join(process.cwd(), 'data');
        const creds = fs.readdirSync(credDir).filter((f) => f === 'credentials.json' || /^spotify-(?!oauth-|pkce-).*\.json$/.test(f));
        if (!creds.length) throw new Error('Spotify account not connected');
        const credFile = path.join(credDir, creds[0]);
        const qMap: Record<string, string> = { '27': 'lossless', '7': 'very_high', '6': 'high', '5': 'normal' };
        const ladder = [qMap[quality] ?? 'very_high', 'very_high', 'high', 'normal'].filter((v, i, a) => a.indexOf(v) === i);
        let lastErr = '';
        for (const q of ladder) {
            const proc = await withLibrespotLock(() => Promise.resolve(spotifyStdout(id, q, credFile)));
            const ok = await new Promise<boolean>((resolve) => {
                let settled = false;
                const done = (v: boolean) => {
                    if (!settled) {
                        settled = true;
                        resolve(v);
                    }
                };
                proc.stderr.on('data', (d) => {
                    lastErr += d.toString();
                    // spotify-native.py prints the result JSON on stderr in '-' mode — a good sign
                    if (lastErr.includes('"file"')) done(true);
                });
                // 'readable' fires on first buffered bytes WITHOUT consuming them
                proc.stdout.once('readable', () => done(true));
                proc.on('close', () => done(false));
                proc.on('error', () => done(false));
            });
            if (ok) return { stream: proc.stdout, format: 'ogg', cleanup: () => proc.kill('SIGKILL') };
            lastErr = lastErr.slice(-400);
        }
        throw new Error(lastErr || 'spotify stream failed for all qualities');
    }

    if (source === 'amazon' || source === 'amazon-native') {
        const zQ = quality === '27' ? 'Max' : quality === '7' ? 'Master' : quality === '6' ? 'High' : 'Normal';
        const { picked, key } = await resolveAmazonStream(id, zQ as any, { amazonToken: spec.tokens?.amazonToken });
        return { stream: Readable.from(amazonRangeGen(picked.base_url!, picked.segments ?? [])), format: 'mp4', decryptKey: key };
    }

    if (source === 'apple' || source === 'apple-native') return null; // amdl writes a file — buffered path

    return null;
}

const OUT_FMT: Record<string, string> = { flac: 'flac', mp3: 'mp3', wav: 'wav', ogg: 'ogg', opus: 'opus', webm: 'webm', m4a: 'mp4' };

// Upstream → ffmpeg(stdin) → stdout → response. One process does decrypt+tag+encode.
export async function streamTaggedTrack(spec: DownloadSpec, jobId?: string): Promise<{ body: Readable; ext: string; contentLength?: number; cleanup?: () => void }> {
    const prog = (patch: Partial<JobProgress>) => jobId && setProgress(jobId, patch);
    prog({ stage: 'resolving' });
    const up = await produceTrackStream(spec);

    const sourceMode = spec.codec === 'SOURCE';
    const inExt = up ? (EXT_OF_FORMAT[up.format] ?? 'flac') : 'flac';
    const outExt = sourceMode ? inExt : (CODEC[spec.codec]?.ext ?? inExt);
    const skipRecode = sourceMode || inExt === outExt || (inExt === 'flac' && spec.codec === 'FLAC') || (inExt === 'mp3' && spec.codec === 'MP3' && spec.bitrate === 320);
    const doTags = spec.applyMeta && outExt !== 'wav';

    // pure pass-through — no processing needed at all
    if (up && skipRecode && !doTags && !up.decryptKey) {
        if (jobId && up.contentLength) prog({ total: up.contentLength });
        const counted = jobId ? up.stream.pipe(countingTransform(jobId, 'sent', 'sending')) : up.stream;
        counted.on('end', () => prog({ stage: 'done' }));
        counted.on('error', (e: any) => prog({ stage: 'error', error: e?.message ?? 'stream error' }));
        return { body: counted, ext: outExt, contentLength: up.contentLength, cleanup: up.cleanup };
    }

    // mp4/m4a can't produce a properly-formed tagged file on an unseekable pipe
    // (empty_moov drops the attached-pic codec params) — and wav needs a sized
    // header. Those take the buffered path; flac/mp3/ogg-family stream cleanly.
    const streamable = ['flac', 'mp3', 'ogg', 'opus', 'webm'].includes(outExt);
    if (!up || !streamable) {
        up?.stream.destroy();
        up?.cleanup?.();
        prog({ stage: 'downloading' });
        const { data, format } = await produceTrackBytes(spec);
        prog({ stage: 'processing', received: data.length, total: data.length });
        const { data: out, ext } = await tagAndEncode(data, format, spec);
        prog({ stage: 'sending' });
        const body = jobId ? Readable.from(out).pipe(countingTransform(jobId, 'sent')) : Readable.from(out);
        body.on('end', () => prog({ stage: 'done' }));
        return { body, ext };
    }

    prog({ stage: 'downloading', total: up.contentLength });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagstream-'));
    try {
        const args: string[] = ['-hide_banner', '-loglevel', 'error'];
        if (up.decryptKey) args.push('-decryption_key', up.decryptKey);
        args.push('-i', 'pipe:0');

        let inputIdx = 1;
        let metaInput = -1;
        if (doTags) {
            const artists = spec.artist || 'Various Artists';
            let meta = ';FFMETADATA1';
            meta += `\ntitle=${metaEsc(spec.title)}`;
            meta += `\nartist=${metaEsc(artists)}`;
            meta += `\nalbum_artist=${metaEsc(artists)}`;
            meta += `\nalbum=${metaEsc(spec.album || spec.title)}`;
            if (spec.genre) meta += `\ngenre=${metaEsc(spec.genre)}`;
            if (spec.date) meta += `\ndate=${metaEsc(spec.date)}`;
            if (spec.year) meta += `\nyear=${metaEsc(spec.year)}`;
            if (spec.label) meta += `\nlabel=${metaEsc(spec.label)}`;
            if (spec.copyright) meta += `\ncopyright=${metaEsc(spec.copyright)}`;
            if (spec.isrc) meta += `\nisrc=${metaEsc(spec.isrc)}`;
            if (spec.upc) meta += `\nbarcode=${metaEsc(spec.upc)}`;
            if (spec.trackNum) meta += `\ntrack=${spec.totalTracks ? `${spec.trackNum}/${spec.totalTracks}` : spec.trackNum}`;
            if (spec.discNum) meta += `\ndisc=${spec.discNum}`;
            const metaFile = path.join(dir, 'meta.txt');
            fs.writeFileSync(metaFile, meta, 'utf-8');
            args.push('-i', metaFile);
            metaInput = inputIdx++;
        }

        const artFile = path.join(dir, 'art.jpg');
        let artInput = -1;
        if (doTags && spec.artUrl && !['wav', 'webm'].includes(outExt)) {
            try {
                const art = await fetchBuf(normalizeArtUrl(spec.artUrl)!, { 'User-Agent': 'Mozilla/5.0' });
                fs.writeFileSync(artFile, art);
                args.push('-i', artFile);
                artInput = inputIdx++;
            } catch {}
        }

        if (metaInput >= 0) args.push('-map_metadata', String(metaInput));
        args.push('-map', '0:a');
        if (artInput >= 0) args.push('-map', String(artInput), '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
        if (skipRecode) args.push('-c', 'copy');
        else {
            args.push('-c:a', CODEC[spec.codec]?.codec ?? 'copy');
            if (spec.bitrate) args.push('-b:a', `${spec.bitrate}k`);
            if (spec.codec === 'OPUS') args.push('-vbr', 'on');
        }
        const outFmt = OUT_FMT[outExt] ?? outExt;
        if (outFmt === 'mp4') args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof');
        args.push('-f', outFmt, 'pipe:1');

        const proc = spawn(ffmpegBin(), args, { windowsHide: true });
        const cleanup = () => {
            try {
                proc.kill('SIGKILL');
            } catch {}
            up.cleanup?.();
            fs.rmSync(dir, { recursive: true, force: true });
        };
        let errTail = '';
        proc.stderr.on('data', (d) => {
            errTail = (errTail + d.toString()).slice(-3000);
        });
        proc.stdout.on('close', cleanup);
        proc.on('close', (code) => {
            cleanup();
            if (jobId) prog(code === 0 ? { stage: 'done' } : { stage: 'error', error: errTail.trim().slice(-300) || `ffmpeg exited ${code}` });
        });
        // upstream bytes → 'downloading'; ffmpeg output → 'sending'
        const inCounted = jobId ? up.stream.pipe(countingTransform(jobId, 'received', 'downloading')) : up.stream;
        inCounted.pipe(proc.stdin);
        proc.stdin.on('error', () => {}); // EPIPE when ffmpeg dies early
        const outBody = jobId ? proc.stdout.pipe(countingTransform(jobId, 'sent', 'sending')) : proc.stdout;
        outBody.on('error', (e: any) => prog({ stage: 'error', error: e?.message ?? 'ffmpeg stream error' }));
        return { body: outBody, ext: outExt, cleanup };
    } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true });
        up.cleanup?.();
        throw e;
    }
}

// ------------------ job progress ------------------
export interface JobProgress {
    stage: 'queued' | 'resolving' | 'downloading' | 'processing' | 'sending' | 'done' | 'error';
    received: number; // upstream bytes fetched
    sent: number; // response bytes delivered to the browser
    total?: number; // upstream total when known
    label?: string; // e.g. 'Track 3/12 — Faded'
    error?: string;
    cancelled?: boolean;
    at: number;
}

declare global {
    var __dlProgress: Map<string, JobProgress> | undefined;
}
const progressMap: Map<string, JobProgress> = (globalThis.__dlProgress ??= new Map());

const PROGRESS_TTL = 5 * 60 * 1000;
export function setProgress(id: string, patch: Partial<JobProgress>) {
    const p = progressMap.get(id) ?? { stage: 'queued', received: 0, sent: 0, at: Date.now() };
    Object.assign(p, patch);
    p.at = Date.now();
    progressMap.set(id, p);
    if (progressMap.size > 200)
        for (const [k, v] of progressMap) if (Date.now() - v.at > PROGRESS_TTL) progressMap.delete(k);
}
export function getProgress(id: string): JobProgress | null {
    const p = progressMap.get(id);
    if (!p) return null;
    if ((p.stage === 'done' || p.stage === 'error') && Date.now() - p.at > PROGRESS_TTL) return null;
    return p;
}

// Counts bytes and reflects them into the job's progress entry. Stops the pipeline
// dead when the user cancels.
function countingTransform(id: string, field: 'received' | 'sent', stage?: JobProgress['stage']) {
    return new Transform({
        transform(chunk: Buffer, _enc, cb) {
            const p = progressMap.get(id);
            if (p?.cancelled) {
                cb(new Error('cancelled'));
                return;
            }
            if (p) {
                p[field] += chunk.length;
                if (stage && p.stage !== 'done' && p.stage !== 'error') p.stage = stage;
                p.at = Date.now();
            }
            this.push(chunk);
            cb();
        }
    });
}

// ------------------ download job handoff ------------------
// Client POSTs the full spec (settings + tokens) → gets a job id → a[download] on
// /api/download-file?job=<id> lets Chrome own the transfer with live progress.
export interface StoredJob {
    spec: DownloadSpec;
    at: number;
    used?: boolean;
}

const JOB_TTL = 15 * 60 * 1000;
declare global {
    var __dlJobs: Map<string, StoredJob> | undefined;
}
const jobs: Map<string, StoredJob> = (globalThis.__dlJobs ??= new Map());

export function createJob(spec: DownloadSpec): string {
    const id = crypto.randomBytes(16).toString('hex');
    jobs.set(id, { spec, at: Date.now() });
    // sweep
    for (const [k, v] of jobs) if (Date.now() - v.at > JOB_TTL) jobs.delete(k);
    return id;
}

export function takeJob(id: string): StoredJob | null {
    const j = jobs.get(id) ?? null;
    if (!j) return null;
    jobs.delete(id);
    return Date.now() - j.at <= JOB_TTL ? j : null;
}
