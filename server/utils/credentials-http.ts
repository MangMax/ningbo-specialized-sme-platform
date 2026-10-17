import { readApiToken, resolveApiAuth } from './api-auth'
import { credentialStatus, resolveCredential, updateCredential, type CredentialContext } from './credential-state'
import type { CoreRequest, CoreResponse } from './core-route'
export function handleCredentialsRequest(action: 'state' | 'reveal', request: CoreRequest, ctx: CredentialContext & { apiToken?: string | null }): CoreResponse {
  const json = (status: number, body: unknown): CoreResponse => ({ status, body, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
  const auth = resolveApiAuth({ given: readApiToken(request.headers), configured: ctx.apiToken })
  if (!auth.writeAuthorized) return { ...json(401, { message: '需要 API 管理授权' }), headers: { ...json(401, {}).headers, 'www-authenticate': 'Bearer realm="agent-api"' } }
  try {
    if (action === 'reveal') {
      if (request.method !== 'POST') return json(405, { message: '仅支持 POST' })
      return json(200, { value: resolveCredential('ocrToken', ctx).value })
    }
    if (request.method === 'PATCH' || request.method === 'DELETE') {
      const body = request.body
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { message: '需要 JSON 对象' })
      const input = body as Record<string, unknown>
      if (request.method === 'DELETE') {
        if (input.key !== 'ocrToken' || Object.keys(input).some(key => key !== 'key')) return json(400, { message: '请明确指定要清除的配置' })
        updateCredential('ocrToken', null, ctx)
      } else {
        if (Object.keys(input).some(key => key !== 'ocrToken')) return json(400, { message: '不支持的配置字段' })
        if (input.ocrToken !== undefined) {
          if (typeof input.ocrToken !== 'string' || !input.ocrToken.trim() || input.ocrToken.length > 65536) return json(400, { message: '请输入非空 OCR token（最多 65536 字符）' })
          updateCredential('ocrToken', input.ocrToken.trim(), ctx)
        }
      }
    } else if (request.method !== 'GET') return json(405, { message: '不支持的方法' })
    return json(200, credentialStatus(ctx))
  } catch {
    // Never forward filesystem paths, JSON parse excerpts, credentials or upstream exceptions.
    return json(503, { message: '配置存储不可用，请检查外置目录与权限后重试；旧配置未被覆盖。' })
  }
}
