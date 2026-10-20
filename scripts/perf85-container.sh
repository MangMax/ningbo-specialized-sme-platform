#!/usr/bin/env bash
# Optional exclusive #85 run. Builds a Linux artifact from committed source.
set -euo pipefail

output_dir=${1:?usage: scripts/perf85-container.sh /absolute/private-output-dir}
[[ "$output_dir" = /* ]] || { echo 'Output directory must be absolute' >&2; exit 2; }
command -v docker >/dev/null || { echo 'Docker is required' >&2; exit 2; }
[[ -z "$(git status --porcelain)" ]] || { echo 'Commit the exact source tree before the container run' >&2; exit 2; }
mkdir -p "$output_dir"
scratch_dir=$(mktemp -d)
trap 'rm -rf "$scratch_dir"' EXIT
mkdir -p "$scratch_dir/context"
git archive HEAD | tar -x -C "$scratch_dir/context"
cat > "$scratch_dir/context/Dockerfile" <<'DOCKERFILE'
FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
CMD ["node", "scripts/perf85-transport.mjs"]
DOCKERFILE
image="perf85-m3-$(git rev-parse --short HEAD)"
source_sha=$(git rev-parse HEAD)
docker build -t "$image" "$scratch_dir/context"
for scale in 1 2 5; do
  fixture_json=$(node scripts/perf85-fixture.mjs "$scale")
  fixture_path=$(printf '%s' "$fixture_json" | node -e 'let t="";process.stdin.on("data",x=>t+=x).on("end",()=>process.stdout.write(JSON.parse(t).dbPath))')
  fixture_dir=$(dirname "$fixture_path")
  for concurrency in 1 2 5; do
    docker run --rm --cpus=1 --memory=4g --memory-swap=4g --pids-limit=256 \
      --mount "type=bind,src=$fixture_dir,dst=/fixture,readonly" \
      -e PERF85_CONTAINER_LIMITED=1 -e "PERF85_SOURCE_SHA=$source_sha" "$image" \
      node scripts/perf85-transport.mjs --db /fixture/roster.db --manifest /fixture/manifest.json \
      --concurrency "$concurrency" --rounds 20 \
      > "$output_dir/scale${scale}-c${concurrency}.json"
  done
  rm -rf "$fixture_dir"
done
