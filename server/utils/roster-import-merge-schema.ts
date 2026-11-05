import { z } from 'zod'
import { enterpriseAlias } from '../../db/schema'
import type { RosterImportMerge } from '../../lib/roster-import-client'
import { platformRefDiscoverySchema, relationRefDiscoverySchema } from './roster-import-alias-schema'

const model = z.array(z.looseObject({
  fromEnterpriseId: z.number().optional(), fromEnterpriseName: z.string().optional(), intoUscc: z.string(),
  canonicalName: z.string().nullable().optional(), aliasName: z.string().optional(),
  sourceKind: z.enum(enterpriseAlias.sourceKind.enumValues).optional(), sourceRefId: z.number().optional(),
  sourceRelationRef: relationRefDiscoverySchema.optional(), evidenceQueryId: z.number().nullable().optional(),
  evidenceQueryRef: platformRefDiscoverySchema.optional(), note: z.string().nullable().optional(),
} satisfies Record<keyof RosterImportMerge, z.ZodType>)).describe('原身份归并命令；fromEnterpriseId 或唯一 fromEnterpriseName 定位，同时给须一致。intoUscc 规范主体可在本批创建。canonicalName 省略/null 不改名，给出须非空；证据裸 id 与自然键不可同时给。保留别名、事件、出处、回执及归并血缘；生命周期/差异冲突由原核心保护，整批原子执行。')
const { $schema: _, ...discovery } = z.toJSONSchema(model, { io: 'input' })
;(discovery.items as { anyOf?: unknown }).anyOf = [{ required: ['fromEnterpriseId'] }, { required: ['fromEnterpriseName'] }]
export const mergesMcpSchema = z.unknown().optional().meta(discovery)
