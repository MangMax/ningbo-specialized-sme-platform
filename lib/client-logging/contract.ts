/** Fixed application vocabulary. Never accept page paths, messages or execution IDs. */
export const CLIENT_ERROR_KINDS = ['script_error', 'vue_error', 'unhandled_rejection', 'interaction_failure'] as const
export const CLIENT_PAGES = ['roster', 'tasks', 'files', 'logs', 'settings', 'other'] as const
export type ClientErrorKind = typeof CLIENT_ERROR_KINDS[number]
export type ClientPage = typeof CLIENT_PAGES[number]
export interface ClientErrorReport { kind: ClientErrorKind; page: ClientPage; level: 'error' | 'warn' }
export function clientErrorReport(value: unknown): ClientErrorReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (!CLIENT_ERROR_KINDS.includes(input.kind as ClientErrorKind) || !CLIENT_PAGES.includes(input.page as ClientPage)
    || (input.level !== 'error' && input.level !== 'warn')) return null
  return { kind: input.kind as ClientErrorKind, page: input.page as ClientPage, level: input.level }
}
export function clientPage(path: string): ClientPage {
  const first = path.split('/')[1]
  if (!first || first === 'current-enterprises' || first === 'enterprises') return 'roster'
  return ['tasks', 'files', 'logs', 'settings'].includes(first) ? first as ClientPage : 'other'
}
