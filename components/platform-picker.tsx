'use client';
import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Music2Icon } from 'lucide-react';
import { PLATFORMS } from '@/lib/platforms/types';
import { usePlatform } from '@/lib/platform-provider';
import { cn } from '@/lib/utils';

const PlatformPicker = ({ className }: { className?: string }) => {
    const { platform, setPlatform } = usePlatform();
    const current = PLATFORMS.find((p) => p.id === platform) ?? PLATFORMS[0];
    // server-side credential health — which platforms can actually serve audio
    const [health, setHealth] = useState<Record<string, boolean>>({});
    useEffect(() => {
        fetch('/api/platform-health')
            .then((r) => r.json())
            .then((j) => j?.success && setHealth(j.data))
            .catch(() => {});
    }, []);

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant='outline'
                    className={cn('my-2 flex gap-2 focus-visible:outline-none focus-visible:ring-transparent select-none shadow-none outline-none !z-[99]', className)}
                >
                    <Music2Icon />
                    <span>{current.label}</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
                <DropdownMenuRadioGroup value={platform} onValueChange={(v) => setPlatform(v as typeof platform)}>
                    {PLATFORMS.map((p) => {
                        // live source = server reports credentials; else degrade to metadata-only
                        const live = health[p.id] !== false;
                        return (
                            <DropdownMenuRadioItem key={p.id} value={p.id} className='flex items-center justify-between gap-3'>
                                <span>{p.label}</span>
                                {!live && <span className='text-[10px] text-muted-foreground'>(unconfigured)</span>}
                            </DropdownMenuRadioItem>
                        );
                    })}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export default PlatformPicker;
