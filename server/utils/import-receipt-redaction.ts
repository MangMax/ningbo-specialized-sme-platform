import { validateReceiptRuntimeContext, type ReceiptRuntimeContext } from './receipt-runtime-context'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import { cookieRedactor } from '../../layers/sme-roster/lib/platform/client'
import { credentialContext, resolveCredential } from '../../layers/core/server/utils/credential-state'
import { sanitizeEvidence } from '../../layers/sme-roster/server/utils/record-correspondence-read'

type Db = BetterSQLite3Database<typeof schema>
const sensitive = /cookie|password|passwd|token|secret|credential|authorization|authentication|api.?key|session/i
/** Explicit trusted input for the internal name-only mode, never inferred from raw shape. */
export type OfficialPublishedNameInput = Readonly<{
  evidenceId: number; eventId: number; revision: number; availability: 'captured'
  nameRaw: string | null; sourceBindingKnown: boolean
}>
export type ReceiptRedactionMode = 'official_published_name'
export type ReceiptRedactor = ((value: unknown, mode?: ReceiptRedactionMode) => unknown) & {
  readonly knownRedactors: ReadonlyArray<(text: string) => string>
}
export type RedactionOptions = { additionalSecrets?: readonly (string | null | undefined)[] }
export function importReceiptRedactor(db: Db, options: RedactionOptions = {}, receiptRuntime?: ReceiptRuntimeContext): ReceiptRedactor {
  const runtime = receiptRuntime === undefined ? (typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : undefined) : validateReceiptRuntimeContext(receiptRuntime)
  const context = receiptRuntime === undefined ? { ...credentialContext(), db } : { db, ocrToken: runtime?.ocrToken }
  const secrets = [...(options.additionalSecrets ?? []), runtime?.apiToken, runtime?.mcpToken, process.env.NUXT_API_TOKEN, process.env.NUXT_MCP_TOKEN, resolveCredential('sme-roster.miitCookie', context).value, resolveCredential('core.ocrToken', context).value]
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
  function redactValue(value: unknown, mode?: ReceiptRedactionMode): unknown {
    if (mode === 'official_published_name') {
      // Only the presentation's explicit call opts in. The full input remains
      // visible to request callbacks; generic dictionaries get no shape exemption.
      const { nameRaw } = value as OfficialPublishedNameInput
      return nameRaw === null ? null : redact(nameRaw)
    }
    return redact(value)
  }
  // The legacy sanitizer and new DTO callback share these exact closures. Never
  // resolve credentials again when the caller retrieves the list.
  return Object.defineProperty(redactValue, 'knownRedactors', { value: redactors }) as ReceiptRedactor
}
