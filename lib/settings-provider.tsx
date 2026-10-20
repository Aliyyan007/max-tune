'use client';
import React, { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import type { PlatformSource, ServiceTokens } from './platforms/types';

export type OutputCodec = 'SOURCE' | 'FLAC' | 'WAV' | 'ALAC' | 'MP3' | 'AAC' | 'OGG' | 'OPUS';

// Per-platform output preference — codec only. Download quality is not a
// setting: every download resolves the platform's maximum available tier.
export type PlatformOutput = { outputCodec: OutputCodec; bitrate: number };

export type SettingsProps = {
    particles: boolean;
    outputCodec: OutputCodec;
    bitrate: number | undefined;
    applyMetadata: boolean;
    explicitContent: boolean;
    albumArtSize: number;
    albumArtQuality: number;
    zipName: string;
    trackName: string;
    serviceTokens?: ServiceTokens;
    // per-platform codec overrides — falls back to the platform's native codec
    platformSettings?: Partial<Record<PlatformSource, Partial<PlatformOutput>>>;
};

export const nameVariables: string[] = ['artists', 'name', 'year', 'duration'];

const CODECS = ['SOURCE', 'FLAC', 'WAV', 'ALAC', 'MP3', 'AAC', 'OGG', 'OPUS'] as const;

const isValidSettings = (obj: any): obj is SettingsProps => {
    return (
        typeof obj.particles === 'boolean' &&
        (CODECS as readonly string[]).includes(obj.outputCodec) &&
        ((typeof obj.bitrate === 'number' && obj.bitrate >= 24 && obj.bitrate <= 320) || obj.bitrate === undefined) &&
        typeof obj.applyMetadata === 'boolean' &&
        typeof obj.explicitContent === 'boolean' &&
        typeof obj.albumArtSize === 'number' &&
        obj.albumArtSize >= 100 &&
        obj.albumArtSize <= 3600 &&
        typeof obj.albumArtQuality === 'number' &&
        obj.albumArtQuality >= 0.1 &&
        obj.albumArtQuality <= 1 &&
        typeof obj.zipName === 'string' &&
        typeof obj.trackName === 'string' &&
        (obj.serviceTokens === undefined || typeof obj.serviceTokens === 'object') &&
        (obj.platformSettings === undefined || typeof obj.platformSettings === 'object')
    );
};

// Each platform's native codec — the default selection, passthrough with no
// fake conversions. bitrate applies only when the user picks a lossy codec.
export const platformDefaults: Record<PlatformSource, PlatformOutput> = {
    qobuz: { outputCodec: 'SOURCE', bitrate: 320 },
    deezer: { outputCodec: 'SOURCE', bitrate: 320 },
    tidal: { outputCodec: 'SOURCE', bitrate: 320 },
    spotify: { outputCodec: 'SOURCE', bitrate: 320 },
    apple: { outputCodec: 'SOURCE', bitrate: 320 },
    amazon: { outputCodec: 'SOURCE', bitrate: 320 }
};

// Effective output for a given platform: explicit override → platform default → global.
export function outputFor(source: string | undefined, settings: SettingsProps): PlatformOutput {
    const s = (source ?? 'qobuz') as PlatformSource;
    const base = platformDefaults[s] ?? platformDefaults.qobuz;
    const over = settings.platformSettings?.[s];
    return {
        outputCodec: (over?.outputCodec ?? base.outputCodec ?? settings.outputCodec) as OutputCodec,
        bitrate: over?.bitrate ?? base.bitrate ?? settings.bitrate ?? 320
    };
}

const SettingsContext = createContext<
    | {
          settings: SettingsProps;
          setSettings: React.Dispatch<React.SetStateAction<SettingsProps>>;
          resetSettings: () => void;
      }
    | undefined
>(undefined);

export const defaultSettings: SettingsProps = {
    particles: true,
    outputCodec: 'SOURCE',
    bitrate: 320,
    applyMetadata: true,
    explicitContent: true,
    albumArtSize: 3600,
    albumArtQuality: 1,
    zipName: '{artists} - {name}',
    trackName: '{artists} - {name}'
};

export const SettingsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [settings, setSettings] = useState<SettingsProps>(defaultSettings);

    useEffect(() => {
        const savedSettings = localStorage.getItem('settings');
        if (savedSettings && isValidSettings(JSON.parse(savedSettings))) {
            setSettings(JSON.parse(savedSettings));
        }
    }, []);

    useEffect(() => {
        localStorage.setItem('settings', JSON.stringify(settings));
    }, [settings]);

    return <SettingsContext.Provider value={{ settings, setSettings, resetSettings: () => setSettings(defaultSettings) }}>{children}</SettingsContext.Provider>;
};

export const useSettings = () => {
    const context = useContext(SettingsContext);

    if (!context) {
        throw new Error('useSettings must be used within a SettingsProvider');
    }

    return context;
};
