import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** Narrow shared boundary for subsequent credential kinds; never uses the business DB. */
export type CredentialKey = 'ocrToken'
export interface CredentialValue { value: string; updatedAt: string }
interface State { version: 1; values: Partial<Record<CredentialKey, CredentialValue>> }
export interface CredentialContext {
  stateDir?: string
  ocrToken?: string
  env?: Record<string, string | undefined>
}
export function credentialContext(): CredentialContext {
  const config: { credentialsStateDir?: string; ocrToken?: string } = typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : {}
  return { stateDir: config.credentialsStateDir || process.env.NUXT_CREDENTIALS_STATE_DIR, ocrToken: config.ocrToken }
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !rel || (!rel.startsWith('..') && !isAbsolute(rel))
}
function stateFile(ctx: CredentialContext, create = false): string | null {
  if (!ctx.stateDir) return null
  if (!isAbsolute(ctx.stateDir) || inside(resolve(process.cwd()), resolve(ctx.stateDir))) throw new Error('配置目录必须位于仓库外')
  if (create) mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 })
  // Resolve symlinks too. Missing directory is an unconfigured state, never an alternate path.
  let real: string
  try { real = realpathSync(ctx.stateDir) } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (inside(realpathSync(process.cwd()), real)) throw new Error('配置目录必须位于仓库外')
  return join(real, 'credentials.json')
}
function readStateUnsafe(ctx: CredentialContext): State {
  const file = stateFile(ctx)
  if (!file) return { version: 1, values: {} }
  let text: string
  try { text = readFileSync(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, values: {} }
    throw error
  }
  const state = JSON.parse(text) as State
  if (state.version !== 1 || !state.values || typeof state.values !== 'object' || Array.isArray(state.values)) throw new Error('配置文件无效')
  for (const entry of Object.values(state.values)) {
    if (!entry || typeof entry.value !== 'string' || !entry.value.trim() || typeof entry.updatedAt !== 'string') throw new Error('配置文件无效')
  }
  return state
}
function readState(ctx: CredentialContext): State {
  try { return readStateUnsafe(ctx) } catch { throw new Error('凭据配置存储不可用，请检查外置目录与权限。') }
}
export function resolveCredential(key: CredentialKey, ctx: CredentialContext = credentialContext(), override?: string) {
  if (override?.trim()) return { value: override.trim(), source: 'override', updatedAt: null, hasSaved: false }
  const saved = readState(ctx).values[key]
  if (saved) return { ...saved, source: 'saved', hasSaved: true }
  const env = ctx.env ?? process.env
  if (ctx.ocrToken?.trim() || env.NUXT_OCR_TOKEN?.trim()) return { value: (ctx.ocrToken?.trim() || env.NUXT_OCR_TOKEN!.trim()), source: 'NUXT_OCR_TOKEN', updatedAt: null, hasSaved: false }
  if (env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN?.trim()) return { value: env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN.trim(), source: 'PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN', updatedAt: null, hasSaved: false }
  return { value: '', source: 'none', updatedAt: null, hasSaved: false }
}
export function credentialStatus(ctx: CredentialContext) {
  const { value, ...rest } = resolveCredential('ocrToken', ctx)
  return { ocrToken: { ...rest, configured: !!value, masked: !value ? '' : value.length <= 8 ? '********' : `${value.slice(0, 3)}********${value.slice(-3)}` } }
}
/** Synchronous read/modify/atomic-rename serializes independent HTTP updates in this process.
 * Deploy one writer process per state directory. Failed pre-rename writes leave the old file intact. */
export function updateCredential(key: CredentialKey, value: string | null, ctx: CredentialContext): void {
  const state = readState(ctx)
  if (value === null) delete state.values[key]
  else state.values[key] = { value, updatedAt: new Date().toISOString() }
  const file = stateFile(ctx, true)
  if (!file) throw new Error('未配置外置持久目录')
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, file)
  } finally {
    try { unlinkSync(temporary) } catch { /* renamed or failed before creation */ }
  }
}
