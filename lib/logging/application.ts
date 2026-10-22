import type { LogFilter, LogPolicy } from './contract'
import { LogServiceError, type LogService } from './service'
export type LogAction = 'list' | 'detail' | 'policy' | 'setPolicy' | 'clear'
/** Single protected application boundary, shared by REST and MCP. No business DB handle. */
export async function dispatchLogAction(service: LogService, action: LogAction, input: Record<string, unknown>, authorized: boolean) {
  const headers = { 'cache-control': 'no-store' }
  if (!authorized) return { status: 401, headers, body: { error: { code: 'log_access_denied' } } }
  try {
    let body: unknown
    switch (action) {
      case 'list': body = await service.list(input as LogFilter); break
      case 'detail': body = await service.detail(input.id as string); if (!body) return { status: 404, headers, body: { error: { code: 'log_not_found' } } }; break
      case 'policy': body = await service.policy(); break
      case 'setPolicy': body = await service.setPolicy(input as unknown as LogPolicy); break
      case 'clear': body = await service.clear(input as unknown as LogFilter & { confirm: boolean }); break
    }
    return { status: 200, headers, body }
  } catch (error) {
    return { status: error instanceof LogServiceError ? error.statusCode : 503, headers, body: { error: { code: error instanceof LogServiceError ? error.code : 'logging_unavailable' }, status: service.status() } }
  }
}
