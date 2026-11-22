import { projectEnterpriseFactState, parseEnterpriseFactInput, enterpriseFactCommandSchema, enterpriseFactHash, fail, planEnterpriseFact, enterpriseFactCommitSchema, enterpriseFactRevisions } from './enterprise-fact-model'
import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../../../db/schema'
import { EnterpriseProfileError } from './enterprise-profile'
type Db = BetterSQLite3Database<typeof s>
type Executor = Pick<Db, 'select' | 'insert'>
function state(db: Executor, enterpriseId: number) {
  if (!db.select({ id: s.enterprise.id }).from(s.enterprise).where(eq(s.enterprise.id, enterpriseId)).get()) throw new EnterpriseProfileError(404, 'not_found', 'Enterprise not found')
  const history = db.select().from(s.enterpriseFactRevision).where(eq(s.enterpriseFactRevision.enterpriseId, enterpriseId)).orderBy(asc(s.enterpriseFactRevision.id)).all()
  return projectEnterpriseFactState(enterpriseId, history)
}
export function getEnterpriseFacts(db: Db, enterpriseId: number) { return db.transaction(tx => state(tx, enterpriseId)) }
function prepare(db: Executor, enterpriseId: number, body: unknown) {
  const request = parseEnterpriseFactInput(enterpriseFactCommandSchema, body), requestHash = enterpriseFactHash({ enterpriseId, request })
  const prior = db.select().from(s.enterpriseFactReceipt).where(eq(s.enterpriseFactReceipt.idempotencyKey, request.idempotencyKey)).get()
  if (prior && prior.requestHash !== requestHash) fail('idempotency_conflict', 'Key already used for another fact command')
  const current = state(db, enterpriseId)
  return planEnterpriseFact(enterpriseId, request, requestHash, prior, current)
}
export function preflightEnterpriseFact(db: Db, enterpriseId: number, body: unknown) {
  return db.transaction(tx => {
    const p = prepare(tx, enterpriseId, body)
    return { planHash: p.planHash, expectedVersion: p.request.expectedVersion, replay: !!p.prior }
  })
}
export function commitEnterpriseFact(db: Db, enterpriseId: number, body: unknown) {
  const input = parseEnterpriseFactInput(enterpriseFactCommitSchema, body)
  return db.transaction(tx => {
    const p = prepare(tx, enterpriseId, input.request)
    if (p.planHash !== input.planHash) fail('plan_conflict', 'Preflight does not match request')
    if (p.prior) return p.prior.receipt
    const createdAt = new Date().toISOString()
    const { factId, revisions } = enterpriseFactRevisions(enterpriseId, p, createdAt)
    for (const revision of revisions) tx.insert(s.enterpriseFactRevision).values(revision).run()
    const receipt = { factId, version: state(tx, enterpriseId).version, committedAt: createdAt }
    tx.insert(s.enterpriseFactReceipt).values({ idempotencyKey: p.request.idempotencyKey, requestHash: p.requestHash, receipt }).run()
    return receipt
  }, { behavior: 'immediate' })
}
export { enterpriseFactCommandSchema, enterpriseFactCommitSchema, enterpriseFactHash, parseEnterpriseFactInput, projectEnterpriseFactState, planEnterpriseFact, enterpriseFactRevisions } from './enterprise-fact-model'
