import { z } from 'zod'
import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { EnterpriseKernelError } from './enterprise-kernel'

export const enterpriseId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)

export function directoryInput<T>(schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Invalid enterprise directory request', data: parsed.error.issues })
  return parsed.data
}

export async function directoryResult<T>(run: () => T | Promise<T>) {
  try {
    return await run()
  } catch (error) {
    if (error instanceof EnterpriseKernelError) throw createError({ statusCode: error.statusCode, message: error.message, data: { code: error.code } })
    throw error
  }
}

export function usePostgresDirectoryWriteDb() {
  const db = usePostgresDirectoryDb()
  if (db && process.env.NUXT_POSTGRES_DIRECTORY_WRITE !== '1') {
    throw new EnterpriseKernelError(503, 'directory_read_only', '企业基础库处于只读验收模式。')
  }
  return db
}
