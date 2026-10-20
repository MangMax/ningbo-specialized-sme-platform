# Explanation review UI (#111 under #108)

Consumes the frozen #109 assessment and #114 bounded review reads. Business writes
use only the existing #102 decision-lifecycle command. This slice adds no backend,
migration, evidence processing, rule publication, automatic judgement or production work.

## State ownership

- `QueryAssessmentSummary` displays `queryCoverage`, `currentDecision`,
  `explanationValidity` and `assessment` independently. `QueryCoverageDetails` keeps
  interface, conditions, page gaps, subject uncertainty and truncation visible.
- `EnterpriseExplanations` composes exact title/direction summaries, history and an
  enterprise-scoped review list. URL coordinates locate the matching explanation;
  event links use the existing enterprise event navigation. An impact from another
  enterprise cannot be reviewed through that enterprise's detail link.
- `ComparisonExplanation` consumes the existing enterprise detail read for the exact
  title/direction, sharing its Colada key with the enterprise page. The comparison
  page's review tab owns the global bounded work view.
- `EvidenceReviewList` owns submitted filters, opaque cursors and selected impact.
  Filters cover enterprise/title/direction/event, pending/reviewed and current/history.
  List, source and event reads use at most 25 items per request. Failed pages retain
  their last successful rows with the source scope and explicit retry/restart.
  `invalid_cursor` explains snapshot expiry/eviction; retry keeps the old cursor,
  while explicit user restart or a filter change starts a fresh read.
- `EvidenceReviewDetail` owns the live impact read. Old and current decisions remain
  readable together. If an unmanaged legacy merge deleted the old decision,
  `oldDecision=null` / `gaps.decisionUnavailable` displays the missing original
  explicitly, retains its historical coordinate and source pages, skips the deleted
  enterprise history read, and never enables completion. The additive `reviewedBaseline` audit is displayed separately
  from the original decision audit; maintain never fabricates a new decision version.
  `DecisionHistory` pages #102 history and reads a selected full
  immutable version, including its original evidence and audit fields.
- `EvidenceImpactSources` and `EvidenceRevisionEvents` own their separate committed
  source/event pages. `useBoundedReviewPage` retains the successful page and handles
  cursor navigation; it does not process evidence or interpret business reasons.
- `EvidenceReviewForm` owns the explicit maintain/replacement choice, audit inputs,
  replacement draft and in-memory write credential. It never stores the credential
  in Colada, browser storage, a URL or a payload returned by the server. Known error
  codes are translated locally; raw exception text is never rendered.

## Review completion

Maintain sends the live decision ID and reviewed evidence token and omits a new
business decision. Replacement requires explicit reason/measure selections; no
reason is preselected. Both use #102 with an idempotency key, actor, basis, rule
version and effective time. An unchanged failed request retries its original
envelope/key. Decision/evidence conflicts require a live reread before resubmission;
drafts survive. Historical/withdrawn/merged owners and unready projections are read
only. No credential means no submission; a rejected credential is cleared.
Explicit reread refreshes the assessment, list and history caches as well as the
impact detail, so a concurrent replacement cannot leave an old summary beside a
new current decision. Reviewed source rows keep their original change classification
without relabelling the completed item as pending. A focused explanation waits for
surrounding detail loading to settle and clears the sticky header when located.

After committed success, `useEvidenceReviewRefresh` invalidates all affected active
and inactive Colada list/detail/history prefixes. A frozen pending-list cursor must
also restart at the first page: invalidating its old cursor alone intentionally
returns the historical snapshot. No failed write clears a pending item locally.

## Verification boundary

Public UI interaction tests exercise actual Vue components and Colada consumers
with a simulated HTTP boundary. They are not real-browser or actual #114 API
acceptance. Final acceptance requires completed #114 integrated into this branch,
an isolated synthetic SQLite/server, actual HTTP/MCP and manual desktop/390px
interactions. Keep that evidence, exact candidate SHA and any pending lane in the
external ticket handoff; never substitute mocked screenshots.
