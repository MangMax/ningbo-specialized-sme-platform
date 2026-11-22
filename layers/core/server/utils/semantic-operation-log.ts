import { appLog, type LogContext, type LogInput } from '../../lib/logging'

// Application-owned domain codes only. Never forward arbitrary exception.code strings.
const DOMAIN_CODES = new Set([
  'alias_correction_empty', 'alias_idempotency_conflict', 'alias_identity_conflict', 'alias_input_invalid',
  'alias_lifecycle_required', 'alias_not_found', 'alias_page_response_too_large', 'alias_source_evidence_mismatch',
  'alias_source_evidence_required', 'alias_subject_conflict', 'alias_transition_invalid', 'alias_version_conflict',
  'ambiguous_attachment', 'ambiguous_target', 'attachment_conflict', 'coordinate_conflict', 'file_changed',
  'file_identity_conflict', 'file_unavailable', 'not_page_capable', 'page_count_unknown', 'page_invalid',
  'basis_required', 'credential_in_evidence', 'duplicate_target', 'enterprise_not_found', 'evidence_mismatch',
  'evidence_not_found', 'idempotency_conflict', 'identity_conflict', 'invalid_event_combination', 'invalid_name',
  'invalid_prior_time', 'invalid_request', 'method_not_allowed', 'natural_key_conflict', 'no_change',
  'no_current_decision', 'not_found', 'old_value_conflict', 'plan_mismatch', 'previous_name_confirmation_required',
  'qualification_evidence_unconfirmed', 'request_limit', 'response_too_large', 'source_limit', 'stale_evidence',
  'stale_revision', 'stale_version', 'target_mismatch', 'transaction_failed', 'unauthorized',
  'unexpected_previous_name', 'version_conflict', 'internal_error',
])
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}
export function semanticErrorCode(value: unknown): string | undefined {
  const code = object(value).code ?? object(object(value).data).code
  return typeof code === 'string' && DOMAIN_CODES.has(code) ? code : undefined
}
function resultBody(value: unknown): Record<string, unknown> {
  const result = object(value)
  // Only decode a bounded error envelope; never parse arbitrary successful text/results.
  if (result.isError === true) {
    const text = object(Array.isArray(result.content) ? result.content[0] : undefined).text
    if (typeof text === 'string' && text.length <= 8192) {
      try { return object(JSON.parse(text)) } catch { /* Toolkit may return plain error text. */ }
    }
  }
  return result
}
const positiveId = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
/** Explicit output projections: no request IDs, idempotency keys, actor, text, paths or guessed audits. */
function references(operation: string, body: Record<string, unknown>): LogContext {
  if (operation === 'mcp.tool.patch_enterprise_profile' || operation === 'maintenance.enterprise_profile.patch') return { auditId: positiveId(body.auditId) }
  if (operation === 'mcp.tool.maintain_enterprise_alias' || operation === 'maintenance.alias.patch') return { resourceType: 'enterprise_alias', resourceId: positiveId(object(body.alias).id) }
  if (['mcp.tool.commit_event_corrections', 'mcp.tool.preflight_event_corrections', 'maintenance.event.commit', 'maintenance.event.preflight'].includes(operation)) return { batchId: positiveId(body.batchId) }
  if (operation === 'mcp.tool.save_difference_decision' || operation === 'maintenance.decision.commands') return { resourceType: 'difference_decision_version', resourceId: positiveId(body.versionId) }
  return {}
}
/** Semantic operation only; evlog owns request completion. Failure here cannot affect business execution. */
export function logSemanticOperation(source: LogInput['source'], operation: string, context: LogContext, started: number, value: unknown, status?: number, thrown = false) {
  try {
    const result = object(value), body = resultBody(value)
    const failure = thrown || result.isError === true || !!body.error || (status !== undefined && status >= 400)
    const code = semanticErrorCode(body.error) ?? (thrown ? semanticErrorCode(value) : undefined)
    const denied = status === 401 || status === 403 || code === 'unauthorized'
    appLog({ source, operation, outcome: denied ? 'denied' : failure ? 'failure' : 'success',
      durationMs: Math.max(0, performance.now() - started), statusCode: status,
      errorCode: failure ? code ?? 'operation_failed' : undefined,
      ...(!failure ? references(operation, body) : {}),
    }, context)
  } catch { /* Logging is disposable, authoritative business audits are not. */ }
}
