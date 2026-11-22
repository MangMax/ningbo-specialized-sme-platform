import { z } from 'zod'
import { ANNUAL_CORRESPONDENCE_KIND as KIND, ANNUAL_CORRESPONDENCE_VERSION as VERSION, type AnnualTaskReceipt, type AnnualTaskResult } from '../../../lib/roster/annual-correspondence'
import type { JobRow } from '../../../../core/server/utils/job-contract'

export const annualTaskInput = z.strictObject({ clientRequestId: z.string().trim().min(1).max(120), eventIds: z.array(z.number().int().positive()).min(1).max(200) })

export interface AnnualTaskParams extends Record<string, unknown> {
  eventIds: number[]
  clientRequestIds: string[]
  serverIdentity: string
  sourceGenerations: { eventId: number; generation: string }[]
  ruleVersion: string
}

const emptyFinal = () => ({ stepId: null, status: 'none' as const, decisionRefs: [], reasons: ['task_not_processed'] })

export function annualTaskReceipt(row: Pick<JobRow, 'id' | 'state' | 'params'>): AnnualTaskReceipt {
  return { jobId: row.id, kind: KIND, state: row.state, sourceGenerations: (row.params as AnnualTaskParams).sourceGenerations }
}

export function initialAnnualResult(sourceGenerations: AnnualTaskParams['sourceGenerations']): AnnualTaskResult {
  return { ruleVersion: VERSION, attempt: 0, events: sourceGenerations.map(source => ({ ...source, status: 'pending', outcomes: [], finalQualification: emptyFinal() })) }
}

export function annualErrorCode(cause: unknown): string {
  const code = (cause as {code?:string})?.code
  return ['source_generation_changed','event_unavailable','source_materialization_limit','rule_version_changed','invalid_annual_task_request','idempotency_conflict','protected_decision','retry_unavailable','invalid_endpoint_type','identity_conflict','title_conflict','ambiguous_candidate','incomplete_coverage','stale_revision','plan_mismatch'].includes(code ?? '') ? code! : 'annual_step_failed'
}
