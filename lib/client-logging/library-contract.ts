import { CLIENT_PAGES, type ClientPage } from './contract'

/** Fixed observations, never library messages, query keys, routes or callback arguments. */
export const CLIENT_LIBRARY_SIGNALS = {
  tus_upload_started: { integration: 'tus-client', operation: 'client.tus.upload_started', outcome: 'started', level: 'debug' },
  tus_upload_ready: { integration: 'tus-client', operation: 'client.tus.upload_ready', outcome: 'started', level: 'info' },
  tus_upload_success: { integration: 'tus-client', operation: 'client.tus.upload_success', outcome: 'success', level: 'info' },
  tus_upload_failure: { integration: 'tus-client', operation: 'client.tus.upload_failure', outcome: 'failure', level: 'error' },
  pdf_log_debug: { integration: 'embedpdf', operation: 'client.embedpdf.log_debug', outcome: 'unknown', level: 'debug' },
  pdf_log_info: { integration: 'embedpdf', operation: 'client.embedpdf.log_info', outcome: 'unknown', level: 'info' },
  pdf_log_warn: { integration: 'embedpdf', operation: 'client.embedpdf.log_warn', outcome: 'unknown', level: 'warn' },
  pdf_log_error: { integration: 'embedpdf', operation: 'client.embedpdf.log_error', outcome: 'unknown', level: 'error' },
  pdf_startup_failure: { integration: 'embedpdf', operation: 'client.embedpdf.startup_failure', outcome: 'failure', level: 'error' },
  pdf_document_ready: { integration: 'embedpdf', operation: 'client.embedpdf.document_ready', outcome: 'success', level: 'info' },
  pdf_document_failure: { integration: 'embedpdf', operation: 'client.embedpdf.document_failure', outcome: 'failure', level: 'error' },
  colada_query_success: { integration: 'pinia-colada', operation: 'client.colada.query_success', outcome: 'success', level: 'info' },
  colada_query_failure: { integration: 'pinia-colada', operation: 'client.colada.query_failure', outcome: 'failure', level: 'error' },
  colada_mutation_success: { integration: 'pinia-colada', operation: 'client.colada.mutation_success', outcome: 'success', level: 'info' },
  colada_mutation_failure: { integration: 'pinia-colada', operation: 'client.colada.mutation_failure', outcome: 'failure', level: 'error' },
  router_navigation_success: { integration: 'vue-router', operation: 'client.router.navigation_success', outcome: 'success', level: 'info' },
  router_navigation_aborted: { integration: 'vue-router', operation: 'client.router.navigation_aborted', outcome: 'cancelled', level: 'warn' },
  router_navigation_cancelled: { integration: 'vue-router', operation: 'client.router.navigation_cancelled', outcome: 'cancelled', level: 'debug' },
  router_navigation_duplicated: { integration: 'vue-router', operation: 'client.router.navigation_duplicated', outcome: 'skipped', level: 'debug' },
  router_navigation_failure: { integration: 'vue-router', operation: 'client.router.navigation_failure', outcome: 'failure', level: 'warn' },
  router_navigation_error: { integration: 'vue-router', operation: 'client.router.navigation_error', outcome: 'failure', level: 'error' },
} as const

export type ClientLibrarySignal = keyof typeof CLIENT_LIBRARY_SIGNALS
export interface ClientLibraryReport { kind: 'library_signal'; signal: ClientLibrarySignal; page: ClientPage }

export function clientLibraryReport(value: unknown): ClientLibraryReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.kind !== 'library_signal' || typeof input.signal !== 'string'
    || !Object.hasOwn(CLIENT_LIBRARY_SIGNALS, input.signal) || !CLIENT_PAGES.includes(input.page as ClientPage)) return null
  return { kind: 'library_signal', signal: input.signal as ClientLibrarySignal, page: input.page as ClientPage }
}
