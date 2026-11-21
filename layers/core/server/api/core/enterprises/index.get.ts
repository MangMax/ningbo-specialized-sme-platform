import { useDb } from '@db'
import { normalizeReviewedUscc } from '#core/lib/enterprise-uscc'
import { enterpriseLibrarySortFields } from '#core/lib/core/enterprise-library'
import { z } from 'zod'
import { usePostgresDirectoryDb } from '../../../../../../db/postgresql/client'
import { listPostgresDirectoryEnterprises } from '../../../utils/enterprise-directory-postgres'
import { listDirectoryEnterprises } from '../../../utils/enterprise-kernel'
import { directoryInput, enterpriseId } from '../../../utils/enterprise-directory-route'

defineRouteMeta({ openAPI: {
  tags: ['企业基础库'], summary: '筛选并排序企业基础资料',
  description: '组合筛选作用于全部结果。名称和地址按包含匹配，信用代码按完整值匹配。sort 和 direction 可重复传入，按顺序一一对应，第一项优先。未传 direction 时各项为升序。排序使用页码分页。',
  parameters: [
    { name: 'name', in: 'query', schema: { type: 'string' } },
    { name: 'uscc', in: 'query', schema: { type: 'string' } },
    { name: 'districtCode', in: 'query', schema: { type: 'string' } },
    { name: 'townshipCode', in: 'query', schema: { type: 'string' } },
    { name: 'industryDivisionCode', in: 'query', schema: { type: 'string' } },
    { name: 'industryCode', in: 'query', schema: { type: 'string' } },
    { name: 'registeredAddress', in: 'query', schema: { type: 'string' } },
    { name: 'operatingAddress', in: 'query', schema: { type: 'string' } },
    { name: 'sourceId', in: 'query', schema: { type: 'integer' } },
    { name: 'includeRemoved', in: 'query', schema: { type: 'boolean' } },
    { name: 'sort', in: 'query', style: 'form', explode: true, schema: {
      type: 'array', items: { type: 'string', enum: ['name', 'uscc', 'district', 'township', 'industry', 'registeredAddress', 'operatingAddress'] },
    } },
    { name: 'direction', in: 'query', style: 'form', explode: true, schema: {
      type: 'array', items: { type: 'string', enum: ['asc', 'desc'] },
    } },
    { name: 'page', in: 'query', schema: { type: 'integer' } },
    { name: 'after', in: 'query', schema: { type: 'integer' } },
    { name: 'limit', in: 'query', schema: { type: 'integer' } },
  ],
  responses: { 200: { description: '企业列表。页码分页返回总数，游标分页返回下一页游标。' } },
} })

const keyword = z.string().trim().min(1).max(500).optional()
const sortField = z.enum(enterpriseLibrarySortFields)
const sortDirection = z.enum(['asc', 'desc'])
const sortLimit = enterpriseLibrarySortFields.length
const filters = z.strictObject({
  name: keyword,
  uscc: z.string().transform(normalizeReviewedUscc).pipe(z.string().regex(/^[A-Z0-9]{18}$/)).optional(),
  districtCode: z.string().optional(),
  townshipCode: z.string().optional(),
  industryDivisionCode: z.string().optional(),
  industryCode: z.string().optional(),
  registeredAddress: keyword,
  operatingAddress: keyword,
  sourceId: enterpriseId.optional(),
  includeRemoved: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
  sort: z.union([sortField, z.array(sortField).min(1).max(sortLimit)]).optional()
    .transform(value => value === undefined ? [] : Array.isArray(value) ? value : [value]),
  direction: z.union([sortDirection, z.array(sortDirection).min(1).max(sortLimit)]).optional()
    .transform(value => value === undefined ? [] : Array.isArray(value) ? value : [value]),
  page: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})
  .refine(query => query.after === undefined || (query.page === undefined && !query.sort.length), '游标分页不能与页码或排序同时使用。')
  .refine(query => new Set(query.sort).size === query.sort.length, '排序字段不能重复。')
  .refine(query => query.direction.length === 0 || query.direction.length === (query.sort.length || 1), '每个排序字段须对应一个排序方向。')
  .transform(({ sort, direction, ...query }) => ({
    ...query,
    sorts: sort.map((field, index) => ({ field, direction: direction[index] ?? 'asc' as const })),
  }))

export default defineEventHandler(event => {
  const input = directoryInput(filters, getQuery(event))
  const postgres = usePostgresDirectoryDb()
  return postgres ? listPostgresDirectoryEnterprises(postgres, input) : listDirectoryEnterprises(useDb(), input)
})
