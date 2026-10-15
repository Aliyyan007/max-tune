import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { adapters, apiError, getContext, getSource } from '@/lib/platforms';
import { getCache } from '@/lib/cache';
import z from 'zod';

const albumInfoParamsSchema = z.object({
    album_id: z.string().min(1, 'ID is required')
});

const cache = getCache('album', 48 * 1024 * 1024, 10 * 60 * 1000);

export async function GET(request: NextRequest) {
    const source = getSource(request);
    const ctx = getContext(request);
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { album_id } = albumInfoParamsSchema.parse(params);
        const tokHash = crypto.createHash('sha1').update(JSON.stringify(ctx.tokens)).digest('hex').slice(0, 16);
        const data = await cache.wrap(`${source}:${album_id}:${ctx.country ?? ''}:${tokHash}`, () => adapters[source].getAlbumInfo(album_id, ctx));
        return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    } catch (error: any) {
        return apiError(error);
    }
}
