import { getHeader, type H3Event } from 'h3'
import { readApiToken, resolveApiAuth } from './api-auth'
import { sameOriginBrowserAccess } from './browser-page-access'
/** Same-origin page access is enabled by default; remote clients still use API tokens. */
export function logAccessAllowed(event: H3Event): boolean {
  const config = useRuntimeConfig(event)
  if (resolveApiAuth({ given: readApiToken({ authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token') }), configured: config.apiToken }).writeAuthorized) return true
  return sameOriginBrowserAccess(event, 'x-log-browser', event.method === 'PATCH' ? 'POST' : event.method)
}
