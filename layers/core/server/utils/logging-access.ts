import { getHeader, getRequestURL, type H3Event } from 'h3'
import { readApiToken, resolveApiAuth } from '../../../../server/utils/api-auth'
import { taskCenterBrowserAllowed } from './task-center-browser-auth'
/** Same-origin page access is enabled by default; remote clients still use API tokens. */
export function logAccessAllowed(event: H3Event): boolean {
  const config = useRuntimeConfig(event)
  if (resolveApiAuth({ given: readApiToken({ authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token') }), configured: config.apiToken }).writeAuthorized) return true
  return taskCenterBrowserAllowed({
    method: event.method === 'PATCH' ? 'POST' : event.method,
    serverOrigin: getRequestURL(event, { xForwardedHost: false, xForwardedProto: false }).origin,
    headers: {
      'x-task-center-browser': getHeader(event, 'x-log-browser'),
      'sec-fetch-site': getHeader(event, 'sec-fetch-site'), origin: getHeader(event, 'origin'),
      referer: getHeader(event, 'referer'), 'content-type': getHeader(event, 'content-type'),
    },
  })
}
