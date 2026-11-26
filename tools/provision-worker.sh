#!/usr/bin/env bash
# Provision native tooling for the Linux worker (Render/Docker build step).
# - bin/amdl             : Apple Music downloader (linux amd64 ELF)
# - .venv-worker/python  : librespot + pywidevine isolated from system packages
set -euo pipefail

mkdir -p bin
if [ ! -f bin/amdl ]; then
  echo "[provision] fetching pinned amdl_linux_amd64 v0.1.0"
  curl -fsSL "https://github.com/zhaarey/apple-music-downloader/releases/download/v0.1.0/amdl_linux_amd64" -o bin/amdl
  # The release asset is externally hosted; pin its digest so a replaced or
  # truncated artifact cannot become executable worker code silently.
  echo "949e287d0fd92d0960ae9b14a0582c1056afaa78a7f66d486648d80673ef8d59  bin/amdl" | sha256sum -c -
  chmod +x bin/amdl
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[provision] ERROR: python3 is required for Spotify/Amazon native jobs" >&2
  exit 1
fi

python3 -m venv .venv-worker
PIP=.venv-worker/bin/pip

# librespot needs protobuf==3.20.1 while pywidevine needs >=6.33. Install
# pywidevine first, then librespot without dependency resolution plus its
# remaining runtime deps. tools set PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python
# so the old generated protos remain compatible with protobuf 6.x.
"$PIP" install --no-cache-dir --upgrade pip >/dev/null
"$PIP" install --no-cache-dir "pywidevine==1.9.0"
"$PIP" install --no-cache-dir --no-deps "librespot==0.0.10"
"$PIP" install --no-cache-dir \
  "requests==2.34.2" "websocket-client==1.9.2" "zeroconf==0.151.5" \
  "PyOgg==0.6.14a1" "PyYAML==6.0.3" "Unidecode==1.4.0" \
  "pycryptodomex==3.24.0" "defusedxml==0.7.1"

.venv-worker/bin/python -c "import librespot" && echo "[provision] librespot ok"
.venv-worker/bin/python -c "import pywidevine" && echo "[provision] pywidevine ok"
