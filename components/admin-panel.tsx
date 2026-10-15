'use client';
import React, { useCallback, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { Separator } from './ui/separator';
import { cn } from '@/lib/utils';
import { ActivityIcon, CheckCircle2Icon, KeyRoundIcon, PlusIcon, RefreshCwIcon, ShieldIcon, Trash2Icon, XCircleIcon } from 'lucide-react';

type TokenRow = {
    token: string;
    label?: string;
    ok: number;
    fail: number;
    lastError?: string;
    lastOkAt?: number;
    lastUsedAt?: number;
    disabled: boolean;
};

const PLATFORM_LABELS: Record<string, string> = {
    deezer: 'Deezer ARL',
    tidal: 'Tidal Bearer token',
    spotify: 'Spotify clientId:secret',
    apple: 'Apple media-user-token',
    amazon: 'Amazon session JWT'
};
const PLATFORM_ORDER = ['deezer', 'tidal', 'spotify', 'apple', 'amazon'];

async function adminCall(password: string, action: string, extra: Record<string, any> = {}) {
    const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action, ...extra })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error ?? 'request failed');
    return json.data;
}

const ago = (ts?: number) => {
    if (!ts) return '—';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
};

const AdminPanel = () => {
    const [sheetOpen, setSheetOpen] = useState(false);
    const [pwOpen, setPwOpen] = useState(false);
    const [password, setPassword] = useState('');
    const [pwError, setPwError] = useState('');
    const [authed, setAuthed] = useState<string | null>(null); // holds the password while open
    const [stats, setStats] = useState<any>(null);
    const [tokens, setTokens] = useState<Record<string, TokenRow[]>>({});
    const [newToken, setNewToken] = useState<Record<string, string>>({});
    const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const refresh = useCallback(async (pw: string) => {
        const data = await adminCall(pw, 'stats');
        setStats(data.stats);
        setTokens(data.tokens ?? {});
    }, []);

    const onDot = () => {
        // single click = nothing (invisible affordance); double-click = admin gate
        if (clickTimer.current) {
            clearTimeout(clickTimer.current);
            clickTimer.current = null;
            if (authed) setSheetOpen(true);
            else setPwOpen(true);
        } else {
            clickTimer.current = setTimeout(() => (clickTimer.current = null), 350);
        }
    };

    const login = async () => {
        try {
            await adminCall(password, 'stats');
            setAuthed(password);
            setPwOpen(false);
            setPwError('');
            setPassword('');
            setSheetOpen(true);
            await refresh(password);
        } catch {
            setPwError('Wrong password');
        }
    };

    const mutate = async (fn: () => Promise<any>) => {
        if (!authed) return;
        await fn().catch(() => {});
        await refresh(authed).catch(() => {});
    };

    return (
        <>
            {/* invisible admin affordance — bottom-right corner dot, double-click */}
            <button
                aria-label='admin'
                onClick={onDot}
                className='fixed bottom-2 right-2 z-[60] h-3 w-3 rounded-full bg-muted-foreground/15 hover:bg-muted-foreground/40 transition-colors'
            />
            <Dialog open={pwOpen} onOpenChange={setPwOpen}>
                <DialogContent className='max-w-xs'>
                    <DialogHeader>
                        <DialogTitle className='flex items-center gap-2'>
                            <ShieldIcon size={18} /> Admin access
                        </DialogTitle>
                        <DialogDescription>Enter the admin password</DialogDescription>
                    </DialogHeader>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            login();
                        }}
                        className='space-y-3'
                    >
                        <Input type='password' autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder='Password' />
                        {pwError && <p className='text-xs text-destructive'>{pwError}</p>}
                        <Button type='submit' className='w-full'>
                            Unlock
                        </Button>
                    </form>
                </DialogContent>
            </Dialog>
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                <SheetContent className='flex flex-col gap-4 overflow-hidden sm:max-w-lg'>
                    <SheetHeader>
                        <SheetTitle className='flex items-center gap-2'>
                            <ActivityIcon size={18} /> Admin Panel
                        </SheetTitle>
                        <SheetDescription>Server stats + credential pool with health & rotation</SheetDescription>
                    </SheetHeader>
                    <div className='flex-1 overflow-y-auto scrollbar-hide space-y-5 pr-1'>
                        {/* ---- stats ---- */}
                        {stats && (
                            <div className='grid grid-cols-3 gap-2 text-center'>
                                <div className='rounded-md border p-2'>
                                    <p className='text-lg font-semibold'>{Math.floor(stats.uptimeSec / 60)}m</p>
                                    <p className='text-[10px] text-muted-foreground'>Uptime</p>
                                </div>
                                <div className='rounded-md border p-2'>
                                    <p className='text-lg font-semibold'>{stats.memoryMB}MB</p>
                                    <p className='text-[10px] text-muted-foreground'>Memory</p>
                                </div>
                                <div className='rounded-md border p-2'>
                                    <p className='text-lg font-semibold'>{stats.jobs?.active ?? 0}</p>
                                    <p className='text-[10px] text-muted-foreground'>Active jobs</p>
                                </div>
                            </div>
                        )}
                        <Button variant='outline' size='sm' onClick={() => authed && refresh(authed)} className='gap-2'>
                            <RefreshCwIcon size={14} /> Refresh
                        </Button>
                        <Separator />
                        {/* ---- token pools ---- */}
                        {PLATFORM_ORDER.map((plat) => {
                            const list = tokens[plat] ?? [];
                            return (
                                <div key={plat} className='space-y-2'>
                                    <div className='flex items-center justify-between'>
                                        <p className='font-medium text-sm capitalize'>{PLATFORM_LABELS[plat] ?? plat}</p>
                                        <p className='text-xs text-muted-foreground'>
                                            {list.filter((t) => !t.disabled).length} active / {list.length} total
                                        </p>
                                    </div>
                                    {list.map((t, i) => (
                                        <div key={i} className='flex items-center gap-2 rounded-md border px-2 py-1.5'>
                                            {t.disabled || t.lastError ? (
                                                <XCircleIcon size={14} className='text-destructive shrink-0' />
                                            ) : (
                                                <CheckCircle2Icon size={14} className='text-green-500 shrink-0' />
                                            )}
                                            <div className='flex-1 min-w-0'>
                                                <p className='text-xs font-mono truncate'>{t.token}</p>
                                                <p className='text-[10px] text-muted-foreground truncate'>
                                                    {t.lastError ? <span className='text-destructive'>{t.lastError} · </span> : null}
                                                    ok {t.ok} · fail {t.fail} · used {ago(t.lastUsedAt)}
                                                </p>
                                            </div>
                                            <Button
                                                variant='ghost'
                                                size='icon'
                                                className='h-6 w-6 shrink-0'
                                                title={t.disabled ? 'Re-enable' : 'Disable'}
                                                onClick={() => mutate(() => adminCall(authed!, 'toggle', { platform: plat, token: t.token, disabled: !t.disabled }))}
                                            >
                                                <KeyRoundIcon size={12} className={cn(t.disabled && 'opacity-40')} />
                                            </Button>
                                            <Button
                                                variant='ghost'
                                                size='icon'
                                                className='h-6 w-6 shrink-0 text-destructive'
                                                onClick={() => mutate(() => adminCall(authed!, 'remove', { platform: plat, token: t.token }))}
                                            >
                                                <Trash2Icon size={12} />
                                            </Button>
                                        </div>
                                    ))}
                                    <form
                                        className='flex gap-2'
                                        onSubmit={(e) => {
                                            e.preventDefault();
                                            const v = (newToken[plat] ?? '').trim();
                                            if (!v) return;
                                            mutate(async () => {
                                                await adminCall(authed!, 'add', { platform: plat, token: v });
                                                setNewToken((p) => ({ ...p, [plat]: '' }));
                                            });
                                        }}
                                    >
                                        <Input
                                            type='password'
                                            placeholder={`Add ${PLATFORM_LABELS[plat] ?? plat}…`}
                                            value={newToken[plat] ?? ''}
                                            onChange={(e) => setNewToken((p) => ({ ...p, [plat]: e.target.value }))}
                                            className='text-xs h-8'
                                        />
                                        <Button type='submit' size='icon' variant='outline' className='h-8 w-8 shrink-0'>
                                            <PlusIcon size={14} />
                                        </Button>
                                    </form>
                                </div>
                            );
                        })}
                        <p className='text-[10px] text-muted-foreground'>
                            Tokens rotate round-robin per request and are auto-disabled on auth failure. Env-var tokens act as the fallback pool.
                        </p>
                        <Separator />
                        <div className='space-y-2'>
                            <p className='font-medium text-sm'>Connect a Spotify account (real audio)</p>
                            <SpotifyConnect />
                            <p className='text-[10px] text-muted-foreground'>
                                Generate a link → owner signs in → their browser lands on a dead 127.0.0.1 page → paste that full URL back here.
                            </p>
                        </div>
                    </div>
                </SheetContent>
            </Sheet>
        </>
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


export default AdminPanel;
