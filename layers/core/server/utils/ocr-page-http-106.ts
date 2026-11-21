import { requestLogContext } from '../../lib/logging'
import { createError, getHeader, getQuery, getRouterParam, readBody, setHeader, type H3Event } from 'h3'
import { z } from 'zod'
import { readApiToken, resolveApiAuth, unauthorizedApiMessage } from './api-auth'
import { deleteOcrFilePage, requireOcrFileTarget } from './ocr-files'
import { getOcrResultForFile, ocrExpectedVersionSchema, ocrPageSchema, saveOcrImport } from './ocr-page-lifecycle'

const writeBody = z.object({ markdown: z.string(), engine: z.string().optional(), model: z.string().nullable().optional(), expectedVersion: ocrExpectedVersionSchema.nonoptional() }).strict()
const deleteBody = z.object({ expectedVersion: ocrExpectedVersionSchema.nonoptional() }).strict()

/** Authenticated agent HTTP adapter; legacy local UI routes retain their documented policy. */
export async function ocrPageHttp106(event: H3Event, action: 'get' | 'save' | 'delete') {
  setHeader(event, 'cache-control', 'no-store')
  const config = useRuntimeConfig()
  if (action !== 'get') {
    const auth = resolveApiAuth({ given: readApiToken({ authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token') }), configured: config.apiToken })
    if (!auth.writeAuthorized) throw createError({ statusCode: 401, message: unauthorizedApiMessage(auth.reason) })
  }
  const id = getRouterParam(event, 'id')
  const rawPage = getRouterParam(event, 'page')
  if (!id || !/^[1-9]\d*$/.test(id) || !rawPage || !/^[1-9]\d*$/.test(rawPage)) throw createError({ statusCode: 400, message: 'fileId 与 page 必须是正整数' })
  const page = ocrPageSchema.safeParse(Number(rawPage))
  if (!page.success) throw createError({ statusCode: 400, message: 'page 超出允许范围' })
  if (Object.keys(getQuery(event)).length) throw createError({ statusCode: 400, message: '不接受查询参数;范围仅由路径中的 fileId/page 定位' })
  let body: Record<string, unknown> = {}
  if (action !== 'get') {
    const raw = await readBody(event).catch(() => { throw createError({ statusCode: 400, message: '请求体必须是 JSON 对象' }) })
    const parsed = (action === 'save' ? writeBody : deleteBody).safeParse(raw ?? {})
    if (!parsed.success) throw createError({ statusCode: 400, message: '请求字段非法;只接受 markdown/engine/model/expectedVersion,删除仅接受 expectedVersion' })
    body = parsed.data
  }
  const target = await requireOcrFileTarget({ fileId: Number(id) }, { allowRemoved: action === 'get' }, config.filesDir)
  const { row } = target
  if (action === 'get') return getOcrResultForFile(target, page.data)
  if (action === 'save') return saveOcrImport(target, { ...body, page: page.data }, 'upload', requestLogContext(event))
  const out = await deleteOcrFilePage(target, page.data, body.expectedVersion as string | null | undefined, requestLogContext(event))
  if (!out.ok) throw createError({ statusCode: out.statusCode, message: out.message })
  return { file: { id: row.id, relPath: row.relPath, filename: row.filename }, page: out.page, deleted: out.deleted, remaining: out.remaining }
}
