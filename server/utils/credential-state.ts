import { eq } from 'drizzle-orm'
import { useDb } from '../../db/client'
import { serviceCredential } from '../../db/schema'

export type CredentialKey = 'ocrToken' | 'miitCookie'
export interface CredentialValue { value: string; updatedAt: string }
type State = Partial<Record<CredentialKey, CredentialValue>>
export interface CredentialContext {
  db?: ReturnType<typeof useDb>
  ocrToken?: string
  env?: Record<string, string | undefined>
}
export function credentialContext(): CredentialContext {
  const config: { ocrToken?: string } = typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : {}
  return { ocrToken: config.ocrToken }
}
const storageError = () => new Error('凭据配置存储不可用，请检查数据库后重试。')
function readState(ctx: CredentialContext): State {
  try {
    const state: State = {}
    for (const row of (ctx.db ?? useDb()).select().from(serviceCredential).all()) {
      if (!['ocrToken', 'miitCookie'].includes(row.key) || typeof row.value !== 'string' || !row.value.trim() || typeof row.updatedAt !== 'string') throw storageError()
      state[row.key] = { value: row.value, updatedAt: row.updatedAt }
    }
    return state
  } catch { throw storageError() }
}
export function resolveCredential(key: CredentialKey, ctx: CredentialContext = credentialContext(), override?: string) {
  if (override?.trim()) return { value: override.trim(), source: 'override', updatedAt: null, hasSaved: false }
  return resolveFromState(key, ctx, readState(ctx))
}
function resolveFromState(key: CredentialKey, ctx: CredentialContext, state: State) {
  const saved = state[key]
  if (saved) return { ...saved, source: 'saved', hasSaved: true }
  const env = ctx.env ?? process.env
  if (key === 'miitCookie') return { value: env.MIIT_COOKIE?.trim() || '', source: env.MIIT_COOKIE?.trim() ? 'MIIT_COOKIE' : 'none', updatedAt: null, hasSaved: false }
  if (ctx.ocrToken?.trim() || env.NUXT_OCR_TOKEN?.trim()) return { value: ctx.ocrToken?.trim() || env.NUXT_OCR_TOKEN!.trim(), source: 'NUXT_OCR_TOKEN', updatedAt: null, hasSaved: false }
  if (env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN?.trim()) return { value: env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN.trim(), source: 'PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN', updatedAt: null, hasSaved: false }
  return { value: '', source: 'none', updatedAt: null, hasSaved: false }
}
export function credentialStatus(ctx: CredentialContext) {
  const state = readState(ctx)
  const status = (key: CredentialKey) => {
    const { value, ...rest } = resolveFromState(key, ctx, state)
    return { ...rest, configured: !!value, masked: !value ? '' : value.length <= 8 ? '********' : `${value.slice(0, 3)}********${value.slice(-3)}` }
  }
  return { ocrToken: status('ocrToken'), miitCookie: status('miitCookie') }
}
export function updateCredential(key: CredentialKey, value: string | null, ctx: CredentialContext): void {
  updateCredentials({ [key]: value }, ctx)
}
/** One transaction keeps independent keys intact and rolls back a failed mixed update. */
export function updateCredentials(values: Partial<Record<CredentialKey, string | null>>, ctx: CredentialContext): void {
  try {
    const db = ctx.db ?? useDb()
    db.transaction(tx => {
      const updatedAt = new Date().toISOString()
      for (const key of ['ocrToken', 'miitCookie'] as const) {
        const value = values[key]
        if (value === null) tx.delete(serviceCredential).where(eq(serviceCredential.key, key)).run()
        else if (value !== undefined) tx.insert(serviceCredential).values({ key, value, updatedAt }).onConflictDoUpdate({ target: serviceCredential.key, set: { value, updatedAt } }).run()
      }
    })
  } catch { throw storageError() }
}
/** The application reads database overrides; explicit callbacks remain controlled overrides. */
export function resolvePlatformCookie(override?: string | (() => string) | null, ctx: CredentialContext = credentialContext()): string {
  if (typeof override === 'function') return override().trim()
  if (typeof override === 'string') return override.trim()
  return resolveCredential('miitCookie', ctx).value
}
