import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import { EnterpriseProfileError } from './enterprise-profile'
import {
  enterpriseFactCommandSchema, enterpriseFactCommitSchema, enterpriseFactHash, enterpriseFactRevisions,
  parseEnterpriseFactInput, planEnterpriseFact, projectEnterpriseFactState,
} from './enterprise-facts'

type Executor = Pick<NodePgDatabase, 'execute'>
const readSnapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const

async function state(db: Executor, enterpriseId: number, lock = false) {
  const found = await db.execute(sql`SELECT id FROM enterprise WHERE id = ${enterpriseId} ${lock ? sql`FOR UPDATE` : sql.empty()}`)
  if (!found.rowCount) throw new EnterpriseProfileError(404, 'not_found', 'Enterprise not found')
  const history = await readPostgresRosterRowsById(db, schema.enterpriseFactRevision, sql`
    FROM enterprise_fact_revision p WHERE p.enterprise_id = ${enterpriseId}`)
  return projectEnterpriseFactState(enterpriseId, history)
}

export function readPostgresEnterpriseFacts(db: NodePgDatabase, enterpriseId: number) {
  return db.transaction(tx => state(tx, enterpriseId), readSnapshot)
}

async function prepare(db: Executor, enterpriseId: number, body: unknown, lock = false) {
  const request = parseEnterpriseFactInput(enterpriseFactCommandSchema, body)
  if (lock) await db.execute(sql`SELECT pg_advisory_xact_lock(144815, hashtext(${'enterprise-fact:' + request.idempotencyKey}))`)
  const requestHash = enterpriseFactHash({ enterpriseId, request })
  const { rows: [prior] } = await db.execute<{ requestHash: string; receipt: typeof schema.enterpriseFactReceipt.$inferSelect['receipt'] }>(sql`
    SELECT request_hash AS "requestHash", receipt::json AS receipt FROM enterprise_fact_receipt
    WHERE idempotency_key = ${request.idempotencyKey}`)
  if (prior && prior.requestHash !== requestHash) throw new EnterpriseProfileError(409, 'idempotency_conflict', 'Key already used for another fact command')
  return planEnterpriseFact(enterpriseId, request, requestHash, prior, await state(db, enterpriseId, lock))
}

export function preflightPostgresEnterpriseFact(db: NodePgDatabase, enterpriseId: number, body: unknown) {
  return db.transaction(async tx => {
    const plan = await prepare(tx, enterpriseId, body)
    return { planHash: plan.planHash, expectedVersion: plan.request.expectedVersion, replay: Boolean(plan.prior) }
  }, readSnapshot)
}

export function commitPostgresEnterpriseFact(db: NodePgDatabase, enterpriseId: number, body: unknown) {
  const input = parseEnterpriseFactInput(enterpriseFactCommitSchema, body)
  return db.transaction(async tx => {
    const plan = await prepare(tx, enterpriseId, input.request, true)
    if (plan.planHash !== input.planHash) throw new EnterpriseProfileError(409, 'plan_conflict', 'Preflight does not match request')
    if (plan.prior) return plan.prior.receipt
    const createdAt = new Date().toISOString()
    const { factId, revisions } = enterpriseFactRevisions(enterpriseId, plan, createdAt)
    let lastRevision: number | null = null
    for (const row of revisions) {
      const { rows: [written] } = await tx.execute<{ id: string }>(sql`
        INSERT INTO enterprise_fact_revision (enterprise_id, fact_id, revision, status, fact, replaces, action, actor, basis, created_at)
        VALUES (${row.enterpriseId}, ${row.factId}, ${row.revision}, ${row.status}, ${JSON.stringify(row.fact)}, ${row.replaces ?? null},
          ${row.action}, ${JSON.stringify(row.actor)}, ${row.basis}, ${row.createdAt})
        RETURNING id`)
      lastRevision = Number(written!.id)
    }
    const receipt = { factId, version: enterpriseFactHash({ enterpriseId, lastRevision }), committedAt: createdAt }
    await tx.execute(sql`INSERT INTO enterprise_fact_receipt (idempotency_key, request_hash, receipt)
      VALUES (${plan.request.idempotencyKey}, ${plan.requestHash}, ${JSON.stringify(receipt)})`)
    return receipt
  })
}
