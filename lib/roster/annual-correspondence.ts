import type { JobProgress, JobState } from '../../layers/core/lib/job'

export const ANNUAL_CORRESPONDENCE_KIND = 'event-annual-correspondence'
export const ANNUAL_CORRESPONDENCE_RULE = 'event-annual-process'
export const ANNUAL_CORRESPONDENCE_VERSION = '1'

/** An explicit decision on this observation. Never inherited by another observation. */
export interface AnnualDecisionRef {
  id: number
  relationId: number
  revision: number
  status: 'candidate' | 'confirmed' | 'rejected' | 'unlinked'
  requiresRevalidation: boolean
}
export interface AnnualFinalQualification {
  stepId: string | null
  status: 'confirmed' | 'eligible' | 'blocked' | 'none'
  decisionRefs: AnnualDecisionRef[]
  reasons: string[]
}
export interface AnnualStepOutcome {
  stepId: string
  status: 'created' | 'existing' | 'protected' | 'needs_review'
  relationId: number | null
  decisionRefs: AnnualDecisionRef[]
  reasons: string[]
}
export interface AnnualEventOutcome {
  eventId: number
  generation: string
  status: 'pending' | 'running' | 'done' | 'failed'
  /** Historical execution checkpoints, not current decisions on every observation. */
  outcomes: AnnualStepOutcome[]
  /** Task GET recomputes this against its frozen generation; mismatch blocks final. */
  finalQualification: AnnualFinalQualification
  errorCode?: string
}
export interface AnnualTaskResult {
  ruleVersion: string
  attempt: number
  events: AnnualEventOutcome[]
}
export interface AnnualTaskReceipt {
  jobId: string
  kind: typeof ANNUAL_CORRESPONDENCE_KIND
  state: JobState
  sourceGenerations: { eventId: number; generation: string }[]
}
export interface AnnualTaskDto {
  jobId: string
  kind: typeof ANNUAL_CORRESPONDENCE_KIND
  status: JobState
  progress: JobProgress
  result: AnnualTaskResult | null
  errorCode: string | null
  capabilities: { cancel: boolean; retry: boolean }
}
