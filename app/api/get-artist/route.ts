import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { adapters, apiError, getContext, getSource } from '@/lib/platforms';
import { getCache } from '@/lib/cache';
import z from 'zod';

const cache = getCache('artist', 32 * 1024 * 1024, 10 * 60 * 1000);

const artistReleasesParamsSchema = z.object({
    artist_id: z.string().min(1, 'ID is required'),
    artist_name: z.string().optional()
});

export async function GET(request: NextRequest) {
    const source = getSource(request);
    const ctx = getContext(request);
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { artist_id, artist_name } = artistReleasesParamsSchema.parse(params);
        const tokHash = crypto.createHash('sha1').update(JSON.stringify(ctx.tokens)).digest('hex').slice(0, 16);
        const data = await cache.wrap(`${source}:${artist_id}:${ctx.country ?? ''}:${tokHash}`, () => adapters[source].getArtist(artist_id, ctx, artist_name));
        // adapters return {artist} normalized; qobuz returns the raw page object which the route wraps
        const artist = data?.artist ? data : { artist: data };
        return new Response(JSON.stringify({ success: true, data: artist }), { status: 200 });
    } catch (error: any) {
        return apiError(error);
    }
}
