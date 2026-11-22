import { z } from 'zod'
import { editableDictionaryKinds } from '#core/lib/dictionaries'
import { sameOriginBrowserAccess } from '../../../utils/browser-page-access'
import { directoryResult, usePostgresDirectoryWriteDb } from '../../../utils/enterprise-directory-route'
import { savePostgresDictionaryEntry } from '../../../utils/dictionaries'

const name = z.string().trim().min(1).max(120).refine(value => value.isWellFormed() && !value.includes('\0') && !!value.normalize('NFKC').trim())
const entry = z.union([
  z.strictObject({ name }),
  z.strictObject({ name, code: z.string().min(1).max(64), previousName: z.string().min(1).max(120) }),
])

defineRouteMeta({ openAPI: { tags: ['字典管理'], summary: '新增选项或更新选项名称',
  description: '同源页面写入。改名保留编码；须提交编辑时读取的原名称。',
  parameters: [{ in: 'path', name: 'kind', required: true, schema: { type: 'string', enum: ['list-sources', 'list-types'] } }],
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: {
    name: { type: 'string' }, code: { type: 'string' }, previousName: { type: 'string' },
  } } } } },
  responses: { 200: { description: '已保存的字典项' }, 403: { description: '来源校验未通过或系统保留项' }, 409: { description: '同名或并发变更' } },
} })

export default defineEventHandler(async event => {
  if (!sameOriginBrowserAccess(event, 'x-dictionary-browser')) {
    throw createError({ statusCode: 403, message: '请从字典管理页面保存。' })
  }
  const kind = z.enum(editableDictionaryKinds).safeParse(getRouterParam(event, 'kind'))
  if (!kind.success) throw createError({ statusCode: 404, message: '找不到可编辑的字典。' })
  const parsed = entry.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: '请检查字典项名称和原值。' })
  const result = await directoryResult(() => {
    const postgres = usePostgresDirectoryWriteDb()
    return savePostgresDictionaryEntry(postgres, kind.data, parsed.data)
  })
  if ('message' in result) throw createError({ statusCode: result.status, message: result.message })
  return result.entry
})
