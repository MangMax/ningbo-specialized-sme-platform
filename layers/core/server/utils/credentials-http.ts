import { isCredentialKey, registeredCredentials, type CredentialKey } from '../../../../lib/app-modules'
import { credentialStatus, resolveCredential, updateCredential, updateCredentials, type CredentialContext } from './credential-state'
import type { CoreRequest, CoreResponse } from './core-route'
export function handleCredentialsRequest(action: 'state' | 'reveal', request: CoreRequest, ctx: CredentialContext, revealKey?: string): CoreResponse {
  const json = (status: number, body: unknown): CoreResponse => ({ status, body, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
  try {
    if (action === 'reveal') {
      if (request.method !== 'POST') return json(405, { message: '仅支持 POST' })
      if (!isCredentialKey(revealKey)) return json(404, { message: '未登记的凭据' })
      return json(200, { value: resolveCredential(revealKey, ctx).value })
    }
    if (request.method === 'PATCH' || request.method === 'DELETE') {
      const body = request.body
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { message: '需要 JSON 对象' })
      const input = body as Record<string, unknown>
      if (request.method === 'DELETE') {
        if (!isCredentialKey(input.key) || Object.keys(input).some(key => key !== 'key')) return json(400, { message: '请明确指定要清除的配置' })
        updateCredential(input.key, null, ctx)
      } else {
        const keys = Object.keys(input)
        if (!keys.every(isCredentialKey)) return json(400, { message: '不支持的配置字段' })
        // Validate the complete request before changing either independent field.
        const values: Partial<Record<CredentialKey, string>> = {}
        for (const key of keys) {
          const value = input[key]
          if (typeof value !== 'string' || !value.trim() || value.length > 65536 || (registeredCredentials.get(key)?.singleLine && /[\r\n]/.test(value))) return json(400, { message: '请输入非空凭据（最多 65536 字符，Cookie 不可含换行）' })
          values[key] = value.trim()
        }
        if (keys.length) updateCredentials(values, ctx)
      }
    } else if (request.method !== 'GET') return json(405, { message: '不支持的方法' })
    return json(200, credentialStatus(ctx))
  } catch {
    // Never forward SQL errors, credentials or upstream exceptions.
    return json(503, { message: '配置存储不可用，请检查数据库后重试。' })
  }
}
