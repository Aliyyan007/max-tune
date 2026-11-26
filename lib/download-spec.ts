// Request-boundary validation for download payloads. Provider adapters trust
// these objects deeply (child-process arguments, file names, metadata writes),
// so shape and size limits are enforced before a job is accepted.
import { z } from 'zod';
import type { DownloadSpec } from './server-download';
import type { AlbumZipSpec } from './album-zip-produce';

const source = z.enum(['qobuz', 'deezer', 'tidal', 'spotify', 'apple', 'amazon', 'apple-preview', 'spotify-native', 'apple-native', 'amazon-native']);
const platformSource = z.enum(['qobuz', 'deezer', 'tidal', 'spotify', 'apple', 'amazon']);
const quality = z.enum(['27', '7', '6', '5']).default('27');
const codec = z.enum(['SOURCE', 'FLAC', 'WAV', 'ALAC', 'MP3', 'AAC', 'OGG', 'OPUS']).default('SOURCE');
const shortString = (max = 500) => z.string().trim().min(1).max(max);
const optionalString = (max = 500) => z.string().trim().max(max).optional();
const tokens = z
    .record(z.string().trim().max(8192))
    .refine((obj) => Object.keys(obj).length <= 32 && Object.values(obj).reduce((n, v) => n + v.length, 0) <= 48 * 1024, 'too many or oversized service tokens')
    .optional();
const positiveInt = z.number().int().positive().max(100000).optional();

export const downloadSpecSchema = z.object({
    source,
    id: z.string().trim().min(1).max(256),
    quality,
    title: shortString(700),
    artist: shortString(700),
    album: shortString(700),
    trackNum: positiveInt,
    totalTracks: positiveInt,
    discNum: positiveInt,
    genre: optionalString(300),
    date: optionalString(100),
    year: optionalString(20),
    label: optionalString(300),
    copyright: optionalString(500),
    isrc: optionalString(40),
    upc: optionalString(40),
    artUrl: z.string().trim().min(1).max(4096).refine((s) => s.startsWith('/') || /^https?:\/\//i.test(s), 'artUrl must be an absolute http(s) URL or app-relative proxy path').optional(),
    filename: z.string().trim().min(1).max(240),
    applyMeta: z.boolean().default(true),
    codec,
    bitrate: z.number().int().positive().max(2000).optional(),
    tokens,
    country: z.string().trim().regex(/^[a-zA-Z]{2}$/).optional(),
    duration: z.number().positive().max(24 * 3600).optional()
});

export const albumZipSpecSchema = z.object({
    albumId: z.string().trim().min(1).max(256),
    source: platformSource,
    quality,
    codec,
    bitrate: z.number().int().positive().max(2000).optional(),
    applyMeta: z.boolean().default(true),
    tokens,
    country: z.string().trim().regex(/^[a-zA-Z]{2}$/).optional(),
    zipName: z.string().trim().min(1).max(240),
    trackNamePattern: z.string().trim().max(240).optional()
});

// Provider metadata often uses JSON null for genuinely absent fields (Spotify
// rows are a common case). Null means "absent" here, not an invalid string, so
// normalize it to an omitted key before validation.
function withoutNulls(value: any): any {
    if (Array.isArray(value)) return value.map(withoutNulls);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, withoutNulls(v)]));
    }
    return value;
}

export function parseDownloadSpec(input: unknown): DownloadSpec {
    const r = downloadSpecSchema.safeParse(withoutNulls(input));
    if (!r.success) throw new Error(`invalid download spec: ${r.error.issues[0]?.message ?? 'bad request'}`);
    return r.data as DownloadSpec;
}

export function parseAlbumZipSpec(input: unknown): AlbumZipSpec {
    const r = albumZipSpecSchema.safeParse(withoutNulls(input));
    if (!r.success) throw new Error(`invalid zip spec: ${r.error.issues[0]?.message ?? 'bad request'}`);
    return r.data as AlbumZipSpec;
}
