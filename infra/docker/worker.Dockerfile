# syntax=docker/dockerfile:1.7
# Cortex Farm worker — multi-arch (linux/amd64 + linux/arm64 for the Oracle Ampere VPS).
#   docker buildx build -f infra/docker/worker.Dockerfile --platform linux/amd64,linux/arm64 .

ARG NODE_IMAGE=node:24-bookworm-slim

# ---- build: install, generate Prisma for THIS platform, bundle -------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/worker/package.json apps/worker/
COPY apps/sentinel/package.json apps/sentinel/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/exchange/package.json packages/exchange/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.base.json tsconfig.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN npx prisma generate --schema packages/db/prisma/schema.prisma \
 && node scripts/build-worker.mjs

# ---- runtime: bundle + Prisma client/engine + protos only ------------------------------------
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    TRADING_MODE=shadow \
    MEXC_PROTO_DIR=/app/proto/mexc \
    MARKET_DATA_DIR=/data/market
COPY --from=build /app/dist/worker ./dist
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/packages/exchange/proto/mexc ./proto/mexc
COPY --from=build /app/packages/db/prisma ./prisma
RUN mkdir -p /data/market && chown -R node:node /data
USER node
VOLUME ["/data"]
# tini: PID 1 forwards SIGTERM so the worker drains and closes the recording cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
