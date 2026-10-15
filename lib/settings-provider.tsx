'use client';
import React, { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import type { PlatformSource, ServiceTokens } from './platforms/types';

export type OutputCodec = 'SOURCE' | 'FLAC' | 'WAV' | 'ALAC' | 'MP3' | 'AAC' | 'OGG' | 'OPUS';
export type OutputQuality = '27' | '7' | '6' | '5';

export type PlatformOutput = { outputQuality: OutputQuality; outputCodec: OutputCodec; bitrate: number };

export type SettingsProps = {
    particles: boolean;
    outputQuality: OutputQuality;
    outputCodec: OutputCodec;
    bitrate: number | undefined;
    applyMetadata: boolean;
    fixMD5: boolean;
    explicitContent: boolean;
    albumArtSize: number;
    albumArtQuality: number;
    zipName: string;
    trackName: string;
    serviceTokens?: ServiceTokens;
    // per-platform quality/codec overrides — falls back to the global fields when unset
    platformSettings?: Partial<Record<PlatformSource, Partial<PlatformOutput>>>;
};

export const nameVariables: string[] = ['artists', 'name', 'year', 'duration'];

const QUALITIES = ['27', '7', '6', '5'] as const;
const CODECS = ['SOURCE', 'FLAC', 'WAV', 'ALAC', 'MP3', 'AAC', 'OGG', 'OPUS'] as const;

const isValidSettings = (obj: any): obj is SettingsProps => {
    return (
        typeof obj.particles === 'boolean' &&
        (QUALITIES as readonly string[]).includes(obj.outputQuality) &&
        (CODECS as readonly string[]).includes(obj.outputCodec) &&
        ((typeof obj.bitrate === 'number' && obj.bitrate >= 24 && obj.bitrate <= 320) || obj.bitrate === undefined) &&
        typeof obj.applyMetadata === 'boolean' &&
        typeof obj.explicitContent === 'boolean' &&
        typeof obj.fixMD5 === 'boolean' &&
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

// Sensible per-platform defaults — each platform's native codec/tier, no fake conversions.
export const platformDefaults: Record<PlatformSource, PlatformOutput> = {
    qobuz: { outputQuality: '27', outputCodec: 'SOURCE', bitrate: 320 },
    deezer: { outputQuality: '7', outputCodec: 'SOURCE', bitrate: 320 },
    tidal: { outputQuality: '27', outputCodec: 'SOURCE', bitrate: 320 },
    spotify: { outputQuality: '7', outputCodec: 'SOURCE', bitrate: 320 },
    apple: { outputQuality: '7', outputCodec: 'SOURCE', bitrate: 320 },
    amazon: { outputQuality: '27', outputCodec: 'SOURCE', bitrate: 320 }
};

// Effective output for a given platform: explicit override → platform default → global.
export function outputFor(source: string | undefined, settings: SettingsProps): PlatformOutput {
    const s = (source ?? 'qobuz') as PlatformSource;
    const base = platformDefaults[s] ?? platformDefaults.qobuz;
    const over = settings.platformSettings?.[s];
    return {
        outputQuality: (over?.outputQuality ?? base.outputQuality ?? settings.outputQuality) as OutputQuality,
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
    outputQuality: '27',
    outputCodec: 'FLAC',
    bitrate: 320,
    applyMetadata: true,
    fixMD5: false,
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
