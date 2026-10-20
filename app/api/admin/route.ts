import { NextRequest, NextResponse } from 'next/server';
import { admin } from '@/lib/token-pool';
import { jobStats } from '@/lib/server-download';
import { apiError } from '@/lib/platforms';

export const runtime = 'nodejs';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'qobuz-dl';

// POST {password, action, ...payload}
// actions: stats | list | add | remove | toggle
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        if (body?.password !== ADMIN_PASSWORD) {
            return NextResponse.json({ success: false, error: 'invalid password' }, { status: 401 });
        }
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
            default:
                throw new Error(`unknown action ${action}`);
        }
        return NextResponse.json({ success: true, data });
    } catch (e: any) {
        return apiError(e);
    }
}
