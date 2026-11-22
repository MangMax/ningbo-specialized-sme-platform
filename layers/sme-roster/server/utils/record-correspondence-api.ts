import { type CorrespondenceApiInput, type CorrespondenceApiOutput, auth, fail, parseListQuery, ok, detailPageResponse, discovery, success, sanitizePublishedObject, sanitizePublishedEvent, candidate, decision, commitDecision, scalar, batchResponse, int, sourceKinds, sourceFilter, sourceResponse, sanitizePublishedDetail, auditPaging, auditResponse } from './record-correspondence-runtime'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { importReceiptRedactor } from './import-receipt-redaction-sqlite'
import { commitRecordCorrespondences, getRecordCorrespondence, listRecordCorrespondences, pageRecordCorrespondences, pageRecordCorrespondenceAudit, preflightRecordCorrespondences, readRecordCorrespondenceBatch } from './record-correspondence'
import { CorrespondenceError } from './record-correspondence-model'
import { detail, details, sourceReader, sanitizeEvidence, type SourceKind } from './record-correspondence-read'
import { summaries } from './record-correspondence-summary-projection'
import { discoverEventArchives } from './event-archive-discovery'
import { generateCandidates } from './record-correspondence-candidates'
type Db = BetterSQLite3Database<typeof schema>
export function handleRecordCorrespondenceRequest(input: CorrespondenceApiInput, context: { db: Db; apiToken?: string | null; browserAuthorized?: boolean }): CorrespondenceApiOutput {
  return ['list', 'get', 'audit', 'source', 'candidates', 'discover'].includes(input.action)
    ? context.db.transaction(() => correspondenceSnapshot(input, context))
    : correspondenceSnapshot(input, context)
}
function correspondenceSnapshot(input: CorrespondenceApiInput, context: { db: Db; apiToken?: string | null; browserAuthorized?: boolean }): CorrespondenceApiOutput {
  try {
    const { db } = context
    const write = ['preflight', 'commit', 'batch'].includes(input.action)
    if (write && context.browserAuthorized !== true && !auth(input, context.apiToken)) return fail(401, 'unauthorized', 'Configured API token required')
    const method = ['list', 'get', 'audit', 'source', 'batch'].includes(input.action) ? 'GET' : 'POST'
    if (input.method !== method) return fail(405, 'method_not_allowed', `${method} required`)
    // Resolve secrets before any preflight or commit side effect, so response
    // redaction cannot fail after a decision was written.
    const redact = importReceiptRedactor(db, { additionalSecrets: [context.apiToken] })
    const redactors = redact.knownRedactors
    if (input.action === 'list') {
      const parsed = parseListQuery(input.query ?? {})
      if ('status' in parsed) return parsed
      const { filter, paging, view } = parsed
      const result = pageRecordCorrespondences(db, filter, paging)
      if (view === 'summary') return ok({ ...result, rows: summaries(result.rows) }, redactors)
      return detailPageResponse(result, details(db, result.rows, redact), redactors)
    }
    if (input.action === 'discover') {
      const parsed = discovery.safeParse(input.body)
      if (!parsed.success) return fail(400, 'invalid_request', 'Invalid event discovery request')
      const result = discoverEventArchives(db, parsed.data, redact)
      if (!result) return fail(404, 'not_found', 'Official award or review event not found')
      return success(sanitizePublishedObject(result, redactors, (key, value) => key === 'event'
        ? sanitizePublishedEvent(result.event, redactors) : sanitizeEvidence(value, redactors)))
    }
    if (input.action === 'candidates') {
      const parsed = candidate.safeParse(input.body)
      if (!parsed.success) return fail(400, 'invalid_request', z.prettifyError(parsed.error))
      const result = generateCandidates(db, parsed.data)
      return result ? ok(result, redactors) : fail(404, 'not_found', 'Official event or enterprise not found')
    }
    if (input.action === 'preflight') {
      const parsed = decision.safeParse(input.body)
      return parsed.success ? ok(preflightRecordCorrespondences(db, parsed.data), redactors) : fail(400, 'invalid_request', z.prettifyError(parsed.error))
    }
    if (input.action === 'commit') {
      const parsed = commitDecision.safeParse(input.body)
      return parsed.success ? ok(commitRecordCorrespondences(db, parsed.data.request, parsed.data.planHash), redactors) : fail(400, 'invalid_request', z.prettifyError(parsed.error))
    }
    if (input.action === 'batch') {
      const key = scalar(input.key); if (!key) return fail(400, 'invalid_request', 'Idempotency key required')
      return batchResponse(readRecordCorrespondenceBatch(db, key), redactors)
    }
    const id = int(input.id); if (!id) return fail(400, 'invalid_request', 'Positive ID required')
    if (input.action === 'source') {
      const kind = input.kind as SourceKind
      if (!sourceKinds.includes(kind)) return fail(400, 'invalid_request', 'Invalid source kind')
      const rows = listRecordCorrespondences(db, sourceFilter(kind, id))
      return sourceResponse(sourceReader(db, rows, { kind, id }, redact), kind, id, rows, redactors)
    }
    if (input.action === 'get') {
      const row = getRecordCorrespondence(db, id)
      return row ? success(sanitizePublishedDetail(detail(db, row, redact), redactors)) : fail(404, 'not_found', 'Correspondence not found')
    }
    if (!db.select({ id: schema.recordCorrespondence.id }).from(schema.recordCorrespondence).where(eq(schema.recordCorrespondence.id, id)).get()) return fail(404, 'not_found', 'Correspondence not found')
    const paging = auditPaging(input.query ?? {}); if (!paging) return fail(400, 'invalid_request', 'Invalid audit query')
    return auditResponse(pageRecordCorrespondenceAudit(db, id, paging), redactors)
  } catch (error) {
    if (error instanceof CorrespondenceError) return fail(error.status, error.code, error.message)
    throw error
  }
}
export { type CorrespondenceAction, type CorrespondenceApiInput, type CorrespondenceApiOutput, handlePostgresCorrespondenceRequest } from './record-correspondence-runtime'
