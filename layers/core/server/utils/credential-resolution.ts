import { isCredentialKey, registeredCredentials, type CredentialKey } from '../../../../lib/app-modules'

export interface CredentialValue { value: string; updatedAt: string }
export type CredentialState = Partial<Record<CredentialKey, CredentialValue>>
export interface CredentialReadContext {
  ocrToken?: string
  env?: Record<string, string | undefined>
}
export function credentialContext(): CredentialReadContext {
  const config: { ocrToken?: string } = typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : {}
  return { ocrToken: config.ocrToken }
}
export const storageError = () => Object.assign(new Error('凭据配置存储不可用，请检查数据库后重试。'), { statusCode: 503 })
export function credentialState(rows: { key: string; value: string; updatedAt: string }[]) {
  const state: CredentialState = {}
  for (const row of rows) {
    if (!isCredentialKey(row.key) || typeof row.value !== 'string' || !row.value.trim() || typeof row.updatedAt !== 'string') throw storageError()
    state[row.key] = { value: row.value, updatedAt: row.updatedAt }
  }
  return state
}

export function resolveFromState(key: CredentialKey, ctx: CredentialReadContext, state: CredentialState) {
  const saved = state[key]
  if (saved) return { ...saved, source: 'saved', hasSaved: true }
  const env = ctx.env ?? process.env
  for (const source of registeredCredentials.get(key)?.environment ?? []) {
    const runtimeValue = source === 'NUXT_OCR_TOKEN' ? ctx.ocrToken?.trim() : undefined
    const value = runtimeValue || env[source]?.trim()
    if (value) return { value, source, updatedAt: null, hasSaved: false }
  }
  return { value: '', source: 'none', updatedAt: null, hasSaved: false }
}
export function credentialStatus(ctx: CredentialReadContext, state: CredentialState) {
  const status = (key: CredentialKey) => {
    const { value, ...rest } = resolveFromState(key, ctx, state)
    return { ...rest, configured: !!value, masked: !value ? '' : value.length <= 8 ? '********' : `${value.slice(0, 3)}********${value.slice(-3)}` }
  }
  return Object.fromEntries(Array.from(registeredCredentials.keys(), key => [key, status(key)])) as Record<CredentialKey, ReturnType<typeof status>>
}
export interface CredentialStorage {
  read(): CredentialState | Promise<CredentialState>
  update(values: Partial<Record<CredentialKey, string | null>>): CredentialState | Promise<CredentialState>
}
