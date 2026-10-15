'use client';
import React, { useEffect, useRef, useState } from 'react';

const APP_NAME = process.env.NEXT_PUBLIC_APPLICATION_NAME || 'max-tune';
import { Button } from './button';
import { Checkbox } from '@/components/ui/checkbox';
import { ChevronDownIcon, DotIcon, InfoIcon, SettingsIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from './input';
import { ModeToggle } from '../mode-toggle';
import { nameVariables, platformDefaults, PlatformOutput, SettingsProps, useSettings } from '@/lib/settings-provider';
import { PLATFORMS, PlatformSource } from '@/lib/platforms/types';
import { Separator } from './separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Slider } from './slider';

const losslessCodecs = ['FLAC', 'ALAC', 'WAV', 'SOURCE'];

const qualityMap = {
    '27': [24, 192],
    '7': [24, 96],
    '6': [16, 44.1]
};

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

    const [open, setOpen] = useState(false);
    const [cfgPlatform, setCfgPlatform] = useState<PlatformSource | 'all'>('all');

    const bitrateInput = useRef<HTMLInputElement | null>(null);

    // effective output values for the selected platform (or global when 'all')
    const eff: PlatformOutput =
        cfgPlatform === 'all'
            ? { outputCodec: settings.outputCodec, outputQuality: settings.outputQuality, bitrate: settings.bitrate ?? 320 }
            : { ...platformDefaults[cfgPlatform], ...(settings.platformSettings?.[cfgPlatform] ?? {}) };

    const setEff = (patch: Partial<PlatformOutput>) => {
        if (cfgPlatform === 'all') setSettings((prev) => ({ ...prev, ...patch }));
        else
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
            if (cfgPlatform === 'all') setSettings((prev) => ({ ...prev, bitrate: numberInput || 320 }));
            else setEff({ bitrate: numberInput || 320 });
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
                            <p className='font-medium text-sm'>Configure For</p>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant='outline' className='flex gap-2 items-center'>
                                        <p>{cfgPlatform === 'all' ? 'All Platforms (global)' : PLATFORMS.find((x) => x.id === cfgPlatform)?.label}</p>
                                        <ChevronDownIcon />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align='start'>
                                    <DropdownMenuRadioGroup value={cfgPlatform} onValueChange={(v) => setCfgPlatform(v as PlatformSource | 'all')}>
                                        <DropdownMenuRadioItem value='all'>All Platforms (global)</DropdownMenuRadioItem>
                                        {PLATFORMS.map((p) => (
                                            <DropdownMenuRadioItem key={p.id} value={p.id}>
                                                {p.label}
                                            </DropdownMenuRadioItem>
                                        ))}
                                    </DropdownMenuRadioGroup>
                                </DropdownMenuContent>
                            </DropdownMenu>
                            {cfgPlatform !== 'all' && (
                                <p className='text-xs text-muted-foreground'>
                                    Native format: <span className='font-medium'>{nativeFormat[cfgPlatform]}</span> — &quot;Keep source&quot; preserves it exactly;
                                    other codecs transcode.
                                </p>
                            )}
                            <p className='font-medium text-sm'>Output Codec</p>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant='outline' className='flex gap-2 items-center'>
                                        <p>{eff.outputCodec === 'SOURCE' ? 'Keep source' : eff.outputCodec}</p>
                                        <ChevronDownIcon />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align='start'>
                                    <DropdownMenuRadioGroup
                                        value={eff.outputCodec}
                                        onValueChange={(codec: string) => {
                                            const c = codec as SettingsProps['outputCodec'];
                                            setEff({ outputCodec: c });
                                            if (!losslessCodecs.includes(codec)) {
                                                setEff({ outputCodec: c, outputQuality: codec === 'OPUS' ? '6' : '5', bitrate: eff.bitrate || 320 });
                                            } else if (eff.outputQuality === '5') {
                                                setEff({ outputCodec: c, outputQuality: '27', bitrate: 320 });
                                            }
                                        }}
                                    >
                                        <DropdownMenuRadioItem value='SOURCE'>Keep source (recommended)</DropdownMenuRadioItem>
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
                        {losslessCodecs.includes(eff.outputCodec) ? (
                            <div className='space-y-2'>
                                <p className='font-medium text-sm'>Max Download Quality</p>
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button variant='outline' className='flex gap-2 items-center'>
                                            {parseQualityHTML(eff.outputQuality)}
                                            <ChevronDownIcon />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align='start'>
                                        <DropdownMenuRadioGroup
                                            value={eff.outputQuality}
                                            onValueChange={(quality: string) => {
                                                setEff({ outputQuality: quality as SettingsProps['outputQuality'] });
                                            }}
                                        >
                                            <DropdownMenuRadioItem value={'27'}>
                                                <p>24-bit</p>
                                                <DotIcon />
                                                <p>192kHz</p>
                                            </DropdownMenuRadioItem>
                                            <DropdownMenuRadioItem value={'7'}>
                                                <p>24-bit</p>
                                                <DotIcon />
                                                <p>96kHz</p>
                                            </DropdownMenuRadioItem>
                                            <DropdownMenuRadioItem value={'6'}>
                                                <p>16-bit</p>
                                                <DotIcon />
                                                <p>44.1kHz</p>
                                            </DropdownMenuRadioItem>
                                        </DropdownMenuRadioGroup>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>
                        ) : (
                            <>
                                <p className='text-xs text-muted-foreground text-center'>
                                    Lossy codec selected. All music will be downloaded at 320kbps. You can specify a bitrate to rencode to below.
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
                    <SheetHeader className='space-y-3'>
                        <div className='flex flex-col my-1'>
                            <SheetTitle>Service Tokens</SheetTitle>
                            <SheetDescription>Premium account credentials — required for full-length downloads on each platform</SheetDescription>
                        </div>
                        <div className='space-y-1'>
                            <p className='font-medium text-sm'>Deezer ARL cookie</p>
                            <Input
                                type='password'
                                placeholder='deezer.com → DevTools → Cookies → arl'
                                value={settings.serviceTokens?.deezerArl ?? ''}
                                onChange={(e) => setSettings((prev) => ({ ...prev, serviceTokens: { ...prev.serviceTokens, deezerArl: e.target.value.trim() } }))}
                            />
                            <p className='text-xs text-muted-foreground'>Free account = 128kbps, Premium = 320kbps, HiFi = FLAC.</p>
                        </div>
                        <div className='space-y-1'>
                            <p className='font-medium text-sm'>Tidal access token</p>
                            <Input
                                type='password'
                                placeholder='listen.tidal.com → DevTools → Network → Authorization: Bearer …'
                                value={settings.serviceTokens?.tidalToken ?? ''}
                                onChange={(e) => setSettings((prev) => ({ ...prev, serviceTokens: { ...prev.serviceTokens, tidalToken: e.target.value.trim().replace(/^Bearer\s+/i, '') } }))}
                            />
                            <p className='text-xs text-muted-foreground'>Grab the Bearer token from any API request in the web player. Requires a paid plan for downloads.</p>
                        </div>
                        <div className='space-y-1'>
                            <p className='font-medium text-sm'>Connect a Spotify account (real audio)</p>
                            <SpotifyConnect />
                            <p className='text-xs text-muted-foreground'>
                                Send the generated link to the account owner → they sign in and click Agree → their browser lands on a dead
                                127.0.0.1 page → they copy that full page URL and send it back. Premium streams real OGG audio.
                            </p>
                        </div>
                        <div className='space-y-1'>
                            <p className='font-medium text-sm'>Spotify Client ID</p>
                            <Input
                                placeholder='developer.spotify.com → Create App'
                                value={settings.serviceTokens?.spotifyId ?? ''}
                                onChange={(e) => setSettings((prev) => ({ ...prev, serviceTokens: { ...prev.serviceTokens, spotifyId: e.target.value.trim() } }))}
                            />
                            <p className='font-medium text-sm'>Spotify Client Secret</p>
                            <Input
                                type='password'
                                placeholder='from the same app page'
                                value={settings.serviceTokens?.spotifySecret ?? ''}
                                onChange={(e) => setSettings((prev) => ({ ...prev, serviceTokens: { ...prev.serviceTokens, spotifySecret: e.target.value.trim() } }))}
                            />
                            <p className='text-xs text-muted-foreground'>
                                Powers Spotify search + metadata through the official Web API. The dev-app owner needs a Premium account
                                (a free-owned app gets 403 from Spotify).
                            </p>
                        </div>
                        <div className='space-y-1'>
                            <p className='font-medium text-sm'>Apple Music media-user-token (real audio)</p>
                            <Input
                                type='password'
                                placeholder='media-user-token cookie — Apple Music subscription required'
                                value={settings.serviceTokens?.appleMediaToken ?? ''}
                                onChange={(e) => setSettings((prev) => ({ ...prev, serviceTokens: { ...prev.serviceTokens, appleMediaToken: e.target.value.trim() } }))}
                            />
                            <p className='font-medium text-sm'>Apple wrapper endpoint (optional)</p>
                            <Input
                                placeholder='http://127.0.0.1:12340'
                                value={settings.serviceTokens?.appleWrapper ?? ''}
                                onChange={(e) => setSettings((prev) => ({ ...prev, serviceTokens: { ...prev.serviceTokens, appleWrapper: e.target.value.trim() } }))}
                            />
                            <p className='text-xs text-muted-foreground'>
                                Real ALAC/AAC/Atmos. Needs: (1) wrapper-lite running — download &quot;wrapper.x86_64.latest&quot; from
                                github.com/WorldObservationLog/wrapper, run wrapper-lite-qemu.exe --login your@apple.id once; (2) media-user-token —
                                music.apple.com → DevTools → Application → Cookies → media-user-token.
                            </p>
                        </div>
                        <div className='space-y-1'>
                            <p className='font-medium text-sm'>Amazon Music session token (real audio)</p>
                            <Input
                                type='password'
                                placeholder='Session JWT from amz.dezalty.com — Unlimited required'
                                value={settings.serviceTokens?.amazonToken ?? ''}
                                onChange={(e) => setSettings((prev) => ({ ...prev, serviceTokens: { ...prev.serviceTokens, amazonToken: e.target.value.trim() } }))}
                            />
                            <p className='text-xs text-muted-foreground'>
                                Real HD/UltraHD FLAC via the amz.dezalty.com gateway. Get the token: open amz.dezalty.com → &quot;Open Amazon Login&quot; → sign in with your
                                Amazon Music Unlimited account → paste the redirect URL → copy the Session JWT here. The JWT renews itself automatically once stored —
                                no re-login needed. Decryption also needs a Widevine device file: drop a <code>.wvd</code> (extracted from an Android device/emulator) at
                                <code>data/amazon-device.wvd</code>.
                            </p>
                        </div>
                    </SheetHeader>
                    <Button variant='destructive' onClick={resetSettings}>
                        Reset Settings
                    </Button>
                </div>
            </SheetContent>
        </Sheet>
    );
};

const SpotifyConnect = () => {
    const [authUrl, setAuthUrl] = useState('');
    const [redirectUrl, setRedirectUrl] = useState('');
    const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
    const [message, setMessage] = useState('');

    const generate = async () => {
        setStatus('loading');
        setMessage('');
        try {
            const res = await fetch('/api/spotify-auth');
            const json = await res.json();
            if (!json.success) throw new Error(json.error ?? 'failed');
            setAuthUrl(json.data.url);
            setStatus('idle');
        } catch (e: any) {
            setMessage(e?.message ?? 'failed to generate link');
            setStatus('error');
        }
    };

    const connect = async () => {
        setStatus('loading');
        setMessage('');
        try {
            const res = await fetch('/api/spotify-auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: redirectUrl.trim() }) });
            const json = await res.json();
            if (!json.success) throw new Error(json.error ?? 'exchange failed');
            setStatus('done');
            setMessage(`Connected as ${json.data.user ?? 'spotify user'} — real audio enabled`);
            setRedirectUrl('');
        } catch (e: any) {
            setMessage(e?.message ?? 'failed');
            setStatus('error');
        }
    };

    return (
        <div className='space-y-2'>
            <div className='flex gap-2'>
                <Button type='button' variant='outline' size='sm' onClick={generate} disabled={status === 'loading'}>
                    {status === 'loading' && !authUrl ? 'Generating…' : 'Generate login link'}
                </Button>
                {authUrl && (
                    <Button type='button' variant='ghost' size='sm' onClick={() => navigator.clipboard.writeText(authUrl)}>
                        Copy link
                    </Button>
                )}
            </div>
            {authUrl && <Input readOnly value={authUrl} className='text-[10px] h-7' onFocus={(e) => e.target.select()} />}
            {authUrl && (
                <div className='flex gap-2'>
                    <Input
                        placeholder='Paste the 127.0.0.1 redirect URL here'
                        value={redirectUrl}
                        onChange={(e) => setRedirectUrl(e.target.value)}
                        className='text-xs'
                    />
                    <Button type='button' size='sm' onClick={connect} disabled={!redirectUrl.includes('code=') || status === 'loading'}>
                        {status === 'loading' ? 'Connecting…' : 'Connect'}
                    </Button>
                </div>
            )}
            {message && <p className={cn('text-xs', status === 'error' ? 'text-destructive' : 'text-green-500')}>{message}</p>}
        </div>
    );
};

export const parseQualityHTML = (quality: string) => {
    try {
        return (
            <div className='flex items-center'>
                <p>{qualityMap[quality as keyof typeof qualityMap][0]}-bit</p>
                <DotIcon className='min-h-[24px] min-w-[24px]' size={24} />
                <p>{qualityMap[quality as keyof typeof qualityMap][1]} kHz</p>
            </div>
        );
    } catch {
        return quality;
    }
};

export default SettingsForm;
