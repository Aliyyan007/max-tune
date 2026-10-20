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
- **Quality is always max** — internal tier `'27'`, mapped per provider
  (Spotify→lossless, Amazon→Max, Apple→alac-hi, Tidal→HI_RES_LOSSLESS…). There is
  intentionally no user-facing quality setting; users pick **platform → codec**
  in Settings (`SOURCE` = keep the native format is the default).
- **Admin panel** — invisible: double-click the tiny dot bottom-right →
  `ADMIN_PASSWORD`. Manages the credential pool (`lib/token-pool.ts`, persisted
  in `data/token-pool.json`) and the Spotify OAuth connect flow.

## Local run quirks (Windows, apostrophe in path)

- The project path contains `'` → `next build` fails in
  `next-metadata-route-loader` (upstream bug, unfixed). Workaround used here:
  `subst Q: "D:\Aliyyan's Projects\Multi Platform 2\Qobuz-DL-main"` and build from `Q:`.
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
  title+artist search in the storefront); if genuinely absent it throws
  "region-locked" and `produceTrackBytes` falls back to qobuz → deezer → tidal
  (ISRC/duration-matched; **~30s previews are rejected and skipped**).
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
- **Tidal** — anonymous v1 token path. Genre is genuinely absent from Tidal's
  catalog API — don't fabricate.
- **Amazon** — hosted gateway (`amz.dezalty.com`) + optional session JSON.
  Track rows lack ISRC — honest gap.
- **Downloads** — upstream byte fetches retry transient net errors
  (`axiosBuf` in server-download.ts: ECONNRESET/ETIMEDOUT/5xx, 3 tries). A CDN
  mid-read reset previously killed whole album zips.

## Known credential-dependent behavior

- **Spotify audio downloads** (librespot via `tools/spotify-native.py` +
  OAuth session) are independent of the metadata path — unaffected by any
  pathfinder hash rotation.
- **Apple** without `APPLE_MEDIA_USER_TOKEN`/`APPLE_WRAPPER_URL` returns the free
  30s iTunes preview — tagged identically, flagged as preview. With wrapper +
  media token, amdl decrypts at the account's region; cross-region adamIds get
  re-resolved in the serving wrapper's storefront (itunes `country=<region>`),
  then qobuz→deezer→tidal fallback if still locked.
- **Tidal/Amazon** free-tier tokens surface the platform's own
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
