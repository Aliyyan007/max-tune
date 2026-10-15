# ---- deps: install node_modules once ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile the Next.js production bundle ----
FROM node:20-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner: minimal prod image ----
# python3 + ffmpeg drive the native download tools (spotify/amazon/apple)
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# free tier is 512Mi — keep node from trying to over-allocate
ENV NODE_OPTIONS=--max-old-space-size=384

# librespot needs protobuf==3.20.1 while pywidevine needs >=6.33 — pip can't
# co-resolve them, so install pywidevine (pulls protobuf 6.x) then librespot
# with --no-deps + its remaining deps. PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION
# (PY_ENV in code) makes the old protos work under protobuf 6 — proven locally.
RUN apk add --no-cache python3 py3-pip ffmpeg libogg libvorbis opus opusfile \
    && python3 -m venv /opt/py \
    && /opt/py/bin/pip install --no-cache-dir pywidevine \
    && /opt/py/bin/pip install --no-cache-dir --no-deps librespot==0.0.10 \
    && /opt/py/bin/pip install --no-cache-dir \
        "requests>=2.32" "websocket-client>=1.8" "zeroconf>=0.146" \
        "PyOgg==0.6.14a1" "PyYAML<7,>=6.0.3" "Unidecode>=1.3.7" pycryptodomex defusedxml

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tools ./tools
RUN mkdir -p data

# point the native tools at the venv python
ENV NATIVE_PYTHON=/opt/py/bin/python

# Render (and most PaaS) inject $PORT — next start honours it; 3000 local default.
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
