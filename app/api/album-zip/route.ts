import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import fs from 'fs';
import { Zip, AsyncZipDeflate } from 'fflate';
import { adapters, apiError } from '@/lib/platforms';
import { stageToFile, specFromTrack, normalizeArtUrl, setProgress, getProgress, pipelineSlots, fetchArtworkBuf } from '@/lib/server-download';
import type { PlatformSource, ServiceTokens } from '@/lib/platforms/types';
import { queueEnabled, enqueueJob, jobGet, jobSet, jobExpire, publicJobView } from '@/lib/queue';
import { cacheEnabled, cacheGet, presignGet, zipCacheKeyFor } from '@/lib/download-cache';
import { parseAlbumZipSpec } from '@/lib/download-spec';
import { rateLimit, clientIp } from '@/lib/rate-limit';

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
        const contentLength = Number(request.headers.get('content-length') ?? 0);
        if (contentLength > 48 * 1024) return apiError(new Error('zip spec too large'), 413);
        if (!(await rateLimit(`zip:${clientIp(request.headers)}`, 8, 600))) {
            return apiError(new Error('too many album zip jobs — slow down'), 429);
        }
        const spec = parseAlbumZipSpec(await request.json());
        const id = crypto.randomBytes(16).toString('hex');
        if (queueEnabled()) {
            if (cacheEnabled()) {
                // Preview-containing archives are job-scoped, not reusable cache
                // entries; a later entitled account must re-resolve full audio.
                const hit = await cacheGet(zipCacheKeyFor(spec)).catch(() => null);
                if (hit) {
                    const filename = spec.zipName.toLowerCase().endsWith('.zip') ? spec.zipName : `${spec.zipName}.zip`;
                    await jobSet(id, {
                        state: 'done', stage: 'done', kind: 'zip', cacheHit: '1',
                        resultUrl: presignGet(hit.objectKey, filename, 6 * 3600),
                        resultExt: 'zip', resultName: filename,
                        resultJson: { objectKey: hit.objectKey, size: hit.size, cacheHit: true, containsPreviews: false },
                        received: hit.size, sent: hit.size, total: hit.size, at: Date.now()
                    });
                    await jobExpire(id);
                    return NextResponse.json({ success: true, data: { job: id, cached: true, mode: 'queue' } });
                }
            }
            await enqueueJob(id, spec, spec.source, 'zip');
            return NextResponse.json({ success: true, data: { job: id, mode: 'queue' } });
        }
        zipJobs.set(id, { spec, at: Date.now() });
        setProgress(id, { stage: 'queued' });
        for (const [k, v] of zipJobs) if (Date.now() - v.at > ZIP_JOB_TTL) zipJobs.delete(k);
        return NextResponse.json({ success: true, data: { job: id, mode: 'local' } });
    } catch (e: any) {
        return apiError(e);
    }
}

const clean = (s: string) => s.replace(/[\/\\?:"*<>|]/g, '_').trim();

export async function GET(request: NextRequest) {
    const id = new URL(request.url).searchParams.get('job') ?? '';

    if (queueEnabled()) {
        // Non-blocking artifact handoff — clients poll /api/job-status first.
        const j = await jobGet(id);
        if (!j) return apiError(new Error('zip job expired — retry'), 410);
        if (j.stage === 'error') return apiError(new Error(publicJobView(j).error ?? 'zip failed'), 502);
        if (j.stage !== 'done') {
            return NextResponse.json({ success: false, error: 'job not ready', stage: j.stage ?? 'queued' }, { status: 202, headers: { 'Retry-After': '2', 'Cache-Control': 'no-store' } });
        }
        const objectKey = j.resultJson?.objectKey;
        const resultUrl = objectKey && j.resultName ? presignGet(objectKey, j.resultName, 6 * 3600) : j.resultUrl;
        if (resultUrl) return NextResponse.redirect(resultUrl, 302);
        if ((j as any).resultB64) {
            const buf = Buffer.from((j as any).resultB64, 'base64');
            const filename = j.resultName ?? 'album.zip';
            return new NextResponse(buf as any, {
                headers: {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
                    'Content-Length': String(buf.length)
                }
            });
        }
        return apiError(new Error('zip result missing — retry'), 410);
    }

    const job = zipJobs.get(id);
    if (!job || Date.now() - job.at > ZIP_JOB_TTL) return apiError(new Error('zip job expired — retry'), 410);
    zipJobs.delete(id);
    const spec = job.spec;
    const zipAbort = new AbortController();
    request.signal.addEventListener('abort', () => zipAbort.abort(), { once: true });

    try {
        const ctx = { tokens: spec.tokens ?? {}, country: spec.country };

        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                let zipErr: any = null;
                let dead = false; // once errored/closed, fflate workers keep calling us — ignore them
                let entryOpen = false;
                let lastChunkAt = Date.now();
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
                        if (chunk.length) {
                            controller.enqueue(chunk);
                            lastChunkAt = Date.now();
                        }
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
                // Keepalive — a track's produce can legitimately take minutes on a
                // fallback chain; a silent gap that long trips the client's undici
                // body-timeout. Emit a 0-byte marker entry every 45s of silence —
                // legal zip, bytes flow, browser stays alive.
                const keepalive = setInterval(() => {
                    if (dead || entryOpen || Date.now() - lastChunkAt < 45_000) return;
                    try {
                        const k = new AsyncZipDeflate('.keepalive', { level: 0 });
                        zip.add(k);
                        k.push(new Uint8Array(0), true);
                    } catch {}
                }, 45_000);
                try {
                    // album metadata resolves inside the stream — headers flush
                    // immediately and the keepalive covers the resolve gap
                    const album = await adapters[spec.source].getAlbumInfo(spec.albumId, ctx);
                    const allTracks = album.tracks?.items ?? [];
                    const tracks = allTracks.filter((t: any) => t.streamable !== false);
                    // a track the platform says can't be streamed used to
                    // silently vanish — report it in FAILED.txt
                    const failed: string[] = allTracks
                        .filter((t: any) => t.streamable === false)
                        .map((t: any) => `${t.title ?? 'track'} — not streamable on ${spec.source} (region/entitlement)`);
                    // cover.jpg first
                    const artUrl = normalizeArtUrl(album.image?.large);
                    if (artUrl && spec.applyMeta !== false) {
                        try {
                            const artBytes = await fetchArtworkBuf(artUrl);
                            const entry = new AsyncZipDeflate('cover.jpg', { level: 0 });
                            zip.add(entry);
                            entry.push(new Uint8Array(artBytes), true);
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
                    // Pipeline: start producing track N+1 BEFORE awaiting track N —
                    // the resolve+download chain is the slow part. Zip produces
                    // hold a pipeline slot too — a big album must not starve
                    // single downloads of the global cap.
                    const tryProduce = async (tSpec: any) => {
                        const rel = await pipelineSlots.acquire();
                        try {
                            // jobId=undefined — byte progress inside stageToFile
                            // belongs to single downloads; zip progress is track-count
                            return { st: await stageToFile(tSpec, undefined, zipAbort.signal), e: null as any };
                        } catch (e) {
                            return { st: null as any, e };
                        } finally {
                            rel();
                        }
                    };
                    let pending: ReturnType<typeof tryProduce> | null = specs.length ? tryProduce(specs[0].tSpec) : null;
                    for (const [index, { track, tSpec }] of specs.entries()) {
                        if (zipErr) throw zipErr;
                        if (getProgress(id)?.cancelled) throw new Error('cancelled');
                        setProgress(id, {
                            stage: 'downloading',
                            label: `Track ${index + 1}/${tracks.length} — ${track.title}`,
                            received: index,
                            total: tracks.length,
                            sent: 0
                        });
                        const num = String(index + 1).padStart(Math.max(String(tracks.length).length, 2), '0');
                        const nextP = index + 1 < specs.length && !dead ? tryProduce(specs[index + 1].tSpec) : null;
                        const r = await pending!;
                        pending = nextP;
                        if (r.e) {
                            // one region-locked/unavailable track must not kill the album
                            failed.push(`${num} ${tSpec.filename} — ${r.e?.message ?? 'download failed'}`);
                            console.log(`[zip ${id.slice(0, 8)}] track ${index + 1} failed: ${r.e?.message}`);
                            continue;
                        }
                        const st = r.st;
                        try {
                            const name = clean(`${num} ${tSpec.filename}.${st.ext}`);
                            const entry = new AsyncZipDeflate(name, { level: 0 });
                            entryOpen = true;
                            zip.add(entry);
                            for await (const chunk of fs.createReadStream(st.file, { highWaterMark: 1 << 19 })) {
                                if (dead || getProgress(id)?.cancelled) break;
                                entry.push(new Uint8Array(chunk as Buffer), false);
                            }
                            entry.push(new Uint8Array(0), true);
                            entryOpen = false;
                        } finally {
                            entryOpen = false;
                            fs.rmSync(st.dir, { recursive: true, force: true });
                        }
                        setProgress(id, { sent: index + 1, ...(st.servedBy ? { label: `Track ${index + 1}/${tracks.length} (via ${st.servedBy})` } : {}) });
                    }
                    // if we bail early a prefetched produce may still hold a
                    // staged dir — clean it when it settles
                    pending?.then((r) => r?.st && fs.rmSync(r.st.dir, { recursive: true, force: true })).catch(() => {});
                    if (failed.length) {
                        const note = new AsyncZipDeflate('FAILED.txt', { level: 0 });
                        zip.add(note);
                        note.push(
                            new TextEncoder().encode(
                                `The following ${failed.length} track(s) could not be downloaded on ${spec.source} (region-locked, preview-only, or unavailable):\r\n\r\n${failed.join('\r\n')}`
                            ),
                            true
                        );
                    }
                    zip.end();
                    clearInterval(keepalive);
                } catch (e: any) {
                    clearInterval(keepalive);
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
