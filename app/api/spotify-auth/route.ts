import { NextRequest } from 'next/server';
import { execFile } from 'child_process';
import path from 'path';
import z from 'zod';

// Two-step OAuth connect for real Spotify audio:
//   GET  -> { url }           the authorize link — send to the account owner, they click Agree
//   POST -> { url, ok, user } paste the dead 127.0.0.1 redirect URL they land on; exchanges the code and stores session creds

const loginScript = path.join(process.cwd(), 'tools', 'spotify-login.py');

function run(args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
        execFile('python', [loginScript, ...args], { timeout: 90000 }, (err, stdout, stderr) => {
            const line = (stdout ?? '').trim().split('\n').pop() ?? '';
            try {
                resolve(JSON.parse(line));
            } catch {
                reject(new Error(err?.message || stderr?.trim().slice(-300) || 'spotify-auth failed'));
            }
        });
    });
}

export async function GET() {
    try {
        const data = await run(['--start']);
        if (!data?.url) return Response.json({ success: false, error: data?.error ?? 'no url' }, { status: 500 });
        return Response.json({ success: true, data });
    } catch (e: any) {
        return Response.json({ success: false, error: e?.message ?? 'failed' }, { status: 500 });
    }
}

const bodySchema = z.object({ url: z.string().min(10) });

export async function POST(request: NextRequest) {
    try {
        const { url } = bodySchema.parse(await request.json());
        const data = await run(['--finish', url]);
        if (!data?.ok) return Response.json({ success: false, error: data?.error ?? 'exchange failed' }, { status: 400 });
        return Response.json({ success: true, data });
    } catch (e: any) {
        return Response.json({ success: false, error: e?.message ?? 'failed' }, { status: 500 });
    }
}
