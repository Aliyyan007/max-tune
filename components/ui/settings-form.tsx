'use client';
import React, { useEffect, useRef, useState } from 'react';

const APP_NAME = process.env.NEXT_PUBLIC_APPLICATION_NAME || 'max-tune';
import { Button } from './button';
import { Checkbox } from '@/components/ui/checkbox';
import { ChevronDownIcon, InfoIcon, SettingsIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from './input';
import { ModeToggle } from '../mode-toggle';
import { nameVariables, platformDefaults, PlatformOutput, SettingsProps, useSettings } from '@/lib/settings-provider';
import { usePlatform } from '@/lib/platform-provider';
import { PLATFORMS, PlatformSource } from '@/lib/platforms/types';
import { Separator } from './separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Slider } from './slider';

const losslessCodecs = ['FLAC', 'ALAC', 'WAV', 'SOURCE'];

// what each platform natively delivers — shown as context in the quality section
const nativeFormat: Record<PlatformSource, string> = {
    qobuz: 'FLAC up to 24-bit / 192kHz',
    deezer: 'FLAC 16-bit / 44.1kHz (premium) · MP3 320k (free)',
    tidal: 'FLAC / Hi-Res FLAC or AAC, by plan',
    spotify: 'OGG Vorbis up to 320 kbps (Premium)',
    apple: 'ALAC / AAC in .m4a',
    amazon: 'FLAC HD/UltraHD up to 24-bit/192kHz (Unlimited)'
};

const SettingsForm = () => {
    const { settings, setSettings, resetSettings } = useSettings();
    const { platform } = usePlatform();

    const [open, setOpen] = useState(false);
    // the platform picker defaults to whatever the user is currently browsing
    const [cfgPlatform, setCfgPlatform] = useState<PlatformSource>(platform);
    useEffect(() => {
        if (open) setCfgPlatform(platform);
    }, [open, platform]);

    const bitrateInput = useRef<HTMLInputElement | null>(null);

    // effective output values for the selected platform (defaults = platform's native)
    const eff: PlatformOutput = { ...platformDefaults[cfgPlatform], ...(settings.platformSettings?.[cfgPlatform] ?? {}) };

    const setEff = (patch: Partial<PlatformOutput>) => {
        setSettings((prev) => ({
            ...prev,
            platformSettings: {
                ...prev.platformSettings,
                [cfgPlatform]: { ...platformDefaults[cfgPlatform], ...prev.platformSettings?.[cfgPlatform], ...patch }
            }
        }));
    };

    useEffect(() => {
        if (!open && bitrateInput.current) {
            let numberInput = parseInt(bitrateInput.current.value);
            if (isNaN(numberInput)) numberInput = 320;
            if (numberInput > 320) numberInput = 320;
            if (numberInput < 24) numberInput = 320;
            setEff({ bitrate: numberInput || 320 });
        }
    }, [open]);

    return (
        <Sheet open={open} onOpenChange={setOpen} modal={true}>
            <Button
                variant='outline'
                size='icon'
                onClick={() => {
                    setOpen(true);
                }}
            >
                <SettingsIcon />
            </Button>
            <SheetContent className='flex flex-col gap-4 overflow-hidden'>
                <div className='flex flex-col gap-4 pt-4 h-full overflow-y-scroll scrollbar-hide'>
                    <SheetHeader>
                        <div className='flex flex-col my-1'>
                            <SheetTitle>Theme</SheetTitle>
                            <SheetDescription>Change the way {APP_NAME} looks</SheetDescription>
                        </div>
                        <ModeToggle />
                    </SheetHeader>
                    <Separator />
                    <SheetHeader>
                        <div className='flex flex-col my-1'>
                            <SheetTitle>Background</SheetTitle>
                            <SheetDescription>Change the background of {APP_NAME}</SheetDescription>
                        </div>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant='outline' className='flex gap-2 items-center'>
                                    <p className='capitalize'>{settings.particles ? 'Particles' : 'Solid Color'}</p>
                                    <ChevronDownIcon />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align='start'>
                                <DropdownMenuRadioGroup
                                    value={settings.particles ? 'particles' : 'solid color'}
                                    onValueChange={(value: string) => {
                                        setSettings((prev) => ({ ...prev, particles: value === 'particles' }));
                                    }}
                                >
                                    <DropdownMenuRadioItem value='particles'>Particles</DropdownMenuRadioItem>
                                    <DropdownMenuRadioItem value='solid color'>Solid Color</DropdownMenuRadioItem>
                                </DropdownMenuRadioGroup>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </SheetHeader>
                    <Separator />
                    <SheetHeader className='space-y-4'>
                        <div className='flex flex-col my-1'>
                            <SheetTitle>Output Settings</SheetTitle>
                            <SheetDescription>Change the way your music is saved</SheetDescription>
                        </div>
                        <div className='space-y-2'>
                            <div className='px-0.5 space-y-2'>
                                <p className='font-medium text-sm'>Zip File Naming</p>
                                <div className='flex gap-2'>
                                    <Dialog>
                                        <DialogTrigger asChild>
                                            <Button size='icon' className='aspect-square' variant='outline'>
                                                <InfoIcon />
                                            </Button>
                                        </DialogTrigger>
                                        <DialogContent>
                                            <DialogHeader>
                                                <DialogTitle>Zip File Naming</DialogTitle>
                                                <DialogDescription>The variables used in the zip file name</DialogDescription>
                                            </DialogHeader>
                                            <p className='text-xs text-muted-foreground'>An example is {'{artists} - {name}'}</p>
                                            <div className='flex flex-col gap-2'>
                                                {nameVariables.map((variable, index) => (
                                                    <div key={index} className='flex text-sm items-center justify-between gap-2'>
                                                        <p>
                                                            <span className='capitalize'>{variable}</span>{' '}
                                                            <span className='text-muted-foreground'>{`{${variable}}`}</span>
                                                        </p>
                                                        <p>{settings.zipName.includes(variable) ? 'Currently used' : 'Not used'}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </DialogContent>
                                    </Dialog>
                                    <Input value={settings.zipName} onChange={(e) => setSettings((prev) => ({ ...prev, zipName: e.target.value }))} />
                                </div>
                            </div>
                            <div className='px-0.5 space-y-2'>
                                <p className='font-medium text-sm'>Track File Naming</p>
                                <div className='flex gap-2'>
                                    <Dialog>
                                        <DialogTrigger asChild>
                                            <Button size='icon' className='aspect-square' variant='outline'>
                                                <InfoIcon />
                                            </Button>
                                        </DialogTrigger>
                                        <DialogContent>
                                            <DialogHeader>
                                                <DialogTitle>Track File Naming</DialogTitle>
                                                <DialogDescription>The variables used in the track file name</DialogDescription>
                                            </DialogHeader>
                                            <p className='text-xs text-muted-foreground'>An example is {'{artists} - {name}'}</p>
                                            <div className='flex flex-col gap-2'>
                                                {nameVariables.map((variable, index) => (
                                                    <div key={index} className='flex text-sm items-center justify-between gap-2'>
                                                        <p>
                                                            <span className='capitalize'>{variable}</span>{' '}
                                                            <span className='text-muted-foreground'>{`{${variable}}`}</span>
                                                        </p>
                                                        <p>{settings.trackName.includes(variable) ? 'Currently used' : 'Not used'}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </DialogContent>
                                    </Dialog>
                                    <Input value={settings.trackName} onChange={(e) => setSettings((prev) => ({ ...prev, trackName: e.target.value }))} />
                                </div>
                            </div>
                            <p className='font-medium text-sm'>Platform</p>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant='outline' className='flex gap-2 items-center'>
                                        <p>{PLATFORMS.find((x) => x.id === cfgPlatform)?.label}</p>
                                        <ChevronDownIcon />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align='start'>
                                    <DropdownMenuRadioGroup value={cfgPlatform} onValueChange={(v) => setCfgPlatform(v as PlatformSource)}>
                                        {PLATFORMS.map((p) => (
                                            <DropdownMenuRadioItem key={p.id} value={p.id}>
                                                {p.label}
                                            </DropdownMenuRadioItem>
                                        ))}
                                    </DropdownMenuRadioGroup>
                                </DropdownMenuContent>
                            </DropdownMenu>
                            <p className='text-xs text-muted-foreground'>
                                Native format: <span className='font-medium'>{nativeFormat[cfgPlatform]}</span> — &quot;Original&quot; preserves it
                                exactly (recommended); other codecs transcode.
                            </p>
                            <p className='font-medium text-sm'>Output Codec</p>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant='outline' className='flex gap-2 items-center'>
                                        <p>{eff.outputCodec === 'SOURCE' ? 'Original (recommended)' : eff.outputCodec}</p>
                                        <ChevronDownIcon />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align='start'>
                                    <DropdownMenuRadioGroup
                                        value={eff.outputCodec}
                                        onValueChange={(codec: string) => {
                                            const c = codec as SettingsProps['outputCodec'];
                                            setEff({ outputCodec: c, outputQuality: '27' });
                                        }}
                                    >
                                        <DropdownMenuRadioItem value='SOURCE'>Original (recommended)</DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value='FLAC'>FLAC</DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value='WAV'>WAV</DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value='ALAC'>ALAC</DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value='MP3'>MP3</DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value='AAC'>AAC</DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value='OGG'>OGG (Vorbis)</DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value='OPUS'>OPUS</DropdownMenuRadioItem>
                                    </DropdownMenuRadioGroup>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                        {!losslessCodecs.includes(eff.outputCodec) && (
                            <>
                                <p className='text-xs text-muted-foreground text-center'>
                                    Lossy codec selected. Source audio is always fetched at the platform&apos;s maximum quality, then re-encoded at
                                    the bitrate below.
                                </p>
                                <div className='flex items-center gap-2 w-full justify-center'>
                                    <Input ref={bitrateInput} max={320} min={24} className='w-fit' type='number' defaultValue={eff.bitrate} />
                                    <p>kbps</p>
                                </div>
                            </>
                        )}
                        <div className='flex items-center gap-2 pt-2'>
                            <div className='flex flex-col'>
                                <p className={cn('font-medium', eff.outputCodec === 'WAV' && 'text-muted-foreground')}>Apply metadata</p>
                                <p className={cn('text-xs', eff.outputCodec === 'WAV' ? 'text-muted-background' : 'text-muted-foreground')}>
                                    If enabled (default), songs will be tagged with cover art, album information, etc.
                                </p>
                            </div>
                            <Checkbox
                                checked={settings.applyMetadata && eff.outputCodec !== 'WAV'}
                                onCheckedChange={(checked: boolean) => setSettings((settings) => ({ ...settings, applyMetadata: checked }))}
                                disabled={eff.outputCodec === 'WAV'}
                            />
                        </div>
                        {eff.outputCodec === 'OPUS' && (
                            <p className='text-xs text-destructive font-semibold text-center'>WARNING: OGG (OPUS) files do not support album art.</p>
                        )}
                        {eff.outputCodec === 'WAV' && (
                            <p className='text-xs text-destructive font-semibold text-center'>WAV files do not support metadata / tags.</p>
                        )}
                    </SheetHeader>
                    <Separator />
                    <SheetHeader>
                        <div className='flex items-center gap-2'>
                            <div className='flex flex-col'>
                                <p className='font-medium'>Fix MD5 Hash</p>
                                <p className='text-xs text-muted-foreground'>
                                    If enabled (default), MD5 hashes will be fixed, improving compatiablity with old software. This will take longer to
                                    download.
                                </p>
                            </div>
                            <Checkbox
                                checked={settings.fixMD5}
                                onCheckedChange={(checked: boolean) => setSettings((settings) => ({ ...settings, fixMD5: checked }))}
                            />
                        </div>
                    </SheetHeader>
                    <Separator />
                    <SheetHeader>
                        <div className='flex items-center gap-2'>
                            <div className='flex flex-col'>
                                <p className='font-medium'>Allow Explicit content</p>
                                <p className='text-xs text-muted-foreground'>If enabled (default), explicit songs will be shown when searching.</p>
                            </div>
                            <Checkbox
                                checked={settings.explicitContent}
                                onCheckedChange={(checked: boolean) => setSettings((settings) => ({ ...settings, explicitContent: checked }))}
                            />
                        </div>
                    </SheetHeader>
                    <Separator />
                    <SheetHeader>
                        <div className='flex flex-col items-center gap-2'>
                            <div className='flex flex-col'>
                                <p className='font-medium'>Max Album Art Size</p>
                                <p className='text-xs text-muted-foreground'>If apply metadata is enabled, album art will be resized to this size.</p>
                            </div>
                            <Slider
                                min={100}
                                max={3600}
                                step={100}
                                value={[settings.albumArtSize]}
                                onValueChange={(value: number[]) => setSettings((settings) => ({ ...settings, albumArtSize: value[0] }))}
                            />
                            <p>
                                {settings.albumArtSize}x{settings.albumArtSize}
                            </p>
                        </div>
                    </SheetHeader>
                    <Separator />
                    <SheetHeader>
                        <div className='flex flex-col items-center gap-2'>
                            <div className='flex flex-col'>
                                <p className='font-medium'>Album Art Quality</p>
                                <p className='text-xs text-muted-foreground'>
                                    If apply metadata is enabled, album art will be compressed to this quality. 100% is lossless.
                                </p>
                            </div>
                            <Slider
                                min={10}
                                max={100}
                                step={1}
                                value={[settings.albumArtQuality * 100]}
                                onValueChange={(value: number[]) => setSettings((settings) => ({ ...settings, albumArtQuality: value[0] / 100 }))}
                            />
                            <p>{Math.round(settings.albumArtQuality * 100)}%</p>
                        </div>
                    </SheetHeader>
                    <Separator />
                    <Button variant='destructive' onClick={resetSettings}>
                        Reset Settings
                    </Button>
                </div>
            </SheetContent>
        </Sheet>
    );
};

export default SettingsForm;
