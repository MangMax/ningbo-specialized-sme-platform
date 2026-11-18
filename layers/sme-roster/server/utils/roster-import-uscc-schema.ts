import { z } from 'zod'
import type { RosterImportUsccBackfill, RosterImportUsccSource } from '../../lib/roster-import-client'

const source = z.looseObject({
  url: z.string(), checkedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), basis: z.string(), name: z.string(),
  region: z.string().nullable().optional(),
} satisfies Record<keyof RosterImportUsccSource, z.ZodType>).describe('必填判据沿用 missingUsccSourceFields：非空 URL、查证日期、主体对应依据及来源名称；不新增 URL scheme 或日历有效性规则。')
const model = z.array(z.looseObject({
  enterpriseId: z.number().optional(), enterpriseName: z.string().optional(),
  uscc: z.string().describe('沿用 usccFormatVerdict 的格式及校验位判据与旧归一化，不猜代码'),
  source, note: z.string().nullable().optional(),
} satisfies Record<keyof RosterImportUsccBackfill, z.ZodType>)).describe('仅补已有企业缺失统代；enterpriseId 或唯一 enterpriseName 定位，同时给须一致。已有代码拒绝覆盖，被其他企业占用拒绝自动合并；原 source/lineage 保留，不改名或写别名。')
const { $schema: _, ...discovery } = z.toJSONSchema(model, { io: 'input' })
;(discovery.items as { anyOf?: unknown }).anyOf = [{ required: ['enterpriseId'] }, { required: ['enterpriseName'] }]
export const usccBackfillsMcpSchema = z.unknown().optional().meta(discovery)
