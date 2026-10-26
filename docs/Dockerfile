# syntax=docker/dockerfile:1

# ── Stage 1: build the real Dockflow WebUI, embedded as a live demo on the landing page ──
FROM node:24-alpine AS ui-builder

RUN npm install -g pnpm@9

WORKDIR /ui

COPY cli/ui/package.json cli/ui/pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.pnpm-store \
    pnpm install --frozen-lockfile --store-dir=/root/.pnpm-store

COPY cli/ui/. .
# @api-types resolves to ../src/api/types (cli/ui/tsconfig.json), outside cli/ui/ itself.
COPY cli/src/api/types.ts /src/api/types.ts
RUN ./node_modules/.bin/ng build --configuration production --base-href /ui-demo/ --output-path dist/ui-demo

# ── Stage 2: docs site ──
FROM node:24-alpine

RUN npm install -g pnpm@9

WORKDIR /app

COPY docs/package.json docs/pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.pnpm-store \
    pnpm install --frozen-lockfile --store-dir=/root/.pnpm-store

COPY docs/. .

# Pre-built UI demo bundle (cli/ui isn't in this stage's build context, so
# scripts/build-ui-demo.mjs skips its own build and trusts this instead).
RUN rm -rf public/ui-demo
COPY --from=ui-builder /ui/dist/ui-demo/browser/. ./public/ui-demo/
COPY docs/scripts/ui-demo-mock.js ./public/ui-demo/mock.js
RUN sed -i 's#</head>#  <script src="/ui-demo/mock.js"></script>\n</head>#' public/ui-demo/index.html

# Next's own incremental build cache — speeds up repeat builds the same way
# the pnpm store cache above does (excluded from the final image layer).
RUN --mount=type=cache,target=/app/.next/cache \
    pnpm build

CMD ["pnpm", "start"]
