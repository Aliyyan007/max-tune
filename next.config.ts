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
                        key: 'Access-Control-Allow-Origin',
                        value: '*'
                    },
                    {
                        key: 'Cross-Origin-Opener-Policy',
                        value: 'same-origin'
                    },
                    {
                        key: 'Cross-Origin-Embedder-Policy',
                        value: 'require-corp'
                    }
                ]
            }
        ];
    }
};

export default nextConfig;
