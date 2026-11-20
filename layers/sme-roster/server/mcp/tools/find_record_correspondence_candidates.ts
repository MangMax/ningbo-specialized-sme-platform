import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchRecordCorrespondenceMcp } from '../../utils/mcp-record-correspondence'

const correspondenceRef = z.object({
  id: z.number().int(), relationId: z.number().int().nullable(), exportRowId: z.number().int().nullable(), eventId: z.number().int().nullable(), predecessorEventId: z.number().int().nullable(), enterpriseId: z.number().int().nullable(), titleCode: z.string(), type: z.string(), role: z.string(), status: z.enum(['candidate', 'confirmed', 'rejected', 'unlinked']), revision: z.number().int(), ruleId: z.string(), ruleVersion: z.string(), createdAt: z.string(), decidedAt: z.string().nullable(), endedAt: z.string().nullable(),
})
const businessRecord = z.object({
  recordId: z.number().int().nullable(), versionId: z.number().int().nullable(), interface: z.string(), platformKey: z.string().nullable(), groupState: z.enum(['verified', 'not_indexed', 'missing_key', 'conflict', 'unverifiable']), identityState: z.enum(['resolved', 'missing_key', 'conflict', 'not_indexed']), contentState: z.enum(['verified', 'unverifiable', 'not_indexed']), keySource: z.string().nullable(), projectionRuleVersion: z.string().nullable(), hashAlgorithm: z.string().nullable(), contentHash: z.string().nullable(),
})
const observationRef = z.object({
  relationId: z.number().int(), queryId: z.number().int(), sequenceNo: z.number().int(), queriedAt: z.string(), interface: z.string(), relationKey: z.string().nullable(), queryStatus: z.string(), queryKey: z.string(), rdjb: z.string(), queryTitleCode: z.string().nullable(), titleCode: z.string(), enterpriseId: z.number().int().nullable(), usccRaw: z.string().nullable(), nameRaw: z.string().nullable(), verificationStatus: z.string(), matchBasis: z.string(), target: z.object({ eventId: z.number().int().nullable(), enterpriseId: z.number().int(), titleCode: z.string(), type: z.string(), role: z.string() }), evidence: z.record(z.string(), z.unknown()), conflicts: z.array(z.string()), businessRecord, existingCorrespondenceIds: z.array(z.number().int()), existingCorrespondences: z.array(correspondenceRef),
})
export default defineMcpTool({
  name: 'find_record_correspondence_candidates', title: '从选定归档业务版本只读生成对应候选',
  description: '等价 POST /api/roster/correspondences/candidates。先按选中query/event/主体/称号/角色过滤，再以同接口recordId+versionId分组；不支持asOf。返回businessRecord、全部observationRefs、existingCorrespondenceIds和含status/revision/ruleVersion的existingCorrespondences。缺编号/冲突/无原文/未索引按relationId独立。代表端点优先有旧对应的最小原ID，否则最小原ID；相反决定报correspondence_decision_conflict。multiple_candidate_rows按实际候选组计数。导出逐行，分页在分组后。不借未选观察确认，不自动确认或写入。应用错误isError=true，content[0].text含error.code/message。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { eventId: z.number().int().positive().optional(), enterpriseId: z.number().int().positive().optional(), titleCode: z.string().optional(), queryIds: z.array(z.number().int().positive()).optional(), exportBatchIds: z.array(z.number().int().positive()).optional(), ruleVersion: z.string().min(1), page: z.number().int().positive().optional(), pageSize: z.number().int().min(1).max(200).optional() },
  outputSchema: {
    rows: z.array(z.object({ edge: z.object({ type: z.string(), role: z.string(), relationId: z.number().int().optional(), exportRowId: z.number().int().optional(), eventId: z.number().int().optional(), enterpriseId: z.number().int().optional(), titleCode: z.string().optional() }), status: z.literal('candidate'), ruleId: z.string(), ruleVersion: z.string(), evidence: z.record(z.string(), z.unknown()), conflicts: z.array(z.string()), existingCorrespondenceId: z.number().int().nullable(), revision: z.number().int().nullable(), businessRecord: businessRecord.optional(), representativeRelationId: z.number().int().optional(), observationRefs: z.array(observationRef).optional(), existingCorrespondenceIds: z.array(z.number().int()).optional(), existingCorrespondences: z.array(correspondenceRef).optional() })),
    total: z.number().int(), page: z.number().int(), pageSize: z.number().int(), coverage: z.array(z.record(z.string(), z.unknown())), exportBatches: z.array(z.record(z.string(), z.unknown())),
  },
  handler: async input => {
    const result = await dispatchRecordCorrespondenceMcp('candidates', input, { get db() { return useDb() } })
    if (result && typeof result === 'object' && 'isError' in result) return result
    return { structuredContent: result as Record<string, unknown>, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
})
