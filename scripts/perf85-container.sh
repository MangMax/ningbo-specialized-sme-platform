#!/usr/bin/env bash
# Optional exclusive #85 run. --check-context performs no image build or benchmark.
set -Eeuo pipefail

mode=${1:-}
if [[ "$mode" == '--check-context' ]]; then
  output_dir=
else
  output_dir=${1:?usage: scripts/perf85-container.sh <--check-context|/absolute/private-output-dir>}
  [[ "$output_dir" = /* ]] || { echo 'Output directory must be absolute' >&2; exit 2; }
  [[ -z "$(git status --porcelain)" ]] || { echo 'Commit the exact source tree before the container run' >&2; exit 2; }
  mkdir -p "$output_dir"
fi

scratch_dir=$(mktemp -d)
owned_containers=()
owned_fixtures=()
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"

container_record() {
  local name=$1 prefix=$2 owner
  docker inspect "$name" >/dev/null 2>&1 || return 0
  owner=$(docker inspect --format '{{index .Config.Labels "perf85.owner"}}' "$name")
  [[ "$owner" == "$run_id" ]] || { echo "Refusing to remove unowned container $name" >&2; return 1; }
  docker inspect --format '{"id":"{{.Id}}","name":"{{.Name}}","state":{{json .State}},"limits":{"nanoCpus":{{.HostConfig.NanoCpus}},"memoryBytes":{{.HostConfig.Memory}},"memorySwapBytes":{{.HostConfig.MemorySwap}}},"labels":{{json .Config.Labels}}}' "$name" > "$prefix.inspect.json"
  docker logs "$name" > "$prefix.json" 2> "$prefix.stderr.log" || true
  docker rm "$name" >/dev/null
}

cleanup() {
  local status=$? name prefix fixture
  trap - EXIT INT TERM
  # macOS Bash 3.2 treats an empty array expansion as unset under nounset.
  set +u
  for name in "${owned_containers[@]}"; do
    if docker inspect "$name" >/dev/null 2>&1; then
      prefix="$output_dir/${name##*/}"
      docker stop -t 10 "$name" >/dev/null 2>&1 || true
      container_record "$name" "$prefix" || status=1
    fi
  done
  for fixture in "${owned_fixtures[@]}"; do
    [[ "$(basename "$fixture")" == perf85-synthetic-* ]] && [[ -d "$fixture" ]] && rm -r -- "$fixture"
  done
  [[ -d "$scratch_dir" ]] && rm -r -- "$scratch_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$scratch_dir/context"
git archive HEAD | tar -x -C "$scratch_dir/context"
node scripts/perf85-context.mjs prepare "$scratch_dir/context"
node scripts/perf85-context.mjs check "$scratch_dir/context"
source_sha=$(git rev-parse HEAD)
short_sha=${source_sha:0:12}
image=${PERF85_IMAGE:-perf85-m3-$short_sha}
# Stay on the repository's digest-pinned Node 24 base and native build prerequisites.
node_image=$(sed -n 's/^ARG NODE_IMAGE=//p' Dockerfile)
[[ "$node_image" =~ ^node:24-bookworm-slim@sha256:[0-9a-f]{64}$ ]] || { echo 'Expected pinned repository Node 24 base' >&2; exit 2; }
cat > "$scratch_dir/context/Dockerfile" <<DOCKERFILE
ARG NODE_IMAGE=$node_image
FROM \${NODE_IMAGE}
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install --global --no-audit --no-fund pnpm@12.11.2
COPY . .
RUN pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store && pnpm build && rm -rf /tmp/pnpm-store
CMD ["node", "scripts/perf85-transport.mjs"]
DOCKERFILE
node -e 'const a=require("node:assert/strict"),s=require("node:fs").readFileSync(process.argv[1],"utf8");a.ok(s.includes(`ARG NODE_IMAGE=${process.argv[2]}`));a.match(s,/apt-get install -y --no-install-recommends python3 make g\+\+/);a.match(s,/COPY \. \./);a.match(s,/pnpm install --frozen-lockfile/)' "$scratch_dir/context/Dockerfile" "$node_image"
[[ "$mode" == '--check-context' ]] && exit 0

command -v docker >/dev/null || { echo 'Docker is required' >&2; exit 2; }
if [[ -z "${PERF85_IMAGE:-}" ]]; then
  docker build -t "$image" "$scratch_dir/context"
else
  docker image inspect "$image" >/dev/null
fi

for scale in 1 2 5; do
  fixture_json=$(node scripts/perf85-fixture.mjs "$scale")
  fixture_path=$(printf '%s' "$fixture_json" | node -e 'let t="";process.stdin.on("data",x=>t+=x).on("end",()=>process.stdout.write(JSON.parse(t).dbPath))')
  fixture_dir=$(dirname "$fixture_path")
  [[ "$(basename "$fixture_dir")" == perf85-synthetic-* ]] || { echo 'Unexpected fixture directory' >&2; exit 2; }
  owned_fixtures+=("$fixture_dir")
  for concurrency in 1 2 5; do
    name="perf85-${short_sha}-${run_id}-s${scale}-c${concurrency}"
    prefix="$output_dir/scale${scale}-c${concurrency}"
    docker create --name "$name" --label "perf85.owner=$run_id" --label "perf85.source=$source_sha" --label 'perf85.scope=m3-synthetic' \
      --cpus=1 --memory=4g --memory-swap=4g --pids-limit=256 \
      --mount "type=bind,src=$fixture_dir,dst=/fixture,readonly" --workdir /app --entrypoint sh \
      -e PERF85_CONTAINER_LIMITED=1 -e "PERF85_SOURCE_SHA=$source_sha" "$image" \
      -ec 'printf "cpu.max=" >&2; cat /sys/fs/cgroup/cpu.max >&2; printf "memory.max=" >&2; cat /sys/fs/cgroup/memory.max >&2; test -f scripts/perf85-transport.mjs && test -f scripts/perf85-fixture.mjs; exec node scripts/perf85-transport.mjs "$@"' \
      perf85-run --db /fixture/roster.db --manifest /fixture/manifest.json --concurrency "$concurrency" --rounds 20 >/dev/null
    owned_containers+=("$name")
    docker start "$name" >/dev/null
    exit_code=$(docker wait "$name")
    container_record "$name" "$prefix"
    node -e 'const x=JSON.parse(require("node:fs").readFileSync(process.argv[1]));const code=Number(process.argv[2]);if(x.state.ExitCode!==code||x.state.OOMKilled||code!==0)process.exit(1)' "$prefix.inspect.json" "$exit_code" || {
      echo "Container $name failed (exit=$exit_code); inspect $prefix.inspect.json and $prefix.stderr.log" >&2
      exit 1
    }
  done
done
