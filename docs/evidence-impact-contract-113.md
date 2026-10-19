# Committed evidence revisions and impact staging (#113)

This internal substrate is consumed by #114. It adds no REST/MCP endpoints,
review-completion command or decision writer. `saveDecision102` remains the owner
of business decisions. There is no startup drain, rule auto-release or historical
backfill. Production migration and backlog assessment need separate authority.

## Persistence and transaction boundary

Migration `0023_evidence_impact_113` follows journal entry 21
`0018_decision_lifecycle_102` (not numeric filename order). It adds empty tables
and indexes only. Existing decisions and source bodies are preserved.

- `evidence_revision_113`: immutable committed source version, exact enterprise,
  title, optional direction/event scope, independent coverage/fact digests,
  scalar source references and decision-ID cutoff.
- `evidence_semantic_head_113`: semantic dedup per source partition. Original
  query occurrences remain archived even when their evidence is equivalent.
- `evidence_impact_progress_113`: persistent keyset cursor per revision.
- `evidence_scope_version_113`: latest committed version and outstanding work
  count per exact source scope; token reads use at most eight indexed keys.
- `explanation_impact_113`: working view per enterprise/title/direction and the
  existing #102 decision version. `reviewedRevisionId` starts null.
- `evidence_impact_link_113` and `evidence_revision_event_113`: indexed source
  revisions and exact associated event dependencies, paged separately.

Hooks run inside existing successful fact transactions: USCC supplementation,
identity merge, confirmed alias import/maintenance, profile rename, platform
archive, selected export snapshot and official event/evidence revisions. Pending
aliases, note/location-only changes and semantic duplicates create no work.
The importer updates its receipt after the fact transaction; capture deliberately
precedes that update, so committed work survives a failed receipt update.

Snapshot selection matches the current reader: highest year then highest ID per
title. Older unselected imports are inactive. Revisions freeze old/new batch
references and maximum source-row IDs, including additions to the selected batch.
The evaluator compares exact owned row material per enterprise, including absence.
It does not connect similar names, and unknown source rows are never zero records.

The merge transaction transfers `record_correspondence.enterprise_id` to the
survivor along with other child lookup owners. Stable source IDs, confirmation
status, original identity/provenance/fingerprint and audit remain unchanged;
the change requires review rather than automatic re-confirmation.

## Internal domain interfaces

`server/utils/evidence-impact-113.ts` exposes:

- `processEvidenceImpacts113(db, {limit})`: explicit immediate transaction;
  `limit` is 1..100 candidate evaluations/progress steps. Returns processed,
  unfinished and contiguous revision watermark. Repeated drains are safe.
- `listEvidenceImpacts113(db, {enterpriseId?,afterId?,limit?})`: bounded working
  view ordered by stable ID; no implicit processing.
- `listImpactEvidence113(db, impactId, {afterRevisionId?,limit?})` and
  `listRevisionEvents113(db, revisionId, {enterpriseId?,afterEventId?,limit?})`:
  source and event dependency pages, both at most 100.
- `readEvidenceToken113(db, exactScope)`: current #102 decision version,
  committed scoped revision watermark and projectionReady. An unfinished token
  must not complete review. It is conservative: coverage-only changes and
  title-wide snapshot revisions can advance it even without a new review item.
- `readEvidenceImpact113(db, exactScope, decisionId)`: narrow #109 reader
  extension seam returning durable state, token and hasReviewedBaseline.
- `captureRuleRevision113(tx, {ruleId,version,scope,
  previousEvaluationDigest,evaluationDigest})`: one explicit exact scope per
  caller transaction. Equal evaluations create no work. #114 owns the bounded
  release envelope, auth, request idempotency and public command.

All list reads select metadata/scalars. Archive capture projects selected JSON
properties and streams source relations/export rows in chunks of 200; it never
loads raw_response, collection_evidence.rows or whole raw_fields into JavaScript.
SQLite still parses selected JSON text; this is not a constant-IO guarantee.

## Evaluation and #109 composition

`premise_invalid` only represents #109's provable old `not_queried` contradiction:
an exact-subject or matched-relation same-title query attempt. Merely filling a
code does not prove what a free-text explanation meant; it is evidence_changed.
Coverage-only changes preserve existing substantive material and do not create
work for confirmed decisions. Explicit disjoint conditions/continuation pages
of the same bound source are excluded. Substantive relevant changes become
`evidence_changed`. No review is created for an absent or withdrawn current
explanation; historical work remains available under its original decision ID.

#114 must compose persisted state inside `readQueryAssessment`, preserving
queryCoverage/currentDecision/explanationValidity/assessment and the validity
object's status/reasons/explanationId/evidenceQueryIds shape. No baseline means
unknown/no_evidence_baseline, never valid. This slice does not change those
public fields. Only #114's atomic reviewed-version receipt can establish valid.

Completion belongs in the existing #102 transaction: compare both current
#102 decision ID (including withdrawal tombstones) and a ready evidence token;
publish/maintain via that service and settle only the observed revision.
A replayed old receipt must not settle later evidence. #114 owns stable public
as-of cursors, permission/error/cache contracts and all completion writes.
