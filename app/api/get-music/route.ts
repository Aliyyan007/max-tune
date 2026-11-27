import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { adapters, apiError, getContext, getSource } from '@/lib/platforms';
import { getCache } from '@/lib/cache';
import z from 'zod';

const searchParamsSchema = z.object({
    q: z.string().min(1, 'Query is required'),
    offset: z.preprocess(
        (a) => (a === undefined || a === null || a === '' ? 0 : parseInt(a as string)),
        z.number().max(1000, 'Offset must be less than 1000').min(0, 'Offset must be 0 or greater').default(0)
    ),
    limit: z.preprocess(
        (a) => (a === undefined || a === null || a === '' ? 10 : parseInt(a as string)),
        z.number().max(20, 'Limit must be 20 or less').min(1, 'Limit must be at least 1').default(10)
    )
});

const cache = getCache('search', 48 * 1024 * 1024, 3 * 60 * 1000);

export async function GET(request: NextRequest) {
    const source = getSource(request);
    const ctx = getContext(request);
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { q, offset, limit } = searchParamsSchema.parse(params);
        // tokens change what a search returns (account tier/region) — key on their hash
        const tokHash = crypto.createHash('sha1').update(JSON.stringify(ctx.tokens)).digest('hex').slice(0, 16);
        const light = params.light === '1' || params.light === 'true';
        const key = `${source}:${q.toLowerCase().trim()}:${offset}:${limit}:${light ? 'light' : 'full'}:${ctx.country ?? ''}:${tokHash}`;
        const searchResults = await cache.wrap(key, () => adapters[source].search(q, limit, offset, ctx, light));
        return new Response(JSON.stringify({ success: true, data: searchResults }), { status: 200 });
    } catch (error: any) {
        return apiError(error);
    }
}
