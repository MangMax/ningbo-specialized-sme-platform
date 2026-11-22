import { z } from 'zod'
import { PLATFORM_INTERFACE_VALUES,TITLE_ORDER } from '../../lib/labels'
import { platformQueryResultShape } from '../../lib/platform/live-query'
import type { RosterImportPlatformQuery,RosterImportRelation } from '../../lib/roster-import-client'

export const platformRelationInputSchema = z.looseObject({
  sequenceNo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe('原查询内正安全整数序号；新完整采集按输入顺序从 1 连续编号，不截断小数'),
  relationKey: z.string().nullable().optional(), enterpriseId: z.number().nullable().optional(),
  usccRaw: z.string().nullable().optional(), nameRaw: z.string().nullable().optional(),
  aliasNameRaw: z.string().nullable().optional(), province: z.string().nullable().optional(),
  status: z.string().nullable().optional(), batch: z.string().nullable().optional(),
  declareKind: z.string().nullable().optional(), appliedAt: z.string().nullable().optional(),
  awardBatchLabel: z.string().nullable().optional(), year: z.number().int().nullable().optional(),
  matchBasis: z.enum(['uscc', 'alias', 'manual', 'none']).optional(),
  verificationStatus: z.enum(['confirmed', 'pending']).optional(),
  sourceText: z.string().nullable().optional(), rawFields: z.record(z.string(), z.unknown()).nullable().optional(),
} satisfies Record<keyof RosterImportRelation, z.ZodType>)
export const platformQueriesInputSchema = z.array(z.looseObject({
  reuseExisting: z.literal(true).optional(), interface: z.enum(PLATFORM_INTERFACE_VALUES),
  queryKey: z.string(), rdjb: z.string().optional(),
  titleCode: z.enum(TITLE_ORDER as [string, ...string[]]).nullable().optional(), queriedAt: z.string(),
  status: z.enum(['success', 'failed', 'no_record', 'not_queried', 'partial']).optional(),
  collectionEvidence: z.object(platformQueryResultShape).nullable().optional(),
  failureReason: z.string().nullable().optional(), rawResponse: z.string().nullable().optional(),
  relations: z.array(platformRelationInputSchema).optional(),
} satisfies Record<keyof RosterImportPlatformQuery, z.ZodType>)).describe('三来源原查询归档；recognized_list 新采集须带原 collectionEvidence，来源/interface、查询坐标、状态/称号及每条 relation 序号/身份/rawFields 必须匹配原行。dataRows 保留全部 typed 业务字段而不保存请求/响应正文；rawData.version=1 保留 typed JSON 原值、原页 body 与来源隔离；缺省保持 legacy。reuseExisting:true 仅引用已存坐标，不补行；legacy 无 collectionEvidence 时 rawResponse 省略/null 是原引用哨兵，字符串 null 不是。显式不可变值、原行及 hash 冲突由核心拒绝，不重算来源。')
const { $schema: _, ...discovery } = z.toJSONSchema(platformQueriesInputSchema, { io: 'input' })
// New recognized archives require the original envelope; an existing coordinate may be referenced.
;(discovery.items as { allOf?: unknown }).allOf = [{
  if: { properties: { interface: { const: 'recognized_list' } }, required: ['interface'], not: { properties: { reuseExisting: { const: true } }, required: ['reuseExisting'] } },
  then: { required: ['collectionEvidence'], properties: { collectionEvidence: { type: 'object' } } },
}]
export const platformQueriesMcpSchema = z.unknown().optional().meta(discovery)
