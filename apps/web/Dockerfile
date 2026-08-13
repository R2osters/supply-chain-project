# syntax=docker/dockerfile:1
#
# Built from the repo root: the web app imports the @scip/shared workspace package.

FROM node:22-bookworm-slim AS deps
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN mkdir -p apps/api && echo '{"name":"@scip/api","version":"0.1.0","private":true}' > apps/api/package.json

RUN npm ci --workspace @scip/shared --workspace @scip/web --include-workspace-root

FROM deps AS build
WORKDIR /repo

# NEXT_PUBLIC_* values are inlined at build time, so they have to be present here rather
# than at run time — a container started with a different API URL would ignore it.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001/api/v1
ARG NEXT_PUBLIC_WS_URL=http://localhost:3001
ARG NEXT_PUBLIC_MAP_STYLE_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_PUBLIC_MAP_STYLE_URL=$NEXT_PUBLIC_MAP_STYLE_URL \
    NEXT_TELEMETRY_DISABLED=1

COPY packages/shared packages/shared
COPY apps/web apps/web

RUN npm run build --workspace @scip/shared \
 && npm run build --workspace @scip/web

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# `output: 'standalone'` in next.config produces a self-contained server with only the
# modules actually reached, which is a fraction of node_modules.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public

USER node
EXPOSE 3000

HEALTHCHECK --interval=20s --timeout=4s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/login || exit 1

CMD ["node", "apps/web/server.js"]
