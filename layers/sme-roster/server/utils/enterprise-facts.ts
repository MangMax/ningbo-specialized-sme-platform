import { createHash } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../../../db/schema'
import { EnterpriseProfileError, enterpriseProfilePatchSchema } from './enterprise-profile'
type Db = BetterSQLite3Database<typeof s>
type Executor = Pick<Db, 'select' | 'insert'>
const text = (max: number) => z.string().trim().min(1).max(max).refine(v => v.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(v))
const point = z.discriminatedUnion('precision', [
  z.strictObject({ precision: z.literal('unknown'), value: z.null() }),
  z.strictObject({ precision: z.literal('year'), value: z.string().regex(/^\d{4}$/) }),
  z.strictObject({ precision: z.literal('month'), value: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
  z.strictObject({ precision: z.literal('day'), value: z.iso.date() }),
  z.strictObject({ precision: z.literal('instant'), value: z.iso.datetime() }),
])
const factSchema = z.strictObject({
  kind: z.enum(['moved_in', 'moved_out', 'cancelled', 'registration_status']),
  source: z.strictObject({ reference: text(2000), statement: text(4000) }),
  observed: point, effective: point, city: text(100).nullable(),
})
const envelope = {
  idempotencyKey: enterpriseProfilePatchSchema.shape.idempotencyKey,
  expectedVersion: enterpriseProfilePatchSchema.shape.expectedVersion,
  actor: enterpriseProfilePatchSchema.shape.actor,
  basis: enterpriseProfilePatchSchema.shape.basis,
}
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const enterpriseFactCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...envelope, action: z.literal('assert'), fact: factSchema }),
  z.strictObject({ ...envelope, action: z.literal('confirm'), factId: id }),
  z.strictObject({ ...envelope, action: z.literal('withdraw'), factId: id }),
  z.strictObject({ ...envelope, action: z.literal('replace'), factId: id, fact: factSchema }),
])
export const enterpriseFactCommitSchema = z.strictObject({ request: enterpriseFactCommandSchema, planHash: z.string().regex(/^[a-f0-9]{64}$/) })
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
function fail(code: string, message: string): never { throw new EnterpriseProfileError(409, code, message) }
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) throw new EnterpriseProfileError(400, 'invalid_request', z.prettifyError(result.error))
  return result.data
}
function state(db: Executor, enterpriseId: number) {
  if (!db.select({ id: s.enterprise.id }).from(s.enterprise).where(eq(s.enterprise.id, enterpriseId)).get()) throw new EnterpriseProfileError(404, 'not_found', 'Enterprise not found')
  const history = db.select().from(s.enterpriseFactRevision).where(eq(s.enterpriseFactRevision.enterpriseId, enterpriseId)).orderBy(asc(s.enterpriseFactRevision.id)).all()
  const facts = new Map<number, typeof history[number]>()
  for (const row of history) facts.set(row.factId, row)
  return { enterpriseId, version: hash({ enterpriseId, lastRevision: history.at(-1)?.id ?? null }), facts: [...facts.values()], history }
}
export function getEnterpriseFacts(db: Db, enterpriseId: number) { return db.transaction(tx => state(tx, enterpriseId)) }
function prepare(db: Executor, enterpriseId: number, body: unknown) {
  const request = parse(enterpriseFactCommandSchema, body), requestHash = hash({ enterpriseId, request })
  const prior = db.select().from(s.enterpriseFactReceipt).where(eq(s.enterpriseFactReceipt.idempotencyKey, request.idempotencyKey)).get()
  if (prior && prior.requestHash !== requestHash) fail('idempotency_conflict', 'Key already used for another fact command')
  const current = state(db, enterpriseId)
  const target = 'factId' in request ? current.facts.find(f => f.factId === request.factId) : undefined
  if (!prior) {
    if (current.version !== request.expectedVersion) fail('version_conflict', 'Read current enterprise facts again')
    if (request.action !== 'assert') {
      if (!target || target.status === 'withdrawn' || target.status === 'replaced') fail('fact_conflict', 'Fact is missing or terminal; cannot revive it')
      if (request.action === 'confirm' && target.status !== 'pending') fail('fact_conflict', 'Only pending facts can be confirmed')
    }
  }
  return { request, requestHash, prior, current, target, planHash: hash({ rule: 'enterprise-facts-306-v1', enterpriseId, request }) }
}
export function preflightEnterpriseFact(db: Db, enterpriseId: number, body: unknown) {
  return db.transaction(tx => {
    const p = prepare(tx, enterpriseId, body)
    return { planHash: p.planHash, expectedVersion: p.request.expectedVersion, replay: !!p.prior }
  })
}
export function commitEnterpriseFact(db: Db, enterpriseId: number, body: unknown) {
  const input = parse(enterpriseFactCommitSchema, body)
  return db.transaction(tx => {
    const p = prepare(tx, enterpriseId, input.request)
    if (p.planHash !== input.planHash) fail('plan_conflict', 'Preflight does not match request')
    if (p.prior) return p.prior.receipt
    const { request, target } = p, createdAt = new Date().toISOString()
    const audit = { enterpriseId, actor: request.actor, basis: request.basis, action: request.action, createdAt }
    let factId: number
    if (request.action === 'assert' || request.action === 'replace') {
      if (target) tx.insert(s.enterpriseFactRevision).values({ ...audit, factId: target.factId, revision: target.revision + 1, fact: target.fact, status: 'replaced', replaces: target.replaces }).run()
      factId = Math.max(0, ...p.current.facts.map(f => f.factId)) + 1
      tx.insert(s.enterpriseFactRevision).values({ ...audit, factId, revision: 1, fact: request.fact, status: 'pending', replaces: target?.factId ?? null }).run()
    } else {
      factId = target!.factId
      tx.insert(s.enterpriseFactRevision).values({ ...audit, factId, revision: target!.revision + 1, fact: target!.fact, status: request.action === 'confirm' ? 'confirmed' : 'withdrawn', replaces: target!.replaces }).run()
    }
    const receipt = { factId, version: state(tx, enterpriseId).version, committedAt: createdAt }
    tx.insert(s.enterpriseFactReceipt).values({ idempotencyKey: request.idempotencyKey, requestHash: p.requestHash, receipt }).run()
    return receipt
  }, { behavior: 'immediate' })
}
