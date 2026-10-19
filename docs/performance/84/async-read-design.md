# Enterprise asynchronous execution design — R1 freeze

Frozen before worker/query implementation, base `8bb163fe63d1e2a6615fb04d7731502c863b7f78`.
Owns R1 F2 only: enterprise list/detail public HTTP and MCP, same business readers.
F1 exceptional UTF-16 fix and STD-01/02 are separate changes. No schema/migration,
result cache, heap increase, timeout increase, production access or adjacent job work.

## Interface and ownership

A single enterprise read executor per application process accepts a database path,
list filter or detail ID, and optional AbortSignal. HTTP and MCP call this same
asynchronous seam. Exactly **one native SQLite worker** executes one job at a time;
a bounded FIFO admits at most 16 pending jobs and 64KiB of encoded request metadata.
Overflow returns a retryable 503; aborted queued work is removed. Running abort
terminates the owned worker, rejects only that request, then restarts lazily for the
remaining queue. Errors/exits reject the active request, release ownership and allow
later requests to recover; no automatic replay of a failed read. Shutdown rejects
queued/active work and awaits termination. Readiness and error listeners precede
all awaits. Idle worker must not keep a closed server alive.

The worker opens a **new readonly fileMustExist connection for every execution**,
never the app writer or a path-cached async transaction. The existing list/detail
read transaction covers selection/counts/page/hydration/evidence; its first read
pins the committed snapshot. Rollback and close run in finally. Requests executing
after a completed commit see that commit; queued requests have no prematurely
pinned snapshot. File replacement does not reuse a stale handle. No credentials,
raw bodies, result graphs or SQLite handles travel in request metadata.

## Packaging and resource evidence

Nuxt 4 / Nitro 2 (installed versions are authoritative) emits the worker as an
explicit Rollup entry alongside the server, with common chunks and native package
externals packaged by Nitro. Development/tests resolve the same worker source via
Node's TypeScript support or a documented source loader; production never depends
on source checkout/jiti. Compiled verifier must run from a different cwd.

Responses cross the seam in a transferable serialized buffer; measure its exact
byte length, serialization/deserialization time and process-wide RSS plus the sum
of worker and application V8 heaps. One worker has a bounded V8 old-generation
limit; it does not add parallel throughput or justify a higher total memory budget.
Queue metadata, in-flight response transfer and transport serialization count toward
incremental heap. The fixed-page/ID 64MiB and full-body **2× body bytes +64MiB**
budgets remain unchanged. Measurements must disclose sampling gaps and native/external
buffers; they are not hidden behind an application-only heap metric.

## Throughput implementation and acceptance

Move the **whole native aggregate block**, lifecycle projection and sorting off the
request event loop. Reduce repeated CTE materialization/grouping and unnecessary
coordinates/JSON decoding using existing indexes, preserving exact independent
filters/counts, first-award ties/uncertainty, differences, lifecycle, aliases and
JS localeCompare name ordering. One worker alone cannot fix serial c5 latency:
profile actual readonly clones and optimize per-request work before acceptance.
Any essential index proposal stays separate in index-request.md; no DDL here.

Test first at the authorized real SQLite/public HTTP/MCP seams. Preserve R1 and
all old failed samples. Prove responsiveness while native SQLite is blocked, queue
backpressure/abort/error/restart, coherent snapshots during commits, next-read
visibility and byte-exact full detail. Rebuild at a committed SHA, rerun 756 same-input
responses over 1x/2x/5x × HTTP/MCP × list/detail × c1/2/5 (20 hot +1 cold), compare
canonical result hashes to the historical same-input baseline, and report throughput,
combined memory, payload copies and loop delay. Keep frozen #82 budgets and describe
the synthetic-growth and uncontrolled-host/container limits. Full suite, typecheck,
build, production OpenAPI, shared cache/comparison/correspondence/import regressions
and desktop/390px interaction complete the handoff; no claim of production or parent
acceptance follows from local measurements.

## Measured design amendment — sequential connection reuse

Before this change, the one-worker 5x/c5 compiled probe still measured hot p95
562.4/563.6ms (same inputs, 20 hot samples); a fresh connection per request also
throws away the native page cache. A covering-index-only probe saved about13ms
in the narrow aggregate, insufficient evidence for essential DDL.

Revise **connection ownership only**: the single serial worker owns at most one
readonly handle for its current realpath/device/inode. Each job still starts and
finishes its own transaction; no read snapshot or business result survives a job.
A later job starts a fresh committed snapshot on that never-writing connection.
Changing source/file identity closes the old handle before opening another;
read errors close it, cancellation terminates the worker, and shutdown releases
it. This is native SQLite page/connection reuse, not a result cache. Record its
native RSS cost in total process RSS. Parallel requests still queue rather than
sharing an active transaction. Snapshot, external-commit, rollback, replacement,
abort/error/restart and combined memory regressions remain required.

The Nitro plugin loads worker code/readiness before accepting traffic. This does
not execute an enterprise query, warm a business result, or retain a snapshot.
Startup and post-health interactive delay windows are measured separately, with
both retained. The worker's baseline heap is included in both total-memory accounting
and the post-health baseline; it is not omitted because it runs in another isolate.

## Raw-body copy correction (measured before adoption)

A17,600,015B synthetic body through compiled HTTP then MCP exceeded the frozen
102,308,894B heap-delta cap:186,939,608B observed combined delta. Do not relabel
that transfer design as passed. Move JSON serialization into the native worker;
it transfers an exclusively owned UTF-8 buffer. HTTP sends that JSON buffer with
its content type. MCP returns its JSON text directly to the toolkit, avoiding a
second decoded result graph and pretty-print serialization. The full field values
and their byte-exact string contents are unchanged; wrapper whitespace is not a
business field. Object-returning internal callers still decode explicitly via
the same executor. Measure transferred backing-buffer bytes, V8 and external
memory separately and rerun the exact same raw fixture without raising limits.

Response admission also stays held through the Node response `finish`/`close`:
HTTP routes and only the two enterprise MCP calls share17 transport slots.
Slow consumers cannot admit indefinitely after the native job resolves. This
holds no body/result cache and releases on error/finish/disconnect. A controlled
real HTTP stream regression exercises full admission and release; the native
executor retains its separate16-pending/64KiB metadata gate.

The dev runtime reproduction found Nitro2's inline-dynamic-import default rejects
a second worker entry. Dev output now explicitly emits separate entries while
preserving Nitro runtime grouping; the standalone dev server then became ready
in3.28s. Further raw-memory diagnostics showed the async plugin return was not
awaited by Nitro2: health could precede worker module initialization, falsely
making that initialization part of the first read. Use a synchronous plugin and
an awaited request hook for code readiness. This performs no enterprise query;
startup heap/loop and the sum of both initialized heaps remain reported. Retain
the original raw failure, all copy-profile metrics, and both failed dev gates.

Final telemetry observes worker heap at native get/all boundaries and every256
cursor rows, plus projection/encoding boundaries; the main thread samples heap/RSS
while native work runs. Report sum-of-isolates heap and OS maximum process RSS
(RSS is process-wide, not added twice). The conservative fixed-page increment is
application peak growth after health + maximum positive per-job worker peak/start
delta + positive retained worker-baseline growth over its initialized baseline.
This avoids subtracting a later GC minimum from an earlier startup heap and falsely
calling initialization garbage a request allocation. Raw-profile diagnostics also
retain the stricter sum-of-component maxima/minima result. Neither method is a
continuous allocation trace; native/external/transfer bytes are separately reported.

The remaining concurrent-dev gate was reproduced with captured child output:
Nuxt CLI refused a second server sharing its generated directory/lock (exit1).
`NUXT_BUILD_DIR` now selects an owned private directory for each of the two HTTP
fixtures. No lock bypass or timeout increase. Child-aware readiness exposes the
actual exit/output rather than waiting60s. Both12 public tests then passed atc2.
