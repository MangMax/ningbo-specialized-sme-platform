import { credentialStatus, resolveCredential, updateCredential, updateCredentials, type CredentialKey, type CredentialContext } from './credential-state'
import type { CoreRequest, CoreResponse } from './core-route'
export function handleCredentialsRequest(action: 'state' | 'reveal', request: CoreRequest, ctx: CredentialContext, revealKey: CredentialKey = 'ocrToken'): CoreResponse {
  const json = (status: number, body: unknown): CoreResponse => ({ status, body, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
  try {
    if (action === 'reveal') {
      if (request.method !== 'POST') return json(405, { message: '仅支持 POST' })
      return json(200, { value: resolveCredential(revealKey, ctx).value })
    }
    if (request.method === 'PATCH' || request.method === 'DELETE') {
      const body = request.body
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { message: '需要 JSON 对象' })
      const input = body as Record<string, unknown>
      if (request.method === 'DELETE') {
        if (!['ocrToken', 'miitCookie'].includes(String(input.key)) || Object.keys(input).some(key => key !== 'key')) return json(400, { message: '请明确指定要清除的配置' })
        updateCredential(input.key as CredentialKey, null, ctx)
      } else {
        const keys: CredentialKey[] = ['ocrToken', 'miitCookie']
        if (Object.keys(input).some(key => !keys.includes(key as CredentialKey))) return json(400, { message: '不支持的配置字段' })
        // Validate the complete request before changing either independent field.
        for (const key of keys) {
          const value = input[key]
          if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 65536 || (key === 'miitCookie' && /[\r\n]/.test(value)))) return json(400, { message: '请输入非空凭据（最多 65536 字符，Cookie 不可含换行）' })
        }
        if (Object.keys(input).length) updateCredentials(Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, (input[key] as string).trim()])), ctx)
      }
    } else if (request.method !== 'GET') return json(405, { message: '不支持的方法' })
    return json(200, credentialStatus(ctx))
  } catch {
    // Never forward filesystem paths, JSON parse excerpts, credentials or upstream exceptions.
    return json(503, { message: '配置存储不可用，请检查外置目录与权限后重试；旧配置未被覆盖。' })
  }
}
