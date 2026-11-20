import type { H3Event } from 'h3'
import { requireApiToken } from './api-guard'
import { sameOriginBrowserAccess } from './browser-page-access'

/** Scope same-origin page access to task-center actions and current-roster exports. */
export function taskCenterBrowserAccess(event: H3Event): boolean {
  return sameOriginBrowserAccess(event, 'x-task-center-browser')
}
export function requireTaskCenterAccess(event: H3Event): void {
  if (!taskCenterBrowserAccess(event)) requireApiToken(event)
}
