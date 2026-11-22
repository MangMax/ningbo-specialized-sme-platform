import { z } from 'zod'
import { enterpriseAlias } from '../../../../db/postgresql/enterprise-tables'
import { PLATFORM_INTERFACE_VALUES } from '../../lib/labels'
import type { RosterImportAlias, RosterPlatformRef } from '../../lib/roster-import-client'

export const platformRefDiscoverySchema = z.looseObject({
  interface: z.enum(PLATFORM_INTERFACE_VALUES),
  queryKey: z.string(),
  rdjb: z.string().nullable().optional(),
  queriedAt: z.string().nullable().optional(),
  sequenceNo: z.number().nullable().optional(),
  relationKey: z.string().nullable().optional(),
} satisfies Record<keyof RosterPlatformRef, z.ZodType>).describe('原查询自然键；queriedAt 省略时须唯一命中。关系引用须带 sequenceNo，给出 relationKey 时须与序号指向同一原行。')

export const relationRefDiscoverySchema = platformRefDiscoverySchema.extend({ sequenceNo: z.number().min(1) })

const aliasDiscoverySchema = z.array(z.looseObject({
  enterpriseName: z.string().nullable().optional(),
  uscc: z.string().nullable().optional(),
  name: z.string(),
  sourceKind: z.enum(enterpriseAlias.sourceKind.enumValues),
  sourceRefId: z.number().nullable().optional(),
  sourceRelationRef: relationRefDiscoverySchema.nullable().optional(),
  verificationStatus: z.enum(enterpriseAlias.verificationStatus.enumValues).nullable().optional(),
  validFrom: z.string().nullable().optional(),
  validTo: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
} satisfies Record<keyof RosterImportAlias, z.ZodType>)).describe('企业别名证据；uscc 或 enterpriseName 定位已有或本批企业，sourceRefId 与 sourceRelationRef 不可同时给。confirmed 平台别名须有匹配主体及别名的原关系证据。旧字段归一化、缺失/null、附加字段与逐项错误由原导入核心处理。')

const { $schema: _, ...aliasDiscovery } = z.toJSONSchema(aliasDiscoverySchema, { io: 'input' })
// The core resolves an owner by name or USCC; neither a bare alias nor a new owner is a command.
const aliasItemDiscovery = aliasDiscovery.items as { anyOf?: { required: string[] }[] }
aliasItemDiscovery.anyOf = [{ required: ['enterpriseName'] }, { required: ['uscc'] }]
// Discovery is additive: the legacy runtime input still reaches the domain core verbatim.
export const aliasesMcpSchema = z.unknown().optional().meta(aliasDiscovery)
