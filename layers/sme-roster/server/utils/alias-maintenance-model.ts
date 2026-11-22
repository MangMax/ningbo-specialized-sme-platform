import { createError } from 'h3'
import { z } from 'zod'
import { normalizeName } from '../../lib/domain'
import type { view } from './alias-maintenance'

export const positiveId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)

export function fail(statusCode: number, code: string, message: string): never { throw createError({ statusCode, message, data: { code } }) }

export function parse<T>(shape: z.ZodType<T>, value: unknown): T {
  const result = shape.safeParse(value)
  if (!result.success) fail(400, 'alias_input_invalid', result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
  return result.data
}

export const aliasPageInput = {
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}

export const aliasDecisionInput = {
  action: z.enum(['confirm', 'correct', 'withdraw']),
  changes: z.object({
    name: z.string().trim().min(1).max(1000).optional(),
    sourceKind: z.enum(['platform_business', 'platform_apply', 'announcement', 'manual']).optional(),
    sourceRefId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    validFrom: z.string().trim().min(1).max(100).nullable().optional(),
    validTo: z.string().trim().min(1).max(100).nullable().optional(),
    note: z.string().max(4000).nullable().optional(),
  }).strict().optional(),
  expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  actor: z.string().trim().min(1).max(200),
  basis: z.string().trim().min(1).max(4000),
  idempotencyKey: z.string().trim().min(1).max(200),
}

export const aliasListInput = { ...aliasPageInput, status: z.enum(['all', 'pending', 'confirmed', 'withdrawn']).default('all') }

export const aliasDecisionSchema = z.strictObject(aliasDecisionInput)

/** A page never silently truncates persisted notes or history snapshots. */
export function boundedAliasPage<T>(result: T): T {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 256 * 1024) fail(413, 'alias_page_response_too_large', '别名页面超过256KiB，请减小pageSize后完整分页读取')
  return result
}

export function decideEnterpriseAlias(before: ReturnType<typeof view>, request: z.infer<typeof aliasDecisionSchema>) {
  if (before.version !== request.expectedVersion) fail(409, 'alias_version_conflict', '别名版本已改变，请重新读取')
  if (request.action !== 'correct' && request.changes != null) fail(400, 'alias_input_invalid', '仅更正操作接收changes')
  if (request.action === 'confirm' && before.verificationStatus === 'confirmed') fail(409, 'alias_transition_invalid', '该别名已经确认')
  if (request.action === 'withdraw' && before.verificationStatus === 'withdrawn') fail(409, 'alias_transition_invalid', '该别名已经撤回')
  const changes = request.changes ?? {}
  if (request.action === 'correct' && !Object.entries(changes).some(([key, value]) => before[key as keyof typeof before] !== value)) fail(400, 'alias_correction_empty', '更正必须明确改变字段')
  const next = { ...before, ...changes, nameNorm: changes.name == null ? before.nameNorm : normalizeName(changes.name),
    verificationStatus: request.action === 'confirm' ? 'confirmed' as const : request.action === 'withdraw' ? 'withdrawn' as const : before.verificationStatus }
  if (!next.nameNorm) fail(400, 'alias_input_invalid', '归一化名称不能为空')
  return next
}
