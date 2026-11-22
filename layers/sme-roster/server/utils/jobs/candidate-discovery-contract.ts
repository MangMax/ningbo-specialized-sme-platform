import { z } from 'zod'
import { EVENT_ARCHIVE_RULE_VERSION } from '../event-archive-discovery-model'
import type { CorrespondenceEdge } from '../record-correspondence-model'
import { JOB_ID_RE } from '../../../../core/lib/job'

export const CANDIDATE_JOB_KIND = 'event-archive-candidates'

export const candidateJobInput = z
  .object({
    clientRequestId: z.string().trim().min(1).max(120),
    eventIds: z.array(z.number().int().positive()).min(1).max(200).optional(),
    titleCode: z
      .enum(['specialized_sme', 'innovative_sme', 'little_giant'])
      .optional(),
    queryId: z.number().int().positive().optional(),
    afterEventId: z.number().int().nonnegative().default(0),
    throughEventId: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (v) => [v.eventIds, v.titleCode, v.queryId].filter(Boolean).length === 1,
    '恰选事件、称号或归档查询范围之一',
  )

// Internal continuation metadata; public submission keeps its existing shape.
// The originating task identifies one archive generation and survives retries.
export const candidateJobParams = candidateJobInput.safeExtend({
  archiveGeneration: z.string().regex(JOB_ID_RE).optional(),
})

export type CandidateJobParams = z.infer<typeof candidateJobParams>

export interface CandidateJobItem {
  eventId: number
  enterpriseId: number | null
  status: 'pending' | 'running' | 'done' | 'failed'
  page: number
  rowIndex: number
  created: number
  existing: number
  needsReview: boolean
  errorCode?: string
}

export interface CandidateJobResult {
  ruleVersion: string
  attempt: number
  items: CandidateJobItem[]
  throughEventId: number
  nextAfterEventId: number | null
  continuationJobId?: string
  counts: {
    succeeded: number
    needsReview: number
    failed: number
    created: number
    existing: number
  }
}

export function candidateResult(rows: { eventId: number; enterpriseId: number }[], high: number, explicitEventIds?: number[]): CandidateJobResult {
  const selected: { eventId: number; enterpriseId: number | null }[] =
    rows.slice(0, 200)
  // Explicit event IDs must not disappear as a successful empty task.
  if (explicitEventIds)
    for (const id of explicitEventIds)
      if (!selected.some((r) => r.eventId === id))
        selected.push({ eventId: id, enterpriseId: null })
  return {
    ruleVersion: EVENT_ARCHIVE_RULE_VERSION,
    attempt: 0,
    throughEventId: high,
    nextAfterEventId: rows.length > 200 ? rows[199]!.eventId : null,
    items: selected.map((row) => ({
      ...row,
      status: 'pending',
      page: 1,
      rowIndex: 0,
      created: 0,
      existing: 0,
      needsReview: false,
    })),
    counts: {
      succeeded: 0,
      needsReview: 0,
      failed: 0,
      created: 0,
      existing: 0,
    },
  }
}

export function updateCounts(result: CandidateJobResult) {
  result.counts = {
    succeeded: result.items.filter((i) => i.status === 'done').length,
    needsReview: result.items.filter(
      (i) => i.status === 'done' && i.needsReview,
    ).length,
    failed: result.items.filter((i) => i.status === 'failed').length,
    created: result.items.reduce((n, i) => n + i.created, 0),
    existing: result.items.reduce((n, i) => n + i.existing, 0),
  }
}

/** The existing domain hydrates one selected source for its fingerprint and
 * audit. Bound that work before hydration; discovery never loads the corpus. */
export function candidateSourceLimitError() {
  return Object.assign(new Error('source_materialization_limit'), { statusCode: 422 })
}

export function candidateCompletion(result: CandidateJobResult, cancelled: boolean) {
  return {
    result,
    ...(result.counts.failed
      ? {
          error: result.items.some((item) => item.errorCode === 'source_materialization_limit')
            ? '部分事件原档超过4 MiB任务处理上限；此原行未写入，原档与已完成候选保留。原档不变时重试仍会失败，请按原行核对。'
            : '部分事件失败；已完成候选保留，可重试未完成项。',
        }
      : {}),
    progress: {
      done: result.counts.succeeded + result.counts.failed,
      total: result.items.length,
    },
    ...(cancelled ? { cancelled: true } : {}),
  }
}

export function candidateRequest(jobId: string, eventId: number, candidate: Record<string, unknown>) {
  const edge = candidate.edge as CorrespondenceEdge & { eventId: number; relationId: number }
  return {
    idempotencyKey: `candidate-job:${jobId}:${eventId}:${edge.relationId}`,
    sourceIdentity: `candidate-job/${jobId}`,
    actor: { type: 'agent' as const, id: 'candidate-discovery-job' },
    basis: '归档原行精确身份与称号匹配；仅生成待核候选，人工核对后决定。',
    ruleId: String(candidate.ruleId),
    ruleVersion: EVENT_ARCHIVE_RULE_VERSION,
    operations: [{ action: 'create' as const, status: 'candidate' as const, edge }] as [{ action: 'create'; status: 'candidate'; edge: typeof edge }],
  }
}
