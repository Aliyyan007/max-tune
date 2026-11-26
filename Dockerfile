# ---- deps: install node_modules once ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY tools/apply-patches.mjs ./tools/apply-patches.mjs
RUN npm ci

# ---- build: compile the Next.js production bundle ----
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm run build:worker && npm prune --omit=dev

# ---- runner: minimal prod image ----
# python3 + ffmpeg drive the native download tools (spotify/amazon/apple)
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# free tier is 512Mi — keep node from trying to over-allocate
ENV NODE_OPTIONS=--max-old-space-size=384

COPY --from=build /app/tools ./tools

# Native tools are provisioned in one pinned, isolated venv shared by web and
# worker commands. The same script is used by Render so dependency behavior
# does not drift between deployment targets.
RUN apk add --no-cache bash curl python3 py3-pip ffmpeg libogg libvorbis opus opusfile \
    && bash tools/provision-worker.sh

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/worker.mjs ./worker.mjs
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./next.config.ts
RUN mkdir -p data

# point the native tools at the provisioned venv python
ENV NATIVE_PYTHON=/app/.venv-worker/bin/python

# Render (and most PaaS) inject $PORT — next start honours it; 3000 local default.
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
