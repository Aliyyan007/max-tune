import axios, { AxiosError } from 'axios';
import { artistReleaseCategories } from '@/components/artist-dialog';
import { formatCustomTitle } from './utils';
import { createJob } from './status-bar/jobs';
import { Disc3Icon, DiscAlbumIcon } from 'lucide-react';
import { FetchedQobuzAlbum, formatArtists, formatTitle, QobuzAlbum, QobuzArtistResults, QobuzTrack } from './qobuz-dl';
import { getServiceTokens, serviceHeaders } from './service-tokens';
import { outputFor, SettingsProps } from './settings-provider';
import { StatusBarProps } from '@/components/status-bar/status-bar';
import { ToastAction } from '@/components/ui/toast';
import { saveUrl } from './browser-save';
import { addRecentDownload } from './recent-downloads';

const sourceOf = (obj: any): string => obj?.source ?? 'qobuz';

// Always fetch the platform's maximum quality tier — no user quality setting.
const MAX_QUALITY = '27' as const;

// pull the server's {error:"..."} message out of a failed axios call instead of "Request failed with status code N"
const errDesc = (e: any): string => {
    const data = (e as AxiosError)?.response?.data;
    if (data && typeof data === 'object' && 'error' in data) return String((data as any).error);
    return e instanceof Error ? e.message : 'An unknown error occurred';
};

const fmtMB = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const fmtETA = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 1) return '';
    if (seconds < 60) return `${Math.ceil(seconds)}s left`;
    return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s left`;
};
const activeTrackDownloads = new Set<string>();

type Stage = 'queued' | 'resolving' | 'downloading' | 'processing' | 'uploading' | 'sending' | 'done' | 'error';
const STAGE_TEXT: Record<Stage, string> = {
    queued: 'Queued…',
    resolving: 'Resolving source…',
    downloading: 'Fetching audio…',
    processing: 'Tagging & embedding artwork…',
    uploading: 'Uploading artifact…',
    sending: 'Handing to browser…',
    done: 'Done — check your downloads',
    error: 'Failed'
};

// Poll /api/job-status while the server produces the file so the status bar
// tracks real stages — resolving, fetching, tagging, pushing — with byte counts.
// Resolves true when done, false on error/cancel.
function watchJob(
    jobId: string,
    setStatusBar: React.Dispatch<React.SetStateAction<StatusBarProps>>,
    signal: AbortSignal,
    opts?: { onLiveReady?: () => void }
): Promise<any | false> {
    return new Promise((resolve) => {
        let lastStage = '';
        let lastBytes = 0;
        let lastBytesAt = 0;
        let lastBytesStage = '';
        let smoothSpeed = 0;
        let liveNotified = false;
        const startedAt = Date.now();
        const poll = async () => {
            if (signal.aborted) return resolve(false);
            try {
                const res = await axios.get('/api/job-status', { params: { id: jobId }, signal });
                const p = res.data?.data;
                if (!p) {
                    if (Date.now() - startedAt < 6000) {
                        setTimeout(poll, 500);
                        return;
                    }
                    return resolve(false); // aged out — Chrome already has it
                }
                if (!liveNotified && (p.liveReady === '1' || p.liveReady === 1 || p.liveReady === true)) {
                    liveNotified = true;
                    opts?.onLiveReady?.();
                }
                if (p.stage !== lastStage || ['downloading', 'uploading', 'sending', 'queued'].includes(p.stage)) {
                    lastStage = p.stage;
                    let desc = STAGE_TEXT[p.stage as Stage] ?? p.stage;
                    if (p.stage === 'queued' && p.queuePosition) desc = `Queued — position ${p.queuePosition}`;
                    else if (p.stage === 'downloading' && p.received) desc = `Fetching audio — ${fmtMB(p.received)}${p.total ? ` of ${fmtMB(p.total)}` : ''}`;
                    else if (p.stage === 'uploading' && p.sent) desc = `Uploading artifact — ${fmtMB(p.sent)}${p.total ? ` of ${fmtMB(p.total)}` : ''}`;
                    else if (p.stage === 'sending' && p.sent) desc = `Handing to browser — ${fmtMB(p.sent)}${p.total ? ` of ${fmtMB(p.total)}` : ''}`;
                    if (['downloading', 'uploading', 'sending'].includes(p.stage)) {
                        const byteCount = Number(p.stage === 'downloading' ? p.received ?? 0 : p.sent ?? 0);
                        const total = Number(p.total ?? 0);
                        const now = Date.now();
                        if (lastBytesStage !== p.stage) {
                            lastBytes = 0;
                            lastBytesAt = 0;
                            smoothSpeed = 0;
                            lastBytesStage = p.stage;
                        }
                        if (lastBytesAt && byteCount > lastBytes) {
                            const instantSpeed = (byteCount - lastBytes) / Math.max((now - lastBytesAt) / 1000, 0.1);
                            smoothSpeed = smoothSpeed ? smoothSpeed * 0.65 + instantSpeed * 0.35 : instantSpeed;
                            lastBytes = byteCount;
                            lastBytesAt = now;
                        } else if (!lastBytesAt && byteCount > 0) {
                            lastBytes = byteCount;
                            lastBytesAt = now;
                        }
                        if (smoothSpeed > 1024) {
                            desc += ` · ${fmtMB(smoothSpeed)}/s`;
                            const eta = total > byteCount ? fmtETA((total - byteCount) / smoothSpeed) : '';
                            if (eta) desc += ` · ${eta}`;
                        }
                    }
                    let pct = 4;
                    if (p.stage === 'resolving') pct = 10;
                    else if (p.stage === 'downloading') pct = p.total ? 12 + Math.round((50 * p.received) / p.total) : Math.min(60, 12 + Math.round(p.received / 524288));
                    else if (p.stage === 'processing') pct = 68;
                    else if (p.stage === 'uploading') pct = p.total ? 72 + Math.round((23 * p.sent) / Math.max(p.total, p.sent)) : 78;
                    else if (p.stage === 'sending') pct = p.total ? 95 + Math.round((4 * p.sent) / Math.max(p.total, p.sent)) : 97;
                    else if (p.stage === 'done') pct = 100;
                    setStatusBar((prev) => ({ ...prev, progress: Math.min(pct, 100), description: desc }));
                }
                if (p.stage === 'done') return resolve(p);
                if (p.stage === 'error') {
                    setStatusBar((prev) => ({ ...prev, description: p.error ?? 'Download failed' }));
                    return resolve(p);
                }
                setTimeout(poll, p.stage === 'queued' ? 700 : 350);
                return;
            } catch (e) {
                if (e instanceof AxiosError && e.response?.status === 404 && Date.now() - startedAt > 6000) return resolve(false);
            }
            setTimeout(poll, 700);
        };
        poll();
    });
}

// For non-qobuz platforms the album object bundled with a search result is sparse —
// fetch the full album so tags (genre/label/upc/date) are complete.
// Memoized per album id — N tracks from one album used to fire N sequential calls
// before each job was even created.
const albumEnrichP = new Map<string, Promise<void>>();
async function enrichAlbum(result: QobuzTrack, country: string | undefined, signal?: AbortSignal) {
    const album = result.album;
    if (!album || album.full || sourceOf(result) === 'qobuz' || !album.id) return;
    const key = `${sourceOf(result)}:${album.id}`;
    let p = albumEnrichP.get(key);
    if (!p) {
        p = (async () => {
            try {
                const res = await axios.get('/api/get-album', {
                    params: { album_id: album.id, source: sourceOf(result) },
                    headers: { 'Token-Country': country, ...serviceHeaders() },
                    timeout: 2500,
                    signal
                });
                const full = res.data?.data;
                if (full) {
                    album.genre = full.genre ?? album.genre;
                    album.label = full.label ?? album.label;
                    album.upc = full.upc ?? album.upc;
                    album.release_date_original = full.release_date_original || album.release_date_original;
                    album.released_at = full.released_at || album.released_at;
                    album.artists = full.artists?.length ? full.artists : album.artists;
                    if (full.image?.large) album.image = full.image;
                    album.full = true;
                }
            } catch {}
        })();
        albumEnrichP.set(key, p);
        if (albumEnrichP.size > 100) albumEnrichP.delete(albumEnrichP.keys().next().value!);
    }
    await p;
}

export const createDownloadJob = async (
    result: QobuzAlbum | QobuzTrack,
    setStatusBar: React.Dispatch<React.SetStateAction<StatusBarProps>>,
    settings: SettingsProps,
    toast: (toast: any) => void,
    fetchedAlbumData?: FetchedQobuzAlbum | null,
    setFetchedAlbumData?: React.Dispatch<React.SetStateAction<FetchedQobuzAlbum | null>>,
    country?: string
) => {
    if ((result as QobuzTrack).album) {
        const formattedTitle = formatCustomTitle(settings.trackName, result as QobuzTrack);
        const initialSource = sourceOf(result);
        const initialOutput = outputFor(initialSource, settings);
        const dedupeKey = [initialSource, String((result as QobuzTrack).id), initialOutput.outputCodec, initialOutput.bitrate, settings.applyMetadata ? 'meta' : 'raw'].join(':');
        if (activeTrackDownloads.has(dedupeKey)) {
            toast({ title: 'Already queued', description: 'This song is already being downloaded. Duplicate downloads are ignored.' });
            return;
        }
        activeTrackDownloads.add(dedupeKey);
        await createJob(setStatusBar, formattedTitle, Disc3Icon, async () => {
            const completion = new Promise<void>(async (resolve) => {
                const controller = new AbortController();
                const signal = controller.signal;
                let jobId: string | null = null;
                setStatusBar((prev) => ({
                    ...prev,
                    progress: 0,
                    title: `Downloading ${formatTitle(result)}`,
                    description: 'Preparing download…',
                    onCancel: () => {
                        controller.abort();
                        if (jobId) axios.post('/api/job-status', { id: jobId }).catch(() => {});
                        resolve();
                    }
                }));
                try {
                    const source = sourceOf(result);
                    const eff = outputFor(source, settings);
                    // Album enrichment improves tags, but it must never hold the
                    // click hostage behind a slow provider detail endpoint. Use
                    // whatever arrives quickly; the sparse search-row metadata is
                    // still valid and the queue notification should be immediate.
                    await Promise.race([
                        enrichAlbum(result as QobuzTrack, country, signal),
                        new Promise((resolve) => setTimeout(resolve, 1200))
                    ]);
                    const track = result as QobuzTrack;
                    const album = track.album as any;
                    const spec = {
                        source,
                        id: String(track.id),
                        quality: MAX_QUALITY,
                        title: formatTitle(track),
                        artist: formatArtists(track),
                        album: formatTitle(album ?? track),
                        trackNum: track.track_number,
                        discNum: track.media_number,
                        genre: album?.genre?.name,
                        date: album?.release_date_original,
                        year: album?.release_date_original ? String(new Date(album.release_date_original).getFullYear()) : undefined,
                        label: album?.label?.name,
                        copyright: track.copyright,
                        isrc: track.isrc,
                        upc: album?.upc,
                        artUrl: album?.image?.large ?? (track as any).image?.large,
                        filename: formattedTitle,
                        applyMeta: settings.applyMetadata,
                        codec: eff.outputCodec,
                        bitrate: eff.bitrate,
                        // user-entered provider credentials (Settings → Service Tokens) take
                        // precedence server-side; the token pool covers the unconfigured case
                        tokens: getServiceTokens() as Record<string, string>,
                        country,
                        duration: track.duration
                    };
                    // POST registers the job server-side (tokens never hit the URL),
                    // then a[download] lets Chrome own the transfer — live progress
                    // and a real file in Downloads, no in-memory blob.
                    const res = await axios.post('/api/download-file', spec, { signal });
                    const job = res.data?.data?.job;
                    if (!job) throw new Error('download job not created');
                    jobId = job;
                    // Queue mode: wait for the worker-published artifact first —
                    // the web GET is deliberately non-blocking and redirects to
                    // object storage. Local mode keeps the old concurrent behavior
                    // because the GET itself is the producer.
                    const mode = res.data?.data?.mode;
                    const toastState = res.data?.data;
                    toast({
                        title: toastState?.deduped ? 'Already queued' : toastState?.cached ? 'Ready from cache' : mode === 'queue' ? 'Queued for download' : 'Download started',
                        description: toastState?.deduped
                            ? `${formatTitle(track)} is already in the download queue — the existing job will be used.`
                            : `${formatTitle(track)} — ${formatArtists(track)}`
                    });
                    const finishProduced = (outcome?: any) => {
                        addRecentDownload({
                            key: `${source}:${track.id}`,
                            source,
                            trackId: String(track.id),
                            title: formatTitle(track),
                            artist: formatArtists(track),
                            album: spec.album,
                            artUrl: spec.artUrl,
                            ext: outcome?.resultExt,
                            duration: track.duration,
                            size: outcome?.total,
                            isPreview: !!outcome?.isPreview,
                            downloadedAt: Date.now()
                        });
                        if (outcome?.isPreview) {
                            const provider = source.charAt(0).toUpperCase() + source.slice(1);
                            toast({
                                title: 'Preview downloaded',
                                description: `${provider} only authorizes a ${outcome.previewDuration ? `${Math.round(outcome.previewDuration)}s ` : ''}preview for this account. This is ${provider}'s own preview asset, not audio substituted from another platform; the filename is marked “(Preview)”.`
                            });
                        }
                        setStatusBar((prev) => ({ ...prev, progress: 100, description: 'Done — check your downloads' }));
                        resolve();
                    };
                    const saveProduced = async (outcome?: any) => {
                        const result = await saveUrl(`/api/download-file?job=${job}`, formattedTitle, {
                            signal,
                            forceNav: mode === 'queue',
                            onProgress: (received, total) =>
                                setStatusBar((prev) => ({
                                    ...prev,
                                    description: total ? `Saving to disk — ${fmtMB(received)} of ${fmtMB(total)}` : `Saving to disk — ${fmtMB(received)}`,
                                    progress: total ? Math.max(prev.progress ?? 0, Math.min(99, Math.round((99 * received) / total))) : prev.progress
                                }))
                        });
                        if (result.method === 'aborted') {
                            axios.post('/api/job-status', { id: job }).catch(() => {});
                            return resolve();
                        }
                        finishProduced(outcome);
                    };
                    const liveUrl = res.data?.data?.liveUrl;
                    const liveNavUrl = `/api/download-file?job=${encodeURIComponent(job)}&live=1`;
                    let liveStarted = false;
                    let liveStartAttempted = false;
                    const liveDecisions: Promise<void>[] = [];
                    const startLiveDownload = () => {
                        if (!liveUrl || liveStartAttempted || signal.aborted) return;
                        liveStartAttempted = true;
                        liveDecisions.push((async () => {
                            try {
                                // Probe first so a wrong/expired worker URL falls back
                                // to the normal published-artifact path instead of
                                // silently opening a failed browser navigation.
                                const probeCtl = new AbortController();
                                const cancelProbe = () => probeCtl.abort();
                                const probeTimeout = setTimeout(() => probeCtl.abort(), 5000);
                                signal.addEventListener('abort', cancelProbe, { once: true });
                                let probe: Response;
                                try {
                                    probe = await fetch(liveNavUrl, { method: 'HEAD', cache: 'no-store', signal: probeCtl.signal });
                                } finally {
                                    clearTimeout(probeTimeout);
                                    signal.removeEventListener('abort', cancelProbe);
                                }
                                if (!probe.ok) return;
                                await saveUrl(liveNavUrl, formattedTitle, { signal, forceNav: true });
                                liveStarted = true;
                                toast({
                                    title: 'Fast download started',
                                    description: 'The finished track is downloading now while its cloud copy is uploaded in parallel.'
                                });
                                setStatusBar((prev) => ({ ...prev, description: 'Handing to browser — cloud copy uploading…' }));
                            } catch {}
                        })());
                    };
                    if (mode === 'queue') {
                        try {
                            const outcome = await watchJob(job, setStatusBar, signal, { onLiveReady: startLiveDownload });
                            await Promise.allSettled(liveDecisions);
                            if (signal.aborted) return resolve();
                            if (!outcome) throw new Error('download monitoring ended before completion');
                            if (outcome.stage === 'error') throw new Error(outcome.error ?? 'Download failed');
                            if (liveStarted) finishProduced(outcome);
                            else await saveProduced(outcome);
                        } catch (e) {
                            axios.post('/api/job-status', { id: job }).catch(() => {});
                            throw e;
                        }
                    } else {
                        const watch = watchJob(job, setStatusBar, signal);
                        try {
                            await saveProduced();
                        } catch (e) {
                            // tell the server to stop producing, then rethrow for the toast
                            axios.post('/api/job-status', { id: job }).catch(() => {});
                            throw e;
                        } finally {
                            void watch;
                        }
                    }
                } catch (e) {
                    if (e instanceof AxiosError && e.code === 'ERR_CANCELED') resolve();
                    else {
                        const message = errDesc(e);
                        toast({
                            title: /region limitations|region-locked|not available in this region/i.test(message) ? 'Region unavailable' : 'Error',
                            description: message,
                            action: (
                                <ToastAction altText='Copy Stack' onClick={() => navigator.clipboard.writeText((e as Error).stack!)}>
                                    Copy Stack
                                </ToastAction>
                            )
                        });
                        resolve();
                    }
                }
            });
            try {
                await completion;
            } finally {
                activeTrackDownloads.delete(dedupeKey);
            }
        }, () => activeTrackDownloads.delete(dedupeKey), () => {
            toast({
                title: 'Added to download queue',
                description: `${formatTitle(result)} will start as soon as the current download finishes.`
            });
        });
    } else {
        const formattedZipTitle = formatCustomTitle(settings.zipName, result as QobuzAlbum);
        const zipSource = sourceOf(result);
        const zipOutput = outputFor(zipSource, settings);
        const zipDedupeKey = ['zip', zipSource, String((result as QobuzAlbum).id), zipOutput.outputCodec, zipOutput.bitrate, settings.applyMetadata ? 'meta' : 'raw', formattedZipTitle].join(':');
        if (activeTrackDownloads.has(zipDedupeKey)) {
            toast({ title: 'Already queued', description: 'This album is already being downloaded. Duplicate downloads are ignored.' });
            return;
        }
        activeTrackDownloads.add(zipDedupeKey);

        await createJob(setStatusBar, formattedZipTitle, DiscAlbumIcon, async () => {
            return new Promise<void>(async (resolve) => {
                const controller = new AbortController();
                const signal = controller.signal;
                let jobId: string | null = null;
                setStatusBar((prev) => ({
                    ...prev,
                    progress: 0,
                    title: `Downloading ${formatTitle(result)}`,
                    description: 'Preparing album zip…',
                    onCancel: () => {
                        controller.abort();
                        if (jobId) axios.post('/api/job-status', { id: jobId }).catch(() => {});
                        resolve();
                    }
                }));
                try {
                    const source = sourceOf(result);
                    const eff = outputFor(source, settings);
                    // Register the zip job, then let Chrome stream the archive — it
                    // appears as one live download while the server tags each track.
                    const res = await axios.post(
                        '/api/album-zip',
                        {
                            albumId: String((result as QobuzAlbum).id),
                            source,
                            quality: MAX_QUALITY,
                            codec: eff.outputCodec,
                            bitrate: eff.bitrate,
                            applyMeta: settings.applyMetadata,
                            tokens: getServiceTokens() as Record<string, string>,
                            country,
                            zipName: formattedZipTitle,
                            trackNamePattern: settings.trackName
                        },
                        { signal }
                    );
                    const job = res.data?.data?.job;
                    if (!job) throw new Error('zip job not created');
                    jobId = job;
                    // zips can be GBs — queue mode waits for the verified archive,
                    // then object storage serves the bytes rather than the web dyno.
                    const mode = res.data?.data?.mode;
                    const zipQueued = res.data?.data;
                    toast({
                        title: zipQueued?.deduped ? 'Already queued' : zipQueued?.cached ? 'Album ready from cache' : mode === 'queue' ? 'Album queued for download' : 'Album download started',
                        description: zipQueued?.deduped ? `${formatTitle(result)} is already in the download queue — the existing job will be used.` : formatTitle(result)
                    });
                    const saveZip = async (outcome?: any) => {
                        const result = await saveUrl(`/api/album-zip?job=${job}`, formattedZipTitle + '.zip', { signal, navIfNoPicker: true, forceNav: mode === 'queue' });
                        if (result.method === 'aborted') {
                            axios.post('/api/job-status', { id: job }).catch(() => {});
                            return resolve();
                        }
                        if (outcome?.containsPreviews || outcome?.previewCount) {
                            toast({
                                title: 'Preview tracks included',
                                description: `${source} only authorized preview audio for ${outcome.previewCount ?? 'some'} track(s). Preview entries are marked “(Preview)” inside the archive.`
                            });
                        }
                        setStatusBar((prev) => ({ ...prev, progress: 100, description: 'Done — check your downloads' }));
                        resolve();
                    };
                    if (mode === 'queue') {
                        try {
                            const outcome = await watchJob(job, setStatusBar, signal);
                            if (signal.aborted) return resolve();
                            if (!outcome) throw new Error('zip monitoring ended before completion');
                            if (outcome.stage === 'error') throw new Error(outcome.error ?? 'Zip failed');
                            await saveZip(outcome);
                        } catch (e) {
                            axios.post('/api/job-status', { id: job }).catch(() => {});
                            throw e;
                        }
                    } else {
                        const watch = watchJob(job, setStatusBar, signal);
                        try {
                            await saveZip();
                        } catch (e) {
                            axios.post('/api/job-status', { id: job }).catch(() => {});
                            throw e;
                        } finally {
                            void watch;
                        }
                    }
                } catch (e) {
                    if (e instanceof AxiosError && e.code === 'ERR_CANCELED') resolve();
                    else {
                        const message = errDesc(e);
                        toast({
                            title: /region limitations|region-locked|not available in this region/i.test(message) ? 'Region unavailable' : 'Error',
                            description: message,
                            action: (
                                <ToastAction altText='Copy Stack' onClick={() => navigator.clipboard.writeText((e as Error).stack!)}>
                                    Copy Stack
                                </ToastAction>
                            )
                        });
                        resolve();
                    }
                }
            }).finally(() => activeTrackDownloads.delete(zipDedupeKey));
        }, () => activeTrackDownloads.delete(zipDedupeKey), () => {
            toast({
                title: 'Album added to download queue',
                description: `${formatTitle(result)} will start as soon as the current download finishes.`
            });
        });
    }
};

export async function downloadArtistDiscography(
    artistResults: QobuzArtistResults,
    setArtistResults: React.Dispatch<React.SetStateAction<QobuzArtistResults | null>>,
    fetchMore: (searchField: any, artistResults: QobuzArtistResults) => Promise<void>,
    type: 'album' | 'epSingle' | 'live' | 'compilation' | 'all',
    setStatusBar: React.Dispatch<React.SetStateAction<StatusBarProps>>,
    settings: SettingsProps,
    toast: (toast: any) => void,
    country?: string
) {
    let types: ('album' | 'epSingle' | 'live' | 'compilation')[] = [];
    if (type === 'all') types = ['album', 'epSingle', 'live', 'compilation'];
    else types = [type];
    for (const type of types) {
        while (artistResults.artist.releases[type].has_more) {
            await fetchMore(type, artistResults);
            artistResults = (await loadArtistResults(setArtistResults)) as QobuzArtistResults;
        }
        for (const release of artistResults.artist.releases[type].items) {
            await createDownloadJob(release, setStatusBar, settings, toast, undefined, undefined, country);
        }
    }
    toast({
        title: `Added all ${artistReleaseCategories.find((category) => category.value === type)?.label ?? 'releases'} by '${artistResults.artist.name.display}'`,
        description: 'All releases have been added to the queue'
    });
}

export async function loadArtistResults(setArtistResults: React.Dispatch<React.SetStateAction<QobuzArtistResults | null>>): Promise<QobuzArtistResults | null> {
    return new Promise((resolve) => {
        setArtistResults((prev: QobuzArtistResults | null) => (resolve(prev), prev));
    });
}
