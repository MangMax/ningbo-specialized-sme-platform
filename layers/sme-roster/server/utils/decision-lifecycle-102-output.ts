import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { importPostgresReceiptRedactor } from './import-receipt-redaction'
import { usePostgresRosterDb } from './postgres-roster-db'
import { sanitizeEvidence } from './evidence-redaction'
import { z } from 'zod'
import { DecisionError102, decisionScope102 } from './decision-lifecycle-102/contract'
export async function postgresDecisionOutput102(db: NodePgDatabase) {
  const { knownRedactors } = await importPostgresReceiptRedactor(db)
  return projectDecisionOutput(knownRedactors)
}

export function projectDecisionOutput(redactors: Parameters<typeof sanitizeEvidence>[1]) {
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
export async function decisionReadMcp102(postgres: (tx: NodePgDatabase) => Promise<Record<string, unknown>>, pinned = true,
) {
  try {
    const native = usePostgresRosterDb()
    if (!pinned) return (await postgresDecisionOutput102(native))(await postgres(native))
    return await native.transaction(async tx => (await postgresDecisionOutput102(tx))(await postgres(tx)), {
      isolationLevel: 'repeatable read', accessMode: 'read only',
    })
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(decisionFailure102(error).body) }] }
  }
}

export async function decisionWriteMcp102(postgres: (db: NodePgDatabase) => Promise<Record<string, unknown>>, write = true,
) {
  try {
    const native = usePostgresRosterDb(write)
    const output = await postgresDecisionOutput102(native)
    return output(await postgres(native))
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(decisionFailure102(error).body) }] }
  }
}
