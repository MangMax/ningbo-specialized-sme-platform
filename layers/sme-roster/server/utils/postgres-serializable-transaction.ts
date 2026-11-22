import { setTimeout as delay } from 'node:timers/promises'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type PostgresError = { code?: string; constraint?: string }

export function postgresErrorDetails(error: unknown) {
  const failure = error as (PostgresError & { cause?: PostgresError }) | undefined
  return { code: failure?.code ?? failure?.cause?.code, constraint: failure?.constraint ?? failure?.cause?.constraint }
}

export class PostgresSourceConflict extends Error {
  readonly code = 'plan_mismatch'
  readonly status = 409

  constructor() {
    super('Concurrent source change; preflight again')
  }
}

export async function runPostgresSerializableTransaction<T>(
  db: NodePgDatabase, run: (tx: Tx) => Promise<T>,
  { retryDelays = [0, 0], retryForeignKey }: {
    retryDelays?: readonly number[]
    retryForeignKey?: string
  } = {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(run, { isolationLevel: 'serializable' })
    } catch (error) {
      const { code, constraint } = postgresErrorDetails(error)
      if (code !== '40001' && !(code === '23503' && retryForeignKey && constraint === retryForeignKey)) throw error
      const wait = retryDelays[attempt]
      if (wait === undefined) throw new PostgresSourceConflict()
      if (wait) await delay(wait)
    }
  }
}
