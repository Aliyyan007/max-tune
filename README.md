# MaxTune — multi-platform music downloader

Fork of [Qobuz-DL](https://github.com/QobuzDL/Qobuz-DL) extended to six providers behind one adapter layer, all normalized into the same UI/metadata model.

> [!IMPORTANT]
> This repository does not contain any copyrighted material, or code to illegaly download music. Downloads are provided by provider APIs and should only be initiated by the token/account owner. The author is **not responsible for the usage of this repository nor endorses it**.

## Platforms

| Provider | Metadata | Downloads |
|---|---|---|
| **Qobuz** | full | lossless (account token) |
| **Deezer** | full | 128k MP3 free tier · FLAC with paid ARL |
| **Spotify** | full (web-player gateway) | librespot session (OAuth via admin panel) |
| **Tidal** | full | entitlement-gated — needs paid-tier token |
| **Amazon** | via gateway | entitlement-gated — needs Unlimited session |
| **Apple** | official catalog API | ALAC via `wrapper-lite` + media-user-token · 30s preview without |

## Features

- Same Qobuz-shaped UI for every platform — search, artist/album pages, releases, artwork
- Server-side downloads: resolve → decrypt → ffmpeg tag/art → browser stream
- `SOURCE` codec (native format) is the default; transcode to FLAC/MP3/ALAC/etc on demand
- Optional production layer: **Upstash queue** + **Cloudflare R2** cache (repeat downloads are instant and never re-hit providers)

## Production deploy (Render blueprint)

`render.yaml` defines two free-tier services + one shared env group (`maxtune-shared`):

- **`maxtune-web`** — the Next.js app (search/UI/API)
- **`maxtune-worker`** — the download worker (`WORKER_CAPS=generic,apple`) — consumes the Redis queue, produces tagged audio, stores to R2

Secrets needed in the shared group: `UPSTASH_REDIS_URL/TOKEN`, `R2_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY`, `APPLE_MEDIA_USER_TOKEN`, `DEEZER_ARL`, `QOBUZ_APP_ID/APP_SECRET`, `ADMIN_PASSWORD`.

Without `UPSTASH_*` the app runs fully in-process — queue mode is optional.

### Apple Music wrapper (the one piece that needs "a machine")

`wrapper-lite` serves the decryption endpoints amdl calls. Host options:

- **GCP always-free e2-micro** — Debian + QEMU TCG, 30GB disk, systemd service — the recipe is in `AGENTS.md`
- **Any Linux box** — `wrapper-lite-rootless` (user namespaces, no QEMU, near-native speed)
- **Windows PC** — `tools\wrapper\wrapper-lite-qemu.exe` (only while the machine is on)
- **Skip it** — Apple falls back to the iTunes preview honestly

## Table of Contents

- [Platforms](#platforms)
- [Production deploy](#production-deploy-render-blueprint)
- [Installation](#installation)
- [Contributing](#contributing)
- [License](#license)

## Installation

Before you begin, ensure you have the following installed:

- **Node.js** (LTS version recommended)  
  Download from: [https://nodejs.org/](https://nodejs.org/)

- **npm** (comes with Node.js)  
  To check if npm is installed, run:
    ```bash
    npm -v
    ```

## Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/QobuzDL/Qobuz-DL.git
```

### 2. Navigate to the project directory

```bash
cd Qobuz-DL
```

### 3. Install Dependencies

```bash
npm i
```

### 4. Run the development server

```bash
npm run dev
```

## Docker Installation

### 1. Clone the repo

```bash
git clone https://github.com/QobuzDL/Qobuz-DL.git
```

### 2. Navigate to the project directory

```bash
cd Qobuz-DL
```

### 3. Dockerfile build

```bash
docker build -t qobuz-dl .
```

### 4. Docker compose

```bash
docker-compose up -d
```

### Setup .env (IMPORTANT)

Before you can use Qobuz-DL, you need to change the .env file in the root directory. The default configuration will NOT work. QOBUZ_APP_ID and QOBUZ_SECRET must be set to the correct values. To find these you can use [this tool](https://github.com/QobuzDL/Qobuz-AppID-Secret-Tool).
Additionally, in order to download files longer than 30 seconds, a valid Qobuz token is needed. This can be found in the localuser.token key of localstorage on the [official Qobuz website](https://play.qobuz.com/) for any paying members.

## Contributing

1. Fork the repository.
2. Create a new branch: `git checkout -b feature-name`.
3. Make your changes.
4. Push your branch: `git push origin feature-name`.
5. Create a pull request.

## License

This project is licensed under the [MIT License](LICENSE).
