# MaxTune — multi-platform music downloader

Fork of [Qobuz-DL](https://github.com/QobuzDL/Qobuz-DL) extended to six providers behind one adapter layer, normalized into the same UI and metadata model.

> [!IMPORTANT]
> This repository does not contain copyrighted material. Downloads use provider-controlled delivery paths and must only be initiated by the account/token owner for content that account is entitled to access. The project does not bypass entitlement, region, or subscription restrictions.

## Platform support and honest account-tier behavior

| Provider | Metadata | Full-audio requirement | Free/preview behavior |
|---|---|---|---|
| **Qobuz** | full catalog metadata | valid Qobuz account token with streaming entitlement | multiple account tokens rotate per download; preview-length/unentitled responses are explicit and are never represented as full audio |
| **Deezer** | full metadata | ARL; paid accounts unlock higher formats | Deezer free accounts may serve provider-authorized 128 kbps MP3 where available; if full audio is unavailable, Deezer's own preview may be served only as a clearly labeled preview |
| **Spotify** | web-player/catalog metadata | connected Spotify session through the admin OAuth flow | full native audio depends on the connected account; when native access is unavailable, a provider-owned 30-second preview may be served only as a clearly labeled preview |
| **Tidal** | public catalog metadata through OAuth client-credentials tokens (`TIDAL_CLIENT_ID`/`TIDAL_CLIENT_SECRET`, with a compatibility catalog-only fallback) | valid user session plus track entitlement/region availability | expired or missing user sessions cannot produce full audio; Tidal's own anonymous/web preview may be served as a clearly labeled preview |
| **Amazon Music** | gateway metadata | Amazon session/token, Widevine device material, and track entitlement | expired gateway JWTs are refreshed from the stored Amazon session when possible; unentitled/free-tier tracks fail explicitly after license validation |
| **Apple Music** | official catalog API | `wrapper-lite` plus an Apple media user token for an account with an active Apple Music subscription | if the native path is unavailable or fails terminally, the same-provider iTunes preview may be served as a clearly labeled preview; it is never represented as a full track |

The downloader never substitutes audio from a different provider in strict download mode and never uses yt-dlp for platform audio.

### Account-pool selection

For Qobuz, Deezer, Tidal, Apple Music, and Amazon Music, playback credentials rotate per download. The resolver tries eligible accounts in priority order: user-supplied credentials, capable/unknown pool accounts, operator env credentials, then known free-tier or recently full-audio-blocked accounts as a last resort. Real provider responses update the pool: auth-dead accounts are disabled, free/limited accounts are deprioritized, region errors are remembered as diagnostics, and successful full-audio accounts are marked capable. If every candidate reports a region/availability restriction, the user receives a clear region-limitation error. If accounts are merely free-tier or unentitled, only the same provider's authorized preview may be served, visibly marked `(Preview)`. Spotify `clientId:secret` entries are metadata credentials rather than playback accounts; Spotify full audio currently uses the single OAuth session connected in the admin panel.

## Architecture

- **Next.js web service** — UI, metadata/search APIs, request validation, job creation, status, cache-hit redirects.
- **Redis/Upstash durable queue** — job state in hashes, atomic Lua claim/recovery, worker leases, delayed retries, cancellation, and capability queues (`generic`, `apple`).
- **Download worker** — separate process/service. Produces audio to temporary files rather than buffering whole tracks in memory, validates duration/container/archive structure, uploads artifacts, and only then marks jobs complete.
- **Complete-artifact fast lane** — after a track file is fully produced and validated, the worker can serve that exact file directly to the initiating browser while the normal R2 upload continues in parallel. This avoids exposing partially produced media, still preserves the R2 artifact/cache path, and falls back to the usual post-upload redirect when the direct lane is unavailable or expired. It requires `WORKER_PUBLIC_URL` plus the shared job-encryption secret and is bounded by `LIVE_MAX_STREAMS`.
- **Cloudflare R2 artifact store** — streamed uploads, size/ETag verification, SHA-256 metadata, deterministic recipe cache keys, LRU accounting, and presigned browser delivery.
- **Album ZIP jobs** — use the same queue/worker/artifact path as single tracks. Archives are written incrementally to disk with valid ZIP central directories and CRCs.
- **Observability** — `/api/health`, `/api/ready`, `/api/metrics`, `/api/platform-health`, worker `/`, `/ready`, `/metrics`.
- **Security posture** — no default admin password, admin rate limiting, optional AES-GCM encryption of Redis job payloads/shared credential state, no provider tokens in job-status responses.

Queue mode is enabled when `UPSTASH_REDIS_URL` and `UPSTASH_REDIS_TOKEN` are configured. Without them the app retains the local in-process download path for development/single-user use. In production the legacy direct `/api/stream-audio` path is disabled by default (`ENABLE_LEGACY_STREAM_AUDIO=1` re-enables it deliberately), and request-supplied Apple wrapper URLs are ignored unless `ALLOW_USER_APPLE_WRAPPER=1` because arbitrary wrapper endpoints would otherwise create a blind-SSRF risk.

## Production deployment (Render blueprint)

`render.yaml` defines:

- **`max-tune`** — Next.js web service, health checked at `/api/health`.
- **`max-tune-worker`** — worker service binding Render's required port, readiness endpoint at `/ready`, metrics at `/metrics`.
- **`maxtune-shared`** — shared secret env group.

Required shared infrastructure secrets:

- `UPSTASH_REDIS_URL`, `UPSTASH_REDIS_TOKEN`
- `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
- `JOB_PAYLOAD_ENCRYPTION_KEY` — strong random secret
- `ADMIN_PASSWORD` — strong unique password

Provider credentials are environment-specific: `QOBUZ_APP_ID`, `QOBUZ_SECRET`, `QOBUZ_AUTH_TOKENS`, `DEEZER_ARL`, `TIDAL_CLIENT_ID`/`TIDAL_CLIENT_SECRET` for public Tidal metadata plus `TIDAL_ACCESS_TOKEN`/`TIDAL_REFRESH_TOKEN` for playback, `SPOTIFY_SESSION_JSON`, `APPLE_MEDIA_USER_TOKEN`, `APPLE_WRAPPER_URL`, `AMAZON_MUSIC_TOKEN`/`AMAZON_SESSION_JSON`/`AMAZON_DEVICE_WVD_B64` as applicable. The admin API also accepts an authenticated `import-amazon-session` action; it stores the session in the encrypted Redis bridge so both web and worker can refresh expired gateway JWTs after ephemeral redeploys.

Production queue mode requires R2. Redis-inline media results are a development fallback only (`ALLOW_INLINE_RESULTS=1`) and are deliberately disabled in production.

### Worker scaling

The Render blueprint currently sets `WORKER_CONCURRENCY=3` because download jobs are predominantly network-bound and multi-user FIFO waiting is otherwise severe. Monitor CPU, disk, provider errors, and wrapper stability; horizontal worker instances remain the safer way to scale beyond a small concurrency value. Use:

- `WORKER_CAPS=generic` for normal workers.
- `WORKER_CAPS=generic,apple` only where `APPLE_WRAPPER_URL` is reachable.

Set `WORKER_PUBLIC_URL` to the worker service's externally reachable base URL (for this deployment, `https://max-tune-worker.onrender.com`) so the web service can hand browsers a tokenized direct-artifact URL. The direct lane is an optimization, not the correctness path: jobs still upload to and verify against R2 before completion.

Workers heartbeat their leases. Crash recovery is automatic; transient network/tool failures retry with backoff. Where a provider legitimately exposes a same-provider preview, entitlement failure degrades to that labeled preview instead of a silent full-track fake; otherwise region/entitlement failures are terminal and explicit.

## Apple Music wrapper

`wrapper-lite` is the one component that needs an always-on machine. It is an unauthenticated decryption service, so restrict network access to trusted worker egress addresses.

Options:

- **GCP always-free e2-micro** — Debian + QEMU TCG; see the detailed recipe in `AGENTS.md`.
- **Any always-on Linux machine** — `wrapper-lite-rootless` (user namespaces, no QEMU).
- **Windows machine** — `tools\wrapper\wrapper-lite-qemu.exe` while that machine is running.
- **No wrapper** — Apple metadata works; full-track downloads cannot be produced, but the same-provider iTunes preview can still be served with explicit preview labeling.

`APPLE_WRAPPER_URL` accepts a comma-separated list for multiple storefronts.

## Local development

Requirements: Node.js LTS, npm, Python 3, and ffmpeg (or the bundled `ffmpeg-static` binary).

```bash
npm install
npm run dev
```

Production verification on Windows (including checkouts whose path contains an apostrophe — the Next.js metadata-loader issue is patched during `postinstall`):

```powershell
$env:TEMP="$PWD\.tmp"; $env:TMP="$PWD\.tmp"
npm run build
npm run build:worker
npx next start -p 3100
node --env-file=.env worker.mjs
$env:BASE="http://localhost:3100"; node tools/test-suite.mjs
```

Do not build from a `subst` drive root such as `Q:\`; Next.js can omit the stylesheet link from prerendered HTML in that layout, leaving the UI unstyled. Build from the real checkout path or a nested directory instead.

The verification suite exercises metadata, downloads, ffprobe container/artwork validation, admin authentication, queue artifacts, and album ZIPs. Provider tests requiring expired or absent credentials are expected to report explicit credential/entitlement failures rather than fake success.

## Docker

```bash
docker build -t qobuz-dl .
docker compose up -d
```

For queue mode, fill `UPSTASH_REDIS_*` and `R2_*` in `.env`, then:

```bash
docker compose --profile queue up --build
```

The image is based on Node 22 Alpine and provisions the pinned Python native-tool environment plus the Linux Apple downloader during build.

## Operational runbook

### Job appears stuck

1. Check `/api/metrics` for queue depth, inflight count, and worker heartbeat staleness.
2. Check worker `/metrics` for `active`, `lastError`, retry and failure counters.
3. Lease-expired jobs are automatically requeued. If no worker is heartbeating, restart the worker service.
4. Terminal region/entitlement/preview failures are intentional and should not be retried indefinitely.

### Apple downloads fail

1. Check `/api/platform-health` → `apple.details` and wrapper regions.
2. Verify `APPLE_MEDIA_USER_TOKEN` is present and not expired.
3. Verify every comma-separated `APPLE_WRAPPER_URL` is reachable from the worker, not merely from your browser.
4. Confirm the track exists in one of the wrapper account storefronts. Region locks are honest failures unless another Apple storefront adamId is available.

### Spotify downloads fail

1. Confirm the OAuth/native session exists (`SPOTIFY_SESSION_JSON` or Admin → Connect Spotify).
2. Metadata client credentials do not authorize audio downloads.
3. Free/non-eligible accounts can fail full native streaming; this is provider enforcement, not a pipeline fallback case.

### Tidal metadata/download fails

1. Public metadata should use OAuth client credentials. Configure `TIDAL_CLIENT_ID`/`TIDAL_CLIENT_SECRET` from your own Tidal developer app for production; the built-in compatibility client is only a fallback.
2. Tidal user access tokens expire. Reconnect through the admin device-flow or configure a valid refresh token.
3. Full playback remains entitlement- and region-gated even with a valid session.

### Cache/artifact problems

1. Check `/api/ready` — production queue mode should report `artifactStore: r2`.
2. Check R2 credentials, bucket name, and endpoint.
3. Cached artifact keys include provider, track/album, codec, bitrate, metadata/tagging, artwork recipe, and an opaque credential-scope hash. Artifacts produced with request-supplied user credentials are not shared with unrelated users; jobs using the deployment's shared credential pool intentionally share the pool-scoped cache.
4. LRU eviction accounting is visible in `/api/metrics` as `trackedBytes`.

## Contributing

1. Fork the repository.
2. Create a branch: `git checkout -b feature-name`.
3. Make the change and run `npx tsc --noEmit`, `npm run build`, `npm run build:worker`, and `node tools/test-suite.mjs` where credentials permit.
4. Open a pull request.

## License

This project is licensed under the [MIT License](LICENSE).
