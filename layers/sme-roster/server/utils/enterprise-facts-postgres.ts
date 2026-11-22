import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../../../../db/schema'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { enterpriseFactReceipt, enterpriseFactRevision } from '../../../../db/postgresql/qualification-tables'
import { EnterpriseProfileError } from './enterprise-profile-model'
import { enterpriseFactCommandSchema, enterpriseFactCommitSchema, enterpriseFactHash, enterpriseFactRevisions, parseEnterpriseFactInput, planEnterpriseFact, projectEnterpriseFactState } from './enterprise-fact-model'

type Executor = Pick<NodePgDatabase, 'execute' | 'select'>
const readSnapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const

async function state(db: Executor, enterpriseId: number, lock = false) {
  const subject = db.select({ id: enterprise.id }).from(enterprise).where(eq(enterprise.id, enterpriseId))
  if (!(await (lock ? subject.for('update') : subject)).length) throw new EnterpriseProfileError(404, 'not_found', 'Enterprise not found')
  const revisions = await db.select().from(enterpriseFactRevision).where(eq(enterpriseFactRevision.enterpriseId, enterpriseId)).orderBy(enterpriseFactRevision.id)
  return projectEnterpriseFactState(enterpriseId, revisions.map(row => ({
    ...row, status: row.status as typeof schema.enterpriseFactRevision.$inferSelect['status'],
    fact: JSON.parse(row.fact), actor: JSON.parse(row.actor),
  })))
}

export function readPostgresEnterpriseFacts(db: NodePgDatabase, enterpriseId: number) {
  return db.transaction(tx => state(tx, enterpriseId), readSnapshot)
}

async function prepare(db: Executor, enterpriseId: number, body: unknown, lock = false) {
  const request = parseEnterpriseFactInput(enterpriseFactCommandSchema, body)
  // Drizzle has no builder for PostgreSQL transaction advisory locks and hashtext.
  if (lock) await db.execute(sql`SELECT pg_advisory_xact_lock(144815, hashtext(${'enterprise-fact:' + request.idempotencyKey}))`)
  const requestHash = enterpriseFactHash({ enterpriseId, request })
  const [stored] = await db.select().from(enterpriseFactReceipt).where(eq(enterpriseFactReceipt.idempotencyKey, request.idempotencyKey))
  const prior = stored && { requestHash: stored.requestHash, receipt: JSON.parse(stored.receipt) as typeof schema.enterpriseFactReceipt.$inferSelect['receipt'] }
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
      const [written] = await tx.insert(enterpriseFactRevision).values({
        ...row, fact: JSON.stringify(row.fact), actor: JSON.stringify(row.actor),
      }).returning({ id: enterpriseFactRevision.id })
      lastRevision = written!.id
    }
    const receipt = { factId, version: enterpriseFactHash({ enterpriseId, lastRevision }), committedAt: createdAt }
    await tx.insert(enterpriseFactReceipt).values({
      idempotencyKey: plan.request.idempotencyKey, requestHash: plan.requestHash, receipt: JSON.stringify(receipt),
    })
    return receipt
  })
}
