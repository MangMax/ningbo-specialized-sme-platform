/**
 * HTTP method/route facts for the diagnostic projection.
 *
 * `httpRoute` is accepted only by **exact membership** in the generated
 * application route-template set (`route-templates.ts`). There is deliberately
 * no shape heuristic: `/api/files/alice`, `/api/files/bob-smith` and
 * `/api/private-secret` are normal-looking but are not application routes, so
 * they are rejected. The request hook only submits
 * `event.context.matchedRoute.path`; a concrete request path is never used.
 */
import type { LogInput } from './contract'
import { APPLICATION_LOG_ROUTES } from '../../../../lib/logging-route-templates'

/** Fixed server-owned method vocabulary. Incoming headers cannot extend it. */
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

export function safeHttpMethod(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  const method = value.toUpperCase()
  return HTTP_METHODS.has(method) ? method : undefined
}

/** Exact application-template membership; unknown templates are rejected regardless of spelling. */
export function safeHttpRoute(value: unknown): string | undefined {
  return typeof value === 'string' && APPLICATION_LOG_ROUTES.has(value) ? value : undefined
}

const pollingRoutes = new Set(['/api/jobs', '/api/jobs/:id', '/api/task-center', '/api/task-center/:id', '/api/task-center/events'])

export function isSuccessfulProbe(event: LogInput): boolean {
  if (event.operation !== 'http.request' || event.outcome !== 'success') return false
  if (event.httpRoute === '/api/health') return event.httpMethod === 'GET' || event.httpMethod === 'HEAD'
  return event.httpMethod === 'GET' && event.httpRoute !== undefined && pollingRoutes.has(event.httpRoute)
}
