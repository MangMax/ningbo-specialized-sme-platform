import type { LogContext } from '../../../core/lib/logging'

export type AnnualTaskAction = 'submit' | 'detail' | 'cancel' | 'retry'
export type AnnualRuntimeContext = { filesDir: string; apiToken?: string | null; browserAuthorized?: boolean; logContext?: LogContext }
