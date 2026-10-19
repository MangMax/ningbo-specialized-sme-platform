# R2-01 residual: raw lifetime and generation allocation

Base integration: a1a050387e6fa0a092f43b74a0cd83ec527afcec. This amendment
supersedes only the child generation split in r2-worker-design.md. The frozen
#82 limits, application flags, readers, transport and failure policy stay the same.

The strict compiled HTTP regression reproduces the valid 96MiB raw detail's
intermittent child OOM under Node24.22/default, from a different cwd: after five
successful reads in one process, the second fresh process returns 200 then503.
Health/list remain200. A prior identical15-read run passed; that finite pass did
not refute the failure. The regression asserts every status, exact byte count,
literal raw hash and subsequent health/list, and exits nonzero on the503.

A separate diagnostic snapshot at the first IPC chunk contains one100,663,312B
V8 string, retained by rawFields.original and the encoder's suspended generator.
Old/large-object space holds that96MiB value throughout1,537chunk sends. The
snapshot and heap-space sampling alter GC and are investigation evidence, not
the uninstrumented acceptance lane. The original SQLite JSON text may coexist
with its parsed value during decoding; it is absent from that retained snapshot.
A separate parse-boundary diagnostic measures114,673,200B before JSON.parse and
214,408,464B afterward: the input and output are each about96MiB, in new/old
large-object spaces. Thus the temporary two-string lifetime is real, although
only one remains during the asynchronous encoder's long IPC send sequence.
Bounded encoder scratch prevents a third whole JSON string but cannot make a
long-lived96MiB value into short-lived young-generation allocation. Failed runs
mark-compact repeatedly around108MiB live against old128; a320MiB total limit
therefore does not establish sufficient old-generation capacity.

Redistribute the executor's existing allowance, without increasing its total:

- Previous: old128MiB +3 x semi64MiB =320MiB effective V8 heap.
- Revised: old256MiB +3 x semi16MiB =304MiB effective V8 heap.
- Old generation gains128MiB; young allowance loses144MiB; total loses16MiB.

The revised old allocation can accommodate the two96MiB decoding representations
plus64MiB for module/reader metadata and bounded encoding work. This is allocation
planning for the evidenced fixture, not an arbitrary-size support guarantee.
Readiness must measure318,767,104B actual heap_size_limit under default/2048
parents and inherited NODE_OPTIONS. CLI flags belong only to the serial child;
no global application heap is raised. These are V8 allocation limits, not native
SQLite/external-buffer/RSS limits. Actual app+child heap must remain below1.8GiB,
summed RSS below3GiB, and raw incremental heap below2xraw bytes+64MiB. Verify those
separately; a limit formula alone is not a measured budget pass.

No new whole raw copies are introduced: one parsed result graph, bounded16,384
code-unit string pieces, bounded65,536B IPC chunks, one awaited send at a time.
The SQLite source JSON can be transiently live during parsing. The parent holds
received chunks and briefly a second complete Buffer during concatenation; these
are external bytes and count in RSS. HTTP sends that Buffer. MCP converts it to
text and the SDK encodes its envelope; those allocations remain counted in the
separate Unicode raw profile. No96MiB MCP acceptance follows from the HTTP test.
No cache, truncation, cap, spill, forced GC, retry or timeout change is introduced.

Acceptance uses `verify-enterprise-large-repeat.mjs`: three fresh processes per
parent launch, five sequential96MiB HTTP reads in each, default and2048, with no
preload/observer/GC hook in either app or executor. Every read must succeed and
match the original literal hash; health/list must succeed afterward. Separate
instrumented probes establish effective limits and combined heap/RSS/raw budgets.
Existing R1/R2 protocol, Unicode, IPC backpressure, cancellation/restart/slot and
snapshot semantics remain required. Finite local host evidence does not establish
container/production, sustained load or arbitrary-size guarantees.
