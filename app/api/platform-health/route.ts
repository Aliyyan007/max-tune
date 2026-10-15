import { NextResponse } from 'next/server';
import { tokensFor } from '@/lib/token-pool';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';

// Public health probe — which platforms have working credentials server-side.
// Booleans only; token values never leave the server.
export async function GET() {
    const spotifySession =
        !!process.env.SPOTIFY_SESSION_JSON || fs.existsSync(path.join(process.cwd(), 'data', 'spotify-credentials.json')) ||
        fs.readdirSync(path.join(process.cwd(), 'data')).some((f) => f.startsWith('spotify-') && f.endsWith('.json'));
    const data = {
        qobuz: !!(process.env.QOBUZ_APP_ID && process.env.QOBUZ_SECRET),
        deezer: tokensFor('deezer', 'DEEZER_ARL').length > 0,
        tidal: tokensFor('tidal', 'TIDAL_ACCESS_TOKEN').length > 0,
        spotify: spotifySession || !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
        apple: tokensFor('apple', 'APPLE_MEDIA_USER_TOKEN').length > 0,
        amazon: tokensFor('amazon', 'AMAZON_MUSIC_TOKEN').length > 0 || !!process.env.AMAZON_SESSION_JSON
    };
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
}
