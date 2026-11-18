import { useDb } from '@db'
import { supplementSchema } from '../../../../../utils/announcement-intake'
import { importExecutor } from '../../../../../utils/import-execution'
import { intakeRoute } from '../../../../../utils/announcement-intake-route'

defineRouteMeta({ openAPI: {
  tags: ['名录'], summary: '按已核对的企业身份和字段显式补充基础库', security: [{ bearerAuth: [] }],
  description: '含类型化公布证据时，先用相同核对决定和 preflight: true 预检，再省略 preflight 并提交返回的 officialEvidencePlanHash。预检不保留业务写入或回执。',
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['sourceDigest', 'basis', 'rows'],
    properties: {
      sourceDigest: { type: 'string' }, basis: { type: 'string' },
      preflight: { type: 'boolean', enum: [true], description: '预检已核对的主体、资料和出处计划' },
      officialEvidencePlanHash: { type: 'string', description: '提交类型化公布证据时提供本接口预检返回的哈希' },
      rows: { type: 'array', items: { type: 'object', description: '按原行顺序提交。create 提供 fields.name，attach 提供 enterpriseId、expectedRevision 和可选 fields，same_subject 通过从零开始的 row 引用本批较早已核对的行。fields 支持 name、uscc、districtCode、townshipCode、industryCode。' } },
    },
  } } } },
  responses: { 200: { description: '预检结果或一次性补充回执及企业和来源 ID' }, 409: { description: '身份、来源版本或回执冲突' } },
} })
export default intakeRoute((id, input, filesDir, context) => importExecutor.supplement(useDb(), id, input, filesDir, context), supplementSchema)
