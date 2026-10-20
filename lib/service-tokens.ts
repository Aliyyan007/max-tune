'use client';
import type { ServiceTokens } from './platforms/types';

// Tokens live inside the persisted settings object (localStorage['settings'].serviceTokens)
export function getServiceTokens(): ServiceTokens {
    if (typeof window === 'undefined') return {};
    try {
        return JSON.parse(localStorage.getItem('settings') ?? '{}')?.serviceTokens ?? {};
    } catch {
        return {};
    }
}

// Headers to send with every API + stream request so the server can reach platform credentials
export function serviceHeaders(): Record<string, string> {
    const tokens = getServiceTokens();
    return Object.values(tokens).some((v) => v) ? { 'Service-Tokens': encodeURIComponent(JSON.stringify(tokens)) } : {};
}
