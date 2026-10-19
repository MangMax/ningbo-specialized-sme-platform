# R2 worker resource and request ownership freeze

Base: `69b8e54adb7c8026ba2b016e00e9affebc637540`. R2-01 and R2-02 only.
No business reader, comparison module, schema, migration, cache, global heap or
request/startup timeout changes. Frozen #82 budgets still apply.

The serial native executor becomes one owned Node child process. A V8 fatal
allocation in an isolate must not abort the HTTP service. Use explicit child
`--max-old-space-size=128 --max-semi-space-size=64` independently of parent flags
and NODE_OPTIONS, then record actual V8 heap_size_limit at readiness. This matches
the previously observed default worker total heap (320MiB), rather than claiming
128MiB total or claiming Worker resourceLimits wins over a parent 2048 flag.
The application heap setting is unchanged. Measure actual app + child heaps,
external/backing bytes and summed process RSS against the original total limits.

Keep the same list/detail readers and independent committed transactions. Encode
their plain JSON result incrementally, splitting large strings without splitting
surrogate pairs and preserving JSON escaping. Send bounded binary IPC chunks with
send-callback backpressure, then a completion message. No whole JSON string in the
child, no parsed result graph in HTTP/MCP adapters. The parent assembles one Buffer;
chunk buffers and final Buffer briefly coexist (up to twice UTF-8 body bytes in
external memory). Child retains one result graph; main object callers explicitly
decode. Response slots remain held until transport finish/close. There is no raw
size cutoff, truncation, disk spill or payload cache. Fatal child exit rejects the
active request as retryable unavailable and starts a fresh child for later work.

The existing FIFO16/64KiB request metadata, serial native work, abort/shutdown,
file identity and no-snapshot-between-jobs semantics remain. Establish request
abort/response close ownership synchronously in the Nitro request hook before
readiness. Admission and route signal must check already-terminal state after
listeners are attached; release is idempotent. Normal slow consumers retain slots.

Acceptance: reproduce original failures on the pinned source; default production
command from another cwd returns exact 96MiB raw hash and subsequent health/list;
compiled 1s real executor module-import delay has 17 disconnects before ready and
recovers HTTP + MCP; actual effective heap under default and 2048 parent; full raw
copy/memory accounting; existing R1 regressions; full gates and same-input 36-cell
enterprise matrix. Native/OS memory is reported separately, not hidden behind V8
heap. Local Node/platform evidence is not container, CI or production acceptance.
