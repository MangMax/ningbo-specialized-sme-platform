import { batchCandidateMatchInput } from '#core/lib/core/enterprise-batch-supplement'
import { usePostgresDirectoryDb } from '../../../../../../db/postgresql/client'
import { matchPostgresDirectoryCandidates } from '../../../utils/enterprise-directory-postgres'
import { directoryInput } from '../../../utils/enterprise-directory-route'

defineRouteMeta({ openAPI: {
  tags: ['企业基础库'],
  summary: '批量精确匹配企业候选',
  description: '按信用代码、现用名及已确认的曾用名查找在库主体。返回顺序与输入一致，每行标识必须唯一。',
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['rows'], additionalProperties: false,
    properties: { rows: { type: 'array', minItems: 1, maxItems: 200, items: {
      type: 'object', required: ['key', 'name'], additionalProperties: false,
      properties: { key: { type: ['string', 'number'] }, name: { type: 'string' }, uscc: { type: ['string', 'null'] } },
    } } },
  } } } },
  responses: {
    200: { description: '逐行返回 key、匹配状态和企业候选。候选附带资料修订号与命中依据。' },
    400: { description: '请求格式无效或行标识重复。' },
  },
} })

export default defineEventHandler(async event => {
  const input = directoryInput(batchCandidateMatchInput, await readBody(event))
  return matchPostgresDirectoryCandidates(usePostgresDirectoryDb(), input)
})
