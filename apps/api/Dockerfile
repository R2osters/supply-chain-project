# syntax=docker/dockerfile:1
#
# Built from the repo root (see docker-compose.yml) because the API depends on the
# @scip/shared workspace package, which lives outside apps/api.

# --------------------------------------------------------------------- deps
FROM node:22-bookworm-slim AS deps
WORKDIR /repo

# Only the manifests, so a change to source code does not invalidate the install layer.
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

# The web workspace is not needed to build the API; an empty manifest keeps npm's workspace
# resolution happy without pulling in Next.js and its dependency tree.
RUN mkdir -p apps/web && echo '{"name":"@scip/web","version":"0.1.0","private":true}' > apps/web/package.json

RUN npm ci --workspace @scip/shared --workspace @scip/api --include-workspace-root

# -------------------------------------------------------------------- build
FROM deps AS build
WORKDIR /repo

COPY packages/shared packages/shared
COPY apps/api apps/api

RUN npm run build --workspace @scip/shared \
 && npx prisma generate --schema apps/api/prisma/schema.prisma \
 && npm run build --workspace @scip/api

# ------------------------------------------------------------------ runtime
FROM node:22-bookworm-slim AS runtime
WORKDIR /repo

ENV NODE_ENV=production

# OpenSSL is required by the Prisma query engine on Debian slim images.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
# Migrations ship with the image so a deploy can bring the schema forward on its own.
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma

# Never run as root.
USER node

WORKDIR /repo/apps/api
EXPOSE 3001

HEALTHCHECK --interval=20s --timeout=4s --start-period=25s --retries=3 \
  CMD curl -fsS http://localhost:3001/api/v1/health || exit 1

# Migrations are applied at start-up rather than baked into a separate job, so a fresh
# environment is one `docker compose up` away. `migrate deploy` never generates or resets —
# it only applies migrations that already exist, which is what makes it safe to run on boot.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
