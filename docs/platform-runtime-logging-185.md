# Platform runtime diagnostics (#185)

Platform collection uses the #181 `appLog` API and official evlog drain. It does
not modify platform evidence, business audit, receipts, query status, retry policy,
credential resolution or batch checkpoint formats. The only job-parameter addition
is a server-generated `logContext`; public strict input schemas still reject it.

The operation vocabulary uses `platform.query_list`, `platform.business_list` or
`platform.query_bus_list`, followed by:

- `page[.title_1|2|3]`: once at page admission or failure. `page` is the actual
  requested upstream page; `counts.done` is the number of accepted rows. A valid
  empty page is a successful page, not proof about any other title or page.
- `query[.title_1|2|3|.titles_12|13|23|123]`: once per bounded live segment.
  `page` is the requested starting page. Counts are successful, attempted and
  failed pages. Requested title sets use a canonical fixed enum scope, including
  when no request could start. `no_record` only follows the existing domain result.
- `slot[.title_1|2|3]`: legacy single-slot classification. `counts.done` is accepted
  rows; the existing legacy return shape remains unchanged.
- `retry[.title_1|2|3]`: a legacy transport retry starts after backoff; `counts.done`
  is retries started so far. It is not another semantic page completion.
- `item`: one selected batch item's collection attempt, with newly accepted row
  count. Previously complete items are skipped without a new completion event.

`platform.batch.retry` records an accepted explicit resume with the selected item
count; rejected requests never claim a retry started. `platform.batch.collect`
summarizes a collection attempt using item counts. It is
separate from the generic job terminal event. `cancelled` is only emitted when
that attempt actually observes cancellation. Incomplete collection stays `partial`;
per-query and per-item events distinguish failure, authentication and unqueried.

Domain `failed` maps to diagnostic `failure` (or `timeout`); `auth_failed` to
`denied` with fixed `auth_failed`; `not_queried` to `skipped` (credential absence
has `credential_unavailable`). Original business statuses are never rewritten.
Rate limiting has fixed `rate_limited`. Raw errors, input conditions, USCC,
enterprise rows, HTTP bodies, credentials and host paths are never log fields.

REST passes #181's trusted request context. The toolkit's per-request
`mcp:config:resolved` hook clones only the three platform handlers and passes the
same context using a private Symbol in SDK extras. No wire field can supply it,
no global mutable request context is used, and tool guards stay intact. Batch
collection adds the known task/batch ID and generated item ID. Explicit retries
use the new request ID and retain the original trace ID. Other job kinds and the
global MCP entry point are outside this slice.

## Verification seams

`tests/platform-logging-185.test.ts` exercises application entry points and the
real standalone evlog pipeline, with a controlled HTTP upstream for live/legacy
queries and a transport stub for the bounded batch test. It is not actual Nuxt.

After `pnpm build`, run `node scripts/verify-platform-logging-185.mjs` for actual
built Nuxt HTTP/MCP and asynchronous batches, real controlled upstream HTTP,
real SQLite drain and protected log list/detail readback. The harness creates a
private temporary business fixture and independent log directory. A Node
`--import` preload redirects only the three exact official platform URLs to its
owned loopback HTTP server, calls native fetch, forbids redirects/external egress,
and requires synthetic credentials. This is process-only test instrumentation;
no production base-URL override is added to the application. It also checks
session expiry, second-page failure/retry, zero rows, multiple relations, rate
limit, deadline, missing credentials, logging-drain failure and privacy in
protected readbacks, fixture log storage and stdout/stderr fallback. JSON results
and process output stay in the printed temporary evidence directory.
