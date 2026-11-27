'use client';

export type RecentDownload = {
    key: string;
    source: string;
    trackId: string;
    title: string;
    artist: string;
    album?: string;
    artUrl?: string;
    ext?: string;
    duration?: number;
    size?: number;
    isPreview?: boolean;
    downloadedAt: number;
};

const STORAGE_KEY = 'recent-downloads-v1';
const EVENT_NAME = 'recent-downloads-changed';
const MAX_ITEMS = 20;

export function listRecentDownloads(): RecentDownload[] {
    if (typeof window === 'undefined') return [];
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x === 'object').slice(0, MAX_ITEMS) : [];
    } catch {
        return [];
    }
}

export function addRecentDownload(item: RecentDownload): void {
    if (typeof window === 'undefined') return;
    const next = [item, ...listRecentDownloads().filter((x) => x.key !== item.key)].slice(0, MAX_ITEMS);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        window.dispatchEvent(new CustomEvent(EVENT_NAME));
    } catch {}
}

export function clearRecentDownloads(): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function recentDownloadsEventName() {
    return EVENT_NAME;
}
