// Server-side download pipeline: resolve platform audio → ffmpeg-static tags/art/codec →
// bytes the browser can take over natively (a[download] → Chrome download manager).
// Replaces the old client-side ffmpeg.wasm + in-memory blob flow.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { PassThrough, Readable, Transform } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import ffmpegPath from 'ffmpeg-static';
import { adapters } from './platforms';
import { getSetting } from './token-pool';
import { resolveDeezerTrack, decryptDeezerFile, blowfishKey } from './platforms/deezer';
import { resolveTidalTrack, resolveTidalPreview } from './platforms/tidal';
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
    // per-host max-size rules — a generic /WxH→bb rewrite 404s on non-Apple CDNs
    if (/mzstatic\.com/.test(url)) return url.replace(/\/\d+x\d+(bb)?\./, '/1400x1400bb.');
    if (/resources\.tidal\.com/.test(url)) return url.replace(/\/\d+x\d+\./, '/1280x1280.');
    if (/images\.qobuz\.com|static\.qobuz\.com/.test(url) && /_\d+\.jpg$/.test(url)) return url.replace(/_\d+\.jpg$/, '_org.jpg');
    if (/cdn-images\.dzcdn\.net|e-cdns-images\.dzcdn\.net/.test(url)) return url.replace(/\/\d+x\d+-/, '/1200x1200-');
    return url;
}

// Vorbis-family containers (ogg/opus) can't carry a picture *stream* — ffmpeg's
// ogg muxer rejects it ('Unsupported codec id in stream 1'). The standard is a
// base64 FLAC picture block in a METADATA_BLOCK_PICTURE comment.
export function flacPictureBlock(art: Buffer, mime = 'image/jpeg'): string {
    const m = Buffer.from(mime);
    const buf = Buffer.alloc(8 + 4 + m.length + 4 + 16 + 4 + art.length);
    let o = 0;
    buf.writeUInt32BE(3, o); o += 4; // type 3 = front cover
    buf.writeUInt32BE(m.length, o); o += 4;
    m.copy(buf, o); o += m.length;
    buf.writeUInt32BE(0, o); o += 4; // desc len
    for (let i = 0; i < 4; i++) { buf.writeUInt32BE(0, o); o += 4; } // w/h/depth/colors (0 = unknown)
    buf.writeUInt32BE(art.length, o); o += 4;
    art.copy(buf, o);
    return buf.toString('base64');
}

// Escape for FFMETADATA1 format (\ = ; # and newlines are reserved)
const metaEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, ' ').replace(/([=;#])/g, '\\$1');

// ---------------- ID3v2.3 builder ----------------
// ffmpeg writes an ID3 tag on unseekable pipe output with a ZERO size field
// (it can't seek back to patch it) — players/ffprobe then reject the file.
// Fix: strip muxer tags (-id3v2_version 0) and prepend a complete tag we build.
const syncsafe4 = (n: number) => Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
const be32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
};
const id3Frame = (id: string, payload: Buffer) => Buffer.concat([Buffer.from(id, 'latin1'), be32(payload.length), Buffer.alloc(2), payload]);
const id3Text = (id: string, text: string) => id3Frame(id, Buffer.concat([Buffer.from([0x03]), Buffer.from(text, 'utf8')]));

export function buildId3v2(spec: DownloadSpec, art?: Buffer | null, artMime = 'image/jpeg'): Buffer {
    const frames: Buffer[] = [];
    const add = (id: string, v?: string | number) => {
        if (v !== undefined && v !== null && String(v) !== '') frames.push(id3Text(id, String(v)));
    };
    add('TIT2', spec.title);
    add('TPE1', spec.artist);
    add('TPE2', spec.artist);
    add('TALB', spec.album || spec.title);
    add('TCON', spec.genre);
    add('TDRC', spec.date || spec.year);
    add('TRCK', spec.trackNum ? String(spec.totalTracks ? `${spec.trackNum}/${spec.totalTracks}` : spec.trackNum) : undefined);
    add('TPOS', spec.discNum);
    add('TPUB', spec.label);
    add('TCOP', spec.copyright);
    add('TSRC', spec.isrc);
    if (art?.length) {
        const apic = Buffer.concat([Buffer.from([0x03]), Buffer.from(artMime + '\0', 'latin1'), Buffer.from([3]), Buffer.from('\0', 'latin1'), art]);
        frames.push(id3Frame('APIC', apic));
    }
    const body = Buffer.concat(frames);
    return Buffer.concat([Buffer.from('ID3\x03\x00\x00', 'latin1'), syncsafe4(body.length), body]);
}

// transient upstream hiccups (CDN mid-read ECONNRESET, edge 5xx) shouldn't kill
// a whole job — bounded retry with light backoff on every buffer fetch.
// ENOTFOUND/EAI_AGAIN too — a flapping local DNS relay shouldn't abort jobs
const RETRYABLE_NET = /ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|ENETRESET|ENETUNREACH|ENOTFOUND|EAI_AGAIN|socket|terminated/i;
async function axiosBuf(url: string, headers: Record<string, string> = {}, timeout = 300000, tries = 3): Promise<Buffer> {
    let last: any;
    for (let i = 0; i < tries; i++) {
        try {
            const r = await axios.get(url, { responseType: 'arraybuffer', timeout, headers, maxRedirects: 5 });
            return Buffer.from(r.data);
        } catch (e: any) {
            last = e;
            const retriable = RETRYABLE_NET.test(String(e?.code ?? '') + ' ' + String(e?.message ?? '')) || (e?.response?.status ?? 0) >= 500;
            if (!retriable || i === tries - 1) throw e;
            await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        }
    }
    throw last;
}

async function fetchBuf(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
    return axiosBuf(url, headers);
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
        const enc = await axiosBuf(info.url);
        return { data: decryptDeezerFile(enc, String(info.sngId)), format: info.format };
    }

    if (source === 'tidal') {
        try {
            const info = await resolveTidalTrack(id, quality as any, ctx);
            if (info.dashManifest) return { data: await assembleDash(info.dashManifest), format: 'mp4' };
            return { data: await fetchBuf(info.url!, { 'User-Agent': 'Mozilla/5.0' }), format: info.format ?? 'flac' };
        } catch (e: any) {
            // no usable session (missing/expired token) → the web player's anonymous
            // mp3 preview is what this request can legally fetch — honest fallback.
            if (!/expired|session|access token|no usable/i.test(e?.message ?? '')) throw e;
            const p = await resolveTidalPreview(id);
            return { data: await fetchBuf(p.url, { 'User-Agent': 'Mozilla/5.0' }), format: 'mp3' };
        }
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
        try {
            const r = await downloadAppleNative(id, aQ, {
                appleMediaToken: spec.tokens?.appleMediaToken,
                appleWrapper: spec.tokens?.appleWrapper,
                isrc: spec.isrc,
                title: spec.title,
                artist: spec.artist
            });
            const data = fs.readFileSync(r.file);
            fs.unlink(r.file, () => {});
            return { data, format: r.format === 'mp4' ? 'm4a' : r.format };
        } catch (e: any) {
            // region lock — Apple won't mint keys for content outside the account's
            // storefront. The same recording usually exists on the other providers;
            // re-resolve by ISRC/title and fetch it there so the user's click still
            // gets them the audio at full quality.
            // amdl failures (bad adamId handed off, key minting rejected, CDN
            // errors past retries) and wrapper outages both mean no audio was
            // produced — fall back the same way rather than surface a dead click.
            if (!/region-locked|not available in the account's storefront|amdl failed|wrapper-lite not reachable/i.test(e?.message ?? '')) throw e;
            // admin toggle — 'off' means surface the honest region-lock error
            if (getSetting('appleFallback') === 'off') throw e;
            const fb = await appleCrossPlatformFallback(spec, ctx);
            if (fb) return fb;
            throw e;
        }
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

// Region-locked Apple tracks: the same recording usually exists on the other
// providers — re-resolve it there (ISRC first, else title+duration+artist) so a
// storefront lock doesn't mean "no download".
async function appleCrossPlatformFallback(spec: DownloadSpec, ctx: RequestContext): Promise<{ data: Buffer; format: string } | null> {
    const order: ('qobuz' | 'deezer' | 'tidal')[] = ['qobuz', 'deezer', 'tidal'];
    const wantTitle = (spec.title ?? '').trim().toLowerCase();
    const wantArtist = (spec.artist ?? '').split(/[,&]/)[0].trim().toLowerCase();
    console.log(`[apple-fallback] resolving "${spec.title}" — ${spec.artist} (isrc=${spec.isrc ?? 'none'}, dur=${spec.duration ?? '?'}s)`);
    for (const src of order) {
        try {
            // ISRC is the universal join key; text search is the fallback (some
            // providers don't index raw ISRCs in their search endpoint). Don't
            // stop at the first non-empty query — a fuzzy provider can return
            // unrelated rows for an ISRC string; gather all candidates, then match.
            const queries = spec.isrc ? [spec.isrc, `${spec.title} ${spec.artist}`] : [`${spec.title} ${spec.artist}`];
            const items: any[] = [];
            for (const q of queries) {
                try {
                    const res = await adapters[src].search(q, 8, 0, ctx);
                    for (const it of (res as any)?.tracks?.items ?? []) if (!items.includes(it)) items.push(it);
                } catch {}
            }
            const normTitle = (s: string) => s.toLowerCase().replace(/\s*[\(\[][^)\]]*(version|edit|remix|feat\.?|featuring|live|mono|stereo|remaster)[^)\]]*[\)\]]/g, '').trim();
            const wantNorm = normTitle(spec.title ?? '');
            let match: any = null;
            if (spec.isrc) match = items.find((t) => String(t.isrc ?? '').toLowerCase() === spec.isrc!.toLowerCase());
            if (!match) {
                match = items.find((t) => {
                    const name = String(t.title ?? '').trim().toLowerCase();
                    const perf = String(t.performer?.name ?? t.artist?.name ?? t.artists?.[0]?.name ?? '').toLowerCase();
                    const dur = Number(t.duration) || 0;
                    if (wantTitle && name !== wantTitle && normTitle(name) !== wantNorm) return false;
                    if (spec.duration && dur && Math.abs(dur - spec.duration) > 12) return false; // remixes/interludes diverge
                    if (wantArtist && perf && !perf.includes(wantArtist) && !wantArtist.includes(perf)) return false;
                    return true;
                });
            }
            if (!match) {
                console.log(`[apple-fallback] ${src}: ${items.length} candidates, none matched title/artist/duration`);
                continue;
            }
            console.log(`[apple-fallback] "${spec.title}" not on the apple storefront — resolved on ${src} (id ${match.id})`);
            const out = await produceTrackBytes({ ...spec, source: src, id: String(match.id) });
            // a provider under an unentitled account returns a ~30s preview —
            // reject it and try the next source rather than ship a sample
            if (spec.duration) {
                const got = await probeDuration(out.data);
                if (got > 0 && got < spec.duration * 0.6) {
                    console.log(`[apple-fallback] ${src} produced a ${Math.round(got)}s preview for a ${spec.duration}s track — trying next source`);
                    continue;
                }
            }
            return out;
        } catch (e: any) {
            console.log(`[apple-fallback] ${src} failed: ${e?.message?.slice(0, 120) ?? e}`);
            continue;
        }
    }
    return null;
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

// ffprobe duration of a produced buffer — guards the fallback chain against
// providers that silently return 30s previews instead of the full track.
function probeDuration(buf: Buffer): Promise<number> {
    return new Promise((resolve) => {
        const tmp = path.join(os.tmpdir(), `dur-${crypto.randomBytes(6).toString('hex')}.bin`);
        try {
            fs.writeFileSync(tmp, buf);
        } catch {
            return resolve(0);
        }
        const p = spawn(ffmpegBin(), ['-hide_banner', '-i', tmp], { windowsHide: true });
        let err = '';
        p.stderr.on('data', (d) => (err += d.toString()));
        const fin = () => {
            fs.unlink(tmp, () => {});
            const m = err.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
            resolve(m ? parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]) : 0);
        };
        p.on('close', fin);
        setTimeout(() => {
            try {
                p.kill('SIGKILL');
            } catch {}
            resolve(0);
        }, 20000);
    });
}

// Probe a buffered file's real audio codec via ffmpeg -i (manifests lie —
// Tidal serves FLAC inside fMP4 declared as audio/mp4, which breaks remuxing).
function probeAudioCodec(file: string): Promise<string> {
    return new Promise((resolve) => {
        const p = spawn(ffmpegBin(), ['-hide_banner', '-i', file], { windowsHide: true });
        let err = '';
        p.stderr.on('data', (d) => (err += d.toString()));
        p.on('close', () => resolve(err.match(/Audio:\s*([a-zA-Z0-9_]+)/)?.[1]?.toLowerCase() ?? ''));
        setTimeout(() => {
            try {
                p.kill('SIGKILL');
            } catch {}
            resolve('');
        }, 15000);
    });
}

// Apply FFMETADATA tags + cover art + optional transcode — server-side port of applyMetadata
export async function tagAndEncode(input: Buffer, inputFormat: string, spec: DownloadSpec): Promise<{ data: Buffer; ext: string }> {
    let inExt = EXT_OF_FORMAT[inputFormat] ?? 'flac';
    const sourceMode = spec.codec === 'SOURCE';
    // Manifests lie about containers (Tidal fMP4+FLAC, Qobuz "flac" = mp3) —
    // in source mode, probe the real codec and pick the matching extension.
    if (sourceMode) {
        const probeFile = path.join(os.tmpdir(), `probe-${crypto.randomBytes(6).toString('hex')}.${inExt}`);
        try {
            fs.writeFileSync(probeFile, input);
            const codec = await probeAudioCodec(probeFile);
            const CODEC_EXT: Record<string, string> = { flac: 'flac', mp3: 'mp3', aac: 'm4a', alac: 'm4a', eac3: 'm4a', vorbis: 'ogg', opus: 'ogg', pcm_s16le: 'wav', pcm_s24le: 'wav' };
            if (codec && CODEC_EXT[codec]) inExt = CODEC_EXT[codec];
        } catch {
        } finally {
            try {
                fs.rmSync(probeFile, { force: true });
            } catch {}
        }
    }
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

        // Fetch art first: for ogg/opus it lands in the FFMETADATA file as a
        // METADATA_BLOCK_PICTURE comment (the base64 block is far over the OS
        // arg limit, so it can't be a -metadata arg).
        const vorbisArt = ['ogg', 'opus'].includes(outExt);
        let artBuf: Buffer | null = null;
        if (doTags && spec.artUrl && !['wav', 'webm'].includes(outExt)) {
            try {
                artBuf = await fetchBuf(normalizeArtUrl(spec.artUrl)!, { 'User-Agent': 'Mozilla/5.0' });
            } catch {}
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
            if (artBuf && vorbisArt) meta += `\nMETADATA_BLOCK_PICTURE=${metaEsc(flacPictureBlock(artBuf))}`;
            const metaFile = path.join(dir, 'meta.txt');
            fs.writeFileSync(metaFile, meta, 'utf-8');
            const tagged = path.join(dir, `tagged.${outExt}`);
            await runFfmpeg(['-y', '-i', cur, '-i', metaFile, '-map_metadata', '1', '-codec', 'copy', tagged]);
            cur = tagged;
        }

        // cover art embed — stream-based for containers that carry pictures
        if (artBuf && !vorbisArt) {
            try {
                const artFile = path.join(dir, 'art.jpg');
                fs.writeFileSync(artFile, artBuf);
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
            const parts = await Promise.all(batch.map((r) => axiosBuf(baseUrl, { Range: `bytes=${r}` }, 120000)));
            for (const p of parts) yield p;
        }
    } else {
        yield await axiosBuf(baseUrl);
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
        try {
            const info = await resolveTidalTrack(id, quality as any, ctx);
            if (info.dashManifest) return { stream: Readable.from(dashGen(info.dashManifest)), format: 'mp4' };
            const up = await axiosStream(info.url!, { 'User-Agent': 'Mozilla/5.0' });
            return { stream: up.stream, format: CT_FORMAT[up.contentType] ?? info.format ?? 'flac', contentLength: up.length };
        } catch (e: any) {
            if (!/expired|session|access token|no usable/i.test(e?.message ?? '')) throw e;
            const p = await resolveTidalPreview(id);
            const up = await axiosStream(p.url, { 'User-Agent': 'Mozilla/5.0' });
            return { stream: up.stream, format: 'mp3', contentLength: up.length };
        }
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
                    if (lastErr.includes('"file"')) done(true); // result JSON on stderr = clean exit
                });
                // 'readable' also fires at EOF — require real buffered bytes, not just the event
                proc.stdout.once('readable', () => done(proc.stdout.readableLength > 0));
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
        prog({ stage: 'downloading' });
        let data: Buffer, format: string, decryptKey: string | undefined;
        if (up) {
            // drain the already-resolved stream — avoids a second resolve/license call
            const chunks: Buffer[] = [];
            for await (const c of up.stream) chunks.push(c as Buffer);
            up.cleanup?.();
            data = Buffer.concat(chunks);
            format = up.format;
            decryptKey = up.decryptKey;
        } else {
            ({ data, format } = await produceTrackBytes(spec));
        }
        prog({ stage: 'processing', received: data.length, total: data.length });
        // encrypted segments (amazon m4a) get decrypted in a first pass
        if (decryptKey) {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-'));
            try {
                const enc = path.join(dir, `in.${EXT_OF_FORMAT[format] ?? 'mp4'}`);
                const dec = path.join(dir, 'dec.mp4');
                fs.writeFileSync(enc, data);
                await runFfmpeg(['-y', '-decryption_key', decryptKey, '-i', enc, '-c', 'copy', dec]);
                data = fs.readFileSync(dec);
                format = 'mp4';
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }
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

        // Fetch art before building inputs: vorbis-family output embeds it as a
        // METADATA_BLOCK_PICTURE line inside the FFMETADATA file (a CLI arg would
        // blow the OS arg-length limit — the base64 block is ~400KB).
        let artBuf: Buffer | null = null;
        if (doTags && spec.artUrl && !['wav', 'webm'].includes(outExt)) {
            try {
                artBuf = await fetchBuf(normalizeArtUrl(spec.artUrl)!, { 'User-Agent': 'Mozilla/5.0' });
            } catch {}
        }
        const vorbisArt = ['ogg', 'opus'].includes(outExt);
        // mp3 tags go in via a hand-built ID3v2 block prepended to the stream —
        // ffmpeg's mp3 muxer writes a broken size-0 tag on unseekable pipes.
        const mp3Out = outExt === 'mp3';

        let inputIdx = 1;
        let metaInput = -1;
        if (doTags && !mp3Out) {
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
            if (artBuf && vorbisArt) meta += `\nMETADATA_BLOCK_PICTURE=${metaEsc(flacPictureBlock(artBuf))}`;
            const metaFile = path.join(dir, 'meta.txt');
            fs.writeFileSync(metaFile, meta, 'utf-8');
            args.push('-i', metaFile);
            metaInput = inputIdx++;
        }

        const artFile = path.join(dir, 'art.jpg');
        let artInput = -1;
        if (artBuf && !vorbisArt && !mp3Out) {
            fs.writeFileSync(artFile, artBuf);
            args.push('-i', artFile);
            artInput = inputIdx++;
        }

        if (metaInput >= 0) args.push('-map_metadata', String(metaInput));
        if (mp3Out) args.push('-map_metadata', '-1'); // strip source tags — we prepend our own
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
        if (mp3Out) args.push('-id3v2_version', '0'); // no muxer tag — prepended manually
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
            // not 'done' — bytes still need to flush to the client; the route's
            // relay sets 'done' when the response body actually drains.
            if (jobId) prog(code === 0 ? { stage: 'sending' } : { stage: 'error', error: errTail.trim().slice(-300) || `ffmpeg exited ${code}` });
        });
        // upstream bytes → 'downloading'; ffmpeg output → 'sending'
        const inCounted = jobId ? up.stream.pipe(countingTransform(jobId, 'received', 'downloading')) : up.stream;
        inCounted.pipe(proc.stdin);
        proc.stdin.on('error', () => {}); // EPIPE when ffmpeg dies early
        // mp3 gets a real ID3v2 header prepended before ffmpeg's raw frames
        let rawOut: Readable = proc.stdout;
        if (mp3Out && doTags) {
            const merged = new PassThrough();
            merged.write(buildId3v2(spec, artBuf));
            proc.stdout.pipe(merged);
            rawOut = merged;
        }
        const outBody = jobId ? rawOut.pipe(countingTransform(jobId, 'sent', 'sending')) : rawOut;
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
    // terminal stages are sticky — a late 'close' event mustn't regress done→sending
    if ((p.stage === 'done' || p.stage === 'error') && patch.stage && patch.stage !== 'done' && patch.stage !== 'error') {
        const { stage: _stage, ...rest } = patch;
        patch = rest;
    }
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

// live counters for the admin panel — active = not yet terminal/cancelled
export function jobStats() {
    let active = 0;
    for (const p of progressMap.values()) if (p.stage !== 'done' && p.stage !== 'error' && !p.cancelled) active++;
    return { active, total: progressMap.size, queued: jobs.size };
}
