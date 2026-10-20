import { NextResponse } from 'next/server';
import { getSetting, tokensFor } from '@/lib/token-pool';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';

// wrapper-lite reachability probe — any HTTP response means the service is up
async function wrapperUp(url: string): Promise<boolean> {
    try {
        const ctrl = new AbortController();
        // TCG-loaded wrappers take >10s to answer /status — give it room so a
        // slow-but-alive wrapper doesn't read as "unconfigured" in the picker.
        const t = setTimeout(() => ctrl.abort(), 15000);
        await fetch(`${url.replace(/\/$/, '')}/m3u8?adamId=0`, { signal: ctrl.signal });
        clearTimeout(t);
        return true;
    } catch (e: any) {
        // ECONNREFUSED/abort = down; an HTTP error response = still "up"
        return e?.name === 'AbortError' ? false : !!e?.status;
    }
}

// Public health probe — which platforms have working credentials server-side.
// Booleans only; token values never leave the server.
export async function GET() {
    const dataDir = path.join(process.cwd(), 'data');
    let files: string[] = [];
    try {
        files = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
    } catch {}
    const spotifySession =
        !!process.env.SPOTIFY_SESSION_JSON || files.some((f) => f.startsWith('spotify-') && f.endsWith('.json'));
    const appleToken = tokensFor('apple', 'APPLE_MEDIA_USER_TOKEN').length > 0;
    // apple counts as healthy only when the decryption service answers — a bare
    // media token alone still gets the preview fallback
    const wrapperUrl = getSetting('appleWrapperUrl') || process.env.APPLE_WRAPPER_URL || 'http://127.0.0.1:12340';
    const apple = appleToken && (await wrapperUp(wrapperUrl));
    const data = {
        qobuz: !!(process.env.QOBUZ_APP_ID && process.env.QOBUZ_SECRET),
        deezer: tokensFor('deezer', 'DEEZER_ARL').length > 0,
        tidal: tokensFor('tidal', 'TIDAL_ACCESS_TOKEN').length > 0,
        spotify: spotifySession || !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
        apple,
        amazon: tokensFor('amazon', 'AMAZON_MUSIC_TOKEN').length > 0 || !!process.env.AMAZON_SESSION_JSON || files.includes('amazon-session.json')
    };
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
}
