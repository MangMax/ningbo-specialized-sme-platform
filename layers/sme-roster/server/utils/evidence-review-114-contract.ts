import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { DecisionError102, decisionScope102 } from './decision-lifecycle-102/contract'
import { evidenceDigest113 } from './evidence-digest'

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

const limit = positive.max(100).default(50), cursor = z.string().min(1).max(2048).optional()

const filters = decisionScope102.partial().extend({ decisionId: positive.optional() })

export const impactList114 = filters.extend({ eventId: positive.optional(), view: z.enum(['current','historical','all']).default('current'), state: z.enum(['pending','reviewed','all']).default('pending'), limit, cursor })

export const impactGet114 = z.strictObject({ id: positive })

export const impactSources114 = impactGet114.extend({ limit, cursor })

export const impactEvents114 = z.strictObject({ revisionId: positive, enterpriseId: positive.optional(), limit, cursor })

export const impactPreview114 = filters.extend({ revisionId: positive, limit, cursor })

const envelope = z.strictObject({ idempotencyKey: z.string().trim().min(1).max(200), actor: z.strictObject({ type: z.enum(['user','agent']), id: z.string().trim().min(1).max(200) }), basis: z.string().trim().min(1).max(4000) })

export const processCommand114 = envelope.extend({ action: z.literal('process'), limit: positive.max(100) })

const digest = z.string().regex(/^[a-f0-9]{64}$/)

export const ruleCommand114 = envelope.extend({ action: z.literal('release_rule'), ruleId: z.string().trim().min(1).max(200), version: z.string().trim().min(1).max(200), scopes: z.array(decisionScope102.extend({ previousEvaluationDigest: digest, evaluationDigest: digest })).min(1).max(50) }).superRefine((v,c) => { if(new Set(v.scopes.map(x=>JSON.stringify([x.enterpriseId,x.titleCode,x.direction]))).size !== v.scopes.length) c.addIssue({code:'custom',message:'Duplicate rule scopes'}) })

export const workCommand114 = z.discriminatedUnion('action',[processCommand114,ruleCommand114])

const secret = randomBytes(32)

export type EvidenceReviewAnchor = { revision: number; impact: number; decision: number; receipt: number; snapshotId?: string }

function signature(body: string) { return createHmac('sha256',secret).update(body).digest() }

function encode(operation: string, filter: unknown, asOf: EvidenceReviewAnchor, after: number) { const body = Buffer.from(JSON.stringify({operation,filter:evidenceDigest113(filter),asOf,after})).toString('base64url'); return body+'.'+signature(body).toString('base64url') }

export function invalidImpactCursor() {
  return new DecisionError102(400, 'invalid_cursor', 'Cursor is invalid, expired, evicted or belongs to different filters; restart the read')
}

export function decodeImpactCursor(operation: string, filter: unknown, token: string) {
  try {
    const [body,mac,...extra] = token.split('.')
    if (!body || !mac || extra.length) throw invalidImpactCursor()
    const expected = signature(body), given = Buffer.from(mac, 'base64url')
    if (given.length !== expected.length || !timingSafeEqual(expected, given)) throw invalidImpactCursor()
    const value = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (value.operation !== operation || value.filter !== evidenceDigest113(filter) || !Number.isSafeInteger(value.after) ||
        value.after < 0 || !value.asOf || !['revision','impact','decision','receipt'].every(key =>
          Number.isSafeInteger(value.asOf[key]) && value.asOf[key] >= 0)) throw invalidImpactCursor()
    return { asOf: value.asOf as EvidenceReviewAnchor, after: value.after as number }
  } catch { throw invalidImpactCursor() }
}

export function pageImpactRows<T>(rows: T[], max: number, operation: string,
  context: { asOf: EvidenceReviewAnchor; filter: unknown }, key: (value: T) => number) {
  const more = rows.length > max, selected = rows.slice(0, max)
  return { rows: selected, nextCursor: more ? encode(operation, context.filter, context.asOf, key(selected.at(-1)!)) : null, asOf: context.asOf }
}

export function impactScopeFilter114(input: z.infer<typeof filters>, alias: 'i'|'d') {
  const fragments: SQL[]=[]
  if(input.enterpriseId!=null)fragments.push(sql`${sql.raw(alias+'.enterprise_id')}=${input.enterpriseId}`)
  if(input.titleCode!=null)fragments.push(sql`${sql.raw(alias+'.title_code')}=${input.titleCode}`)
  if(input.direction!=null)fragments.push(sql`${sql.raw(alias+'.direction')}=${input.direction}`)
  if(input.decisionId!=null)fragments.push(sql`${sql.raw(alias==='i'?'i.decision_id':'d.id')}=${input.decisionId}`)
  return fragments.length ? sql.join(fragments, sql` and `) : sql`true`
}
