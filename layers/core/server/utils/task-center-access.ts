import { getHeader, getRequestURL, type H3Event } from 'h3'
import { requireApiToken } from './api-guard'
import { taskCenterBrowserAllowed } from './task-center-browser-auth'

/** Scope same-origin page access to task-center actions and current-roster exports. */
export function taskCenterBrowserAccess(event: H3Event): boolean {
  return taskCenterBrowserAllowed({
    method: event.method,
    serverOrigin: getRequestURL(event, { xForwardedHost: false, xForwardedProto: false }).origin,
    headers: Object.fromEntries(['x-task-center-browser', 'sec-fetch-site', 'origin', 'referer', 'content-type'].map(name => [name, getHeader(event, name)])),
  })
}
export function requireTaskCenterAccess(event: H3Event): void {
  if (!taskCenterBrowserAccess(event)) requireApiToken(event)
}
