# Multi-platform Qobuz-DL — agent notes

## What this is

Qobuz-DL frontend extended to six music platforms behind one adapter layer:

- **Platform adapters** — `lib/platforms/{deezer,tidal,spotify,apple,amazon}.ts`; Qobuz
  wraps the existing `lib/qobuz-dl-server.tsx` functions. All normalize provider
  responses into the Qobuz-shaped types the UI already renders.
- **Routing** — every API route reads `?source=` (`lib/platforms/index.ts`) and
  `Service-Tokens`/`Token-Country` headers (`lib/service-tokens.ts`).
- **Downloads are server-side** — client POSTs a `DownloadSpec` to
  `POST /api/download-file` → gets a job id → navigates to `GET
  /api/download-file?job=<id>` so the browser's download manager owns the file.
  `lib/server-download.ts` resolves provider audio, decrypts (Deezer blowfish,
  Amazon Widevine), tags via `ffmpeg-static` and streams. Progress/cancel via
  `GET|POST /api/job-status`. No client ffmpeg.wasm.
- **Download pipeline architecture** (post-refactor): one resolver
  (`produceTrackStream`) per source — downloads are STRICTLY single-platform:
  no cross-platform audio substitution. Region locks, entitlement walls and
  preview-only tiers return honest errors (user picks another platform
  deliberately; metadata/search fallback still lives in the adapters). Output:
  `A` passthrough (no work), `B` streaming FLAC/MP3 retaggers
  (`lib/media-taggers.ts` — exact Content-Length, zero ffmpeg), `D` staged-file
  (one ffmpeg pass to a temp dir → `Content-Length` + `Range` resume via a
  10-min `stagedRegistry`; streamable inputs feed ffmpeg's stdin live — no
  drain-then-encode serial pass). Streaming A/B outputs are tee'd to disk so
  EVERY path supports Range-resume. Resolver claims are never trusted — the
  real container is sniffed from magic bytes (`sniffExt`) before the output
  ext is chosen. Plain-URL sources are wrapped in `resilientStream`
  (Range-reconnect on CDN drops + 60s idle watchdog; the reconnect path is
  serialized and dedups a full-replay response). Deezer's CDN CL can
  over-promise ~4B (`tailPad`) and `Blowfish.PADDING.NULL` strips trailing
  zeros per block — decoded blocks must be re-padded to 2048. All stream
  chains use `stream.pipeline` — bare `.pipe()` was the crash-on-error and
  leaked-socket bug. Preview detection: resolver flags + qobuz returned
  `duration` + a ~64kbps×duration size floor. Hidden/truncated previews still
  fail; when full native access is unavailable, Tidal/Deezer/Spotify/Apple may
  fall back only to the SAME provider's authorized preview asset and the artifact
  is visibly marked `(Preview)` with preview metadata. Pure region exhaustion is
  not preview-masked: it returns a clear region-limitation error.
- **Spotify** downloads go through a persistent librespot daemon
  (`tools/spotify-native.py --daemon` + `SpotifyDaemon` in native-tools.ts) —
  session stays warm; per-track cost is just the CDN fetch. Serialized by
  design (one stream per session).
- **Quality is always max** — internal tier `'27'`, mapped per provider
  (Spotify→lossless, Amazon→Max, Apple→alac-hi, Tidal→HI_RES_LOSSLESS…). There is
  intentionally no user-facing quality setting; users pick **platform → codec**
  in Settings (`SOURCE` = keep the native format is the default).
- **Admin panel** — invisible: double-click the tiny dot bottom-right →
  `ADMIN_PASSWORD`. Manages the credential pool (`lib/token-pool.ts`, persisted
  in `data/token-pool.json`) and the Spotify OAuth connect flow. Pool entries
  carry best-effort region/tier/full-audio capability metadata learned from
  provider sessions and real download attempts. Qobuz/Deezer/Tidal/Apple/Amazon
  playback accounts rotate per download; known free-tier accounts are
  deprioritized and full-audio-blocked accounts are last-resort preview
  candidates. Spotify `clientId:secret` pool entries are metadata credentials,
  not playback accounts — Spotify full audio still uses the single connected
  OAuth/native session.

## Local run quirks (Windows, apostrophe in path)

- The project path contains `'`. The upstream `next-metadata-route-loader`
  apostrophe bug is patched by `tools/apply-patches.mjs` during `postinstall`;
  build from the real checkout root. Do **not** map the checkout itself to a
  `subst` drive root (`Q:\`) and build there: Next then emits manifest keys with
  a doubled drive separator, omits the stylesheet link from prerendered HTML,
  and the UI appears completely unstyled. If a subst workaround is ever needed,
  map the parent directory and build from a nested project path instead.
- `C:\Users\*\AppData\Local\Temp\msdtadmin` is unreadable → a glob over Temp fails
  the build. Set `$env:TEMP="$PWD\.tmp"; $env:TMP="$PWD\.tmp"` for builds.
- If `npm install` stalls on `ffmpeg-static`'s postinstall (GitHub download),
  run `npm install --ignore-scripts` then copy `ffmpeg.exe` from a sibling
  install, or just re-run `npm install` later.

## Verification

```bash
npx tsc --noEmit && npx eslint .          # types + lint
$env:TEMP="$PWD\.tmp"; $env:TMP="$PWD\.tmp"; npx next build   # prod build
npx next start -p 3100                    # prod server
$env:BASE="http://localhost:3100"; node tools/test-suite.mjs  # strict e2e suite
```

The suite exercises search/album/artist/download (incl. ffprobe container +
embedded-art checks), admin auth, and the album-zip flow for every platform.

## Apple pipeline (wrapper-lite + amdl)

- **`bin/amdl.exe`** (zhaarey apple-music-downloader) needs the **`wrapper-lite`
  HTTP service** — `tools\wrapper\wrapper-lite-qemu.exe`, a self-contained QEMU
  guest that boots Apple's decryption environment. Source: `github.com/
  WorldObservationLog/wrapper`, `lite` branch — the Windows CI artifact
  (`wrapper-lite-qemu-windows-x86_64`) bundles QEMU + the guest image.
- **One-time login:** `wrapper-lite-qemu.exe --login "appleid:pass"` → type the
  2FA code → session caches into `qemu/data.img` permanently. Then plain
  `.\wrapper-lite-qemu.exe` serves `http://127.0.0.1:12340` (endpoints
  `/m3u8 /key /lyrics /license /webplayback /status`).
- **`APPLE_WRAPPER_URL` accepts a comma-separated list** — each instance can
  hold a different-region account; per-track probing picks whichever wrapper's
  region serves the adamId. Admin panel can set it server-side too.
- **Region locks:** the wrapper only decrypts what its account's storefront
  licenses (`/status` → `regions`). On a lock, `downloadAppleNative` first
  re-resolves the recording under a different per-region adamId (ISRC →
  title+artist search in the storefront — same platform, still "apple");
  if genuinely absent it throws "region-locked" — there is no cross-platform
  audio fallback, the error surfaces to the user.
- amdl needs `media.get-m3u8-mode: "all"` (avoids Invalid CKC) and canonical
  `…/album/<collectionId>?i=<trackId>` URLs — bare `/song/<id>` 404s. Both are
  handled in `native-tools.ts`.
- Public wrapper federation is gRPC-only (`wm.wol.moe`) — no public lite-HTTP
  endpoints exist; multi-region means a second local wrapper + account.

### Hosting wrapper-lite (self-hosting recipe)

The wrapper is just an HTTP service — it needs *one machine that stays on*. The
workers call it remotely via `APPLE_WRAPPER_URL`; it doesn't have to run beside them.

**GCP always-free e2-micro** (this deployment):
- `e2-micro`, Debian 12/13, us-central1/us-west1/us-east1, 30GB standard disk → $0/mo
- `sudo apt install qemu-system-x86` → build `wrapper-lite-qemu` from the repo's
  `lite` branch (`g++ wrapper-lite-qemu.cpp -o wrapper-lite-qemu`), copy
  `vmlinuz-lite-qemu`/`lite-initramfs.cpio.gz`/`data.img` beside it
- `data.img` carries the Apple login — move it with `scp` to keep the session
- systemd unit launches the wrapper on boot; QEMU runs TCG (no /dev/kvm on
  free tiers) — boot ~60-90s, then serves `0.0.0.0:12340`
- Expose via VPC firewall rule `tcp:12340` (restrict source ranges to your
  worker's egress IPs — the wrapper API is unauthenticated)

**Alternatives**: any always-on Linux box can run `wrapper-lite-rootless` (user
namespaces, no QEMU — near-native speed); a Windows machine runs
`tools\wrapper\wrapper-lite-qemu.exe` directly (only while it's on).

## Upstream API architecture (per platform)

- **Spotify** — primary path is the web-player's own federation gateway
  (`api-partner.spotify.com/pathfinder/v2/query`) behind an **anonymous
  web-player token** (`lib/platforms/spotify-partner.ts`): server-time →
  rotating TOTP secrets (`secretDict.json`, XOR `(i%33)+9`, latest version) →
  `open.spotify.com/api/token`. Persisted ops used: `searchDesktop`,
  `getAlbum`, `getTrack`, `queryArtistOverview`, `queryArtistDiscography(All)`
  — one call returns complete artist discography/top-tracks/bio; no dev-app
  429s. The public Web API (`client_credentials`) remains as fallback — op
  hashes that go stale get auto-disabled (`pfOpDead`) after 'Invalid query
  hash' responses. Search rows lack `isrc`/`trackNumber`; bounded `getAlbum`
  calls per unique album fill album stats AND piggyback track positions.
  Federation returns partial `errors[]` alongside data — only fail when
  `data` is absent entirely.
- **Deezer** — primary is `www.deezer.com/ajax/gw-light.php` methods
  (`deezer.pageSearch/pageAlbum/pageArtist`) with an anonymous session
  (cookie + checkForm from `deezer.getUserData`). One call = full metadata.
  `pageSearch` album/track nodes lack duration+genre → bounded `pageAlbum`
  enrichment per unique album. Artist discography pagination stays on the
  public REST API (`/artist/{id}/albums`) — `pageArtist`'s ALBUMS section
  ignores paging params.
- **Apple** — metadata is the official catalog API
  `api.music.apple.com/v1/catalog/{storefront}` with a dev JWT scraped from
  music.apple.com's JS bundle (`apple-index.js`, `iss: AMPWebPlay`). Real
  totals/pagination, genres, ISRC, durations. Gaps filled by bounded detail
  calls: album duration = sum of `/albums/{id}` tracklist (cached), artist
  ids via `/songs/{id}` relationships (search rows carry neither). iTunes
  Search API kept as fallback. Artist images do not exist anywhere in Apple's
  APIs — honest placeholder.
- **Tidal** — public metadata uses legacy v1 catalog endpoints authenticated with
  an OAuth client-credentials token (`TIDAL_CLIENT_ID`/`TIDAL_CLIENT_SECRET`, or
  the compatibility device client when unset). User bearer sessions are still
  required for playback. Genre is genuinely absent from Tidal's catalog API —
  don't fabricate.
- **Amazon** — hosted gateway (`amz.dezalty.com`) + optional mobile session JSON.
  Gateway JWT expiry is detected locally; refresh uses the exported website
  cookies, then the fresh credential is mirrored through the Redis-backed token
  pool for web/worker sharing. The admin `import-amazon-session` action stores
  a full session export in the encrypted Redis bridge when env provisioning is
  impractical; malformed/partial env or file copies must not shadow that valid
  shared copy. Widevine licenses use the signed mobile
  `getLicenseForPlaybackV2` path in `tools/amz-license.py` and are validated
  before media bytes download. `CUSTOMER_NOT_ELIGIBLE`/`REQUEST_BLOCKED` are
  honest plan or per-track availability failures, not token-refresh bugs.
  Track rows lack ISRC — honest gap.
- **Downloads** — upstream byte fetches retry transient net errors
  (`axiosBuf` in server-download.ts: ECONNRESET/ETIMEDOUT/5xx, 3 tries). A CDN
  mid-read reset previously killed whole album zips.

## Known credential-dependent behavior

- **Spotify audio downloads** (librespot via `tools/spotify-native.py` +
  OAuth session) are independent of the metadata path — unaffected by any
  pathfinder hash rotation.
- **Apple** first tries the wrapper+amdl native path when
  `APPLE_MEDIA_USER_TOKEN`/`APPLE_WRAPPER_URL` are present. If that path is
  unavailable or fails terminally, the same-provider iTunes preview may be
  served as a clearly labeled degraded artifact; it is never represented as a
  full track. With wrapper + media token on an active Apple Music subscription,
  amdl decrypts at the account's region; cross-region adamIds get re-resolved
  in the serving wrapper's storefront (itunes `country=<region>`) — still the
  same platform, never another provider's audio.
- **Tidal** may similarly serve its own anonymous/web preview when full-track
  entitlement is absent. **Amazon** free-tier tokens surface the platform's own
  eligibility/entitlement error — honest failure, not a bug.

## Normalization pitfalls (hard-won)

- **`getType` must not rely on `albums_count` alone** — `JSON.stringify` drops
  `undefined` fields, so an artist card whose count is unknown arrives with no
  `albums_count` key at all → got misclassified as an album → `album.genre.name`
  crashed the whole page on the artists tab. `getType` now also matches artists
  structurally (`name` without `title`). Keep undefined-count semantics on
  `QobuzArtist.albums_count` (`undefined` = unknown → "Releases"; `0` = real
  zero → "0 Releases") — don't revert it to always-0 or this recurs.
- **`parseArtistData` is Qobuz-array-only** — adapters return `releases` as a
  keyed object; guard with `Array.isArray` before touching `.length`/`.forEach`
  or every non-Qobuz artist dialog throws into the catch toast.
- **QEMU/wrapper must stay running** for Apple downloads — it dies with its
  parent shell; restart `tools\wrapper\wrapper-lite-qemu.exe` for daily use.

## Production queue architecture (current)

- Queue mode is active when `UPSTASH_REDIS_URL` + `UPSTASH_REDIS_TOKEN` are set.
  Job state lives in Redis hashes `job:<id>`; queue lists contain only ids.
  Claims, cancellation, delayed retry, heartbeats, and stale recovery are Lua
  scripts in `lib/queue.ts` — do not replace them with non-atomic RPOP/ZADD
  sequences.
- Workers use file-backed production (`stageToFile`) and streamed R2 uploads
  (`cachePutFile`). Do not reintroduce `produceTrackBytes`/`tagAndEncode` in
  worker hot paths; those buffer whole tracks and tagged outputs in memory.
- Album ZIPs are queue jobs too (`kind=zip`) and are written by
  `lib/album-zip-produce.ts` as valid store-only ZIPs on disk. Python
  `zipfile.testzip()` validation passed locally; keep CRC/central-directory
  validation before publishing.
- R2 cache keys are output recipes (`cacheKeyFor`/`zipCacheKeyFor`), not just
  provider+id+codec. Tagging, artwork, bitrate, and metadata choices are part
  of the identity. Raw credentials must never appear in keys; request-supplied
  audio credentials contribute only an opaque credential-scope hash so one
  user's entitled artifact cannot become another user's cache hit. Pool/env
  credential jobs intentionally share the pool-scoped cache.
- Track and album-zip POSTs reserve short-lived Redis dedupe keys derived from
  those output recipes; duplicate browser/client submissions attach to the
  existing job instead of occupying another queue slot. Autocomplete searches
  pass `light=1`, which skips nonessential per-item enrichment; submitted
  searches render light rows first and merge the fully enriched response when
  it arrives. Homepage "recently downloaded" entries are browser-local
  localStorage metadata, not a server-wide history.
- Queue-mode GET endpoints are intentionally non-blocking. Clients poll
  `/api/job-status` and only call GET after `stage=done`; the GET redirects to
  a freshly presigned artifact URL. Long-polling the web service defeats the
  split. Browser clients use navigation for queue artifacts because cross-origin
  R2 redirects are not fetchable without bucket CORS; do not regress this into
  a `fetch()`-only path.
- The legacy `/api/stream-audio` route performs provider work in the web process
  and is disabled in production unless `ENABLE_LEGACY_STREAM_AUDIO=1`. Keep new
  download work in queue workers.
- Request-supplied Apple wrapper URLs are ignored in production unless
  `ALLOW_USER_APPLE_WRAPPER=1`; arbitrary wrapper endpoints are a blind-SSRF
  primitive. Prefer operator env/admin configuration.
- Redis-inline results are development-only. Production workers fail if R2 is
  absent unless `ALLOW_INLINE_RESULTS=1` is explicitly set.
- Set `JOB_PAYLOAD_ENCRYPTION_KEY` in production. It encrypts job payloads,
  result URLs/metadata, sensitive errors, and Redis-bridged credential pool
  values with AES-GCM. Losing/rotating it makes existing encrypted jobs unreadable.
- Admin has no default password. If `ADMIN_PASSWORD` is absent the admin API is
  disabled by design. Correct passwords reset the per-IP failure limiter.
- Worker provisioning is shared by Docker and Render: `tools/provision-worker.sh`
  creates `.venv-worker` and downloads pinned Linux `bin/amdl`. Docker copies
  `worker.mjs`; Render builds it with `npm run build:worker`.
- Tidal public metadata uses OAuth client-credentials tokens; configure
  `TIDAL_CLIENT_ID`/`TIDAL_CLIENT_SECRET` for production. Playback still requires
  a user session/refresh token and remains entitlement/region gated; do not
  fabricate metadata or substitute another provider.
