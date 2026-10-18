# Credential-free platform workflow

`platform-scenarios.json` contains synthetic inputs for single, mixed-source batch,
expired session, second-page failure and same-code multiple-relationship paths.
`investigate-platform.mjs` runs them only through the app. An app API task token
is needed for batch submit/retry; it is unrelated to platform credentials.

```js
import { querySingle, investigatePlatform, retryUnfinishedBatch } from './investigate-platform.mjs'
const single = await querySingle({ baseUrl, query: scenarios.single })
const batch = await investigatePlatform({ baseUrl, apiToken, queries: scenarios.batch })
// Inspect every item's status, segments, page scope and unfinished ranges first.
// After server-side session maintenance or transient failure recovery:
const recovered = await retryUnfinishedBatch({ baseUrl, apiToken, batch })
```

Expected decisions:

- `single`: preserve returned candidates, all original rows, page scope and times.
- `batch`: map each receipt itemId to its unique enterprise investigator; keep all
  three source identities and their different title contracts.
- `expired`: `auth_failed` (or partial if earlier pages succeeded); retain all
  unfinished ranges and request credential maintenance from the operator. No
  automatic repeated authentication attempts and no zero-record conclusion.
- `secondPageFailure`: preserve page1 rows and original queriedAt/completedAt;
  explicit batch retry queries only page2 onward. A queued/running/poll_limit
  batch is not complete.
- `multipleRelations`: the same code can have several rows and titles. Preserve
  every relation in segments; do not collapse rows by code or infer identity.

Reproduce without a real account or Cookie read:

```sh
MIIT_COOKIE='' MIIT_COOKIE_FILE='' pnpm test tests/platform-agent-workflow.test.ts
```

The behavioral check starts a real HTTP app fixture with temporary SQLite and
synthetic server-side credentials, runs these exported functions, injects login
and second-page failures, and audits requested routes. It requires only app
API/MCP calls, never a credential read/reveal or direct platform request from the
agent. This proves the workflow against synthetic upstream samples, not live
platform acceptance. Public research and independent preflight/write remain
separate steps after candidate evidence has been reviewed.
