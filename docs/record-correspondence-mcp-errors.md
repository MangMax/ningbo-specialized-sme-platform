# Correspondence MCP application errors (#176)

The eight correspondence tools keep their names, parameters and successful DTOs:
`list_record_correspondences`, `get_record_correspondence`,
`get_record_correspondence_source`, `get_record_correspondence_audit`,
`find_record_correspondence_candidates`, `preflight_record_correspondences`,
`save_record_correspondences`, `get_record_correspondence_batch`.
They reuse the REST application adapter and domain rules.

For an application failure, `CallToolResult.isError` is `true` and the single text
content item contains JSON `{error:{code,message}}`. Parse that JSON and branch on
`error.code`; message wording is diagnostic and may change. For example, calling
`get_record_correspondence` for a missing positive ID returns:

```json
{"isError":true,"content":[{"type":"text","text":"{\"error\":{\"code\":\"not_found\",\"message\":\"Correspondence not found\"}}"}]}
```

The corresponding REST response remains HTTP 404 with
`{"error":{"code":"not_found","message":"Correspondence not found"}}`.
MCP application failure results travel in the ordinary successful JSON-RPC
response; the domain code is separate from the HTTP transport status.

| error.code | REST status | Client response |
| --- | --- | --- |
| `not_found` | 404 | Check the requested resource ID or receipt key. |
| `invalid_request` | 400 | Correct the request. MCP uses the fixed message `Invalid correspondence request`, without rejected field names or values. |
| `invalid_endpoint_type` | 422 | Check endpoint kinds, roles and transitions. |
| `identity_conflict` | 422 | Recheck the original enterprise identity evidence. |
| `title_conflict` | 422 | Recheck the original title evidence. |
| `ambiguous_candidate` | 422 | Resolve the ambiguous or duplicate proposal explicitly. |
| `incomplete_coverage` | 422 | Supply sufficient current-source proof before confirmation. |
| `stale_revision` | 409 | Read the current revision and preflight again. |
| `plan_mismatch` | 409 | Preflight again using the original intended request and current evidence. |
| `idempotency_conflict` | 409 | Recover the original request/receipt; do not reuse its key for a different request. |
| `internal_error` | Existing unknown-error HTTP 500 behavior | Investigate the service failure. MCP uses `Correspondence operation failed`; no exception text, custom properties, stack or host path is returned. |

For example, a stale revision produces text JSON
`{"error":{"code":"stale_revision","message":"Correspondence revision changed"}}`
inside the same `isError:true` envelope. Failed decisions preserve business edges,
their revisions and audit history, and do not create a committed receipt.
Successful preflight may still write the existing plan ledger.

Authentication remains outside this application envelope: unauthenticated
discovery hides preflight, commit and receipt tools, and forced calls return HTTP
401 (REST uses `unauthorized`). The MCP SDK observes a transport rejection rather
than a `CallToolResult`. MCP protocol/input-schema validation before the handler
also retains the SDK's existing behavior; application validation of nested
decisions uses `invalid_request` above. Other tool families are unchanged.

Run `node scripts/verify-record-correspondence.mjs` for the real MCP SDK and REST
matrix against the same isolated synthetic SQLite. It checks every domain code
above, success/replay parity, auth discovery/forced calls, rejected-input
redaction, and unknown read/write faults. Unknown faults use a temporary preload
at the owned child's SQLite driver boundary; the write fault occurs when an
audit insert is prepared, after the edge insert, and verifies transaction rollback
via public reads and receipt lookup. The verifier never directly edits application
tables. The same error boundary includes database acquisition: an uncached
`useDb()` initialization failure returns the fixed `internal_error` envelope.
The verifier injects an acquisition-time `mkdirSync` EACCES for all eight tools,
checks secret/path redaction through the SDK, and verifies unchanged edges/audits
and no committed receipt through REST. This uses only the owned child's temporary
filesystem preload. It does not establish browser or production acceptance.
