// Streaming container taggers — rewrite audio metadata blocks in-flight so a
// tagged file can be produced WITHOUT ffmpeg, with an exactly-computable output
// size (→ real Content-Length before the first byte reaches the client).
//
//   FLAC: parse metadata blocks, drop VORBIS_COMMENT/PICTURE/PADDING, keep
//         STREAMINFO/SEEKTABLE/APPLICATION/CUESHEET verbatim, emit our own
//         VORBIS_COMMENT + PICTURE + trailing PADDING, then pass frames through.
//         out = 4 + kept(4+len) + our(4+len) + (srcLen − srcHeaderLen)
//   MP3 : strip the leading ID3v2 (10 + synchsafe size [+10 footer]), prepend a
//         hand-built ID3v2.3 tag, pass audio + any trailing tags through.
//         out = ourTag + (srcLen − srcId3v2)
//
// Both emit 'header-done' once the source header has been consumed — at that
// point outSize(srcLen) is exact and can go on the wire as Content-Length.
// If the source magic doesn't match the expected container they emit
// 'format-error' so callers can fall back to the ffmpeg path.
import { Transform } from 'stream';
import type { DownloadSpec } from './server-download';

export class FormatMismatchError extends Error {
    constructor(msg = 'container magic mismatch') {
        super(msg);
        this.name = 'FormatMismatchError';
    }
}

const u32le = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
};
const u32be = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
};
const u24be = (n: number) => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

// ---------------- shared metadata builders ----------------

// Raw FLAC PICTURE block payload (type 3 = front cover). For ogg-family
// containers the same block is base64'd into a METADATA_BLOCK_PICTURE comment.
export function flacPictureBlockBytes(art: Buffer, mime = 'image/jpeg'): Buffer {
    const m = Buffer.from(mime);
    const buf = Buffer.alloc(4 + 4 + m.length + 4 + 4 * 4 + 4 + art.length);
    let o = 0;
    buf.writeUInt32BE(3, o); o += 4;
    buf.writeUInt32BE(m.length, o); o += 4;
    m.copy(buf, o); o += m.length;
    buf.writeUInt32BE(0, o); o += 4; // description len
    for (let i = 0; i < 4; i++) { buf.writeUInt32BE(0, o); o += 4; } // w/h/depth/colors
    buf.writeUInt32BE(art.length, o); o += 4;
    art.copy(buf, o);
    return buf;
}

// VORBIS_COMMENT block payload: vendor + count + length-prefixed KEY=value strings
export function vorbisComment(tags: [string, string][]): Buffer {
    const vendor = Buffer.from('MaxTune');
    const parts: Buffer[] = [u32le(vendor.length), vendor, u32le(tags.length)];
    for (const [k, v] of tags) {
        const s = Buffer.from(`${k}=${v}`, 'utf8');
        parts.push(u32le(s.length), s);
    }
    return Buffer.concat(parts);
}

// DownloadSpec → the tag set every writer uses (same fields ffmpeg FFMETADATA gets)
export function specTagPairs(spec: DownloadSpec): [string, string][] {
    const artists = spec.artist || 'Various Artists';
    const out: [string, string][] = [
        ['TITLE', spec.title ?? ''],
        ['ARTIST', artists],
        ['ALBUMARTIST', artists],
        ['ALBUM', spec.album || spec.title || '']
    ];
    if (spec.genre) out.push(['GENRE', spec.genre]);
    if (spec.date) out.push(['DATE', spec.date]);
    else if (spec.year) out.push(['DATE', spec.year]);
    if (spec.label) out.push(['LABEL', spec.label]);
    if (spec.copyright) out.push(['COPYRIGHT', spec.copyright]);
    if (spec.isrc) out.push(['ISRC', spec.isrc]);
    if (spec.upc) out.push(['BARCODE', spec.upc]);
    if (spec.trackNum) out.push(['TRACKNUMBER', String(spec.trackNum)]);
    if (spec.totalTracks) out.push(['TRACKTOTAL', String(spec.totalTracks)]);
    if (spec.discNum) out.push(['DISCNUMBER', String(spec.discNum)]);
    return out.filter(([, v]) => v !== '');
}

// FFMETADATA1 text for ffmpeg's -map_metadata input (same tag set as specTagPairs)
const metaEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, ' ').replace(/([=;#])/g, '\\$1');
export function buildFFMetadata(spec: DownloadSpec, vorbisArtB64?: string): string {
    const artists = spec.artist || 'Various Artists';
    let meta = ';FFMETADATA1';
    meta += `\ntitle=${metaEsc(spec.title ?? '')}`;
    meta += `\nartist=${metaEsc(artists)}`;
    meta += `\nalbum_artist=${metaEsc(artists)}`;
    meta += `\nalbum=${metaEsc(spec.album || spec.title || '')}`;
    if (spec.genre) meta += `\ngenre=${metaEsc(spec.genre)}`;
    if (spec.date) meta += `\ndate=${metaEsc(spec.date)}`;
    if (spec.year) meta += `\nyear=${metaEsc(spec.year)}`;
    if (spec.label) meta += `\nlabel=${metaEsc(spec.label)}`;
    if (spec.copyright) meta += `\ncopyright=${metaEsc(spec.copyright)}`;
    if (spec.isrc) meta += `\nisrc=${metaEsc(spec.isrc)}`;
    if (spec.upc) meta += `\nbarcode=${metaEsc(spec.upc)}`;
    if (spec.trackNum) meta += `\ntrack=${spec.totalTracks ? `${spec.trackNum}/${spec.totalTracks}` : spec.trackNum}`;
    if (spec.discNum) meta += `\ndisc=${spec.discNum}`;
    if (vorbisArtB64) meta += `\nMETADATA_BLOCK_PICTURE=${metaEsc(vorbisArtB64)}`;
    return meta;
}

// ---------------- ID3v2.3 builder (mp3) ----------------
const syncsafe4 = (n: number) => Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
const id3Frame = (id: string, payload: Buffer) => Buffer.concat([Buffer.from(id, 'latin1'), u32be(payload.length), Buffer.alloc(2), payload]);
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

// ---------------- FLAC retagger ----------------

const FLAC_KEEP = new Set([0, 2, 3, 5]); // STREAMINFO, APPLICATION, SEEKTABLE, CUESHEET
const FLAC_TAIL_PADDING = 2048; // leave room for tag editors that rewrite in place
const FLAC_HEADER_CAP = 24 * 1024 * 1024; // a pathological embedded PICTURE can be MBs

export class FlacRetagger extends Transform {
    private buf = Buffer.alloc(0);
    private headerDone = false;
    private srcHeaderLen = 0;
    private keptBlocks: Buffer[] = [];
    private ourBlocks: Buffer[] = [];
    private emittedHead = false;

    constructor(spec: DownloadSpec, art: Buffer | null, private applyMeta: boolean) {
        super();
        if (applyMeta) {
            const vc = vorbisComment(specTagPairs(spec));
            this.ourBlocks.push(Buffer.concat([u24be(vc.length), vc]));
            if (art?.length) {
                const pic = flacPictureBlockBytes(art);
                // block type 6 = PICTURE
                this.ourBlocks.push(Buffer.concat([Buffer.concat([Buffer.from([6]), u24be(pic.length)]), pic]));
            }
            // VORBIS_COMMENT block type 4 — patch type byte on the first our-block
            this.ourBlocks[0] = Buffer.concat([Buffer.from([4]), this.ourBlocks[0]]);
        }
    }

    private parseHeader(): boolean {
        if (this.buf.length < 4) return false;
        if (this.buf.subarray(0, 4).toString('latin1') !== 'fLaC') throw new FormatMismatchError('not a FLAC stream');
        let off = 4;
        for (;;) {
            if (this.buf.length - off < 4) return false;
            const head = this.buf[off];
            const isLast = (head & 0x80) !== 0;
            const type = head & 0x7f;
            const len = this.buf.readUIntBE(off + 1, 3);
            if (this.buf.length - off - 4 < len) return false;
            const block = this.buf.subarray(off, off + 4 + len);
            if (FLAC_KEEP.has(type)) {
                // preserve the block but clear the last-flag — we append our own tail
                const copy = Buffer.from(block);
                copy[0] = type;
                this.keptBlocks.push(copy);
            }
            off += 4 + len;
            if (isLast) {
                this.srcHeaderLen = off;
                this.buf = this.buf.subarray(off);
                this.headerDone = true;
                return true;
            }
            if (off > FLAC_HEADER_CAP) throw new FormatMismatchError('FLAC header exceeds sanity cap');
        }
    }

    // Exact tagged size once the header is parsed — needs the encrypted/upstream
    // byte count (decrypt is length-preserving).
    outSize(srcLen: number): number {
        if (!this.headerDone) throw new Error('outSize before header-done');
        const kept = this.keptBlocks.reduce((n, b) => n + b.length, 0);
        const ours = this.ourBlocks.reduce((n, b) => n + b.length, 0);
        const pad = this.applyMeta ? 4 + FLAC_TAIL_PADDING : 0;
        return 4 + kept + ours + pad + (srcLen - this.srcHeaderLen);
    }

    _transform(chunk: Buffer, _e: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void) {
        try {
            if (!this.emittedHead) {
                this.buf = Buffer.concat([this.buf, chunk]);
                if (!this.parseHeader()) return cb(); // need more header bytes
                const pad = this.applyMeta ? Buffer.concat([Buffer.from([0x80 | 1]), u24be(FLAC_TAIL_PADDING), Buffer.alloc(FLAC_TAIL_PADDING)]) : Buffer.alloc(0);
                const head = Buffer.concat([Buffer.from('fLaC'), ...this.keptBlocks, ...this.ourBlocks, pad]);
                this.emittedHead = true;
                this.push(head);
                this.emit('header-done');
                if (this.buf.length) {
                    const rest = this.buf;
                    this.buf = Buffer.alloc(0);
                    return cb(null, rest);
                }
                this.buf = Buffer.alloc(0);
                return cb();
            }
            cb(null, chunk);
        } catch (e) {
            cb(e as Error);
        }
    }
}

// ---------------- MP3 retagger ----------------

export class Mp3Retagger extends Transform {
    private buf = Buffer.alloc(0);
    private headerDone = false;
    private srcId3Len = 0;
    private emittedHead = false;
    private ourTag: Buffer;

    constructor(spec: DownloadSpec, art: Buffer | null, applyMeta: boolean) {
        super();
        this.ourTag = applyMeta ? buildId3v2(spec, art) : Buffer.alloc(0);
    }

    private parseHeader(): boolean {
        if (this.buf.length < 10) {
            // 3 bytes is enough to rule out ID3 and check frame sync
            if (this.buf.length >= 3 && this.buf.subarray(0, 3).toString('latin1') !== 'ID3') {
                const isFrame = this.buf[0] === 0xff && (this.buf[1] & 0xe0) === 0xe0;
                if (!isFrame) throw new FormatMismatchError('not an MP3 stream');
                this.srcId3Len = 0;
                // keep this.buf — those bytes are real audio frames that still
                // need to be emitted after our new tag
                this.headerDone = true;
                return true;
            }
            return false;
        }
        if (this.buf.subarray(0, 3).toString('latin1') !== 'ID3') {
            const isFrame = this.buf[0] === 0xff && (this.buf[1] & 0xe0) === 0xe0;
            if (!isFrame) throw new FormatMismatchError('not an MP3 stream');
            this.srcId3Len = 0;
            this.headerDone = true;
            return true;
        }
        const size = ((this.buf[6] & 0x7f) << 21) | ((this.buf[7] & 0x7f) << 14) | ((this.buf[8] & 0x7f) << 7) | (this.buf[9] & 0x7f);
        const footer = this.buf[5] & 0x10 ? 10 : 0; // v2.4 footer-present flag
        const total = 10 + size + footer;
        if (this.buf.length < total) return false;
        this.srcId3Len = total;
        this.buf = this.buf.subarray(total);
        this.headerDone = true;
        return true;
    }

    outSize(srcLen: number): number {
        if (!this.headerDone) throw new Error('outSize before header-done');
        return this.ourTag.length + (srcLen - this.srcId3Len);
    }

    _transform(chunk: Buffer, _e: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void) {
        try {
            if (!this.emittedHead) {
                this.buf = Buffer.concat([this.buf, chunk]);
                if (!this.parseHeader()) return cb();
                this.emittedHead = true;
                this.emit('header-done');
                const rest = this.buf;
                this.buf = Buffer.alloc(0);
                return cb(null, Buffer.concat([this.ourTag, rest]));
            }
            cb(null, chunk);
        } catch (e) {
            cb(e as Error);
        }
    }
}
