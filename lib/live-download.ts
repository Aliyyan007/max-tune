import crypto from 'crypto';

// Direct-worker artifact fast lane. The token is derived from the shared job
// encryption secret rather than stored in Redis, so web and worker independently
// agree on it without exposing it in public job-status responses.
export function workerPublicBase(): string {
    const explicit = (process.env.WORKER_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
    if (explicit) return explicit;
    if (process.env.NODE_ENV !== 'production') return `http://127.0.0.1:${process.env.WORKER_PORT ?? 3101}`;
    return '';
}

export function liveDownloadsEnabled(): boolean {
    return process.env.LIVE_DOWNLOADS !== '0' && !!process.env.JOB_PAYLOAD_ENCRYPTION_KEY && !!workerPublicBase();
}

export function liveTokenForJob(jobId: string): string {
    const secret = process.env.JOB_PAYLOAD_ENCRYPTION_KEY;
    if (!secret) return '';
    return crypto.createHmac('sha256', secret).update(`live-download:${jobId}`).digest('hex');
}

export function liveUrlForJob(jobId: string): string | null {
    if (!liveDownloadsEnabled()) return null;
    return `${workerPublicBase()}/live/${jobId}?token=${liveTokenForJob(jobId)}`;
}

export function validLiveToken(jobId: string, token: string): boolean {
    const expected = liveTokenForJob(jobId);
    if (!expected || !token) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(String(token));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
