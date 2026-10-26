import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import { cookieRedactor } from '../../lib/platform/client'
import { credentialContext, resolveCredential } from './credential-state'
import { sanitizeEvidence } from './record-correspondence-read'

type Db = BetterSQLite3Database<typeof schema>
const sensitive = /cookie|password|passwd|token|secret|credential|authorization|authentication|api.?key|session/i
export type ReceiptRedactor = ((value: unknown) => unknown) & {
  readonly knownRedactors: ReadonlyArray<(text: string) => string>
}
export type RedactionOptions = { additionalSecrets?: readonly (string | null | undefined)[] }
export function importReceiptRedactor(db: Db, options: RedactionOptions = {}): ReceiptRedactor {
  const runtime = typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : undefined
  const context = { ...credentialContext(), db }
  const secrets = [...(options.additionalSecrets ?? []), runtime?.apiToken, runtime?.mcpToken, process.env.NUXT_API_TOKEN, process.env.NUXT_MCP_TOKEN, resolveCredential('miitCookie', context).value, resolveCredential('ocrToken', context).value]
  const redactors = Object.freeze([...new Set(secrets.filter((value): value is string => !!value))].map(cookieRedactor))
  function redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(sanitizeEvidence(key, redactors)), sensitive.test(key) ? '[REDACTED]' : redact(item)]))
    if (typeof value === 'string') {
      try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return JSON.stringify(redact(parsed)) } catch { /* ordinary text */ }
      return String(sanitizeEvidence(value, redactors)).replace(/\bBearer\s+[^\s";,]+/gi, 'Bearer [REDACTED]')
    }
    return value
  }
  // The legacy sanitizer and new DTO callback share these exact closures. Never
  // resolve credentials again when the caller retrieves the list.
  return Object.defineProperty(redact, 'knownRedactors', { value: redactors }) as ReceiptRedactor
}
