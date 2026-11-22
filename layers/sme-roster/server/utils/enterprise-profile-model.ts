import { EnterpriseKernelError as EnterpriseProfileError } from '../../../core/server/public'
import { z } from 'zod'

export { EnterpriseProfileError }

const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/u.test(value) && value.isWellFormed(), 'Invalid text')

const fields = { name: text(300), city: text(100).nullable(), district: text(100).nullable() }

// Preconditions are exact source values, including legacy leading/trailing spaces.
const oldValue = z.string().max(1000).refine(value => value.isWellFormed(), 'Invalid old value')

export const enterpriseProfilePatchSchema = z.strictObject({
  idempotencyKey: text(200),
  expectedVersion: z.string().regex(/^[0-9a-f]{64}$/),
  expectedValues: z.strictObject({ name: oldValue.optional(), city: oldValue.nullable().optional(), district: oldValue.nullable().optional() }).optional(),
  changes: z.strictObject({ name: fields.name.optional(), city: fields.city.optional(), district: fields.district.optional() }).refine(v => Object.keys(v).length > 0, 'At least one profile field required'),
  previousName: z.strictObject({ name: oldValue.min(1), sameSubject: z.literal(true) }).optional(),
  actor: z.strictObject({ type: z.enum(['user', 'agent']), id: text(200) }),
  basis: text(2000),
})

export function parseEnterpriseProfileHistoryQuery(query: Record<string, unknown>) {
  const parsed = z.strictObject({ page: z.coerce.number().int().min(1).max(10000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).safeParse(query)
  if (!parsed.success) throw new EnterpriseProfileError(400, 'invalid_request', 'Expected page 1..10000 and pageSize 1..100; no other selectors')
  return parsed.data
}

export function boundedEnterpriseProfileHistory<T>(history: T): T {
  if (Buffer.byteLength(JSON.stringify(history)) > 256 * 1024) throw new EnterpriseProfileError(413, 'response_too_large', 'History page exceeds 256 KiB; request a smaller pageSize')
  return history
}
