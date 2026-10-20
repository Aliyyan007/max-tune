#!/usr/bin/env bash
# Provision native tooling for the Linux worker (Render build step).
# - bin/amdl          : Apple Music downloader (linux amd64 ELF)
# - librespot         : Spotify download backend (tools/spotify-native.py)
set -e

mkdir -p bin
if [ ! -f bin/amdl ]; then
  echo "[provision] fetching amdl_linux_amd64"
  curl -fsSL "https://github.com/zhaarey/apple-music-downloader/releases/download/v0.1.0/amdl_linux_amd64" -o bin/amdl
  chmod +x bin/amdl
fi

if command -v python3 >/dev/null 2>&1; then
  echo "[provision] python3 present — installing librespot + pywidevine"
  (pip install --quiet librespot pywidevine requests || pip3 install --quiet librespot pywidevine requests || true) && echo "[provision] python deps ok" || echo "[provision] python deps failed — spotify/amazon jobs will surface errors"
else
  echo "[provision] no python3 — spotify/amazon jobs will surface errors"
fi
