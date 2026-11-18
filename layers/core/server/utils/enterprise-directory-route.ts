import { z } from 'zod'
import { EnterpriseKernelError } from './enterprise-kernel'

export const enterpriseId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)

export function directoryInput<T>(schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Invalid enterprise directory request', data: parsed.error.issues })
  return parsed.data
}

export function directoryResult<T>(run: () => T) {
  try {
    return run()
  } catch (error) {
    if (error instanceof EnterpriseKernelError) throw createError({ statusCode: error.statusCode, message: error.message, data: { code: error.code } })
    throw error
  }
}
