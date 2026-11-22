import { z } from 'zod'
import { coreDictionaryKinds } from '#core/lib/dictionaries'
import { readPostgresDictionary } from '../../../utils/dictionaries'
import { usePostgresDirectoryDb } from '../../../../../../db/postgresql/client'

defineRouteMeta({ openAPI: { tags: ['字典管理'], summary: '读取平台字典',
  parameters: [{ in: 'path', name: 'kind', required: true, schema: { type: 'string', enum: ['list-sources', 'list-types', 'regions', 'industries'] } }],
  responses: { 200: { description: '字典项及父级名称' }, 404: { description: '未知字典' } },
} })

export default defineEventHandler(event => {
  const kind = z.enum(coreDictionaryKinds).safeParse(getRouterParam(event, 'kind'))
  if (!kind.success) throw createError({ statusCode: 404, message: '找不到该字典。' })
  const postgres = usePostgresDirectoryDb()
  return readPostgresDictionary(postgres, kind.data)
})
