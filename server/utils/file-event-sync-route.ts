import { getRouterParam, readBody, setHeader, setResponseStatus } from 'h3'
import { z } from 'zod'
import { useDb } from '@db'
import { requireApiToken } from './api-guard'
import { checkBrowserReviewRequest } from './browser-review-102'
import { syncRequestSchema, preflightFileEventSync, commitFileEventSync } from './file-event-sync'
const business = syncRequestSchema.omit({ actor: true })
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  chunk = z.number().int().min(0).max(29)
export function fileEventSyncRoute(action: 'preflight' | 'commit', browser = false) {
  const requestSchema = browser
    ? business.transform(input => ({ ...input, actor: { type: 'agent' as const, id: 'same-origin-file-event-sync-adapter' } }))
    : syncRequestSchema
  return defineEventHandler(async (event) => {
    setHeader(event, 'cache-control', 'no-store')
    const config = useRuntimeConfig()
    if (browser) {
      const gate = checkBrowserReviewRequest(event, config, { write: true })
      if (!gate.ok) {
        setResponseStatus(event, gate.status)
        return { error: { code: gate.code, message: gate.message } }
      }
    } else requireApiToken(event)
    try {
      const id = Number(getRouterParam(event, 'id'))
      if (!Number.isSafeInteger(id) || id < 1)
        throw Object.assign(new Error('文件ID非法'), {
          statusCode: 400,
          code: 'invalid_request',
        })
      const raw = await readBody(event),
        schema =
          action === 'preflight'
            ? requestSchema
            : z.strictObject({
                request: requestSchema,
                planHash: hash,
                chunk,
              })
      if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 16384)
        throw Object.assign(new Error('请求超过16KiB'), {
          statusCode: 413,
          code: 'request_limit',
        })
      const parsed = schema.safeParse(raw)
      if (!parsed.success)
        throw Object.assign(new Error('同步请求字段不合法'), {
          statusCode: 400,
          code: 'invalid_request',
        })
      const input = parsed.data,
        request = 'request' in input ? input.request : input
      return 'request' in input
        ? await commitFileEventSync(
            useDb(),
            id,
            request,
            input.planHash,
            input.chunk,
            config.filesDir,
          )
        : await preflightFileEventSync(useDb(), id, request, config.filesDir)
    } catch (error) {
      const e = error as {
        statusCode?: number
        code?: string
        message?: string
        progress?: unknown
      }
      setResponseStatus(event, e.statusCode ?? 500)
      return {
        progress: e.progress,
        error: {
          code: e.code ?? (e.statusCode ? 'source_unavailable' : 'transaction_failed'),
          message: e.statusCode ? e.message : '同步失败，本块未提交；可用原请求重试',
        },
      }
    }
  })
}
