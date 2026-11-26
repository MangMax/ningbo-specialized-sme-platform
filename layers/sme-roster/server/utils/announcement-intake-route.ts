import { checkBrowserReviewRequest } from './browser-review-access'
import { rosterWriteEnabled } from './postgres-roster-db'
import { z } from 'zod'
import { requireApiToken } from '../../../core/server/utils/api-guard'
import { EnterpriseKernelError } from '../../../core/server/public'
import { ImportReceiptError } from './import-receipt-model'
import { OfficialFactError } from './official-evidence-claim-model'
import { requestLogContext, type LogContext } from '../../../core/lib/logging'

const idSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export function intakeRoute<T>(handle: (id: number, input: T, filesDir: string, context: LogContext) => unknown, schema?: z.ZodType<T>, access: 'token' | 'browser-read' | 'browser-write' = 'token') {
  return defineEventHandler(async event => {
    if (access === 'token') requireApiToken(event)
    setHeader(event, 'cache-control', 'no-store')
    if (access === 'browser-write') {
      const gate = checkBrowserReviewRequest(event, { write: true })
      if (!gate.ok) {
        setResponseStatus(event, gate.status)
        return { error: { code: gate.code, message: gate.message } }
      }
      if (!rosterWriteEnabled()) {
        setResponseStatus(event, 503)
        return { error: { code: 'write_disabled', message: '当前应用为只读模式' } }
      }
    }
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
