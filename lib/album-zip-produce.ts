// File-backed album ZIP production.
//
// Audio codecs are already compressed, so entries are stored (not deflated).
// The writer streams local-file entries to disk with data descriptors and a real
// central directory — unlike the old browser response path this never holds a
// whole archive in memory, and unlike a live-only response it is a durable,
// resumable object-store artifact once uploaded.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { adapters } from './platforms';
import { stageToFile, specFromTrack, normalizeArtUrl, setProgress, pipelineSlots, fetchArtworkBuf, probeFileDuration } from './server-download';
import type { PlatformSource, ServiceTokens } from './platforms/types';

export interface AlbumZipSpec {
    albumId: string;
    source: PlatformSource;
    quality: string;
    codec: string;
    bitrate?: number;
    applyMeta: boolean;
    tokens?: ServiceTokens;
    country?: string;
    zipName: string;
    trackNamePattern?: string;
}

export interface ProducedZip {
    file: string;
    dir: string;
    size: number;
    trackCount: number;
    failedCount: number;
    previewCount: number;
}

const clean = (s: string) => s.replace(/[\/\\?:"*<>|]/g, '_').trim();

// ---------------- streaming ZIP writer (store method) ----------------
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
}
function crcUpdate(state: number, buf: Buffer): number {
    let c = state >>> 0;
    for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0;
    return c;
}

function dosDateTime(d = new Date()): { time: number; date: number } {
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) | 0);
    const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, date };
}

interface CentralEntry {
    name: Buffer;
    crc: number;
    size: number;
    offset: number;
    time: number;
    date: number;
}

class ZipFileWriter {
    private fd: number;
    private offset = 0;
    private entries: CentralEntry[] = [];
    private closed = false;

    constructor(private file: string) {
        this.fd = fs.openSync(file, 'w');
    }

    private write(buf: Buffer) {
        fs.writeSync(this.fd, buf);
        this.offset += buf.length;
    }

    async addBuffer(name: string, data: Buffer): Promise<void> {
        await this.addChunks(name, [data]);
    }

    async addFile(name: string, sourceFile: string): Promise<void> {
        await this.addChunks(name, fs.createReadStream(sourceFile, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>);
    }

    private async addChunks(name: string, chunks: AsyncIterable<Buffer> | Buffer[]): Promise<void> {
        if (this.closed) throw new Error('zip writer already closed');
        const nameBuf = Buffer.from(clean(name), 'utf8');
        if (!nameBuf.length) throw new Error('zip entry name is empty');
        if (nameBuf.length > 0xffff) throw new Error('zip entry name too long');
        const { time, date } = dosDateTime();
        const localOffset = this.offset;
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0);
        head.writeUInt16LE(20, 4); // version needed
        head.writeUInt16LE(0x0808, 6); // UTF-8 names + data descriptor
        head.writeUInt16LE(0, 8); // store
        head.writeUInt16LE(time, 10);
        head.writeUInt16LE(date, 12);
        head.writeUInt32LE(0, 14); // crc in descriptor
        head.writeUInt32LE(0, 18); // compressed size in descriptor
        head.writeUInt32LE(0, 22); // uncompressed size in descriptor
        head.writeUInt16LE(nameBuf.length, 26);
        head.writeUInt16LE(0, 28);
        this.write(head);
        this.write(nameBuf);

        let crcState = 0xffffffff;
        let size = 0;
        for await (const chunk of chunks) {
            const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (!b.length) continue;
            crcState = crcUpdate(crcState, b);
            size += b.length;
            if (size > 0xffffffff) throw new Error('zip entry exceeds ZIP32 size limit');
            this.write(b);
        }
        const crc = (crcState ^ 0xffffffff) >>> 0;
        const desc = Buffer.alloc(16);
        desc.writeUInt32LE(0x08074b50, 0);
        desc.writeUInt32LE(crc, 4);
        desc.writeUInt32LE(size, 8);
        desc.writeUInt32LE(size, 12);
        this.write(desc);
        if (this.offset > 0xfffffff0) throw new Error('zip archive exceeds the ZIP32 size limit');
        this.entries.push({ name: nameBuf, crc, size, offset: localOffset, time, date });
    }

    end(): void {
        if (this.closed) return;
        const cdOffset = this.offset;
        for (const e of this.entries) {
            const c = Buffer.alloc(46);
            c.writeUInt32LE(0x02014b50, 0);
            c.writeUInt16LE(20, 4); // version made by
            c.writeUInt16LE(20, 6); // version needed
            c.writeUInt16LE(0x0808, 8);
            c.writeUInt16LE(0, 10);
            c.writeUInt16LE(e.time, 12);
            c.writeUInt16LE(e.date, 14);
            c.writeUInt32LE(e.crc, 16);
            c.writeUInt32LE(e.size, 20);
            c.writeUInt32LE(e.size, 24);
            c.writeUInt16LE(e.name.length, 28);
            c.writeUInt32LE(e.offset, 42);
            this.write(c);
            this.write(e.name);
        }
        const cdSize = this.offset - cdOffset;
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(this.entries.length, 8);
        end.writeUInt16LE(this.entries.length, 10);
        end.writeUInt32LE(cdSize, 12);
        end.writeUInt32LE(cdOffset, 16);
        this.write(end);
        fs.fsyncSync(this.fd);
        fs.closeSync(this.fd);
        this.closed = true;
    }

    abort(): void {
        if (!this.closed) {
            try {
                fs.closeSync(this.fd);
            } catch {}
            this.closed = true;
        }
    }
}

// Structural validation: locate EOCD, validate central-directory bounds and
// compare the encoded entry count. CRCs were computed while writing; this is a
// corruption/truncation check before an artifact is marked complete.
export function validateZipStructure(file: string, expectedEntries: number): void {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
        const tailLen = Math.min(st.size, 66_000);
        const tail = Buffer.alloc(tailLen);
        fs.readSync(fd, tail, 0, tailLen, st.size - tailLen);
        let pos = -1;
        for (let i = tailLen - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === 0x06054b50) {
                pos = i;
                break;
            }
        }
        if (pos < 0) throw new Error('zip end-of-central-directory missing');
        const entries = tail.readUInt16LE(pos + 10);
        const cdSize = tail.readUInt32LE(pos + 12);
        const cdOffset = tail.readUInt32LE(pos + 16);
        if (entries !== expectedEntries) throw new Error(`zip entry count mismatch: ${entries} != ${expectedEntries}`);
        if (cdOffset + cdSize > st.size) throw new Error('zip central directory outside file bounds');
        if (cdOffset + cdSize + 22 > st.size) throw new Error('zip central directory truncated');
    } finally {
        fs.closeSync(fd);
    }
}

// Produce a complete archive to a temp file. `shouldCancel` is polled at track
// boundaries and while writing entries so cancellation does not wait for the
// whole album or depend on client socket state.
export async function produceAlbumZipFile(spec: AlbumZipSpec, jobId?: string, shouldCancel?: () => boolean): Promise<ProducedZip> {
    const ctx = { tokens: spec.tokens ?? {}, country: spec.country };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'albumzip-'));
    const zipPath = path.join(dir, `${clean(spec.zipName) || 'album'}.zip`);
    const writer = new ZipFileWriter(zipPath);
    const zipAbort = new AbortController();
    const cancelTimer = setInterval(() => {
        if (shouldCancel?.()) zipAbort.abort();
    }, 1000);
    let entries = 0;
    let previewCount = 0;
    let pending: Promise<{ st: any; e: any }> | null = null;
    try {
        const album = await adapters[spec.source].getAlbumInfo(spec.albumId, ctx);
        const allTracks = album.tracks?.items ?? [];
        const tracks = allTracks.filter((t: any) => t.streamable !== false);
        const failed: string[] = allTracks
            .filter((t: any) => t.streamable === false)
            .map((t: any) => `${t.title ?? 'track'} — not streamable on ${spec.source} (region/entitlement)`);

        const artUrl = normalizeArtUrl(album.image?.large);
        if (artUrl && spec.applyMeta !== false) {
            try {
                await writer.addBuffer('cover.jpg', await fetchArtworkBuf(artUrl));
                entries++;
            } catch {}
        }

        const specs = tracks.map((track: any) => ({
            track,
            tSpec: specFromTrack({ ...track, album }, {
                source: spec.source,
                quality: spec.quality,
                codec: spec.codec,
                bitrate: spec.bitrate,
                applyMeta: spec.applyMeta,
                tokens: spec.tokens as Record<string, string>,
                country: spec.country,
                trackNamePattern: spec.trackNamePattern,
                duration: track.duration
            })
        }));

        const cancelled = () => !!shouldCancel?.();
        const tryProduce = async (tSpec: any) => {
            const rel = await pipelineSlots.acquire();
            try {
                return { st: await stageToFile(tSpec, undefined, zipAbort.signal), e: null as any };
            } catch (e) {
                return { st: null as any, e };
            } finally {
                rel();
            }
        };

        pending = specs.length ? tryProduce(specs[0].tSpec) : null;
        for (const [index, { track, tSpec }] of specs.entries()) {
            if (cancelled()) throw new Error('cancelled');
            setProgress(jobId ?? '', {
                stage: 'downloading',
                label: `Track ${index + 1}/${tracks.length} — ${track.title}`,
                received: index,
                total: tracks.length,
                sent: index
            });
            const num = String(index + 1).padStart(Math.max(String(tracks.length).length, 2), '0');
            const nextP = index + 1 < specs.length && !cancelled() ? tryProduce(specs[index + 1].tSpec) : null;
            const r = await pending!;
            pending = nextP;
            if (r.e) {
                failed.push(`${num} ${tSpec.filename} — ${r.e?.message ?? 'download failed'}`);
                continue;
            }
            try {
                try {
                    const gotDuration = await probeFileDuration(r.st.file);
                    if (gotDuration <= 0) throw new Error('produced file is not valid/audio-parseable media');
                    if (!r.st.isPreview && tSpec.duration && gotDuration < tSpec.duration * 0.6) {
                        throw new Error(`only served a ${Math.round(gotDuration)}s clip of a ${tSpec.duration}s track`);
                    }
                } catch (trackErr: any) {
                    failed.push(`${num} ${tSpec.filename} — ${trackErr?.message ?? 'invalid media'}`);
                    continue;
                }
                // A writer failure is archive-fatal, not a per-track entitlement
                // failure: the entry may already be partially written, so the
                // artifact must be discarded rather than annotated and served.
                const entryName = `${num} ${tSpec.filename}${r.st.isPreview && !/preview/i.test(tSpec.filename) ? ' (Preview)' : ''}.${r.st.ext}`;
                await writer.addFile(clean(entryName), r.st.file);
                entries++;
                if (r.st.isPreview) previewCount++;
            } finally {
                fs.rmSync(r.st.dir, { recursive: true, force: true });
            }
            setProgress(jobId ?? '', { sent: index + 1, received: index + 1 });
        }
        pending?.then((r) => r?.st && fs.rmSync(r.st.dir, { recursive: true, force: true })).catch(() => {});

        if (failed.length) {
            await writer.addBuffer(
                'FAILED.txt',
                Buffer.from(
                    `The following ${failed.length} track(s) could not be downloaded on ${spec.source} (region-locked, preview-only, or unavailable):\r\n\r\n${failed.join('\r\n')}`,
                    'utf8'
                )
            );
            entries++;
        }
        writer.end();
        const size = fs.statSync(zipPath).size;
        validateZipStructure(zipPath, entries);
        setProgress(jobId ?? '', { stage: 'processing', label: 'Archive verified', total: size });
        clearInterval(cancelTimer);
        return { file: zipPath, dir, size, trackCount: tracks.length, failedCount: failed.length, previewCount };
    } catch (e) {
        clearInterval(cancelTimer);
        writer.abort();
        pending?.then((r) => r?.st && fs.rmSync(r.st.dir, { recursive: true, force: true })).catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true });
        throw e;
    }
}
