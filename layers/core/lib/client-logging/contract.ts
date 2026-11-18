import { getAppModules } from '../../../../lib/app-modules'
import { clientRequestReference } from './request-reference'
/** Fixed application vocabulary. Never accept page paths, messages or trusted execution IDs. */
export const CLIENT_ERROR_KINDS = ['script_error', 'vue_error', 'unhandled_rejection', 'interaction_failure'] as const
export const CLIENT_INTERACTIONS = ['task_artifact_download', 'task_cancel', 'task_retry'] as const
export type ClientInteraction = typeof CLIENT_INTERACTIONS[number]
export type ClientErrorKind = typeof CLIENT_ERROR_KINDS[number]
export type ClientPage = string

const pages = getAppModules().flatMap(({ id, clientPages }) =>
  (clientPages ?? []).map(({ page, paths, operationPage = page }) => ({ module: id, page, paths, operationPage })))
const attributionByPage = new Map(pages.map(({ module, page, operationPage }) => [page, { module, operationPage }]))
const pagePaths = pages.flatMap(({ page, paths }) => paths.map(path => ({ page, path })))
  .sort((a, b) => b.path.length - a.path.length)

export function isClientPage(value: unknown): value is ClientPage {
  return typeof value === 'string' && (value === 'other' || attributionByPage.has(value))
}

export function clientPageAttribution(page: ClientPage): { module: string | null; operationPage: string } {
  return attributionByPage.get(page) ?? { module: null, operationPage: 'other' }
}

export interface ClientErrorReport { kind: ClientErrorKind; page: ClientPage; level: 'error' | 'warn'; relatedRequestId?: string; interaction?: ClientInteraction }
export function clientErrorReport(value: unknown): ClientErrorReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (!CLIENT_ERROR_KINDS.includes(input.kind as ClientErrorKind) || !isClientPage(input.page)
    || (input.level !== 'error' && input.level !== 'warn')) return null
  const interaction = input.kind === 'interaction_failure' && CLIENT_INTERACTIONS.includes(input.interaction as ClientInteraction) ? input.interaction as ClientInteraction : undefined
  const relatedRequestId = clientRequestReference(input.relatedRequestId)
  return { kind: input.kind as ClientErrorKind, page: input.page, level: input.level, ...(interaction ? { interaction } : {}), ...(relatedRequestId ? { relatedRequestId } : {}) }
}
export function clientPage(path: string): ClientPage {
  return pagePaths.find(entry => path === entry.path || (entry.path !== '/' && path.startsWith(entry.path + '/')))?.page ?? 'other'
}
