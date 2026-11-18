import { useDb } from '@db'
import { supplementSchema } from '../../../../../utils/announcement-intake'
import { importExecutor } from '../../../../../utils/import-execution'
import { intakeRoute } from '../../../../../utils/announcement-intake-route'

defineRouteMeta({ openAPI: {
  tags: ['名录'], summary: '按已核对的企业身份和字段显式补充基础库', security: [{ bearerAuth: [] }],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['sourceDigest', 'basis', 'rows'],
    properties: {
      sourceDigest: { type: 'string' }, basis: { type: 'string' },
      rows: { type: 'array', items: { type: 'object', description: '按原行顺序提交。create 提供 fields.name，attach 提供 enterpriseId、expectedRevision 和可选 fields，same_subject 通过从零开始的 row 引用本批较早已核对的行。fields 支持 name、uscc、districtCode、townshipCode、industryCode。' } },
    },
  } } } },
  responses: { 200: { description: '一次性补充回执和企业及来源 ID' }, 409: { description: '身份、来源版本或回执冲突' } },
} })
export default intakeRoute((id, input, filesDir, context) => importExecutor.supplement(useDb(), id, input, filesDir, context), supplementSchema)
