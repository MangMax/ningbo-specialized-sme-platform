import { clientRequestReference } from './request-reference'
/** Fixed application vocabulary. Never accept page paths, messages or trusted execution IDs. */
export const CLIENT_ERROR_KINDS = ['script_error', 'vue_error', 'unhandled_rejection', 'interaction_failure'] as const
export const CLIENT_PAGES = ['roster', 'tasks', 'files', 'logs', 'settings', 'ocr', 'other'] as const
export const CLIENT_INTERACTIONS = ['task_artifact_download', 'task_cancel', 'task_retry'] as const
export type ClientInteraction = typeof CLIENT_INTERACTIONS[number]
export type ClientErrorKind = typeof CLIENT_ERROR_KINDS[number]
export type ClientPage = typeof CLIENT_PAGES[number]
export interface ClientErrorReport { kind: ClientErrorKind; page: ClientPage; level: 'error' | 'warn'; relatedRequestId?: string; interaction?: ClientInteraction }
export function clientErrorReport(value: unknown): ClientErrorReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (!CLIENT_ERROR_KINDS.includes(input.kind as ClientErrorKind) || !CLIENT_PAGES.includes(input.page as ClientPage)
    || (input.level !== 'error' && input.level !== 'warn')) return null
  const interaction = input.kind === 'interaction_failure' && CLIENT_INTERACTIONS.includes(input.interaction as ClientInteraction) ? input.interaction as ClientInteraction : undefined
  const relatedRequestId = clientRequestReference(input.relatedRequestId)
  return { kind: input.kind as ClientErrorKind, page: input.page as ClientPage, level: input.level, ...(interaction ? { interaction } : {}), ...(relatedRequestId ? { relatedRequestId } : {}) }
}
export function clientPage(path: string): ClientPage {
  const first = path.split('/')[1]
  if (path === '/' || [
    'roster', 'current-enterprises', 'enterprises', 'comparison', 'quality', 'stats',
    'platform-business-processes', 'platform-declarations', 'platform-queries', 'platform-recognized-directory',
  ].includes(first ?? '')) return 'roster'
  if (first === 'preview') return 'files'
  return CLIENT_PAGES.includes(first as ClientPage) ? first as ClientPage : 'other'
}
