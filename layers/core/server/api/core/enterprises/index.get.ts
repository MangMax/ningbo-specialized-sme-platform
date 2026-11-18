import { useDb } from '@db'
import { z } from 'zod'
import { listDirectoryEnterprises } from '../../../utils/enterprise-kernel'
import { directoryInput, enterpriseId } from '../../../utils/enterprise-directory-route'

defineRouteMeta({ openAPI: {
  tags: ['企业基础库'], summary: '按名称、区划、行业或来源读取企业', responses: { 200: { description: '企业列表与下一页游标' } },
} })
const filters = z.strictObject({
  name: z.string().trim().min(1).optional(), districtCode: z.string().optional(), industryCode: z.string().optional(),
  sourceId: enterpriseId.optional(), includeRemoved: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
  after: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(25),
})
export default defineEventHandler(event => listDirectoryEnterprises(useDb(), directoryInput(filters, getQuery(event))))
