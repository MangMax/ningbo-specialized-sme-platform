# Bounded explanation review contract (#114)

Frozen 2026-10-19 for #111. Depends on #109/#113; no UI or automatic business judgement.

## Read operations (no token, Cache-Control: no-store)

- GET `/api/roster/evidence-impacts` / MCP `list_evidence_impacts`: optional enterpriseId, titleCode, direction, decisionId, eventId; `view=current|historical|all` (current), `state=pending|reviewed|all` (pending), limit 1..100 (50), cursor. Returns `{rows,nextCursor,asOf,projectionReady}`. Rows expose id, exact enterpriseId/titleCode/direction/decisionId, latestRevisionId, reviewedRevisionId, classification (premise_invalid/evidence_changed), pending, lineage (current/historical/withdrawn/merged), oldDecision. No processing on reads. Unknown enterprise list is empty.
- GET `/api/roster/evidence-impacts/:id` / `get_evidence_impact {id}`: exact durable item, oldDecision, live currentDecision (null for merged owner), live evidenceToken, queryCoverage (null for merged owner), gaps and lineage. Gaps preserve bounded #109 sources/truncated; never claim unknown subjects are zero records. Historical items cannot be completed.
- GET `/api/roster/evidence-impacts/preview` / `preview_evidence_impacts`: required revisionId, optional enterpriseId/titleCode/direction/decisionId, limit/cursor. Only committed revision IDs; evaluates bounded candidate decisions via #113 and returns classification including no_review. No caller-supplied source bodies.
- GET `/api/roster/evidence-impacts/:id/sources` / `list_evidence_impact_sources {id,limit?,cursor?}`: separate source page of scalar committed revision references/classification and eventId; no raw bodies, credentials or free-form source metadata.
- GET `/api/roster/evidence-impacts/revisions/:revisionId/events` / `list_evidence_revision_events {revisionId,enterpriseId?,limit?,cursor?}`: separate exact associated event page.

Cursors are opaque, signed, filter-bound, operation-bound. The first read freezes committed projection watermark, impact ID ceiling, decision ID ceiling and receipt ID ceiling. Subsequent pages use immutable source links and historical receipts at those ceilings, so processing, replacement, completion and later evidence do not reorder or change the result set. Source/event pages freeze immutable revision ceilings. Cursor tampering/filter changes fail 400; process restart invalidates cursors (start a fresh read). `asOf` describes the frozen result; detail tokens are live and must be reread for completion.

## Explicit work commands (configured write token)

POST `/api/roster/evidence-impacts/commands` / MCP `process_evidence_impacts` accepts `{action:'process',limit:1..100,idempotencyKey,actor:{type:'user'|'agent',id},basis}`. Returns bounded #113 `{processed,unfinished,watermark}` plus command receipt. No startup sweep.
Same POST / MCP `release_evidence_rule` accepts `{action:'release_rule',ruleId,version,scopes:[{enterpriseId,titleCode,direction,previousEvaluationDigest,evaluationDigest}],idempotencyKey,actor,basis}`. 1..50 distinct exact scopes, explicit rule version and SHA256 evaluation digests from the authorized evaluator; identical evaluations create no revision. Same version with different evaluated material conflicts. Does not auto-drain or change business reasons. This is an explicit publication envelope, never a source ingestion endpoint.

## Review completion through existing #102

POST `/api/roster/decision-lifecycle/commands` / existing MCP `save_difference_decision` retains all #102 fields, adding `action:'maintain'` and optional `reviewedEvidence:{latestRevisionId:number,projectionReady:true}` (required for maintain, optional for replace; prohibited for withdraw). Include exact enterprise/title/direction, expectedCurrentId, idempotencyKey, actor,basis,ruleVersion,effectiveAt. Maintain omits decision and preserves the original version/reason/measure/evidence/audit. Replace supplies an actual #102 decision; no invented replacement. Both actions check live current decision ID, latest relevant committed evidence revision and projectionReady inside the existing immediate transaction, then record baseline and original receipt atomically. Withdrawn/historical/merged owners cannot be maintained. No evidence baseline means unknown, never valid.

Receipts retain #102 fields `{versionId,currentId,previousId,action,recordedAt}` and review completions add reviewedRevisionId. Same key/same request replay returns original receipt before concurrency checks and makes no writes; it cannot clear later evidence. Same key/different request:409 idempotency_conflict; changed decision:409 stale_version; changed/unprocessed evidence:409 stale_evidence. Failure rolls back decision, baseline and receipt together. Read detail again after conflict. API/MCP use existing auth, structured error codes, credential filtering and no-store semantics.

#109 queryCoverage/currentDecision/explanationValidity/assessment shapes remain intact. Validity adds valid/evidence_changed. Persisted pending state precedes no-baseline unknown; a reviewed baseline is valid only if token is ready and equals the reviewed revision. New unprocessed changes conservatively report evidence_changed. A reviewed old not_queried premise can be explicitly acknowledged without altering the business reason. No production migration/backlog work is authorized.

Migration 0024_evidence_review_114 adds immutable command/review receipts only, journal idx24 timestamp1792400021005 (idx23 reserved for refreshed #113). No historical backfill.
