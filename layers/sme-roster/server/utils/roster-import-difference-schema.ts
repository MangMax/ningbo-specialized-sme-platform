import { z } from 'zod'
import { differenceMeasures, differenceReasons, differenceStatuses } from '../../../../db/difference-codes'
import { COMPARISON_DIRECTIONS } from '../../lib/comparison-model'
import { TITLE_ORDER } from '../../lib/labels'
import type { RosterImportDifference } from '../../lib/roster-import-client'
import { platformRefDiscoverySchema, relationRefDiscoverySchema } from './roster-import-alias-schema'

const model = z.array(z.looseObject({
  enterpriseName: z.string().optional(), uscc: z.string().nullable().optional(),
  titleCode: z.enum(TITLE_ORDER as [string, ...string[]]), direction: z.enum(COMPARISON_DIRECTIONS),
  status: z.enum(differenceStatuses).optional(),
  reasonCode: z.enum(differenceReasons).nullable().optional(), reasonNote: z.string().nullable().optional(),
  measureCode: z.enum(differenceMeasures).nullable().optional(), measureNote: z.string().nullable().optional(),
  evidenceQueryId: z.number().nullable().optional(), evidenceRelationId: z.number().nullable().optional(),
  evidenceQueryRef: platformRefDiscoverySchema.optional(), evidenceRelationRef: relationRefDiscoverySchema.optional(),
  movedIn: z.looseObject({ city: z.string().nullable().optional(), titleCode: z.string().nullable().optional(), year: z.number().nullable().optional(), batch: z.number().nullable().optional() }).nullable().optional(),
  verificationStatus: z.enum(['confirmed', 'pending']).optional(), recordedAt: z.string(),
} satisfies Record<keyof RosterImportDifference, z.ZodType>)).describe('原差异解释导入；enterpriseName 或 uscc 定位主体，证据裸 id 与对应自然键不可同时给。pending_review 须配 confirmed_reason + confirmed + follow_review；已由生命周期接管的坐标拒绝旧导入，使用 decision-lifecycle commands。缺失/null、归一化及原错误均由核心处理，不新增裁决规则。')
const { $schema: _, ...discovery } = z.toJSONSchema(model, { io: 'input' })
;(discovery.items as { anyOf?: unknown }).anyOf = [{ required: ['enterpriseName'] }, { required: ['uscc'] }]
export const differencesMcpSchema = z.unknown().optional().meta(discovery)
