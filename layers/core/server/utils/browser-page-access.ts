import { getHeader, getRequestURL, type H3Event } from 'h3'
import { browserPageAllowed } from './browser-page-request'

export function sameOriginBrowserAccess(event: H3Event, markerHeader: string, method: string = event.method): boolean {
  return browserPageAllowed({
    method,
    serverOrigin: getRequestURL(event, { xForwardedHost: false, xForwardedProto: false }).origin,
    headers: Object.fromEntries([markerHeader, 'sec-fetch-site', 'origin', 'referer', 'content-type'].map(name => [name, getHeader(event, name)])),
  }, markerHeader)
}
