// Server-side download pipeline: resolve platform audio → tag/mux → bytes the
// browser can take over natively.
//
// Architecture (post-refactor):
//   produceTrackStream — ONE resolver per source (was two parallel trees that
//     drifted). Returns a decrypted/plain Readable + size hints + decrypt key.
//     Downloads are strictly single-platform — the selected source serves the
//     true audio or the request fails honestly (region lock / entitlement /
//     preview-only). Metadata fallback stays inside the adapters.
//   Output paths:
//     A  passthrough          — no tags, no recode: stream upstream as-is (CL known)
//     B  flac/mp3 retagger    — metadata rewritten in-flight, no ffmpeg, EXACT size
//     D  staged file          — everything else (ogg/opus/webm/m4a/wav/encrypted):
//                               one ffmpeg pass to a temp file, then served with
//                               Content-Length + Range resume (stagedRegistry TTL)
import { spawn } from 'child_process';
import { Readable, Transform, pipeline } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { resolveDeezerTrack, blowfishKey } from './platforms/deezer';
import { resolveTidalTrack, resolveTidalPreview } from './platforms/tidal';
import { getDownloadInfo } from './qobuz-dl-server';
import { downloadAppleNative, resolveAmazonStreams, streamSpotifyNative, ffmpegBin } from './platforms/native-tools';
import { pickToken } from './token-pool';
import { Blowfish } from 'egoroof-blowfish';
import { FlacRetagger, Mp3Retagger, FormatMismatchError, buildFFMetadata, flacPictureBlockBytes, buildId3v2 } from './media-taggers';
import { DownloadError, type DownloadErrorKind, type PlatformSource, type RequestContext } from './platforms/types';
import { isAllowedArtworkUrl } from './platforms/normalize';
import { jobSet, queueEnabled } from './queue';

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

const EXT_OF_FORMAT: Record<string, string> = {
    flac: 'flac',
    mp3: 'mp3',
    m4a: 'm4a',
    mp4: 'm4a',
    aac: 'm4a',
    alac: 'm4a',
    m4b: 'm4a',
    m4p: 'm4a',
    eac3: 'm4a',
    webm: 'webm',
    opus: 'webm',
    ogg: 'ogg',
    vorbis: 'ogg',
    wav: 'wav',
    aiff: 'aiff'
};

// Bump artwork to its largest fetchable size — iTunes uses /NxNbb.jpg in the
// path, qobuz uses _N.jpg. Other CDNs are passed through untouched.
export function normalizeArtUrl(url?: string): string | undefined {
    if (!url) return undefined;
    // unwrap our own image proxy — the inner URL is the real CDN artwork
    const proxyMatch = url.match(/\/api\/image-proxy\?url=([^&]+)/);
    if (proxyMatch) {
        try {
            url = decodeURIComponent(proxyMatch[1]);
        } catch {
            return undefined;
        }
    }
    if (!url.startsWith('http')) return undefined;
    // `artUrl` is request-controlled. Fetch only provider image CDNs; otherwise
    // a caller could use tagging artwork as an SSRF/exfiltration primitive.
    if (!isAllowedArtworkUrl(url)) return undefined;
    // per-host max-size rules — a generic /WxH→bb rewrite 404s on non-Apple CDNs
    if (/mzstatic\.com/.test(url)) return url.replace(/\/\d+x\d+(bb)?\./, '/1400x1400bb.');
    if (/resources\.tidal\.com/.test(url)) return url.replace(/\/\d+x\d+\./, '/1280x1280.');
    if (/images\.qobuz\.com|static\.qobuz\.com/.test(url) && /_\d+\.jpg$/.test(url)) return url.replace(/_\d+\.jpg$/, '_org.jpg');
    if (/cdn-images\.dzcdn\.net|e-cdns-images\.dzcdn\.net/.test(url)) return url.replace(/\/\d+x\d+-/, '/1200x1200-');
    return url;
}

// Vorbis-family containers can't carry a picture *stream* — the standard is a
// base64 FLAC picture block in a METADATA_BLOCK_PICTURE comment. (Kept for
// callers that embed via FFMETADATA.)
export function flacPictureBlock(art: Buffer, mime = 'image/jpeg'): string {
    return flacPictureBlockBytes(art, mime).toString('base64');
}
export { buildId3v2 };

// ---------------- error taxonomy ----------------
// DownloadError itself lives in platforms/types (adapters throw it without a
// circular import); here we classify untyped failures for the fallback chain.
export { DownloadError, type DownloadErrorKind };

const RE_REGION = /region.?lock|storefront|not available in|geo.?loc|geo.?block|WrongGeolocation|market.?restrict|restrictions?|no stream URL|did not return a track token|not streamable|unavailable|Cannot get alternative|no playable stream|no usable.*stream/i;
const RE_ENTITLE = /eligible|entitle|premium.?required|subscription|tier|license|expired|session|access token|no usable|unauthor|401|403|token|credential|BadCredentials|not connected/i;
const RE_PREVIEW = /preview|sample/i;

export function classifyDlError(e: any): DownloadErrorKind {
    const msg = `${e?.message ?? ''} ${e?.kind ?? ''}`;
    if (e instanceof FormatMismatchError) return 'tool';
    if (RE_PREVIEW.test(msg) && RE_REGION.test(msg)) return 'region';
    if (RE_REGION.test(msg)) return 'region';
    if (RE_ENTITLE.test(msg)) return 'entitlement';
    if (RETRYABLE_NET.test(`${e?.code ?? ''} ${e?.message ?? ''}`)) return 'network';
    return 'unavailable';
}

// transient upstream hiccups (CDN mid-read ECONNRESET, edge 5xx) shouldn't kill
// a whole job — bounded retry with light backoff on every buffer fetch.
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

// ---------------- bounded concurrency ----------------
// Every pipeline spawns ffmpeg/python children and holds upstream sockets — an
// unbounded fleet of concurrent jobs is what flattened small hosts. Cap the
// production stage globally; queue depth is still unbounded (cheap to hold).
class Semaphore {
    private waiting: (() => void)[] = [];
    private inUse = 0;
    constructor(private max: number) {}
    async acquire(): Promise<() => void> {
        if (this.inUse < this.max) {
            this.inUse++;
            return this.release.bind(this);
        }
        await new Promise<void>((r) => this.waiting.push(r));
        this.inUse++;
        return this.release.bind(this);
    }
    private release() {
        this.inUse--;
        const next = this.waiting.shift();
        if (next) next();
    }
    get active() {
        return this.inUse;
    }
}
export const pipelineSlots = new Semaphore(Number(process.env.MAX_PARALLEL_DOWNLOADS ?? 4));

// ---------------- upstream producers ----------------

// Deezer stripes: every 3rd 2048-byte block is blowfish-CBC'd with a per-stripe
// IV reset — each stripe decrypts independently, safe as a chunk Transform.
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
                    // PADDING.NULL strips trailing 0x00 — the bytes WERE zeros,
                    // re-pad or the stream shrinks and Content-Length lies
                    const dec = Buffer.from(bf.decode(new Uint8Array(b), Blowfish.TYPE.UINT8_ARRAY));
                    this.push(dec.length === 2048 ? dec : Buffer.concat([dec, Buffer.alloc(2048 - dec.length)]));
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

export function artifactFilename(filename: string, ext: string, isPreview?: boolean): string {
    const suffix = `.${ext.toLowerCase()}`;
    const stem = filename.toLowerCase().endsWith(suffix) ? filename.slice(0, -suffix.length) : filename;
    return `${stem}${isPreview && !/preview/i.test(stem) ? ' (Preview)' : ''}.${ext}`;
}

export interface Upstream {
    stream?: Readable; // plain (decrypted) audio bytes
    file?: string; // file-producing natives (apple amdl) hand a path instead
    format: string; // real container format: flac|mp3|m4a|mp4|ogg|webm|opus
    contentLength?: number; // upstream bytes when known
    // true → contentLength is provider-claimed (deezer FILESIZE_* etc), good for
    // progress but NOT for a Content-Length header (observed small drift)
    lengthIsHint?: boolean;
    decryptKey?: string; // CENC key (amazon) — decrypt happens in the output stage
    servedBy?: string; // actual platform (set by the fallback layer)
    isPreview?: boolean; // ~30s asset — last resort only
    cleanup?: () => void;
}

async function axiosStream(url: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<{ stream: Readable; length: number; contentType: string; status: number }> {
    const r = await axios.get(url, { responseType: 'stream', timeout: 300000, headers, maxRedirects: 5, signal });
    return {
        stream: r.data as Readable,
        length: parseInt(r.headers['content-length'] ?? '0') || 0,
        contentType: String(r.headers['content-type'] ?? ''),
        status: r.status
    };
}

// ---------------- resilient upstream ----------------
// CDN sockets die mid-transfer (deezer media hosts are notorious — a reset at
// ~40% previously surfaced as a truncated "successful" file / closed socket).
// This wraps a plain-URL source: on 'error' or premature 'end' it reissues the
// GET with a Range header and splices the bytes back in, so downstream stages
// (blowfish decrypt, taggers) see one contiguous stream.
async function resilientStream(
    fetchFrom: (from: number) => Promise<{ stream: Readable; length: number; contentType: string; status: number }>,
    opts: { total?: number; maxReconnects?: number; tailPad?: number; signal?: AbortSignal } = {}
): Promise<{ stream: Readable; length: number; contentType: string }> {
    const MAX_RECONNECTS = opts.maxReconnects ?? 4;
    const IDLE_MS = 60000;
    const out = new Readable({
        read() {
            cur?.resume();
        },
        destroy(_e, cb) {
            // tearing down the wrapper must also kill the live CDN socket —
            // otherwise a discarded upstream keeps downloading in background
            ended = true;
            stopIdle();
            try {
                cur?.destroy();
            } catch {}
            cb(null);
        }
    });
    let cur: Readable | null = null;
    let received = 0;
    let total = opts.total ?? 0;
    let reconnects = 0;
    let ended = false;
    let connecting = false; // serialize connect() — a stalled connect + resume() mustn't double-open
    let skip = 0; // bytes to drop from the replayed stream (server ignored Range)
    let idle: NodeJS.Timeout | null = null;
    let contentType = '';

    const resetIdle = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => {
            try {
                cur?.destroy(new Error('upstream stalled'));
            } catch {}
        }, IDLE_MS);
    };
    const stopIdle = () => {
        if (idle) clearTimeout(idle);
        idle = null;
    };

    const connect = async (from: number): Promise<void> => {
        if (connecting) return;
        connecting = true;
        stopIdle(); // a slow connect must not trip the idle watchdog into a parallel reconnect
        try {
            const r = await fetchFrom(from);
            if (ended) {
                r.stream.destroy();
                return;
            }
            contentType = r.contentType || contentType;
            // a 200 to a Range request means the server replays from byte 0 —
            // drop the already-received prefix instead of splicing duplicates
            skip = from > 0 && r.status === 200 ? from : 0;
            // content-length on a ranged response is the REMAINING bytes
            if (r.length) total = Math.max(total, received + r.length - skip);
            cur = r.stream;
            resetIdle();
            cur!.on('data', (chunk: Buffer) => {
                resetIdle();
                let b: Buffer = chunk;
                if (skip > 0) {
                    if (skip >= b.length) {
                        skip -= b.length;
                        return;
                    }
                    b = b.subarray(skip);
                    skip = 0;
                }
                received += b.length;
                if (!out.push(b)) cur!.pause();
            });
            cur!.on('end', () => {
                if (ended) return;
                if (total && received < total) return resume();
                ended = true;
                stopIdle();
                out.push(null);
            });
            cur!.on('error', (e: any) => {
                if (ended) return;
                resume(e);
            });
        } finally {
            connecting = false;
        }
    };

    const finish = () => {
        ended = true;
        stopIdle();
        out.push(null);
    };

    const resume = (why?: any) => {
        if (ended) return;
        const shortfall = total ? total - received : 0;
        console.warn(`[upstream] reconnect at ${received}/${total}B (${why?.message ?? 'premature end'})`);
        // deezer's CL over-promises by a few bytes — the CDN 416s a Range past
        // the real EOF; a tiny zero tail is inaudible padding and keeps the
        // declared Content-Length honest
        if (opts.tailPad && shortfall > 0 && shortfall <= opts.tailPad) {
            out.push(Buffer.alloc(shortfall));
            received = total;
            return finish();
        }
        try {
            cur?.destroy();
        } catch {}
        if (opts.signal?.aborted || reconnects++ >= MAX_RECONNECTS) {
            ended = true;
            stopIdle();
            out.destroy(opts.signal?.aborted ? new Error('cancelled') : new Error(`upstream dropped — ${reconnects - 1} reconnects exhausted${why?.message ? `: ${why.message}` : ''}`));
            return;
        }
        connect(received).catch((e) => resume(e));
    };

    await connect(0);
    return { stream: out, length: total, contentType };
}


// Content-Types and resolver claims both lie — the bytes don't. Sniff the
// real container from the first ~12 bytes before choosing an output ext.
function sniffExt(head: Buffer): string | null {
    if (head.length < 12) return null;
    if (head.toString('latin1', 0, 4) === 'fLaC') return 'flac';
    if (head.toString('latin1', 0, 3) === 'ID3') return 'mp3';
    if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';
    if (head.toString('latin1', 0, 4) === 'OggS') return 'ogg';
    if (head.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
    if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE') return 'wav';
    if (head.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
    return null;
}

// Declared formats lie (qobuz says flac for mp3 tiers) — upstream content-type is truth.
// Content-Type may carry parameters ('audio/mpeg; charset=binary') — normalize.
const ctBase = (ct: string) => ct.split(';')[0].trim().toLowerCase();
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

// Yield head chunks then delegate to the rest of a stream — used after peeking
// at magic bytes without losing data.
async function* chainStreams(head: Buffer[], rest: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    yield* head;
    yield* rest;
}

// Pull the first `min` bytes off a paused stream for magic inspection; returns
// them plus a stream that still yields the complete byte sequence.
async function peekStream(stream: Readable, min: number): Promise<{ head: Buffer; rest: Readable }> {
    const head: Buffer[] = [];
    let got = 0;
    while (got < min) {
        const c = stream.read() as Buffer | null;
        if (!c) {
            const done = await Promise.race([
                new Promise<boolean>((r) => stream.once('readable', () => r(false))),
                new Promise<boolean>((r) => stream.once('end', () => r(true))),
                new Promise<boolean>((r) => stream.once('error', () => r(true)))
            ]);
            if (done) break;
            continue;
        }
        head.push(c);
        got += c.length;
    }
    return { head: Buffer.concat(head), rest: Readable.from(chainStreams(head, stream as any)) };
}

// ---------------- segmented sources ----------------

// Tidal DASH fMP4: init + numbered media segments, expanded from SegmentTimeline.
// A failed segment is a truncated track — THROW, never silently break (the old
// version delivered half-songs as "successful" downloads).
function dashSegmentUrls(mpd: string): { init: string; segs: string[] } {
    const initMatch = mpd.match(/initialization="([^"]+)"/);
    const mediaMatch = mpd.match(/media="([^"]+)"/);
    if (!initMatch || !mediaMatch) throw new Error('Unparseable Tidal DASH manifest');
    const init = initMatch[1].replace(/&amp;/g, '&');
    const mediaTemplate = mediaMatch[1].replace(/&amp;/g, '&');
    const tlDur = mpd.match(/<SegmentTimeline[^>]*>([\s\S]*?)<\/SegmentTimeline>/);
    const segs: string[] = [];
    if (tlDur) {
        const sEntries = [...tlDur[1].matchAll(/<S[^>]*d="(\d+)"[^>]*(?:r="(\d+)")?/g)];
        let idx = 1;
        for (const e of sEntries) {
            const rep = parseInt(e[2] ?? '0') + 1;
            for (let i = 0; i < rep; i++) segs.push(mediaTemplate.replace(/\$(?:Number|num)\$/g, String(idx++)));
        }
    } else {
        for (let i = 1; i <= 1000; i++) segs.push(mediaTemplate.replace(/\$(?:Number|num)\$/g, String(i)));
    }
    return { init, segs };
}

const SEG_TRIES = 3;

// Buffered DASH for the legacy stream-audio preview route — same generator,
// drained to memory (was a third hand-copied assembler with the same
// silent-truncation bug this fixes by throwing).
export async function dashBytes(mpd: string): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const c of dashGen(mpd)) parts.push(c);
    return Buffer.concat(parts);
}

async function fetchSeg(url: string, tries = SEG_TRIES): Promise<Buffer> {
    let last: any;
    for (let i = 0; i < tries; i++) {
        try {
            return Buffer.from((await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 })).data);
        } catch (e) {
            last = e;
            await new Promise((r) => setTimeout(r, 300 * (i + 1)));
        }
    }
    throw last;
}

async function* dashGen(mpd: string): AsyncGenerator<Buffer> {
    const { init, segs } = dashSegmentUrls(mpd);
    yield await fetchSeg(init);
    if (!segs.length) return;
    // no SegmentTimeline → segments are numbered until the CDN 404s; a 404 at
    // the tail is normal EOF, a failure mid-list is corruption
    const hasTimeline = segs.length < 1000;
    const WIN = 4;
    for (let i = 0; i < segs.length; i += WIN) {
        const batch = segs.slice(i, i + WIN);
        const parts = await Promise.all(batch.map((u, j) => fetchSeg(u).catch((e) => ({ __err: e, idx: i + j }))));
        for (let j = 0; j < parts.length; j++) {
            const p: any = parts[j];
            if (p?.__err) {
                const status = p.__err?.response?.status;
                if (!hasTimeline && (status === 404 || status === 410)) return; // expected tail
                throw new DownloadError('network', `Tidal segment ${i + j} failed: ${p.__err?.message ?? 'fetch error'}`);
            }
            yield p as Buffer;
        }
    }
}

// Amazon fMP4: init + contiguous media ranges on one base URL. The windowed
// prefetch beats CloudFront's per-connection throttle while keeping order.
async function* amazonRangeGen(baseUrl: string, ranges: string[]): AsyncGenerator<Buffer> {
    const WIN = 4;
    for (let i = 0; i < ranges.length; i += WIN) {
        const batch = ranges.slice(i, i + WIN);
        const parts = await Promise.all(batch.map((r) => axiosBuf(baseUrl, { Range: `bytes=${r}` }, 120000)));
        for (const p of parts) yield p;
    }
}

export function amazonRanges(segments: { initialization_range?: string | null; media_range?: string | null }[] | undefined): string[] {
    return (segments ?? []).map((s) => s.media_range ?? s.initialization_range).filter((r): r is string => !!r && /^\d+-\d+$/.test(r));
}

const rangeEnd = (r: string) => parseInt(r.split('-')[1] ?? '0') || 0;

// ---------------- per-source resolvers ----------------

export async function itunesPreview(id: string): Promise<string> {
    const res = await axios.get('https://itunes.apple.com/lookup', { params: { id }, timeout: 15000 });
    const t = (res.data.results ?? []).find((r: any) => r.wrapperType === 'track');
    if (!t?.previewUrl) throw new Error('no preview available for this track');
    return t.previewUrl as string;
}

// Spotify has no documented anonymous preview endpoint, but its public embed
// player exposes the same provider-owned 30s MP3 in the embedded page state.
// Parse the JSON state rather than scraping player internals or substituting
// another provider's audio.
export async function spotifyPreview(id: string): Promise<string> {
    const res = await axios.get(`https://open.spotify.com/embed/track/${encodeURIComponent(id)}`, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = String(res.data ?? '');
    const jsonMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (jsonMatch) {
        try {
            const root = JSON.parse(jsonMatch[1]);
            const seen = new Set<any>();
            const walk = (x: any, depth = 0): string | null => {
                if (!x || typeof x !== 'object' || depth > 14 || seen.has(x)) return null;
                seen.add(x);
                if (typeof x.audioPreview?.url === 'string') return x.audioPreview.url;
                if (typeof x.preview_url === 'string') return x.preview_url;
                const values = Array.isArray(x) ? x : Object.values(x);
                for (const v of values) {
                    const found = walk(v, depth + 1);
                    if (found) return found;
                }
                return null;
            };
            const url = walk(root);
            if (url) return url;
        } catch {}
    }
    const raw = html.match(/"audioPreview"\s*:\s*\{[^{}]*"url"\s*:\s*"([^"]+)"/)?.[1];
    if (raw) {
        try {
            return JSON.parse(`"${raw}"`);
        } catch {
            return raw;
        }
    }
    throw new Error('no Spotify preview available for this track');
}

function isPreviewFallbackCause(e: any): boolean {
    // Once the full provider-native path has failed terminally, the same
    // provider's authorized preview is a useful degraded artifact. Cancellation
    // is the exception: it must stop work rather than start another resolve.
    return !/cancelled/i.test(`${e?.kind ?? ''} ${e?.message ?? ''}`);
}

async function previewUpstream(source: string, trackId: string, signal?: AbortSignal): Promise<Upstream | null> {
    let url: string;
    let format: string;
    try {
        if (source === 'tidal') {
            url = (await resolveTidalPreview(trackId)).url;
            format = 'mp3';
        } else if (source === 'spotify' || source === 'spotify-native') {
            url = await spotifyPreview(trackId);
            format = 'mp3';
        } else if (source === 'apple' || source === 'apple-native' || source === 'apple-preview') {
            url = await itunesPreview(trackId);
            format = 'm4a';
        } else {
            return null;
        }
        const up = await resilientStream(
            (from) => axiosStream(url, from ? { 'User-Agent': 'Mozilla/5.0', Range: `bytes=${from}-` } : { 'User-Agent': 'Mozilla/5.0' }, signal),
            { signal }
        );
        return { stream: up.stream, format, contentLength: up.length || undefined, isPreview: true };
    } catch {
        return null;
    }
}

// Qobuz format ladder — a 27-only account track denied by
// FormatRestrictedByFormatAvailability resolves at the next tier instead of dying.
async function resolveQobuz(id: string, quality: string, ctx: RequestContext) {
    const ladder = quality === '27' ? ['27', '7', '6', '5'] : quality === '7' ? ['7', '6', '5'] : [quality];
    let lastErr: any = null;
    for (const fmt of ladder) {
        try {
            return await getDownloadInfo(Number(id), fmt as any, ctx.country ? { country: ctx.country } : {});
        } catch (e: any) {
            lastErr = e;
            // only ladder on a tier-entitlement rejection - a '400'/signature
            // error is a real failure, not a cue to try the next tier
            if (!/FormatRestricted|format.*(restricted|unavailable)|lower.*format/i.test(e?.message ?? '')) throw e;
        }
    }
    throw lastErr;
}

// Resolve the raw audio for ONE source — no fallback inside (the caller owns it).
async function rawProduce(source: string, trackId: string, spec: DownloadSpec, ctx: RequestContext, signal?: AbortSignal): Promise<Upstream> {
    const { quality } = spec;

    if (source === 'deezer') {
        const info = await resolveDeezerTrack(trackId, quality as any, ctx);
        // multiple CDN providers may be listed — resilientStream resumes Range
        // requests on mid-stream drops; the list covers initial connect failure
        let up: Awaited<ReturnType<typeof resilientStream>> | null = null;
        let lastErr: any = null;
        for (const url of info.urls ?? [info.url]) {
            try {
                up = await resilientStream((from) => axiosStream(url, from ? { Range: `bytes=${from}-` } : {}, signal), { signal, tailPad: 16 });
                break;
            } catch (e) {
                lastErr = e;
            }
        }
        if (!up) throw lastErr;
        if (signal?.aborted) {
            up.stream.destroy();
            throw new Error('cancelled');
        }
        return {
            // pipeline() (not .pipe()) — propagates errors+destroy BOTH ways;
            // bare pipe leaves the upstream socket alive on downstream destroy
            stream: pipeline(up.stream, deezerDecryptStream(String(info.sngId)), () => {}),
            format: CT_FORMAT[ctBase(up.contentType)] ?? info.format,
            // BF_CBC_STRIPE is length-preserving; the CDN Content-Length is
            // byte-exact, FILESIZE_* is provider-claimed (observed ~8B drift)
            contentLength: up.length || info.fileSize || undefined,
            lengthIsHint: !up.length
        };
    }

    if (source === 'tidal') {
        const info = await resolveTidalTrack(trackId, quality as any, ctx);
        if (info.dashManifest) return { stream: Readable.from(dashGen(info.dashManifest)), format: info.format ?? 'mp4' };
        const up = await resilientStream((from) => axiosStream(info.url!, from ? { 'User-Agent': 'Mozilla/5.0', Range: `bytes=${from}-` } : { 'User-Agent': 'Mozilla/5.0' }, signal), { signal });
        return { stream: up.stream, format: CT_FORMAT[ctBase(up.contentType)] ?? info.format ?? 'flac', contentLength: up.length || undefined };
    }

    if (source === 'qobuz') {
        const info = await resolveQobuz(trackId, quality, ctx);
        if (!/^https?:\/\//.test(String(info.url ?? ''))) {
            throw new DownloadError('region', `Qobuz returned an unusable stream URL (${String(info.url).slice(0, 80)})`);
        }
        // sample flags arrive in several shapes (true/1/"true") and sometimes
        // not at all — the returned track duration is the bulletproof check:
        // a ~30s sample's duration is a fraction of the real track's.
        const grantedDur = Number(info.duration) || 0;
        const isPreview =
            !!(info.sample as any) ||
            (info.restrictions ?? []).length > 0 ||
            (grantedDur > 0 && (spec.duration ?? 0) > 0 && grantedDur < spec.duration! * 0.6);
        // silent tier descent (format ladder fell below what was asked) —
        // still true qobuz audio, but log it so the surprise is visible
        if (info.format_id != null && String(info.format_id) !== '27' && spec.quality === '27') {
            console.warn(`[qobuz] "${spec.title}" granted format_id=${info.format_id} (asked 27) — account tier limits quality`);
        }
        const up = await resilientStream((from) => axiosStream(info.url, from ? { 'User-Agent': 'Mozilla/5.0', Range: `bytes=${from}-` } : { 'User-Agent': 'Mozilla/5.0' }, signal), { signal });
        const mime = String(info.mime_type ?? up.contentType ?? '');
        return {
            stream: up.stream,
            format: CT_FORMAT[ctBase(up.contentType)] ?? (mime.includes('mpeg') ? 'mp3' : mime.includes('mp4') ? 'm4a' : 'flac'),
            contentLength: up.length || undefined,
            isPreview
        };
    }

    if (source === 'spotify' || source === 'spotify-native') {
        const qMap: Record<string, 'normal' | 'high' | 'very_high' | 'lossless'> = { '27': 'very_high', '7': 'very_high', '6': 'high', '5': 'normal' };
        // '27'→lossless is a dead end upstream (keys need PlayPlay) — cap at Vorbis 320
        const ladder: ('normal' | 'high' | 'very_high' | 'lossless')[] = [qMap[quality] ?? 'very_high', 'high', 'normal'];
        let lastErr: any = null;
        for (const q of [...new Set(ladder)]) {
            try {
                const r = await streamSpotifyNative(trackId, q, signal);
                return { stream: r.stream, format: 'ogg', contentLength: r.size || undefined, cleanup: r.cleanup };
            } catch (e: any) {
                lastErr = e;
                if (/premium_required/i.test(e?.message ?? '')) throw e;
            }
        }
        throw lastErr ?? new Error('spotify download failed');
    }

    if (source === 'apple-preview') {
        const url = await itunesPreview(trackId);
        const up = await resilientStream((from) => axiosStream(url, from ? { 'User-Agent': 'Mozilla/5.0', Range: `bytes=${from}-` } : { 'User-Agent': 'Mozilla/5.0' }, signal), { signal });
        return { stream: up.stream, format: 'm4a', contentLength: up.length || undefined, isPreview: true };
    }

    if (source === 'apple' || source === 'apple-native') {
        // No media-user-token → cannot decrypt full tracks. Fail honestly rather
        // than silently shipping a 30s preview under the 'apple' source (the
        // explicit 'apple-preview' source still serves the clip).
        const hasAppleAuth = !!(spec.tokens?.appleMediaToken || process.env.APPLE_MEDIA_USER_TOKEN || pickToken('apple'));
        if (!hasAppleAuth) {
            throw new DownloadError('entitlement', 'Apple Music requires a media-user-token — configure one in the admin panel');
        }
        const aQ = quality === '27' ? 'alac-hi' : quality === '5' ? 'aac' : 'alac';
        const r = await downloadAppleNative(trackId, aQ, {
            appleMediaToken: spec.tokens?.appleMediaToken,
            appleWrapper: spec.tokens?.appleWrapper,
            isrc: spec.isrc,
            title: spec.title,
            artist: spec.artist,
            signal
        });
        const st = fs.statSync(r.file);
        // Native Apple output is always ALAC/AAC in .m4a — never trust a
        // mislabeled extension from the tool (and never announce mp3).
        return { file: r.file, format: 'm4a', contentLength: st.size };
    }

    if (source === 'amazon' || source === 'amazon-native') {
        const zQ = quality === '27' ? 'Max' : quality === '7' ? 'Master' : quality === '6' ? 'High' : 'Normal';
        const { picked, keyP } = await resolveAmazonStreams(trackId, zQ as any, { amazonToken: spec.tokens?.amazonToken });
        // prime the first segment batch; the Widevine license was proven during resolution
        const ranges = amazonRanges(picked.segments);
        const it = (ranges.length > 1 ? amazonRangeGen(picked.base_url!, ranges) : singleGetGen(picked.base_url!))[Symbol.asyncIterator]();
        const first = it.next();
        const key = await keyP;
        const gen = (async function* () {
            const f = await first;
            if (!f.done) yield f.value;
            while (true) {
                const n = await it.next();
                if (n.done) return;
                yield n.value;
            }
        })();
        const total = ranges.length ? rangeEnd(ranges[ranges.length - 1]) + 1 : 0;
        return { stream: Readable.from(gen), format: 'mp4', contentLength: total || undefined, decryptKey: key };
    }

    throw new Error(`unsupported source: ${source}`);
}

async function* singleGetGen(url: string): AsyncGenerator<Buffer> {
    const up = await axiosStream(url);
    yield* up.stream as any;
}

// ---------------- single-source produce ----------------

// A "track" that came back preview-length is NOT the song. Min plausible
// full-track size ≈ duration×64kbps×0.5.
function looksLikePreview(up: Upstream, spec: DownloadSpec): boolean {
    if (!spec.duration) return false;
    // 30s previews sneak past flag checks; a real track can't be smaller than
    // ~64kbps×duration. (A 30s MP3-320 sample is ~1.2MB — under this floor for
    // every track longer than ~2.5 min.)
    if (up.contentLength) return up.contentLength < spec.duration * 8000;
    return false;
}

// Resolve audio STRICTLY from the spec's platform — downloads are never
// silently substituted with another platform's audio. When a free/anonymous
// tier cannot unlock the full recording, use that same provider's authorized
// preview asset and mark it explicitly. Hidden/truncated previews are still
// rejected; they must never be mistaken for complete tracks.
export async function produceTrackStream(spec: DownloadSpec, signal?: AbortSignal): Promise<Upstream> {
    const ctx: RequestContext = { tokens: (spec.tokens ?? {}) as any, country: spec.country };
    if (signal?.aborted) throw new Error('cancelled');
    // per-source budget — a wedged RESOLVE (dead wrapper, hanging CDN) mustn't
    // hang the request forever. Scope it to the produce call only: once the
    // upstream exists, transfer liveness is the streams' own job (idle
    // watchdogs) — a >240s transfer must not be killed mid-flight.
    const srcCtrl = new AbortController();
    const resolveTimeout = setTimeout(() => srcCtrl.abort(new Error('resolve timed out')), 240_000);
    const srcSig = AbortSignal.any([...(signal ? [signal] : []), srcCtrl.signal]);
    let up: Upstream;
    try {
        try {
            up = await rawProduce(String(spec.source), String(spec.id), spec, ctx, srcSig);
        } catch (e: any) {
            // The source-resolution timeout aborts srcSig. Preview fallback must
            // not inherit that aborted signal — it is a fresh degraded resolve,
            // still bounded by the caller's own cancellation and HTTP timeouts.
            const preview = !signal?.aborted && isPreviewFallbackCause(e) ? await previewUpstream(String(spec.source), String(spec.id), signal) : null;
            if (!preview) throw e;
            up = preview;
        }
    } finally {
        clearTimeout(resolveTimeout);
    }
    // If the upstream length itself proves the provider only granted a short
    // asset, label it before delivery. That is different from disguising it:
    // filename, cache namespace, status metadata, and UI all expose it as a
    // preview. Mid-transfer truncations still fail validation later.
    if (!up.isPreview && looksLikePreview(up, spec)) up.isPreview = true;
    return up;
}

// Buffered variant kept for the queue worker + zip route — drains the resolved
// stream (single source of truth) and applies the CENC decrypt when present.
export async function produceTrackBytes(spec: DownloadSpec): Promise<{ data: Buffer; format: string; servedBy?: string }> {
    const up = await produceTrackStream(spec);
    let data: Buffer;
    let format = up.format;
    if (up.file) {
        data = fs.readFileSync(up.file);
        fs.unlink(up.file, () => {});
    } else {
        const chunks: Buffer[] = [];
        for await (const c of up.stream!) chunks.push(c as Buffer);
        data = Buffer.concat(chunks);
    }
    up.cleanup?.();
    if (up.decryptKey) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-'));
        try {
            const enc = path.join(dir, `in.${EXT_OF_FORMAT[format] ?? 'mp4'}`);
            const dec = path.join(dir, 'dec.mp4');
            fs.writeFileSync(enc, data);
            await runFfmpeg(['-y', '-decryption_key', up.decryptKey, '-i', enc, '-c', 'copy', dec]);
            data = fs.readFileSync(dec);
            format = 'mp4';
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    return { data, format, servedBy: up.servedBy };
}

// ---------------- ffmpeg ----------------

// ffmpeg-static's exported path can point into .next/vendor-chunks when bundled —
// the canonical resolver lives in native-tools (imported above).
function runFfmpeg(args: string[], timeoutMs = 300000, childRef?: { p?: any }): Promise<void> {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpegBin(), args, { windowsHide: true });
        if (childRef) childRef.p = p;
        let err = '';
        const kill = setTimeout(() => {
            p.kill('SIGKILL');
            reject(new Error('ffmpeg timed out'));
        }, timeoutMs);
        p.stderr.on('data', (d) => (err = (err + d.toString()).slice(-4000)));
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

// ffmpeg reads these containers fine from stdin — they can feed the encode
// live instead of paying a full drain-then-encode serial pass.
// (mp4/m4a are excluded: moov placement makes them seek-dependent on input.)
const STREAMABLE_IN = new Set(['flac', 'mp3', 'ogg', 'wav', 'webm']);

// Same as runFfmpeg but the INPUT is a live stream on stdin ('-i pipe:0').
export function runFfmpegStream(args: string[], input: Readable, childRef?: { p?: any }, timeoutMs = 300000): Promise<void> {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpegBin(), args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
        if (childRef) childRef.p = p;
        let err = '';
        const kill = setTimeout(() => {
            p.kill('SIGKILL');
            reject(new Error('ffmpeg timed out'));
        }, timeoutMs);
        p.stderr.on('data', (d) => (err = (err + d.toString()).slice(-4000)));
        // EPIPE on stdin happens when ffmpeg dies early — the close handler
        // reports the real error; swallowing it here avoids a second uncaught
        p.stdin.on('error', () => {});
        pipeline(input, p.stdin, () => {});
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

// ffprobe-style duration probe — guards against silent 30s previews.
export function probeDuration(buf: Buffer): Promise<number> {
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

// File variant of probeDuration — used by workers so validation never needs a
// whole artifact buffered in memory.
export function probeFileDuration(file: string): Promise<number> {
    return new Promise((resolve) => {
        const p = spawn(ffmpegBin(), ['-hide_banner', '-i', file], { windowsHide: true });
        let err = '';
        p.stderr.on('data', (d) => (err += d.toString()));
        const finish = () => {
            const m = err.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
            resolve(m ? parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]) : 0);
        };
        p.on('close', finish);
        setTimeout(() => {
            try {
                p.kill('SIGKILL');
            } catch {}
            resolve(0);
        }, 20000);
    });
}

// Probe a file's real audio codec (manifests lie — Tidal serves FLAC inside fMP4).
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

// ONE ffmpeg pass that does decrypt + metadata + art + optional transcode.
// Replaces the old probe → encode → tag → art sequence of up to 4 spawns.
export function buildTagArgs(opts: {
    inFile: string;
    outFile: string;
    spec: DownloadSpec;
    outExt: string;
    skipRecode: boolean;
    decryptKey?: string;
    metaFile?: string;
    artFile?: string;
}): string[] {
    const { inFile, outFile, spec, outExt, skipRecode, decryptKey, metaFile, artFile } = opts;
    const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];
    if (decryptKey) args.push('-decryption_key', decryptKey);
    args.push('-i', inFile);
    let idx = 1;
    let metaInput = -1;
    let artInput = -1;
    if (metaFile) {
        args.push('-i', metaFile);
        metaInput = idx++;
    }
    if (artFile) {
        args.push('-i', artFile);
        artInput = idx++;
    }
    if (metaInput >= 0) args.push('-map_metadata', String(metaInput));
    args.push('-map', '0:a');
    if (artInput >= 0) args.push('-map', String(artInput), '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
    if (skipRecode) args.push('-c:a', 'copy');
    else {
        args.push('-c:a', CODEC[spec.codec]?.codec ?? 'copy');
        if (spec.bitrate) args.push('-b:a', `${spec.bitrate}k`);
        if (spec.codec === 'OPUS') args.push('-vbr', 'on');
    }
    if (outExt === 'mp3') args.push('-id3v2_version', '3');
    args.push(outFile);
    return args;
}

// Album art repeats per track — a zip of N tracks used to fetch the same 2MB
// image N+1 times (and serially block tagger construction). Cache per URL.
const artCache = new Map<string, { at: number; p: Promise<Buffer | null> }>();
const ART_TTL = 10 * 60 * 1000;

const ARTWORK_MAX_BYTES = 20 * 1024 * 1024;

export async function fetchArtworkBuf(url: string): Promise<Buffer> {
    let current = url;
    for (let redirects = 0; redirects <= 5; redirects++) {
        const r = await axios.get(current, {
            responseType: 'stream',
            timeout: 20000,
            maxRedirects: 0,
            validateStatus: (s) => s >= 200 && s < 400,
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*' }
        });
        if (r.status >= 300) {
            const loc = r.headers.location;
            try { r.data.destroy(); } catch {}
            if (!loc) throw new Error(`artwork redirect without location (${r.status})`);
            current = new URL(loc, current).toString();
            // Redirects are user-influenceable input even when the original CDN
            // is trusted; every hop must stay on the provider-artwork allowlist.
            if (!isAllowedArtworkUrl(current)) throw new Error('artwork redirect left the allowed image CDN set');
            continue;
        }
        const type = String(r.headers['content-type'] ?? '').toLowerCase();
        if (type && !type.startsWith('image/')) throw new Error(`artwork response was ${type}, not an image`);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of r.data) {
            const b = chunk as Buffer;
            size += b.length;
            if (size > ARTWORK_MAX_BYTES) {
                try { r.data.destroy(); } catch {}
                throw new Error('artwork exceeds 20MB safety limit');
            }
            chunks.push(b);
        }
        return Buffer.concat(chunks);
    }
    throw new Error('artwork redirected too many times');
}

async function fetchArt(spec: DownloadSpec, outExt: string, doTags: boolean): Promise<Buffer | null> {
    if (!doTags || !spec.artUrl || ['wav', 'webm'].includes(outExt)) return null;
    const url = normalizeArtUrl(spec.artUrl)!;
    const hit = artCache.get(url);
    if (hit && Date.now() - hit.at < ART_TTL) return hit.p;
    const p = Promise.race([
        fetchArtworkBuf(url),
        // a slow art CDN must not stall the headers path — proceed untagged-art
        new Promise<Buffer>((_, rej) => setTimeout(() => rej(new Error('art timeout')), 20000))
    ]).catch(() => null);
    artCache.set(url, { at: Date.now(), p });
    if (artCache.size > 200) {
        const cutoff = Date.now() - ART_TTL;
        for (const [k, v] of artCache) if (v.at < cutoff) artCache.delete(k);
    }
    return p;
}

function pickOutput(spec: DownloadSpec, inExt: string) {
    const sourceMode = spec.codec === 'SOURCE';
    const outExt = sourceMode ? inExt : (CODEC[spec.codec]?.ext ?? inExt);
    // Container equality is not codec equality (m4a can be AAC or ALAC; ogg can
    // be Vorbis or Opus), and an explicit lossy bitrate is a user-requested
    // transcode even when the input is already mp3 — otherwise a 128kbps source
    // would be silently passed off as the requested 320kbps output.
    const skipRecode =
        sourceMode ||
        (inExt === 'flac' && spec.codec === 'FLAC') ||
        (inExt === 'mp3' && spec.codec === 'MP3' && !spec.bitrate);
    const doTags = spec.applyMeta && outExt !== 'wav';
    return { sourceMode, outExt, skipRecode, doTags };
}

// Apply metadata + art + optional transcode on a BUFFER — single ffmpeg pass.
// Kept for the queue worker + zip path; the GET hot path uses streams.
export async function tagAndEncode(input: Buffer, inputFormat: string, spec: DownloadSpec): Promise<{ data: Buffer; ext: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-'));
    try {
        let inExt = EXT_OF_FORMAT[inputFormat] ?? 'flac';
        const src = path.join(dir, `in.${inExt}`);
        fs.writeFileSync(src, input);
        if (spec.codec === 'SOURCE') {
            // magic bytes first — saves an ffprobe spawn for common formats;
            // ffprobe only runs when the head is ambiguous (e.g. raw aac)
            const sniffed = sniffExt(input.subarray(0, 16));
            if (sniffed) {
                inExt = sniffed;
            } else {
                const codec = await probeAudioCodec(src);
                const CODEC_EXT: Record<string, string> = { flac: 'flac', mp3: 'mp3', aac: 'm4a', alac: 'm4a', eac3: 'm4a', vorbis: 'ogg', opus: 'ogg', pcm_s16le: 'wav', pcm_s24le: 'wav' };
                if (codec && CODEC_EXT[codec]) inExt = CODEC_EXT[codec];
            }
            if (inExt !== EXT_OF_FORMAT[inputFormat]) {
                const fixed = path.join(dir, `in.${inExt}`);
                fs.renameSync(src, fixed);
            }
        }
        const inFile = fs.existsSync(src) ? src : path.join(dir, `in.${inExt}`);
        const { outExt, skipRecode, doTags } = pickOutput(spec, inExt);
        if (skipRecode && !doTags) return { data: input, ext: outExt };

        const vorbisArt = ['ogg', 'opus'].includes(outExt);
        const artBuf = await fetchArt(spec, outExt, doTags);
        let metaFile: string | undefined;
        if (doTags) {
            metaFile = path.join(dir, 'meta.txt');
            fs.writeFileSync(metaFile, buildFFMetadata(spec, artBuf && vorbisArt ? flacPictureBlock(artBuf) : undefined), 'utf-8');
        }
        let artFile: string | undefined;
        if (artBuf && !vorbisArt) {
            artFile = path.join(dir, 'art.jpg');
            fs.writeFileSync(artFile, artBuf);
        }
        const outFile = path.join(dir, `out.${outExt}`);
        await runFfmpeg(buildTagArgs({ inFile, outFile, spec, outExt, skipRecode, metaFile, artFile }));
        return { data: fs.readFileSync(outFile), ext: outExt };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ---------------- staged-file production ----------------
// For containers that can't stream (m4a needs its moov atom, wav needs a sized
// header, CENC needs decrypt+remux): produce to a temp file in ONE pass, then
// serve it — exact Content-Length, Range/resume support, low memory.
export interface StagedResult {
    file: string;
    ext: string;
    size: number;
    dir: string;
    servedBy?: string;
    isPreview?: boolean;
}

export async function stageToFile(spec: DownloadSpec, jobId: string | undefined, signal?: AbortSignal, upstream?: Upstream): Promise<StagedResult> {
    const prog = (patch: Partial<JobProgress>) => jobId && setProgress(jobId, patch);
    const artP = spec.applyMeta ? fetchArt(spec, 'm4a', true).catch(() => null) : Promise.resolve(null);
    let up: Upstream | null = null;
    let dir = '';
    try {
        up = upstream ?? (await produceTrackStream(spec, signal));
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
    } catch (e) {
        // never leak a resolved upstream on setup failure
        try {
            up?.cleanup?.();
        } catch {}
        try {
            (up?.stream as any)?.destroy?.();
        } catch {}
        throw e;
    }
    let inExt = up.file ? (path.extname(up.file).slice(1) || EXT_OF_FORMAT[up.format] || 'm4a') : (EXT_OF_FORMAT[up.format] ?? 'mp4');
    let abortFn: (() => void) | null = null;
    const ffRef: { p?: any } = {};
    const cleanup = () => {
        try {
            ffRef.p?.kill?.('SIGKILL');
        } catch {}
        try {
            up!.cleanup?.();
        } catch {}
        try {
            (up!.stream as any)?.destroy?.();
        } catch {}
        fs.rmSync(dir, { recursive: true, force: true });
    };
    const disarmAbort = () => {
        if (abortFn) {
            try {
                signal?.removeEventListener('abort', abortFn);
            } catch {}
            abortFn = null;
        }
    };
    try {
        abortFn = () => cleanup();
        signal?.addEventListener('abort', abortFn, { once: true });
        if (signal?.aborted) abortFn();

        // resolver/container labels lie — sniff the stream head up-front so the
        // output decision is byte-true (mp3-declared-m4a remuxes into a fake)
        if (!up.file && up.stream && !up.decryptKey) {
            const peek = await peekStream(up.stream, 16).catch(() => null);
            if (peek) {
                up.stream = peek.rest;
                const s = sniffExt(peek.head);
                if (s && s !== inExt) {
                    console.warn(`[stage] relabeled '${inExt}' → '${s}' by magic bytes ("${spec.title}")`);
                    inExt = s;
                }
            }
        }

        const { outExt, skipRecode, doTags } = pickOutput(spec, inExt);
        const vorbisArt = ['ogg', 'opus'].includes(outExt);
        const artBuf = await artP;
        let metaFile: string | undefined;
        if (doTags) {
            metaFile = path.join(dir, 'meta.txt');
            fs.writeFileSync(metaFile, buildFFMetadata(spec, artBuf && vorbisArt ? flacPictureBlock(artBuf) : undefined), 'utf-8');
        }
        let artFile: string | undefined;
        if (artBuf && !vorbisArt && outExt !== 'mp3') {
            artFile = path.join(dir, 'art.jpg');
            fs.writeFileSync(artFile, artBuf);
        }
        const outFile = path.join(dir, `out.${outExt}`);
        prog({ stage: 'processing' });
        const noWork = skipRecode && !doTags && !up.decryptKey;

        // streamable inputs feed ffmpeg live (stdin) — skips the drain-then-
        // encode serial pass; production time ≈ max(download, encode) not sum
        const streamableIn = !noWork && !up.file && !!up.stream && !up.decryptKey && STREAMABLE_IN.has(inExt);
        if (streamableIn && !(outExt === 'mp3' && doTags)) {
            await runFfmpegStream(
                buildTagArgs({ inFile: 'pipe:0', outFile, spec, outExt, skipRecode, metaFile, artFile }),
                up.stream!,
                ffRef
            );
            const st = fs.statSync(outFile);
            disarmAbort();
            return { file: outFile, ext: outExt, size: st.size, dir, servedBy: up.servedBy, isPreview: up.isPreview };
        }

        // drain upstream → temp file (streams; progress = received/total)
        let src = path.join(dir, `in.${inExt}`);
        prog({ stage: 'downloading', total: up.contentLength });
        const fd = fs.openSync(src, 'w');
        let received = 0;
        try {
            if (up.file) {
                // already-materialized native output — move into the stage dir
                fs.closeSync(fd);
                fs.renameSync(up.file, src);
                received = fs.statSync(src).size;
            } else {
                for await (const c of up.stream!) {
                    if (signal?.aborted) throw new Error('cancelled');
                    const b = c as Buffer;
                    received += b.length;
                    if (jobId && received - ((prog as any)._last ?? 0) > 262144) {
                        (prog as any)._last = received;
                        setProgress(jobId, { received });
                    }
                    fs.writeSync(fd, b);
                }
            }
        } finally {
            try {
                fs.closeSync(fd);
            } catch {}
        }
        if (jobId) setProgress(jobId, { received });

        // file inputs couldn't be peeked — verify the drained container
        if (up.file) {
            const headBuf = Buffer.alloc(16);
            let hfd: number | null = null;
            try {
                hfd = fs.openSync(src, 'r');
                fs.readSync(hfd, headBuf, 0, 16, 0);
            } catch {
            } finally {
                try {
                    if (hfd != null) fs.closeSync(hfd);
                } catch {}
            }
            const sniffed = sniffExt(headBuf);
            if (sniffed && sniffed !== inExt) {
                const fixed = path.join(dir, `in.${sniffed}`);
                fs.renameSync(src, fixed);
                console.warn(`[stage] relabeled '${inExt}' → '${sniffed}' by magic bytes ("${spec.title}")`);
                inExt = sniffed;
                src = fixed;
            }
        }

        if (noWork && outExt === inExt) {
            // nothing to do — serve the drained file directly
            disarmAbort();
            return { file: src, ext: outExt, size: fs.statSync(src).size, dir, servedBy: up.servedBy, isPreview: up.isPreview };
        }
        if (outExt === 'mp3' && doTags) {
            // staged mp3 → prepend our ID3v2 the same way the streaming path does,
            // but on files: strip source tags via ffmpeg then prepend ours.
            const stripped = path.join(dir, 'stripped.mp3');
            await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-map_metadata', '-1', '-id3v2_version', '0', '-c', 'copy', stripped], 300000, ffRef);
            const tagged = buildId3v2(spec, artBuf);
            const out = fs.openSync(outFile, 'w');
            try {
                fs.writeSync(out, tagged);
                const sfd = fs.openSync(stripped, 'r');
                try {
                    const buf = Buffer.alloc(1 << 20);
                    let n: number;
                    while ((n = fs.readSync(sfd, buf, 0, buf.length, null)) > 0) fs.writeSync(out, buf, 0, n);
                } finally {
                    fs.closeSync(sfd);
                }
            } finally {
                fs.closeSync(out);
            }
        } else {
            await runFfmpeg(
                buildTagArgs({
                    inFile: src,
                    outFile,
                    spec,
                    outExt,
                    skipRecode,
                    decryptKey: up.decryptKey,
                    metaFile,
                    artFile
                }),
                300000,
                ffRef
            );
        }
        const st = fs.statSync(outFile);
        disarmAbort();
        return { file: outFile, ext: outExt, size: st.size, dir, servedBy: up.servedBy, isPreview: up.isPreview };
    } catch (e) {
        cleanup();
        throw e;
    }
}

// ---------------- live pipeline (GET path) ----------------

export interface TaggedStream {
    body: Readable;
    ext: string;
    contentLength?: number;
    stagedFile?: string; // when set, the route may honor Range on this file
    stagedDir?: string;
    servedBy?: string;
    isPreview?: boolean;
    cleanup?: () => void;
}

// Upstream → tag → response. Chooses the lightest correct path per container.
export async function streamTaggedTrack(spec: DownloadSpec, jobId?: string, signal?: AbortSignal): Promise<TaggedStream> {
    const prog = (patch: Partial<JobProgress>) => jobId && setProgress(jobId, patch);
    prog({ stage: 'resolving' });

    const artP = spec.applyMeta ? fetchArt(spec, 'x', true).catch(() => null) : Promise.resolve(null);
    const slot = await pipelineSlots.acquire();
    let released = false;
    const release = () => {
        if (!released) {
            released = true;
            slot();
        }
    };
    let up: Upstream | null = null;
    try {
        up = await produceTrackStream(spec, signal);
    } catch (e) {
        release();
        throw e;
    }
    const wrapCleanup = (extra?: () => void) => () => {
        try {
            up?.cleanup?.();
        } catch {}
        try {
            (up?.stream as any)?.destroy?.();
        } catch {}
        try {
            extra?.();
        } catch {}
        release();
    };
    const finish = () => {
        setTimeout(release, 0);
        if (jobId) prog({ stage: 'done' });
    };
    // Tee a streaming body to a staged file as it serves — when the send
    // completes the file is registered for Range-resume. Adds one append-only
    // disk write per download (the same cost the staged path already pays).
    const teeToStaged = (input: Readable, ext: string) => {
        if (!jobId) return { body: input, onDone: null as null | (() => void) };
        const teeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
        const teeFile = path.join(teeDir, `out.${ext}`);
        const tee = fs.createWriteStream(teeFile);
        let teeFailed = false;
        const kill = () => {
            teeFailed = true;
            try {
                tee.destroy();
            } catch {}
            fs.rmSync(teeDir, { recursive: true, force: true });
        };
        tee.on('error', kill);
        // Backpressure-safe tee: copying with a 'data' listener puts the source
        // into flowing mode and bypasses the response reader. Keeping the copy
        // inside the pipeline preserves backpressure end-to-end.
        const tap = new Transform({
            transform(chunk: Buffer, _enc, cb) {
                this.push(chunk);
                if (teeFailed) return cb();
                try {
                    if (tee.write(chunk)) cb();
                    else tee.once('drain', () => cb());
                } catch {
                    teeFailed = true;
                    cb();
                }
            }
        });
        const body = pipeline(input, tap, (err) => {
            if (err) kill();
        }) as Readable;
        body.on('close', kill);
        return {
            body,
            onDone: () => {
                body.removeListener('close', kill);
                if (teeFailed) return;
                tee.end(() => {
                    try {
                        registerStaged(jobId, teeFile, teeDir, fs.statSync(teeFile).size);
                    } catch {
                        kill();
                    }
                });
            }
        };
    };
    signal?.addEventListener(
        'abort',
        () => {
            try {
                (up?.stream as any)?.destroy?.();
            } catch {}
            try {
                up?.cleanup?.();
            } catch {}
        },
        { once: true }
    );
    if (signal?.aborted) {
        // fired during produce — the listener above is dead; clean up now
        try {
            (up?.stream as any)?.destroy?.();
        } catch {}
        release();
        throw new Error('cancelled');
    }

    // Resolver labels lie — sniff the real container once, up front, so every
    // downstream path (passthrough ext, tagger pick, staged input name) works
    // off byte truth rather than the declared format.
    let sniffed: string | null = null;
    if (up.stream && !up.decryptKey) {
        const peek = await peekStream(up.stream, 16).catch(() => null);
        if (peek) {
            sniffed = sniffExt(peek.head);
            up.stream = peek.rest;
        }
    }
    const inExt = up.file
        ? path.extname(up.file).slice(1) || EXT_OF_FORMAT[up.format] || 'm4a'
        : sniffed ?? EXT_OF_FORMAT[up.format] ?? 'flac';
    if (sniffed && EXT_OF_FORMAT[up.format] && sniffed !== EXT_OF_FORMAT[up.format]) {
        console.warn(`[produce] "${spec.title}" declared '${up.format}' but bytes are '${sniffed}'`);
    }
    const { outExt, skipRecode: skip, doTags: tags } = pickOutput(spec, inExt);
    const decrypt = !!up.decryptKey;
    const counted = (s: Readable, field: 'received' | 'sent', stage?: JobProgress['stage']) =>
        jobId ? pipeline(s, countingTransform(jobId, field, stage), () => {}) : s;

    // ---- A: pure passthrough — no tags, no recode, no decrypt ----
    if (!decrypt && skip && !tags && up.stream) {
        if (jobId && up.contentLength) prog({ total: up.contentLength });
        const countedBody = counted(up.stream, 'sent', 'sending');
        const tee = teeToStaged(countedBody, outExt);
        const body = tee.body;
        body.on('end', () => {
            tee.onDone?.();
            finish();
        });
        body.on('close', release); // destroy() without 'end' must still free the slot
        body.on('error', (e: any) => {
            release();
            prog({ stage: 'error', error: e?.message ?? 'stream error' });
        });
        return { body, ext: outExt, contentLength: up.lengthIsHint ? undefined : up.contentLength, servedBy: up.servedBy, isPreview: up.isPreview, cleanup: wrapCleanup() };
    }

    // ---- D: everything that isn't pure-passthrough or flac/mp3-tag-in-place
    // is STAGED to disk then served with exact Content-Length + Range — the
    // browser gets a real total and can resume, no more anonymous-size downloads.
    // The slot stays held through production — that IS the expensive work.
    const tagInPlace = !!(up.stream && !decrypt && skip && tags && inExt === outExt && (inExt === 'flac' || inExt === 'mp3'));
    if (!tagInPlace) {
        let st: Awaited<ReturnType<typeof stageToFile>>;
        try {
            st = await stageToFile(spec, jobId, signal, up);
            release(); // production is done — the slot bounds produces, not sends
        } catch (e) {
            wrapCleanup()();
            throw e;
        }
        const body = counted(fs.createReadStream(st.file), 'sent', 'sending');
        // The staged file is COMPLETE on disk — register it so a client that
        // loses the connection can Range-resume instead of replaying the whole
        // pipeline; the registry TTL sweeps it afterwards.
        const done = () => {
            registerStaged(jobId, st.file, st.dir, st.size);
            finish();
        };
        body.on('end', done);
        body.on('error', (e: any) => {
            registerStaged(jobId, st.file, st.dir, st.size);
            release();
            prog({ stage: 'error', error: e?.message ?? 'send failed' });
        });
        signal?.addEventListener('abort', done, { once: true });
        return {
            body,
            ext: st.ext,
            contentLength: st.size,
            stagedFile: st.file,
            stagedDir: st.dir,
            servedBy: st.servedBy,
            isPreview: st.isPreview,
            // no rm here — the staged file belongs to the registry until its TTL
            cleanup: wrapCleanup()
        };
    }

    // ---- B: flac→flac / mp3→mp3 tag-only — exact size, zero ffmpeg ----
    if (up.stream && !decrypt && skip && tags && inExt === outExt && (inExt === 'flac' || inExt === 'mp3')) {
        try {
            const peek = await peekStream(up.stream, 4);
            const magicOk = inExt === 'flac' ? peek.head.subarray(0, 4).toString('latin1') === 'fLaC' : true; // mp3 check inside retagger
            if (!magicOk) throw new FormatMismatchError();
            const tagger = inExt === 'flac' ? new FlacRetagger(spec, await artP, true) : new Mp3Retagger(spec, await artP, true);
            const outBody = pipeline(peek.rest, tagger, () => {});
            // tagger parses header bytes inside _transform regardless of its
            // output buffering — 'header-done' fires as soon as it has consumed
            // the source metadata (first chunks), then outSize() is exact.
            await new Promise<void>((resolve, reject) => {
                const to = setTimeout(() => reject(new Error('tagger header timeout')), 30000);
                tagger.once('header-done', () => {
                    clearTimeout(to);
                    resolve();
                });
                tagger.once('error', (e) => {
                    clearTimeout(to);
                    reject(e);
                });
                peek.rest.once('error', (e) => {
                    clearTimeout(to);
                    reject(e);
                });
            });
            // provider-claimed lengths can drift a few bytes — don't promise
            // them as Content-Length or the client sees a truncated transfer
            const outLen = up.contentLength && !up.lengthIsHint ? tagger.outSize(up.contentLength) : undefined;
            if (jobId) prog({ stage: 'sending', total: outLen ?? up.contentLength, received: up.contentLength });
            const countedBody = counted(outBody, 'sent', 'sending');
            const tee = teeToStaged(countedBody, outExt);
            const body = tee.body;
            body.on('end', () => {
                tee.onDone?.();
                finish();
            });
            body.on('close', release);
            body.on('error', (e: any) => {
                release();
                prog({ stage: 'error', error: e?.message ?? 'tagger error' });
            });
            return { body, ext: outExt, contentLength: outLen, servedBy: up.servedBy, isPreview: up.isPreview, cleanup: wrapCleanup() };
        } catch (e) {
            // header inspection says this isn't really flac/mp3 (declared format lied)
            // → drop to the staged ffmpeg path rather than failing the download
            if (!(e instanceof FormatMismatchError) && !/not a (FLAC|MP3) stream/.test((e as Error)?.message ?? '')) {
                wrapCleanup()();
                prog({ stage: 'error', error: (e as Error)?.message ?? 'tagger failed' });
                throw e;
            }
            let st: Awaited<ReturnType<typeof stageToFile>>;
            try {
                // up.stream is poisoned (peek consumed it) — stageToFile
                // re-resolves fresh when no upstream is passed
                up.cleanup?.();
                st = await stageToFile(spec, jobId, signal);
                release(); // production done — slot bounds produces, not sends
            } catch (e2) {
                wrapCleanup()();
                throw e2;
            }
            const body = counted(fs.createReadStream(st.file), 'sent', 'sending');
            // identical staged semantics as branch D — register for Range resume
            const done = () => {
                registerStaged(jobId, st.file, st.dir, st.size);
                finish();
            };
            body.on('end', done);
            body.on('error', () => {
                registerStaged(jobId, st.file, st.dir, st.size);
                release();
            });
            signal?.addEventListener('abort', done, { once: true });
            return {
                body,
                ext: st.ext,
                contentLength: st.size,
                stagedFile: st.file,
                stagedDir: st.dir,
                servedBy: st.servedBy,
                isPreview: st.isPreview,
                cleanup: wrapCleanup()
            };
        }
    }

    // tagInPlace covered above; every other case is staged in branch D — the
    // ffmpeg-pipe path was removed: chunked/unknown-size responses are exactly
    // the anonymous-file UX the pipeline was rebuilt to kill.
    up.cleanup?.();
    release();
    throw new Error('unreachable pipeline state');
}

// ------------------ job progress ------------------
export interface JobProgress {
    stage: 'queued' | 'resolving' | 'downloading' | 'processing' | 'sending' | 'done' | 'error';
    received: number;
    sent: number;
    total?: number;
    label?: string;
    error?: string;
    cancelled?: boolean;
    servedBy?: string;
    at: number;
}

declare global {
    var __dlProgress: Map<string, JobProgress> | undefined;
}
const progressMap: Map<string, JobProgress> = (globalThis.__dlProgress ??= new Map());

const PROGRESS_TTL = 5 * 60 * 1000;
let sweepCounter = 0;
const remoteProgressAt = new Map<string, number>();
function mirrorProgressRemote(id: string, p: JobProgress, stageChanged: boolean) {
    if (!id || !queueEnabled()) return;
    const now = Date.now();
    const last = remoteProgressAt.get(id) ?? 0;
    const terminal = p.stage === 'done' || p.stage === 'error';
    // Chunk-level production can fire hundreds of updates per second. Mirror
    // stage transitions immediately but byte counters at most ~2/sec/job.
    if (!stageChanged && !terminal && now - last < 500) return;
    remoteProgressAt.set(id, now);
    jobSet(id, {
        stage: p.stage,
        received: p.received,
        sent: p.sent,
        total: p.total,
        label: p.label,
        error: p.error,
        cancelled: p.cancelled ? '1' : undefined,
        servedBy: p.servedBy
    }).catch(() => {});
}

export function setProgress(id: string, patch: Partial<JobProgress>) {
    if (!id) return;
    const p = progressMap.get(id) ?? { stage: 'queued', received: 0, sent: 0, at: Date.now() };
    // terminal stages are sticky in BOTH directions — a client disconnect just
    // after the last byte mustn't flip a delivered 'done' into 'error', and a
    // late 'close' mustn't regress anything either
    if ((p.stage === 'done' || p.stage === 'error') && patch.stage) {
        const { stage: _stage, ...rest } = patch;
        patch = rest;
    }
    const oldStage = p.stage;
    Object.assign(p, patch);
    p.at = Date.now();
    progressMap.set(id, p);
    mirrorProgressRemote(id, p, oldStage !== p.stage);
    // periodic sweep — terminal entries older than the TTL get evicted even when
    // the map is small (the old >200 check leaked them indefinitely)
    if (++sweepCounter % 40 === 0 || progressMap.size > 200) {
        for (const [k, v] of progressMap) if (Date.now() - v.at > PROGRESS_TTL) progressMap.delete(k);
    }
}
export function getProgress(id: string): JobProgress | null {
    const p = progressMap.get(id);
    if (!p) return null;
    if ((p.stage === 'done' || p.stage === 'error') && Date.now() - p.at > PROGRESS_TTL) return null;
    return p;
}

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
export interface StoredJob {
    spec: DownloadSpec;
    at: number;
    claimed?: boolean;
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
    for (const [k, v] of jobs) if (Date.now() - v.at > JOB_TTL) jobs.delete(k);
    return id;
}

// First GET claims a job but KEEPS it — a browser that loses its connection can
// retry with a Range request and get the staged file back (stagedRegistry).
export function claimJob(id: string): StoredJob | null {
    const j = jobs.get(id) ?? null;
    if (!j || j.claimed) return null;
    if (Date.now() - j.at > JOB_TTL) {
        jobs.delete(id);
        return null;
    }
    j.claimed = true;
    return j;
}

// completed staged outputs live a short while past delivery so Range resumes work
const STAGED_TTL_MS = 10 * 60 * 1000;
const stagedRegistry = new Map<string, { file: string; dir: string; size: number; at: number }>();
export function stagedFileFor(id: string): { file: string; size: number } | null {
    const s = stagedRegistry.get(id);
    return s ? { file: s.file, size: s.size } : null;
}
export function registerStaged(id: string | undefined, file: string, dir: string, size: number) {
    if (!id) return;
    const prev = stagedRegistry.get(id);
    if (prev && prev.dir !== dir) {
        try {
            fs.rmSync(prev.dir, { recursive: true, force: true });
        } catch {}
    }
    stagedRegistry.set(id, { file, dir, size, at: Date.now() });
    setTimeout(() => {
        if (stagedRegistry.get(id)?.file === file) {
            stagedRegistry.delete(id);
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {}
        }
    }, STAGED_TTL_MS).unref();
}


export function jobStats() {
    let active = 0;
    for (const p of progressMap.values()) if (p.stage !== 'done' && p.stage !== 'error' && !p.cancelled) active++;
    return { active, total: progressMap.size, queued: jobs.size, slots: pipelineSlots.active };
}

// Build a DownloadSpec from a normalized track (+ its album).
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
