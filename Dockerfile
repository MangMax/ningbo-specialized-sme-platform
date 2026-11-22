ARG NODE_IMAGE=node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
ARG POSTGRES_IMAGE=postgres:19.0-bookworm@sha256:f4859caf96de494e38efa69ed703b08a5bbd9605e152e604f2daec8841c87c41

FROM ${POSTGRES_IMAGE} AS postgres-tools

FROM ${NODE_IMAGE} AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global --no-audit --no-fund "$(node -p "require('./package.json').packageManager")" \
  && pnpm install --frozen-lockfile --ignore-scripts --store-dir /tmp/pnpm-store \
  && rm -rf /tmp/pnpm-store

COPY . .
RUN pnpm build

FROM ${NODE_IMAGE} AS runtime-tools

# Use the version-matched PostgreSQL client binaries and libpq from the official image.
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
  NUXT_POSTGRES_BIN=/usr/local/bin

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/MangMax/ningbo-specialized-sme-platform" \
  org.opencontainers.image.revision="${SOURCE_REVISION}"

COPY --from=build --chown=node:node /app/.output/ ./.output/

USER node

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
