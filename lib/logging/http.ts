/**
 * HTTP method/route facts for the diagnostic projection.
 *
 * A route here is a **template** (`/api/files/:id`), never a request path. The
 * request hook only copies `event.context.matchedRoute.path`, which the router
 * built from the application's own route table. `projectEvlog` never derives a
 * route from `event.path` (that would persist concrete IDs, names or tokens).
 */

/** Fixed server-owned method vocabulary. Incoming headers cannot extend it. */
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const MAX_ROUTE_LENGTH = 160
const MAX_SEGMENT_LENGTH = 64
const parameter = /^:[A-Za-z][A-Za-z0-9_]{0,31}$/
const wildcard = /^\*\*?(:[A-Za-z][A-Za-z0-9_]{0,31})?$/
const literal = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const email = /^[^\s@]+@[^\s@]+$/
const hex = /^[0-9a-f]{16,}$/i
const digitRun = /\d{6,}/

/**
 * Static segments are application route words (including camelCase such as
 * `miitCookie`). Reject shapes that identify a concrete value instead.
 */
function looksConcrete(segment: string) {
  return /^\d+$/.test(segment)
    || uuid.test(segment) || email.test(segment) || hex.test(segment) || digitRun.test(segment)
    || segment.length > MAX_SEGMENT_LENGTH
    || segment.includes('_')
    || /^[A-Z]+$/.test(segment)
    || (/[A-Z]/.test(segment) && /\d/.test(segment))
    || (/[A-Za-z]/.test(segment) && /\d/.test(segment) && segment.length >= 6)
    || /^[a-z0-9]{16,}$/.test(segment)
}

export function safeHttpMethod(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  const method = value.toUpperCase()
  return HTTP_METHODS.has(method) ? method : undefined
}

/**
 * Accept only an application route template. `/api/**` and `/mcp` are the
 * surfaces evlog may record; dynamic segment values, query/fragment, encoded
 * bytes, whitespace and concrete-looking IDs are rejected.
 */
export function safeHttpRoute(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 2 || value.length > MAX_ROUTE_LENGTH) return
  if (value !== '/mcp' && !value.startsWith('/api/')) return
  if (/[?#\\%@"'<>\s\x00-\x1f\x7f]/.test(value)) return
  const segments = value.split('/').slice(1)
  if (!segments.length || segments.some(segment => !segment)) return
  for (const segment of segments) {
    if (parameter.test(segment) || wildcard.test(segment)) continue
    if (!literal.test(segment) || looksConcrete(segment)) return
  }
  return value
}
