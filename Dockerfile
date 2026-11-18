ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

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

FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/MangMax/ningbo-specialized-sme-platform" \
  org.opencontainers.image.revision="${SOURCE_REVISION}"

COPY --from=build --chown=node:node /app/.output/ ./.output/

# Independent diagnostics volume; never shares the business /state mount.
RUN mkdir -p /logs && chown node:node /logs
ENV NUXT_LOG_DIR=/logs

USER node

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
