import { NextRequest, NextResponse } from 'next/server';
import { admin } from '@/lib/token-pool';
import { jobStats } from '@/lib/server-download';
import { apiError } from '@/lib/platforms';
import { clientIp, rateLimit, rateLimitReset } from '@/lib/rate-limit';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';

// Production hardening: there is intentionally no implicit admin password. A
// deployment without ADMIN_PASSWORD has the panel disabled rather than being
// one default credential away from credential-pool compromise.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';

function passwordEquals(a: string, b: string): boolean {
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// POST {password, action, ...payload}
// actions: stats | list | add | remove | toggle
export async function POST(request: NextRequest) {
    try {
        if (!ADMIN_PASSWORD) {
            return NextResponse.json({ success: false, error: 'admin panel disabled — configure ADMIN_PASSWORD' }, { status: 503 });
        }
        const ip = clientIp(request.headers);
        const rlKey = `admin:${ip}`;
        if (!(await rateLimit(rlKey, 8, 600))) {
            return NextResponse.json({ success: false, error: 'too many admin attempts' }, { status: 429 });
        }
        const body = await request.json();
        if (!passwordEquals(String(body?.password ?? ''), ADMIN_PASSWORD)) {
            return NextResponse.json({ success: false, error: 'invalid password' }, { status: 401 });
        }
        await rateLimitReset(rlKey);
        const { action, platform, token, label, disabled, key, value } = body ?? {};
        let data: any;
        switch (action) {
            case 'stats':
                data = { stats: admin.stats(jobStats()), tokens: admin.list() };
                break;
            case 'list':
                data = { tokens: admin.list() };
                break;
            case 'add':
                if (!platform || !token) throw new Error('platform + token required');
                data = admin.add(String(platform), String(token).trim(), label ? String(label) : undefined);
                break;
            case 'remove':
                if (!platform || !token) throw new Error('platform + token required');
                data = admin.remove(String(platform), String(token));
                break;
            case 'toggle':
                if (!platform || !token) throw new Error('platform + token required');
                data = admin.toggle(String(platform), String(token), !!disabled);
                break;
            case 'set-setting':
                if (!key || value === undefined) throw new Error('key + value required');
                data = admin.setSetting(String(key), String(value));
                break;
            case 'tidal-connect-start': {
                const { tidalDeviceStart } = await import('@/lib/platforms/tidal');
                data = await tidalDeviceStart();
                break;
            }
            case 'tidal-connect-poll': {
                if (!body?.deviceCode) throw new Error('deviceCode required');
                const { tidalDevicePoll } = await import('@/lib/platforms/tidal');
                const r = await tidalDevicePoll(String(body.deviceCode));
                data = { status: r.status, connected: r.status === 'done' };
                break;
            }
            case 'import-amazon-session': {
                const raw = body?.session ?? value;
                if (!raw) throw new Error('session required');
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                const cookies = parsed?.website_cookies;
                if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies) || !Object.keys(cookies).length) {
                    throw new Error('amazon session must include website_cookies');
                }
                const serialized = JSON.stringify(parsed, null, 2);
                const dir = path.join(process.cwd(), 'data');
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, 'amazon-session.json'), serialized, { mode: 0o600 });
                const { kvSet } = await import('@/lib/queue');
                await kvSet('session:amazon', serialized);
                data = {
                    imported: true,
                    websiteCookies: true,
                    mobileLicenseMaterial: !!(parsed.adp_token && parsed.device_private_key_pem)
                };
                break;
            }
            default:
                throw new Error(`unknown action ${action}`);
        }
        return NextResponse.json({ success: true, data });
    } catch (e: any) {
        return apiError(e);
    }
}
