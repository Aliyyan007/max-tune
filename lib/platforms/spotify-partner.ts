import axios from 'axios';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Spotify Web Player auth — the SAME anonymous session open.spotify.com uses.
// Dev-app `client_credentials` gets hours-long 429 cooldowns from Spotify;
// the anonymous web token refreshes hourly and is dramatically more generous.
// Flow (mirrors the web player + votify):
//   1. fetch TOTP secret dict (rotates — pulled live, cached in-memory)
//   2. derive the secret: join(byte ^ ((i%33)+9)) as a decimal string
//   3. HMAC-SHA1 the server-time counter → 6-digit TOTP
//   4. GET /api/token?totp=… → anonymous accessToken (~1h)
// The bearer then works on api.spotify.com AND api-partner.spotify.com
// (pathfinder GraphQL — where genres still live).
// ---------------------------------------------------------------------------

const SESSION_TOKEN_URL = 'https://open.spotify.com/api/token';
const SERVER_TIME_URL = 'https://open.spotify.com/api/server-time';
const PATHFINDER = 'https://api-partner.spotify.com/pathfinder/v2/query';
const TOTP_SECRETS_URL = 'https://git.gay/thereallo/totp-secrets/raw/branch/main/secrets/secretDict.json';
const CLIENT_VERSION = '1.2.87.27.ga2033a72';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

let totpCache: { version: string; secret: Buffer; at: number } | null = null;

async function getTotp(): Promise<{ version: string; secret: Buffer }> {
    if (totpCache && Date.now() - totpCache.at < 12 * 60 * 60 * 1000) return totpCache;
    const res = await axios.get(TOTP_SECRETS_URL, { timeout: 10000 });
    const secrets = res.data ?? {};
    const version = Object.keys(secrets).sort((a, b) => Number(a) - Number(b)).pop();
    if (!version) throw new Error('TOTP secret dict empty');
    const cipher = secrets[version] as number[];
    // votify derive(): "".join(str(byte ^ ((i % 33) + 9))) — the secret is the
    // ASCII string of those decimal numbers, not the raw bytes
    const secret = Buffer.from(cipher.map((b, i) => String(b ^ ((i % 33) + 9))).join(''), 'ascii');
    totpCache = { version, secret, at: Date.now() };
    return totpCache;
}

function generateTotp(secret: Buffer, timestampMs: number): string {
    const counter = Math.floor(timestampMs / 1000 / 30);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const h = crypto.createHmac('sha1', secret).update(buf).digest();
    const off = h[h.length - 1] & 0x0f;
    const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
    return String(bin % 1e6).padStart(6, '0');
}

let webToken: { token: string; expiresAt: number } | null = null;
let webTokenPending: Promise<string> | null = null;

export async function getWebPlayerToken(): Promise<string> {
    if (webToken && webToken.expiresAt > Date.now() + 60_000) return webToken.token;
    webTokenPending ??= (async () => {
        const { version, secret } = await getTotp();
        // server time — Spotify rejects TOTPs minted against a skewed local clock
        const st = await axios.get(SERVER_TIME_URL, { headers: { 'User-Agent': UA, Referer: 'https://open.spotify.com/' }, timeout: 10000 });
        const serverMs = Number(st.data?.serverTime ?? 0) * 1000 || Date.now();
        const totp = generateTotp(secret, serverMs);
        const res = await axios.get(SESSION_TOKEN_URL, {
            params: { reason: 'init', productType: 'web-player', totp, totpServer: totp, totpVer: version },
            headers: { 'User-Agent': UA, Referer: 'https://open.spotify.com/' },
            timeout: 10000
        });
        const token = res.data?.accessToken;
        if (!token) throw new Error('anonymous session token missing');
        webToken = { token, expiresAt: res.data.accessTokenExpirationTimestampMs ?? Date.now() + 3300_000 };
        webTokenPending = null;
        return token;
    })().catch((e) => {
        webTokenPending = null;
        throw e;
    });
    return webTokenPending;
}

// Persisted-query hashes from Spotify's web bundle — they rotate every few
// weeks/months; a 4xx makes callers fall back to the Web API path. All verified
// live (2025-10).
export const PF_HASH = {
    searchDesktop: '75bbf6bfcfdf85b8fc828417bfad92b7cd66bf7f556d85670f4da8292373ebec',
    getAlbum: 'b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10',
    getTrack: '612585ae06ba435ad26369870deaae23b5c8800a256cd8a57e08eddc25a37294',
    queryArtistOverview: '5b9e64f43843fa3a9b6a98543600299b0a2cbbbccfdcdcef2402eb9c1017ca4c',
    queryArtistDiscography: '4257bb9c1e5eaa6adb95092514dd09a35559f6ad0e284bed5e13547d342490aa',
    queryArtistDiscographyAlbums: '983072ae655f5de212747a41be0d7c4cc49559aa9fe8e32836369b6f130cac33'
};

// A rotated/dead op hash trips this flag once — subsequent calls skip straight
// to the Web API fallback instead of re-probing a dead hash every request.
const deadOps = new Set<string>();
export function pfOpDead(op: string): boolean {
    return deadOps.has(op);
}
export function markPfOpDead(op: string) {
    deadOps.add(op);
}

export async function pathfinder(operationName: string, sha256Hash: string, variables: Record<string, any>): Promise<any> {
    const token = await getWebPlayerToken();
    const res = await axios.post(
        PATHFINDER,
        { variables, operationName, extensions: { persistedQuery: { version: 1, sha256Hash } } },
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'User-Agent': UA,
                'app-platform': 'WebPlayer',
                'spotify-app-version': CLIENT_VERSION,
                Origin: 'https://open.spotify.com',
                Referer: 'https://open.spotify.com/'
            },
            timeout: 15000
        }
    );
    // Federation returns partial errors alongside populated data — only fail
    // when there's no data payload at all; tolerate entity-level blips.
    const errs = res.data?.errors;
    if (Array.isArray(errs) && errs.length && !res.data?.data) {
        if (JSON.stringify(errs).match(/query hash|persisted|Unknown operation/i)) markPfOpDead(operationName);
        throw new Error(errs[0]?.message ?? 'pathfinder error');
    }
    return res.data;
}
