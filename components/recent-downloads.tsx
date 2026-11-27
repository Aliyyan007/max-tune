'use client';

import React, { useEffect, useState } from 'react';
import { Clock3Icon, Music2Icon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PLATFORMS } from '@/lib/platforms/types';
import { clearRecentDownloads, listRecentDownloads, recentDownloadsEventName, type RecentDownload } from '@/lib/recent-downloads';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/qobuz-dl';

const PLATFORM_STYLES: Record<string, string> = {
    qobuz: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
    deezer: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
    tidal: 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20',
    spotify: 'bg-green-500/10 text-green-500 border-green-500/20',
    apple: 'bg-pink-500/10 text-pink-500 border-pink-500/20',
    amazon: 'bg-orange-500/10 text-orange-500 border-orange-500/20'
};

function platformLabel(source: string) {
    return PLATFORMS.find((p) => p.id === source)?.label ?? source;
}

function timeAgo(ts: number) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

export default function RecentDownloads() {
    const [items, setItems] = useState<RecentDownload[]>([]);

    useEffect(() => {
        const load = () => setItems(listRecentDownloads());
        load();
        window.addEventListener(recentDownloadsEventName(), load);
        window.addEventListener('storage', load);
        return () => {
            window.removeEventListener(recentDownloadsEventName(), load);
            window.removeEventListener('storage', load);
        };
    }, []);

    if (!items.length) return null;

    return (
        <section className='w-full max-w-[1100px] mx-auto px-4 pt-4 pb-24'>
            <div className='flex items-center justify-between gap-3 mb-3'>
                <div className='flex items-center gap-2'>
                    <Clock3Icon className='size-4 text-muted-foreground' />
                    <h2 className='text-lg font-bold'>Recently downloaded</h2>
                    <span className='text-xs text-muted-foreground'>{items.length} item{items.length === 1 ? '' : 's'}</span>
                </div>
                <Button variant='ghost' size='sm' className='text-muted-foreground' onClick={clearRecentDownloads}>
                    <Trash2Icon className='size-4' />
                    Clear
                </Button>
            </div>
            <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3'>
                {items.map((item) => (
                    <div key={`${item.key}-${item.downloadedAt}`} className='group border rounded-lg p-3 bg-background/70 backdrop-blur-sm flex gap-3 overflow-hidden hover:bg-accent/40 transition-colors'>
                        <div className='relative size-14 shrink-0 rounded-md overflow-hidden bg-secondary flex items-center justify-center'>
                            {item.artUrl ? (
                                <img src={item.artUrl} alt={item.title} crossOrigin='anonymous' className='absolute inset-0 size-full object-cover' />
                            ) : (
                                <Music2Icon className='size-5 text-muted-foreground' />
                            )}
                        </div>
                        <div className='min-w-0 flex-1 space-y-1'>
                            <p className='font-semibold text-sm truncate' title={item.title}>{item.title}</p>
                            <p className='text-xs text-muted-foreground truncate' title={item.artist}>{item.artist}</p>
                            <div className='flex items-center gap-1.5 flex-wrap'>
                                <span className={cn('text-[10px] font-semibold border rounded-full px-1.5 py-0.5', PLATFORM_STYLES[item.source] ?? 'bg-secondary text-muted-foreground')}>
                                    {platformLabel(item.source)}
                                </span>
                                {item.ext && <span className='text-[10px] uppercase text-muted-foreground font-semibold'>{item.ext}</span>}
                                {item.isPreview && <span className='text-[10px] font-semibold text-amber-500'>Preview</span>}
                                {item.duration ? <span className='text-[10px] text-muted-foreground'>{formatDuration(item.duration)}</span> : null}
                            </div>
                            <p className='text-[10px] text-muted-foreground'>{timeAgo(item.downloadedAt)}</p>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
