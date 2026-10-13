# syntax=docker/dockerfile:1

# ---- runtime base: system Chromium + fonts (kept first so its layer stays cached) ----
FROM node:22-bookworm-slim AS runtime-base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y chromium fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 --no-install-recommends && rm -rf /var/lib/apt/lists/*

# ---- deps ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
# The lockfile is written by npm 11; the npm 10 bundled with Node 22 rejects it as out of sync
RUN npm install -g npm@11.13.0 && npm ci

# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
# pdfjs-dist dynamically loads its worker and @napi-rs/canvas (DOMMatrix polyfill), which standalone tracing misses,
# so ship both packages whole (minus the unused musl canvas binaries)
RUN mkdir -p /extra/node_modules \
    && cp -a node_modules/pdfjs-dist /extra/node_modules/ \
    && if [ -d node_modules/@napi-rs ]; then cp -a node_modules/@napi-rs /extra/node_modules/ && rm -rf /extra/node_modules/@napi-rs/*-musl; fi

# ---- runtime ----
FROM runtime-base AS runtime
WORKDIR /app
# HOME is /tmp because the root filesystem is read-only at runtime (Chromium writes profile data there)
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    HOME=/tmp \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Code stays root-owned and read-only for the app user
COPY --from=build /app/.next/standalone ./
COPY --from=build /extra/node_modules ./node_modules
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# generatePdf.ts reads these relative to process.cwd()
COPY --from=build /app/src/lib/fonts ./src/lib/fonts
COPY config/business.example.json ./config/business.example.json

RUN mkdir -p /app/config /app/.next/cache && chown node:node /app/config /app/.next/cache

USER node
EXPOSE 3000
VOLUME ["/app/config"]
CMD ["node", "server.js"]
