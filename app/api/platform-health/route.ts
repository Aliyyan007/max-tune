import { NextResponse } from 'next/server';
import { getSetting, tokensFor } from '@/lib/token-pool';
import { getTidalSession } from '@/lib/platforms/tidal';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';

async function wrapperProbe(url: string): Promise<{ up: boolean; regions?: string[]; detail: string }> {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10_000);
        const r = await fetch(`${url.replace(/\/$/, '')}/status`, { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(t);
        if (!r.ok) return { up: true, detail: `wrapper answered HTTP ${r.status}` };
        const j = await r.json().catch(() => null);
        const regions = j?.data?.regions ?? j?.regions;
        return { up: true, regions: Array.isArray(regions) ? regions : undefined, detail: 'wrapper reachable' };
    } catch (e: any) {
        return { up: false, detail: e?.name === 'AbortError' ? 'wrapper timeout' : 'wrapper unreachable' };
    }
}

async function wrapperSummary(raw: string): Promise<{ up: boolean; count: number; regions: string[]; detail: string }> {
    const urls = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8);
    if (!urls.length) return { up: false, count: 0, regions: [], detail: 'wrapper URL not configured' };
    const probes = await Promise.all(urls.map(wrapperProbe));
    const up = probes.filter((p) => p.up);
    return {
        up: up.length > 0,
        count: up.length,
        regions: [...new Set(up.flatMap((p) => p.regions ?? []))],
        detail: up.length ? `${up.length}/${urls.length} wrapper(s) reachable` : probes[0]?.detail ?? 'wrapper unreachable'
    };
}

// Public health probe — capability booleans plus non-secret diagnostic detail.
// Token values and wrapper hostnames never leave the server.
export async function GET() {
    const dataDir = path.join(process.cwd(), 'data');
    let files: string[] = [];
    try {
        files = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
    } catch {}

    const spotifySession = !!process.env.SPOTIFY_SESSION_JSON || files.some((f) => f.startsWith('spotify-') && f.endsWith('.json'));
    const spotifyMeta = !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
    const appleToken = tokensFor('apple', 'APPLE_MEDIA_USER_TOKEN').length > 0;
    const wrapperUrl = getSetting('appleWrapperUrl') || process.env.APPLE_WRAPPER_URL || 'http://127.0.0.1:12340';
    const wrapper = appleToken ? await wrapperSummary(wrapperUrl) : { up: false, count: 0, regions: [], detail: 'media user token missing' };

    const qobuzConfigured = !!(process.env.QOBUZ_APP_ID && process.env.QOBUZ_SECRET && process.env.QOBUZ_AUTH_TOKENS);
    const deezerConfigured = tokensFor('deezer', 'DEEZER_ARL').length > 0;
    const tidalConfigured = tokensFor('tidal', 'TIDAL_ACCESS_TOKEN').length > 0;
    let tidalReady = false;
    let tidalDetail = 'missing TIDAL_ACCESS_TOKEN or pool credential';
    if (tidalConfigured) {
        try {
            await getTidalSession({ tokens: {} });
            tidalReady = true;
            tidalDetail = 'session validated; full audio depends on account entitlement/region';
        } catch (e: any) {
            tidalDetail = String(e?.message ?? 'Tidal session invalid').slice(0, 180);
        }
    }
    const amazonConfigured = tokensFor('amazon', 'AMAZON_MUSIC_TOKEN').length > 0 || !!process.env.AMAZON_SESSION_JSON || files.includes('amazon-session.json');

    const details = {
        qobuz: {
            configured: qobuzConfigured,
            ready: qobuzConfigured,
            detail: qobuzConfigured ? 'app credentials and auth token pool configured' : 'missing QOBUZ_APP_ID/QOBUZ_SECRET/QOBUZ_AUTH_TOKENS'
        },
        deezer: {
            configured: deezerConfigured,
            ready: deezerConfigured,
            detail: deezerConfigured ? 'ARL configured; free-tier accounts are limited to Deezer-authorized formats' : 'missing DEEZER_ARL or pool credential'
        },
        tidal: {
            configured: tidalConfigured,
            ready: tidalReady,
            detail: tidalDetail
        },
        spotify: {
            configured: spotifySession || spotifyMeta,
            ready: spotifySession,
            metadataReady: spotifyMeta || spotifySession,
            detail: spotifySession ? 'native session present; full audio depends on the connected account' : spotifyMeta ? 'metadata credentials only — full audio requires OAuth/native session' : 'missing Spotify session/client credentials'
        },
        apple: {
            configured: appleToken,
            ready: appleToken && wrapper.up,
            wrapperCount: wrapper.count,
            regions: wrapper.regions,
            detail: !appleToken ? 'missing APPLE_MEDIA_USER_TOKEN or pool credential' : wrapper.detail
        },
        amazon: {
            configured: amazonConfigured,
            ready: amazonConfigured && !!(process.env.AMAZON_DEVICE_WVD_B64 || files.some((f) => f.endsWith('.wvd'))),
            detail: amazonConfigured ? 'session/token configured; full audio depends on entitlement and Widevine device keys' : 'missing AMAZON_MUSIC_TOKEN/session'
        }
    };
    const data = Object.fromEntries(Object.entries(details).map(([k, v]) => [k, v.ready])) as Record<string, boolean>;
    return NextResponse.json({ success: true, data: { ...data, details } }, { headers: { 'Cache-Control': 'no-store' } });
}
