import { getHeader, getRequestURL, type H3Event } from 'h3'
import { requireApiToken } from './api-guard'
import { taskCenterBrowserAllowed } from './task-center-browser-auth'

/** Scope this opt-in only to task-center actions and current-roster exports. */
export function taskCenterBrowserAccess(event: H3Event): boolean {
  const config = useRuntimeConfig(event)
  return taskCenterBrowserAllowed({
    enabled: config.browserTasksEnabled, apiToken: config.apiToken,
    method: event.method,
    serverOrigin: getRequestURL(event, { xForwardedHost: false, xForwardedProto: false }).origin,
    headers: Object.fromEntries(['x-task-center-browser', 'sec-fetch-site', 'origin', 'referer', 'content-type'].map(name => [name, getHeader(event, name)])),
  })
}
export function requireTaskCenterAccess(event: H3Event): void {
  if (!taskCenterBrowserAccess(event)) requireApiToken(event)
}
