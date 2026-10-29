# The documentation site: built with Next.js and Fumadocs as a static export, served as plain files by Caddy.
FROM oven/bun:1.4.2-alpine AS build
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /site
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# the current release, which the image build cannot read from git (lib/version.ts)
ARG DOCKFLOW_RELEASE
RUN bun run build

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /site/out /srv
