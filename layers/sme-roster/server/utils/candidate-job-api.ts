import type { LogContext } from '../../../core/lib/logging'
export type CandidateJobAction = 'submit' | 'detail' | 'cancel' | 'retry'
export type CandidateRuntimeContext = {
  filesDir: string
  apiToken?: string | null
  browserAuthorized?: boolean
  logContext?: LogContext
}
export type CandidateRequest = {
  method: string
  path: string
  headers?: Record<string, string | undefined>
  body?: unknown
  id?: unknown
}
