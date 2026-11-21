import { isDeepStrictEqual } from 'node:util'
import { readApiToken, resolveApiAuth } from '../../../core/server/utils/api-auth'
import { importPostgresReceiptRedactor } from './import-receipt-redaction'
import { sanitizeEvidence } from './record-correspondence-read'
import { eventCorrectionError, eventCorrectionOutput, parseEventCorrectionWrite } from './roster-event-correction-api'
import { commitPostgresEventCorrections, preflightPostgresEventCorrections } from './roster-event-correction-postgres'
import { runPostgresCorrespondenceTransaction } from './record-correspondence-write-postgres'
import { usePostgresRosterDb } from './postgres-roster-db'

export async function handlePostgresEventCorrectionWrite(action: 'preflight' | 'commit', input: {
  method: string; body: unknown; headers?: Record<string, string | undefined>; apiToken?: string | null
}) {
  if (!usePostgresRosterDb()) return
  const fail = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } })
  if (!resolveApiAuth({ given: readApiToken(input.headers), configured: input.apiToken }).writeAuthorized) return fail(401, 'unauthorized', 'Configured API token required')
  if (input.method !== 'POST') return fail(405, 'method_not_allowed', 'Method not allowed')
  try {
    const command = parseEventCorrectionWrite(action, input.body)
    const db = usePostgresRosterDb(true)!
    const { knownRedactors } = await importPostgresReceiptRedactor(db, { additionalSecrets: [input.apiToken] })
    const safety = (value: unknown) => isDeepStrictEqual(value, sanitizeEvidence(value, knownRedactors))
    const result = await runPostgresCorrespondenceTransaction(db, tx => command.planHash === null
      ? preflightPostgresEventCorrections(tx, command.request, safety)
      : commitPostgresEventCorrections(tx, command.request, command.planHash, safety))
    return { status: 200, body: eventCorrectionOutput(result, safety, knownRedactors) }
  } catch (error) {
    const rejection = eventCorrectionError(error)
    return fail(rejection.status, rejection.code, rejection.message)
  }
}
