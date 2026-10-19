import { cookieRedactor } from '../../lib/platform/client'
import { credentialContext, resolveCredential } from './credential-state'
import { sanitizeEvidence } from './record-correspondence-read'
import { DecisionError102, type DecisionDb } from './decision-lifecycle-102'
/** Resolve redactors before a write so output preparation cannot fail after commit. */
export function decisionOutput102(db: DecisionDb) {
  const runtime = useRuntimeConfig()
  const credentials = { ...credentialContext(), db }
  const values = [runtime.apiToken, runtime.mcpToken, resolveCredential('miitCookie', credentials).value, resolveCredential('ocrToken', credentials).value]
  const redactors = [...new Set(values.filter((v): v is string => typeof v === 'string' && !!v))].map(cookieRedactor)
  return (value: unknown) => sanitizeEvidence(value, redactors)
}
export function decisionFailure102(error: unknown) {
  const typed = error instanceof DecisionError102 ? error : new DecisionError102(500, 'transaction_failed', 'Decision operation failed; no partial changes committed')
  return { status: typed.statusCode, body: { error: { code: typed.code, message: typed.message } } }
}
export function decisionMcp102(db: DecisionDb, operation: () => unknown) {
  try { const output = decisionOutput102(db); return output(operation()) }
  catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(decisionFailure102(error).body) }] } }
}
