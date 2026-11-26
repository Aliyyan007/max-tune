import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    // keep ffmpeg-static out of the bundle so its binary path resolves to node_modules
    serverExternalPackages: ['ffmpeg-static'],
    // lucide-react ships thousands of modules — import only what each file uses
    experimental: { optimizePackageImports: ['lucide-react', 'motion', 'react-country-flag'] },
    images: {
        remotePatterns: [
            {
                protocol: 'https',
                hostname: 'static.qobuz.com',
                port: '',
                pathname: '**',
                search: ''
            }
        ]
    },
    async headers() {
        return [
            {
                source: '/(.*)',
                headers: [
                    {
                        key: 'X-Content-Type-Options',
                        value: 'nosniff'
                    },
                    {
                        key: 'Referrer-Policy',
                        value: 'no-referrer'
                    },
                    {
                        key: 'Cross-Origin-Opener-Policy',
                        value: 'same-origin'
                    },
                    {
                        key: 'Cross-Origin-Embedder-Policy',
                        value: 'require-corp'
                    },
                    {
                        key: 'X-Frame-Options',
                        value: 'DENY'
                    },
                    {
                        key: 'Strict-Transport-Security',
                        value: 'max-age=31536000; includeSubDomains'
                    },
                    {
                        key: 'Permissions-Policy',
                        value: 'camera=(), microphone=(), geolocation=(), payment=()'
                    }
                ]
            }
        ];
    }
};

export default nextConfig;
