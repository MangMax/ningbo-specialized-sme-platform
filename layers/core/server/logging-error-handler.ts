import { defineNitroErrorHandler } from 'nitropack/runtime'
import { send, setResponseHeaders, setResponseStatus } from 'h3'
import { isJsonRequest } from 'nitropack/runtime/utils'

/** Keep Nitro's native API error body and security headers, without its raw stderr fallback.
 * evlog/nuxt still owns error events; only its response formatter is omitted.
 * HTML requests continue through the existing Nuxt renderer.
 */
export default defineNitroErrorHandler(async (error, event, { defaultHandler }) => {
  const path = event.path.split('?')[0]!
  if (!(path.startsWith('/api/') || path === '/mcp') || !isJsonRequest(event)) return
  const response = await defaultHandler(error, event, { silent: true })
  setResponseHeaders(event, response.headers)
  setResponseStatus(event, response.status, response.statusText)
  return send(event, JSON.stringify(response.body, null, 2))
})
