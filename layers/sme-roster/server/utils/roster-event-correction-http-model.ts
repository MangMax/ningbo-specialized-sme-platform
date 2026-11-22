import { z } from 'zod'
import { sanitizeEvidence } from './evidence-redaction'
import { eventCorrectionFailure, eventCorrectionRequestSchema, finalizedCorrectionReadback } from './roster-event-correction-model'

const commitSchema = z.strictObject({ request: eventCorrectionRequestSchema, planHash: z.string().regex(/^[a-f0-9]{64}$/) })

export function parseEventCorrectionWrite(action: 'preflight' | 'commit', body: unknown) {
  if (Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8') > 1024 * 1024) return eventCorrectionFailure(413, 'request_limit', 'Event correction request exceeds 1 MiB')
  if (action === 'preflight') {
    const parsed = eventCorrectionRequestSchema.safeParse(body)
    if (!parsed.success) return eventCorrectionFailure(400, 'invalid_request', 'Invalid event correction request; use the documented strict whitelist')
    return { request: parsed.data, planHash: null }
  }
  const parsed = commitSchema.safeParse(body)
  if (!parsed.success) return eventCorrectionFailure(400, 'invalid_request', 'Original correction request and planHash required')
  return parsed.data
}

export function eventCorrectionOutput(result: unknown, safety: Parameters<typeof finalizedCorrectionReadback>[1], redactors: ReadonlyArray<(text: string) => string>) {
  const finalized = finalizedCorrectionReadback(result, safety)
  if (!finalized) return sanitizeEvidence(result, redactors)
  const legacy = sanitizeEvidence(finalized.legacy, redactors)
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error('Invalid sanitized correction result')
  return { ...legacy, qualificationReadback: finalized.value }
}

export function eventCorrectionError(error: unknown) {
  const known = error as { statusCode?: number; code?: string; message?: string }
  return known.statusCode && known.code
    ? { status: known.statusCode, code: known.code, message: known.message ?? 'Correction rejected' }
    : { status: 500, code: 'transaction_failed', message: 'Event correction failed; no partial changes committed' }
}
