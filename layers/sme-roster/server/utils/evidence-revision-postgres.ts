import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { recordEvent } from '../../../../db/postgresql/ledger-tables'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

export async function advancePostgresOfficialEventRevision(tx: Tx, eventId: number, expectedRevision: number) {
  const revision = expectedRevision + 1
  const changed = await tx.update(recordEvent).set({ revision }).where(and(
    eq(recordEvent.id, eventId), eq(recordEvent.revision, expectedRevision),
  )).returning({ id: recordEvent.id })
  if (changed.length !== 1) throw Object.assign(new Error('Official event revision changed'), { code: 'stale_revision', statusCode: 409 })
  return revision
}
