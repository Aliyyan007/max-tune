'use client';
import React from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Music2Icon } from 'lucide-react';
import { PLATFORMS } from '@/lib/platforms/types';
import { usePlatform } from '@/lib/platform-provider';
import { getServiceTokens } from '@/lib/service-tokens';
import { cn } from '@/lib/utils';

const PlatformPicker = ({ className }: { className?: string }) => {
    const { platform, setPlatform } = usePlatform();
    const current = PLATFORMS.find((p) => p.id === platform) ?? PLATFORMS[0];
    const tokens = typeof window !== 'undefined' ? getServiceTokens() : {};

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
                        const needs = p.needsToken;
                        const missing = needs ? (Array.isArray(needs) ? !needs.some((k) => tokens[k as keyof typeof tokens]) : !tokens[needs as keyof typeof tokens]) : false;
                        return (
                            <DropdownMenuRadioItem key={p.id} value={p.id} className='flex items-center justify-between gap-3'>
                                <span>{p.label}</span>
                                {missing && <span className='text-[10px] text-muted-foreground' title='Needs a token — add it in Settings → Service Tokens'>(key)</span>}
                            </DropdownMenuRadioItem>
                        );
                    })}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export default PlatformPicker;
