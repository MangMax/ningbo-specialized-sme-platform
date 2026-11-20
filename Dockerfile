ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG POSTGRES_IMAGE=postgres:19.0-bookworm@sha256:f4859caf96de494e38efa69ed703b08a5bbd9605e152e604f2daec8841c87c41

FROM ${POSTGRES_IMAGE} AS postgres-tools

FROM ${NODE_IMAGE} AS build

WORKDIR /app

# better-sqlite3 is installed for Linux in this stage. Keep compiler tooling out
# of the runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global --no-audit --no-fund pnpm@12.11.2

# Copy the root assembly and both local layers (layers/core and layers/sme-roster)
# before pnpm install runs Nuxt prepare.
COPY . .
RUN pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store \
  && pnpm build \
  && rm -rf /tmp/pnpm-store

FROM ${NODE_IMAGE} AS runtime-tools

# Use the version-matched PostgreSQL client binaries and libpq from the official image.
# Bookworm's packages supply the remaining runtime libraries.
COPY --from=postgres-tools /usr/lib/postgresql/19/bin/pg_dump /usr/lib/postgresql/19/bin/pg_restore /usr/local/bin/
COPY --from=postgres-tools /usr/lib/*/libpq.so.5.19 /usr/local/lib/
RUN apt-get update \
  && apt-get install -y --no-install-recommends libpq5 liblz4-1 libzstd1 zlib1g \
  && rm -rf /var/lib/apt/lists/* \
  && ldconfig \
  && pg_dump --version \
  && pg_restore --version

FROM runtime-tools AS runtime

WORKDIR /app

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000 \
  NUXT_DB_MODE=postgresql \
  NUXT_POSTGRES_BIN=/usr/local/bin

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/MangMax/ningbo-specialized-sme-platform" \
  org.opencontainers.image.revision="${SOURCE_REVISION}"

COPY --from=build --chown=node:node /app/.output/ ./.output/

# Independent diagnostics volume for explicit legacy SQLite startup.
RUN mkdir -p /logs && chown node:node /logs
ENV NUXT_LOG_DIR=/logs

USER node

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
