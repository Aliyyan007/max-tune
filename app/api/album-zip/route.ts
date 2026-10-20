import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import crypto from 'crypto';
import { Zip, AsyncZipDeflate } from 'fflate';
import { adapters, apiError } from '@/lib/platforms';
import { produceTrackBytes, tagAndEncode, specFromTrack, normalizeArtUrl, setProgress, getProgress } from '@/lib/server-download';
import type { PlatformSource, ServiceTokens } from '@/lib/platforms/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Streaming album zip — Chrome downloads it as one live attachment while the
// server resolves, tags and writes each track into the archive progressively.
interface AlbumZipSpec {
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

interface StoredZipJob {
    spec: AlbumZipSpec;
    at: number;
}

const ZIP_JOB_TTL = 15 * 60 * 1000;
declare global {
    var __zipJobs: Map<string, StoredZipJob> | undefined;
}
const zipJobs: Map<string, StoredZipJob> = (globalThis.__zipJobs ??= new Map());

export async function POST(request: NextRequest) {
    try {
        const spec = (await request.json()) as AlbumZipSpec;
        if (!spec?.albumId || !spec?.source || !spec?.zipName) throw new Error('incomplete zip spec');
        const id = crypto.randomBytes(16).toString('hex');
        zipJobs.set(id, { spec, at: Date.now() });
        setProgress(id, { stage: 'queued' });
        for (const [k, v] of zipJobs) if (Date.now() - v.at > ZIP_JOB_TTL) zipJobs.delete(k);
        return NextResponse.json({ success: true, data: { job: id } });
    } catch (e: any) {
        return apiError(e);
    }
}

const clean = (s: string) => s.replace(/[\/\\?:"*<>|]/g, '_').trim();

export async function GET(request: NextRequest) {
    const id = new URL(request.url).searchParams.get('job') ?? '';
    const job = zipJobs.get(id);
    if (!job || Date.now() - job.at > ZIP_JOB_TTL) return apiError(new Error('zip job expired — retry'), 410);
    zipJobs.delete(id);
    const spec = job.spec;

    try {
        const ctx = { tokens: spec.tokens ?? {}, country: spec.country };
        const album = await adapters[spec.source].getAlbumInfo(spec.albumId, ctx);
        const tracks = (album.tracks?.items ?? []).filter((t: any) => t.streamable !== false);

        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                let zipErr: any = null;
                let dead = false; // once errored/closed, fflate workers keep calling us — ignore them
                const zip = new Zip((err, chunk, final) => {
                    if (dead) return;
                    if (err) {
                        dead = true;
                        zipErr = err;
                        try {
                            controller.error(err);
                        } catch {}
                        return;
                    }
                    try {
                        if (chunk.length) controller.enqueue(chunk);
                        if (final) {
                            controller.close();
                            dead = true;
                            setProgress(id, { stage: 'done' }); // archive fully flushed to the client
                        }
                    } catch {
                        dead = true;
                        zipErr ??= new Error('response stream closed');
                    }
                });
                try {
                    // cover.jpg first
                    const artUrl = normalizeArtUrl(album.image?.large);
                    if (artUrl && spec.applyMeta !== false) {
                        try {
                            const artRes = await axios.get(artUrl, { responseType: 'arraybuffer', timeout: 30000 });
                            const entry = new AsyncZipDeflate('cover.jpg', { level: 0 });
                            zip.add(entry);
                            entry.push(new Uint8Array(artRes.data), true);
                        } catch {}
                    }

                    for (const [index, track] of tracks.entries()) {
                        if (zipErr) throw zipErr;
                        if (getProgress(id)?.cancelled) throw new Error('cancelled');
                        setProgress(id, {
                            stage: 'downloading',
                            label: `Track ${index + 1}/${tracks.length} — ${track.title}`,
                            received: index,
                            total: tracks.length,
                            sent: 0
                        });
                        const t = { ...track, album };
                        const tSpec = specFromTrack(t, {
                            source: spec.source,
                            quality: spec.quality,
                            codec: spec.codec,
                            bitrate: spec.bitrate,
                            applyMeta: spec.applyMeta,
                            tokens: spec.tokens as Record<string, string>,
                            country: spec.country,
                            trackNamePattern: spec.trackNamePattern,
                            duration: track.duration
                        });
                        const { data, format } = await produceTrackBytes(tSpec);
                        const { data: out, ext } = await tagAndEncode(data, format, tSpec);
                        const num = String(index + 1).padStart(Math.max(String(tracks.length).length, 2), '0');
                        const name = clean(`${num} ${tSpec.filename}.${ext}`);
                        const entry = new AsyncZipDeflate(name, { level: 0 });
                        zip.add(entry);
                        entry.push(new Uint8Array(out), true);
                        setProgress(id, { sent: index + 1 });
                    }
                    zip.end();
                } catch (e: any) {
                    if (!dead) setProgress(id, { stage: 'error', error: e?.message ?? 'zip failed' });
                    dead = true;
                    try {
                        controller.error(e);
                    } catch {}
                    try {
                        (zip as any).terminate?.();
                    } catch {}
                }
            }
        });

        return new NextResponse(stream as any, {
            headers: {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(clean(spec.zipName))}.zip`,
                'Cache-Control': 'no-store'
            }
        });
    } catch (e: any) {
        return apiError(e, 502);
    }
}
