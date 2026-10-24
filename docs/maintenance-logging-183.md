# MCP and maintenance runtime diagnostics (#183)

The single `appLog` API emits through the existing evlog drain. `mcp.request` and
`http.request` remain evlog transport completions. `mcp.tool.<registered_name>` is
an invocation outcome: `isError: true` or a JSON error envelope is a failure even
under HTTP 200. It does not establish platform coverage, no-record, transaction
commit, or any other business fact. Unknown client names use `mcp.tool.unknown`.
Rejected RPC batches use `mcp.tool.batch`; they do not represent executed tools.

`semanticRouteHandler` in `core-route.ts` supplies the HTTP maintenance boundary.
Operations are `maintenance.<domain>.<action>` for correspondence, decision,
enterprise_profile, alias, event, evidence and proof. HTTP auth denial is `denied`,
other domain rejection is `failure`. Business handlers, transactions and error
contracts remain in their existing adapters. Unexpected MCP initialization errors
return a fixed `internal_error` envelope instead of the toolkit's raw Error.message.
Known application errors remain on their existing path; invalid-request exception
messages use fixed text. No input, actor, idempotency key, result text, path, token
or error stack is passed to appLog. Static domain codes are explicitly allowlisted;
unrecognized errors use `operation_failed`.

Only output projections supply correlations: enterprise profile receipts supply
`auditId`; alias results supply the alias resource ID; decision receipts supply a
decision-version resource ID; correspondence/event/proof plans and receipts supply
an actual returned `batchId`. Missing identifiers stay missing. Evidence correction
receipts have no returned stable numeric receipt ID, so no ID is invented from
their idempotency key. Runtime retention never changes business audit/receipt data.

The protected runtime-log tools keep #181 discovery/auth guards and suppress both
semantic read events and detailed request logging to prevent recursive log growth.
There is no additional logger, request completion wrapper, storage, migration,
worker protocol, client transport, or shared configuration in this ticket.

Run `pnpm build` then `node scripts/verify-maintenance-logging-183.mjs` for the
actual built Nuxt HTTP + SDK MCP seam. It uses private temporary business/log
storage, synthetic credentials and application API writes, retains results/server
output outside Git, and stops only its own children. It covers receipt replay,
unchanged audit history, failures, redaction, domain initialization, and a real
unavailable drain. Browser/UI, production, Docker and load/SLO are separate lanes.
