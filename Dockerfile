ARG NODE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

FROM ${NODE_IMAGE} AS build

WORKDIR /app

# better-sqlite3 is installed for Linux in this stage. Keep compiler tooling out
# of the runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global --no-audit --no-fund pnpm@12.11.2

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
# db/client.ts resolves migrations from process.cwd(), outside .output.
COPY --from=build --chown=node:node /app/db/migrations/ ./db/migrations/

USER node

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
