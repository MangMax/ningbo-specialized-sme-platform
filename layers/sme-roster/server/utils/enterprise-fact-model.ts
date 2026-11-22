import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { enterpriseFactRevision as EnterpriseFactRevisionTable } from '../../../../db/postgresql/qualification-tables'
import { EnterpriseProfileError } from './enterprise-profile-model'
import { enterpriseProfilePatchSchema } from './enterprise-profile-model'

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

export const enterpriseFactHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')

export function fail(code: string, message: string): never { throw new EnterpriseProfileError(409, code, message) }

export function parseEnterpriseFactInput<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) throw new EnterpriseProfileError(400, 'invalid_request', z.prettifyError(result.error))
  return result.data
}

export type EnterpriseFactRevision = Omit<typeof EnterpriseFactRevisionTable.$inferSelect, 'fact' | 'actor' | 'status'> & {
  fact: Record<string, unknown>
  actor: { type: 'user' | 'agent'; id: string }
  status: 'pending' | 'confirmed' | 'replaced' | 'withdrawn'
}

export type EnterpriseFactReceipt = { factId: number; version: string; committedAt: string }

export function projectEnterpriseFactState(enterpriseId: number, history: Array<EnterpriseFactRevision>) {
  const facts = new Map<number, typeof history[number]>()
  for (const row of history) facts.set(row.factId, row)
  return { enterpriseId, version: enterpriseFactHash({ enterpriseId, lastRevision: history.at(-1)?.id ?? null }), facts: [...facts.values()], history }
}

export function planEnterpriseFact(
  enterpriseId: number,
  request: z.infer<typeof enterpriseFactCommandSchema>,
  requestHash: string,
  prior: { requestHash: string; receipt: EnterpriseFactReceipt } | undefined,
  current: ReturnType<typeof projectEnterpriseFactState>,
) {
  const target = 'factId' in request ? current.facts.find(f => f.factId === request.factId) : undefined
  if (!prior) {
    if (current.version !== request.expectedVersion) fail('version_conflict', 'Read current enterprise facts again')
    if (request.action !== 'assert') {
      if (!target || target.status === 'withdrawn' || target.status === 'replaced') fail('fact_conflict', 'Fact is missing or terminal; cannot revive it')
      if (request.action === 'confirm' && target.status !== 'pending') fail('fact_conflict', 'Only pending facts can be confirmed')
    }
  }
  return { request, requestHash, prior, current, target, planHash: enterpriseFactHash({ rule: 'enterprise-facts-306-v1', enterpriseId, request }) }
}

export function enterpriseFactRevisions(enterpriseId: number, plan: ReturnType<typeof planEnterpriseFact>, createdAt: string) {
  const { request, target } = plan
  const audit = { enterpriseId, actor: request.actor, basis: request.basis, action: request.action, createdAt }
  const revisions: Array<Omit<EnterpriseFactRevision, 'id'>> = []
  if (request.action === 'assert' || request.action === 'replace') {
    if (target) revisions.push({ ...audit, factId: target.factId, revision: target.revision + 1,
      fact: target.fact, status: 'replaced', replaces: target.replaces })
    const factId = plan.current.facts.reduce((max, fact) => Math.max(max, fact.factId), 0) + 1
    revisions.push({ ...audit, factId, revision: 1, fact: request.fact, status: 'pending', replaces: target?.factId ?? null })
    return { factId, revisions }
  }
  const prior = target!
  revisions.push({ ...audit, factId: prior.factId, revision: prior.revision + 1, fact: prior.fact,
    status: request.action === 'confirm' ? 'confirmed' : 'withdrawn', replaces: prior.replaces })
  return { factId: prior.factId, revisions }
}
