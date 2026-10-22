# Implemented logging performance baseline

This harness measures the current eleven collector integrations and real local
SQLite logging pipeline. It does not implement or simulate OTLP/field controls.
No numeric performance SLO is assumed. Results are local measurements.

Run from the repository root with Node24 and the frozen dependencies:

```sh
pnpm install --frozen-lockfile
pnpm build
# First freeze /tmp/implement-spec-180/logging-performance/matrix.md.
# Commit only these benchmark scripts/docs before the final measurement.
node scripts/benchmark-logging.mjs --smoke
node scripts/benchmark-logging.mjs --fault-check
node scripts/benchmark-logging.mjs
node scripts/summarize-logging-performance.mjs /tmp/implement-spec-180/logging-performance/fixed-final-<id>
```

The final command refuses a dirty checkout or a changed production graph relative
to baseline `50f4f710b3e9677d86806557b5120c1ac157130f`. Setup/build is excluded from
measurement time. Each run creates a new directory below the fixed `/tmp` root;
fixtures, output, per-process telemetry, manifest, progress and results remain
there. It creates 1,000 synthetic enterprises and never accepts a user DB path.
It binds ephemeral loopback ports and closes only owned resources. The complete
matrix normally takes about15min, bounded by a25min watchdog. Development flags
are explicitly non-final and their measurements must not be pooled with final.

HTTP uses actual built Nitro routes, a1s warmup and5s closed-loop measurement per
cell, concurrency1/8/32, three rotated rounds, source-off/debug/warn. Every response
body is hashed; random request headers are excluded. Error/timeout counts and all
latency samples enter the result. Driver and main phase telemetry reuse existing
performance modules (including SQL/JSON instrumentation overhead). Additional
500ms NDJSON sampling observes independently spawned business executors and their
SQLite-worker acknowledgements through inherited opt-in NODE_OPTIONS; it never
sends control messages to business-worker IPC. CPU/RSS are process-wide including
threads. Child interval attribution is sampled, not exact; unobserved exits and
child enqueue overflow remain UNKNOWN. Main policy counters are main-only.

The source-pipeline lane loads the actual TypeScript application API with the
project's jiti and real evlog/native SQLite. Its paced generator shares the
application process; CPU includes generator+logger. It reports achieved rate,
scheduler lateness, exact service counters/queues and drain duration. The maximal
legal MCP envelope saturates applicable bounded fields, validates their survival,
and records its sanitized byte size; the8KiB event ceiling does not imply an8KiB
legal event is constructible. Source/integration policies are changed through the
real API. Query preparation uses that pipeline, not direct row seeding. The4GiB
cap avoids rotation during preparation; separate capacity fixtures use1MiB.

Fault injection is limited to newly created log fixtures: real stdout pipe pause,
SQLite transaction lock, rejecting trigger, readonly reopen, and a filler table
under SQLite page cap to provoke genuine SQLITE_FULL without filling host disk.
The filler table is removed for recovery. Readonly classification follows actual
writes (chmod alone proves nothing). SQL fixtures never touch the business DB.
SIGKILL reports persisted/queued observations and cannot promise zero loss.
Graceful close and expiration are freshly executed bounded functional checks;
long-running/high-load lanes are separately identified. All drops/errors survive
in result JSON. Harness failures are retained, not removed or rerun to green.

The summary does not turn sampled bounds into leak proofs, benchmark results
into production SLOs, or inherited functional evidence into fresh performance
coverage. Inspect `correctness.json` independently of performance numbers.

If a management observation fails after a load cell, the driver now writes its
load summary before querying policy and records the observation error separately.
`--http-debug-supplement` replays the full six-cell debug context for rounds0 and2
in a separately labeled fixed-SHA directory. It does not replace original failure
rows or pool its timings into original three-round medians. Error status/code
counts and successful-response latency are additional observations. The original
run's all-response percentiles include fast503 replies and cannot reconstruct
success-only percentiles; do not interpret a low p95 under overload as healthy
business latency. Child acknowledged counts are sampled endpoint differences,
with offsets retained; they cannot reconstruct unacknowledged drops/overflow.

Byte calibration uses queuedBytes/queuedEntries for identical-shaped events. The
initial main manifest's small-event projection reported167B before appLog added
its96B origin; actual queue events were263B. The raw result is preserved and the
summary exposes both values. Large events were2362B in both projection and queue.
The source harness now accounts for the actual origin in future initial metadata.

The overall deadline stops subsequent lanes after terminating owned children;
`LOGGING_BENCH_DEADLINE_MS` can lower (never raise) the25min bound for a smoke
check of cleanup. Port50055 is explicitly excluded from ephemeral selection.

`--stdout-business-supplement` runs one separately labeled25s lane: real built
Nuxt writes stdout to an owned nonblocking FIFO; the reader stops20s while both
business GETs run, then resumes for5s recovery. Per-process telemetry records
actual stdout writable buffering, rather than inferring pressure just from a
paused reader. The FIFO is removed and only raw captured output is retained.

The FIFO reader has its own open file description. On this OS, Node stdout
initialization clears O_NONBLOCK on its inherited writer; sharing that descriptor
with readSync can block the driver. The separate reader retains O_NONBLOCK. A
retained minimal fd-flags probe confirms this boundary; the first aborted FIFO
run is preserved separately and cannot count as completed business evidence.
