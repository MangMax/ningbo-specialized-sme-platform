import { z } from 'zod'
import { requireApiToken } from '../../../core/server/utils/api-guard'
import { EnterpriseKernelError } from '../../../core/server/public'
import { ImportReceiptError } from './import-receipts'
import { OfficialFactError } from './official-evidence-plan'
import { requestLogContext, type LogContext } from '../../../core/lib/logging'

const idSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export function intakeRoute<T>(handle: (id: number, input: T, filesDir: string, context: LogContext) => unknown, schema?: z.ZodType<T>) {
  return defineEventHandler(async event => {
    requireApiToken(event)
    setHeader(event, 'cache-control', 'no-store')
    const id = idSchema.safeParse(getRouterParam(event, 'id'))
    const input = schema ? schema.safeParse(await readBody(event)) : undefined
    if (!id.success || (input && !input.success)) throw createError({ statusCode: 400, message: 'Invalid announcement intake request', data: input?.error?.issues })
    try {
      return await handle(id.data, input?.data as T, useRuntimeConfig().filesDir, requestLogContext(event))
    } catch (error) {
      if (error instanceof ImportReceiptError || error instanceof EnterpriseKernelError || error instanceof OfficialFactError) {
        throw createError({ statusCode: error.statusCode, message: error.message, data: { code: error.code } })
      }
      throw error
    }
  })
}
