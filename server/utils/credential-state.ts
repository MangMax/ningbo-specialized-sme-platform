import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { serviceCredential } from '../../db/schema'
import { isCredentialKey, registeredCredentials, type CredentialKey } from '../../lib/app-modules'

export interface CredentialValue { value: string; updatedAt: string }
type State = Partial<Record<CredentialKey, CredentialValue>>
export interface CredentialContext {
  db?: BetterSQLite3Database<typeof import('../../db/schema')>
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
      if (!isCredentialKey(row.key) || typeof row.value !== 'string' || !row.value.trim() || typeof row.updatedAt !== 'string') throw storageError()
      state[row.key] = { value: row.value, updatedAt: row.updatedAt }
    }
    return state
  } catch { throw storageError() }
}
export function resolveCredential(key: CredentialKey, ctx: CredentialContext = credentialContext(), override?: string) {
  if (!isCredentialKey(key)) throw new Error('不支持的凭据键')
  if (override?.trim()) return { value: override.trim(), source: 'override', updatedAt: null, hasSaved: false }
  return resolveFromState(key, ctx, readState(ctx))
}
function resolveFromState(key: CredentialKey, ctx: CredentialContext, state: State) {
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
export function credentialStatus(ctx: CredentialContext) {
  const state = readState(ctx)
  const status = (key: CredentialKey) => {
    const { value, ...rest } = resolveFromState(key, ctx, state)
    return { ...rest, configured: !!value, masked: !value ? '' : value.length <= 8 ? '********' : `${value.slice(0, 3)}********${value.slice(-3)}` }
  }
  return Object.fromEntries(Array.from(registeredCredentials.keys(), key => [key, status(key)])) as Record<CredentialKey, ReturnType<typeof status>>
}
export function updateCredential(key: CredentialKey, value: string | null, ctx: CredentialContext): void {
  updateCredentials({ [key]: value }, ctx)
}
/** One transaction keeps independent keys intact and rolls back a failed mixed update. */
export function updateCredentials(values: Partial<Record<CredentialKey, string | null>>, ctx: CredentialContext): void {
  if (!Object.keys(values).every(isCredentialKey)) throw new Error('不支持的凭据键')
  try {
    const db = ctx.db ?? useDb()
    db.transaction(tx => {
      const updatedAt = new Date().toISOString()
      for (const key of registeredCredentials.keys()) {
        const value = values[key]
        if (value === null) tx.delete(serviceCredential).where(eq(serviceCredential.key, key)).run()
        else if (value !== undefined) tx.insert(serviceCredential).values({ key, value, updatedAt }).onConflictDoUpdate({ target: serviceCredential.key, set: { value, updatedAt } }).run()
      }
    })
  } catch { throw storageError() }
}
