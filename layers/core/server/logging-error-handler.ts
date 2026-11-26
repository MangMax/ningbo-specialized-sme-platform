import { defineErrorHandler } from 'nitro'
import { getEventContext, HTTPError, isEvent, type HTTPEvent } from 'nitro/h3'
import { shouldHideOpenApiPath } from './utils/openapi-guard'

function isJsonRequest(event: HTTPEvent) {
  const headerIncludes = (name: string, value: string) =>
    event.req.headers.get(name)?.toLowerCase().includes(value)
  if (headerIncludes('accept', 'text/html')) return false
  const pathname = new URL(event.req.url).pathname
  return headerIncludes('accept', 'application/json') || headerIncludes('user-agent', 'curl/')
    || headerIncludes('user-agent', 'httpie/') || headerIncludes('sec-fetch-mode', 'cors')
    || pathname.startsWith('/api/') || pathname.endsWith('.json')
}

/** Keep Nitro's native API error body and security headers, without its raw stderr fallback.
 * evlog/nuxt still owns error events; only its response formatter is omitted.
 * HTML requests continue through the existing Nuxt renderer.
 */
export default defineErrorHandler(async (error, event, { defaultHandler }) => {
  const url = new URL(event.req.url)
  const path = url.pathname
  if (!(path.startsWith('/api/') || path === '/mcp' || shouldHideOpenApiPath(path, { dev: import.meta.dev })) || !isJsonRequest(event)) return
  const response = await defaultHandler(error, event, { silent: true })
  const statusCode = response.status ?? 500
  const headers = new Headers(response.headers)
  if (isEvent(event)) {
    for (const name of ['cache-control', 'www-authenticate', 'retry-after', 'allow']) {
      const value = event.res.headers.get(name)
      if (value) headers.set(name, value)
    }
  }
  if (statusCode === 404 || !headers.has('cache-control')) headers.set('cache-control', 'no-cache')
  for (const [name, value] of Object.entries({
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "script-src 'none'; frame-ancestors 'none';",
  })) if (!headers.has(name)) headers.set(name, value)
  const requestId = getEventContext(event).requestId
  if (typeof requestId === 'string') headers.set('x-request-id', requestId)
  const statusText = response.statusText || 'Server Error'
  const cause = HTTPError.isError(error) && !error.unhandled ? error.cause : undefined
  // H3 strips non-ASCII characters for the HTTP status line. JSON can retain the original message.
  const rawStatus = cause && typeof cause === 'object' && 'statusMessage' in cause ? cause.statusMessage : undefined
  const statusMessage = typeof rawStatus === 'string' && rawStatus ? rawStatus : statusText
  const native = response.body
  if (typeof native !== 'object' || native === null) {
    return new Response(native, { status: statusCode, statusText, headers })
  }
  headers.set('content-type', 'application/json')
  const body = {
    error: true, url: url.href, statusCode, statusMessage,
    message: 'message' in native && typeof native.message === 'string' ? native.message : 'Server Error',
    data: 'data' in native ? native.data : undefined,
  }
  return new Response(JSON.stringify(body, null, 2), { status: statusCode, statusText, headers })
})
