import axios, { AxiosError } from 'axios';
import { FFmpegType } from './ffmpeg-functions';
import { artistReleaseCategories } from '@/components/artist-dialog';
import { formatCustomTitle } from './utils';
import { createJob } from './status-bar/jobs';
import { Disc3Icon, DiscAlbumIcon } from 'lucide-react';
import { FetchedQobuzAlbum, formatArtists, formatTitle, QobuzAlbum, QobuzArtistResults, QobuzTrack } from './qobuz-dl';
import { serviceHeaders, getServiceTokens } from './service-tokens';
import { outputFor, SettingsProps } from './settings-provider';
import { StatusBarProps } from '@/components/status-bar/status-bar';
import { ToastAction } from '@/components/ui/toast';

const sourceOf = (obj: any): string => obj?.source ?? 'qobuz';

// pull the server's {error:"..."} message out of a failed axios call instead of "Request failed with status code N"
const errDesc = (e: any): string => {
    const data = (e as AxiosError)?.response?.data;
    if (data && typeof data === 'object' && 'error' in data) return String((data as any).error);
    return e instanceof Error ? e.message : 'An unknown error occurred';
};

const fmtMB = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

type Stage = 'queued' | 'resolving' | 'downloading' | 'processing' | 'sending' | 'done' | 'error';
const STAGE_TEXT: Record<Stage, string> = {
    queued: 'Queued…',
    resolving: 'Resolving source…',
    downloading: 'Fetching audio…',
    processing: 'Tagging & embedding artwork…',
    sending: 'Pushing to browser…',
    done: 'Done — check your downloads',
    error: 'Failed'
};

// Poll /api/job-status while the server produces the file so the status bar
// tracks real stages — resolving, fetching, tagging, pushing — with byte counts.
// Resolves true when done, false on error/cancel.
function watchJob(jobId: string, setStatusBar: React.Dispatch<React.SetStateAction<StatusBarProps>>, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
        let lastStage = '';
        const poll = async () => {
            if (signal.aborted) return resolve(false);
            try {
                const res = await axios.get('/api/job-status', { params: { id: jobId }, signal });
                const p = res.data?.data;
                if (!p) return resolve(false); // aged out — Chrome already has it
                if (p.stage !== lastStage || p.stage === 'downloading' || p.stage === 'sending') {
                    lastStage = p.stage;
                    let desc = STAGE_TEXT[p.stage as Stage] ?? p.stage;
                    if (p.label) desc = p.label;
                    else if (p.stage === 'downloading' && p.received) desc = `Fetching audio — ${fmtMB(p.received)}${p.total ? ` of ${fmtMB(p.total)}` : ''}`;
                    else if (p.stage === 'sending' && p.sent) desc = `Pushing to browser — ${fmtMB(p.sent)}${p.total ? ` of ${fmtMB(p.total)}` : ''}`;
                    // progress: downloaded share (0-70) + sent share pushes to 95+
                    let pct = 5;
                    if (p.stage === 'resolving') pct = 12;
                    else if (p.stage === 'downloading') pct = p.total ? 15 + Math.round((70 * p.received) / p.total) : Math.min(70, 15 + Math.round(p.received / 524288));
                    else if (p.stage === 'processing') pct = 85;
                    else if (p.stage === 'sending') pct = p.total ? 70 + Math.round((25 * p.sent) / Math.max(p.total, p.sent)) : 92;
                    else if (p.stage === 'done') pct = 100;
                    setStatusBar((prev) => ({ ...prev, progress: Math.min(pct, 100), description: desc }));
                }
                if (p.stage === 'done') return resolve(true);
                if (p.stage === 'error') {
                    setStatusBar((prev) => ({ ...prev, description: p.error ?? 'Download failed' }));
                    return resolve(false);
                }
            } catch {}
            setTimeout(poll, 350);
        };
        poll();
    });
}

// For non-qobuz platforms the album object bundled with a search result is sparse —
// fetch the full album so tags (genre/label/upc/date) are complete.
async function enrichAlbum(result: QobuzTrack, country: string | undefined, signal?: AbortSignal) {
    const album = (result as any).album;
    if (!album || album.full || sourceOf(result) === 'qobuz' || !album.id) return;
    try {
        const res = await axios.get('/api/get-album', {
            params: { album_id: album.id, source: sourceOf(result) },
            headers: { 'Token-Country': country, ...serviceHeaders() },
            signal
        });
        if (res.data?.data) {
            const full = res.data.data;
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
}

export const createDownloadJob = async (
    result: QobuzAlbum | QobuzTrack,
    setStatusBar: React.Dispatch<React.SetStateAction<StatusBarProps>>,
    ffmpegState: FFmpegType,
    settings: SettingsProps,
    toast: (toast: any) => void,
    fetchedAlbumData?: FetchedQobuzAlbum | null,
    setFetchedAlbumData?: React.Dispatch<React.SetStateAction<FetchedQobuzAlbum | null>>,
    country?: string
) => {
    if ((result as QobuzTrack).album) {
        const formattedTitle = formatCustomTitle(settings.trackName, result as QobuzTrack);
        await createJob(setStatusBar, formattedTitle, Disc3Icon, async () => {
            return new Promise(async (resolve) => {
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
                    await enrichAlbum(result as QobuzTrack, country, signal);
                    const track = result as QobuzTrack;
                    const album = track.album as any;
                    const spec = {
                        source,
                        id: String(track.id),
                        quality: eff.outputQuality,
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
                        tokens: getServiceTokens(),
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
                    // Chrome owns the transfer — the status bar mirrors server progress
                    // (resolve → fetch → tag → push) so the wait is visible, not silent.
                    const a = document.createElement('a');
                    a.href = `/api/download-file?job=${job}`;
                    a.download = formattedTitle;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    await watchJob(job, setStatusBar, signal);
                    resolve();
                } catch (e) {
                    if (e instanceof AxiosError && e.code === 'ERR_CANCELED') resolve();
                    else {
                        toast({
                            title: 'Error',
                            description: errDesc(e),
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
        });
    } else {
        const formattedZipTitle = formatCustomTitle(settings.zipName, result as QobuzAlbum);

        await createJob(setStatusBar, formattedZipTitle, DiscAlbumIcon, async () => {
            return new Promise(async (resolve) => {
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
                            quality: eff.outputQuality,
                            codec: eff.outputCodec,
                            bitrate: eff.bitrate,
                            applyMeta: settings.applyMetadata,
                            tokens: getServiceTokens(),
                            country,
                            zipName: formattedZipTitle,
                            trackNamePattern: settings.trackName
                        },
                        { signal }
                    );
                    const job = res.data?.data?.job;
                    if (!job) throw new Error('zip job not created');
                    jobId = job;
                    const a = document.createElement('a');
                    a.href = `/api/album-zip?job=${job}`;
                    a.download = formattedZipTitle + '.zip';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    // mirror server progress — per-track "Track 3/12 — Name" labels
                    await watchJob(job, setStatusBar, signal);
                    resolve();
                } catch (e) {
                    if (e instanceof AxiosError && e.code === 'ERR_CANCELED') resolve();
                    else {
                        toast({
                            title: 'Error',
                            description: errDesc(e),
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
    ffmpegState: FFmpegType,
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
            await createDownloadJob(release, setStatusBar, ffmpegState, settings, toast, undefined, undefined, country);
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
