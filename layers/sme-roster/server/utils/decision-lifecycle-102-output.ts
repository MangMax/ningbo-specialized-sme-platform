import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { importPostgresReceiptRedactor } from './import-receipt-redaction'
import { usePostgresRosterDb } from './postgres-roster-db'
import { cookieRedactor } from '../../lib/platform/client'
import { credentialContext, resolveCredential } from '../../../core/server/utils/credential-state'
import { sanitizeEvidence } from './record-correspondence-read'
import { z } from 'zod'
import { DecisionError102, decisionScope102, type DecisionDb } from './decision-lifecycle-102'
/** Resolve redactors before a write so output preparation cannot fail after commit. */
export function decisionOutput102(db: DecisionDb) {
  const runtime = useRuntimeConfig()
  const credentials = { ...credentialContext(), db }
  const values = [runtime.apiToken, runtime.mcpToken, resolveCredential('sme-roster.miitCookie', credentials).value, resolveCredential('core.ocrToken', credentials).value]
  const redactors = [...new Set(values.filter((v): v is string => typeof v === 'string' && !!v))].map(cookieRedactor)
  return projectDecisionOutput(redactors)
}

export async function postgresDecisionOutput102(db: NodePgDatabase) {
  const { knownRedactors } = await importPostgresReceiptRedactor(db)
  return projectDecisionOutput(knownRedactors)
}

function projectDecisionOutput(redactors: Parameters<typeof sanitizeEvidence>[1]) {
  return (value: Record<string, unknown>) => {
    const safe = sanitizeEvidence(value, redactors)
    // Only this strict numeric/domain version object may pass a token-named key.
    // Arbitrary evidence/source/credential fields still use the existing redactor.
    const version = decisionScope102.extend({ decisionId: z.number().int().positive().nullable(), latestRevisionId: z.number().int().nonnegative(), projectionReady: z.boolean() }).safeParse(value && typeof value === 'object' ? value.evidenceToken : undefined)
    return version.success ? { ...safe, evidenceToken: version.data } : safe
  }
}
export function decisionFailure102(error: unknown) {
  const typed = error instanceof DecisionError102 ? error : new DecisionError102(500, 'transaction_failed', 'Decision operation failed; no partial changes committed')
  return { status: typed.statusCode, body: { error: { code: typed.code, message: typed.message } } }
}
export function decisionMcp102(db: DecisionDb, operation: () => Record<string, unknown>) {
  try { const output = decisionOutput102(db); return output(operation()) }
  catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(decisionFailure102(error).body) }] } }
}

export async function decisionReadMcp102(db: () => DecisionDb, legacy: (tx: DecisionDb) => Record<string, unknown>,
  postgres: (tx: NodePgDatabase) => Promise<Record<string, unknown>>,
) {
  try {
    const native = usePostgresRosterDb()
    if (!native) {
      const sqlite = db()
      return decisionMcp102(sqlite, () => sqlite.transaction(tx => legacy(tx)))
    }
    return await native.transaction(async tx => (await postgresDecisionOutput102(tx))(await postgres(tx)), {
      isolationLevel: 'repeatable read', accessMode: 'read only',
    })
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(decisionFailure102(error).body) }] }
  }
}
