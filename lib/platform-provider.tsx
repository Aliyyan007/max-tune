'use client';
import React, { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { PLATFORMS, type PlatformSource } from './platforms/types';

const PlatformContext = createContext<{ platform: PlatformSource; setPlatform: (p: PlatformSource) => void } | undefined>(undefined);

export const PlatformProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [platform, setPlatformState] = useState<PlatformSource>('qobuz');

    useEffect(() => {
        const saved = localStorage.getItem('platform') as PlatformSource | null;
        if (saved && PLATFORMS.some((p) => p.id === saved)) setPlatformState(saved);
    }, []);

    const setPlatform = (p: PlatformSource) => {
        setPlatformState(p);
        localStorage.setItem('platform', p);
    };

    return <PlatformContext.Provider value={{ platform, setPlatform }}>{children}</PlatformContext.Provider>;
};

export const usePlatform = () => {
    const context = useContext(PlatformContext);
    if (!context) throw new Error('usePlatform must be used within a PlatformProvider');
    return context;
};
