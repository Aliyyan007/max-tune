import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { adapters, apiError, getContext, getSource } from '@/lib/platforms';
import { getCache } from '@/lib/cache';
import z from 'zod';

const cache = getCache('releases', 32 * 1024 * 1024, 10 * 60 * 1000);

const toInt = (fallback: number) => (a: unknown) => {
    const n = parseInt(String(a ?? ''), 10);
    return Number.isNaN(n) ? fallback : n;
};

const releasesParamsSchema = z.object({
    artist_id: z.string().min(1, 'ID is required'),
    release_type: z.enum(['album', 'live', 'compilation', 'epSingle', 'download']).default('album'),
    artist_name: z.string().optional(),
    track_size: z.preprocess(toInt(1000), z.number().positive().default(1000)),
    offset: z.preprocess(toInt(0), z.number().min(0).default(0)),
    limit: z.preprocess(toInt(10), z.number().positive().default(10))
});

export async function GET(request: NextRequest) {
    const source = getSource(request);
    const ctx = getContext(request);
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { artist_id, release_type, offset, limit, artist_name } = releasesParamsSchema.parse(params);
        const tokHash = crypto.createHash('sha1').update(JSON.stringify(ctx.tokens)).digest('hex').slice(0, 16);
        const data = await cache.wrap(`${source}:${artist_id}:${release_type}:${offset}:${limit}:${ctx.country ?? ''}:${tokHash}`, () => adapters[source].getArtistReleases(artist_id, release_type, limit, offset, ctx, artist_name));
        return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    } catch (error: any) {
        return apiError(error);
    }
}
