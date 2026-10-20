import { NextRequest } from 'next/server';
import { adapters, apiError, getContext, getSource } from '@/lib/platforms';
import z from 'zod';

// Downloads always resolve the platform's maximum quality tier — there is no
// user-selectable quality setting.
const MAX_QUALITY = '27' as const;

const downloadParamsSchema = z.object({
    track_id: z.string().min(1),
    title: z.string().optional(),
    artist: z.string().optional(),
    dur: z.string().optional()
});

export async function GET(request: NextRequest) {
    const source = getSource(request);
    const ctx = getContext(request);
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { track_id, title, artist, dur } = downloadParamsSchema.parse(params);
        const hint = title ? { title, artist, duration: dur ? parseInt(dur) : undefined } : undefined;
        const data = await adapters[source].getDownloadURL(track_id, MAX_QUALITY, ctx, hint);
        return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    } catch (error: any) {
        return apiError(error);
    }
}
