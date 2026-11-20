import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchRuntimeEventAnnualProcessMcp } from '../../utils/event-annual-process-api'
export default defineMcpTool({
  name: 'get_event_annual_process', title: '读取正式事件年度过程与末态资格',
  description: '等价GET /api/roster/events/:id/annual-process。完整限定归档scope先计算年度末态，再分页展示steps。保留各接口业务版本、观察出处与原实际决定；finalCandidateStepId仅事实资格，不表示已确认。缺年/partial/unknown如实保留。无asOf/sourceSet，不写ledger或调用preflight。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { eventId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), page: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), pageSize: z.number().int().min(1).max(200).optional() },
  outputSchema: {
    process: z.object({
      event: z.object({ id: z.number().int(), eventType: z.string(), year: z.number().int().nullable(), decidedYear: z.number().int().nullable(), reviewOutcome: z.string().nullable(), record: z.object({ enterpriseId: z.number().int(), titleCode: z.string(), usccRaw: z.string().nullable() }) }),
      ruleVersion: z.string(), businessYear: z.number().int().nullable(), declareKind: z.enum(['apply', 'review']).nullable(),
      steps: z.array(z.object({ id: z.string(), businessKey: z.string().nullable(), year: z.number().int().nullable(), declareKind: z.string().nullable(), appliedAt: z.string().nullable(), status: z.string().nullable(), observedAt: z.string().nullable(), annualEligible: z.boolean(), reasons: z.array(z.string()),
        groups: z.array(z.record(z.string(), z.unknown())).describe('原共享PlatformBusinessGroup：各接口record/version和观察原决定，不传播确认'),
        latestObservationRelationIds: z.array(z.number().int()), latestVersionRefs: z.array(z.object({ interface: z.string(), recordId: z.number().int().nullable(), versionId: z.number().int().nullable(), relationIds: z.array(z.number().int()) })), preferredWriteRelationId: z.number().int().nullable(), corroboratedFields: z.array(z.string()), corroborationRefs: z.array(z.object({ field: z.string(), fromRelationIds: z.array(z.number().int()), toRelationIds: z.array(z.number().int()) })),
      })),
      latestStepId: z.string().nullable(), latestStepSummary: z.object({ id: z.string(), year: z.number().int().nullable(), declareKind: z.string().nullable(), appliedAt: z.string().nullable(), status: z.string().nullable(), observedAt: z.string().nullable() }).nullable(),
      finalCandidateStepId: z.string().nullable().describe('仅当前归档scope事实资格，不等于对应已确认或最终落地'),
      reasons: z.array(z.string()), coverage: z.array(z.object({ queryId: z.number().int(), interface: z.string(), queriedAt: z.string(), status: z.string(), completeness: z.string().nullable(), fullRange: z.boolean().nullable() })), coverageReasons: z.array(z.string()), excludedIdentityRelationIds: z.array(z.number().int()),
      scopeGaps: z.array(z.object({ relationId: z.number().int(), queryId: z.number().int(), interface: z.string(), year: z.number().int().nullable(), declareKind: z.string().nullable(), appliedAt: z.string().nullable(), reasons: z.array(z.string()) })).optional(),
      finalQualification: z.object({ stepId: z.string().nullable(), status: z.enum(['confirmed', 'eligible', 'blocked', 'none']), reasons: z.array(z.string()), decisionRefs: z.array(z.record(z.string(), z.unknown())) }).optional(),
    }), sourceGeneration: z.string(), sourceRefs: z.record(z.string(), z.unknown()), total: z.number().int(), page: z.number().int(), pageSize: z.number().int(),
  },
  handler: async input => {
    const result = await dispatchRuntimeEventAnnualProcessMcp(input, { get db() { return useDb() } })
    if ('isError' in result) return result
    return { structuredContent: result as Record<string, unknown>, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
})
