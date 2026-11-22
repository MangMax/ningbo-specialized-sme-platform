import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { readPostgresCredentialState } from '../../../core/server/utils/credential-state-postgres'
import { resolveFromState } from '../../../core/server/utils/credential-resolution'
import { cookieRedactor } from '../../lib/platform/client'
import { sanitizeEvidence } from './evidence-redaction'
import type { ReceiptRuntimeContext } from './receipt-runtime-context'

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
export async function importPostgresReceiptRedactor(db: NodePgDatabase, options: RedactionOptions = {}, receiptRuntime?: ReceiptRuntimeContext) {
  const runtime = receiptRuntime ?? (typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : undefined)
  const saved = await readPostgresCredentialState(db)
  const context = { ocrToken: runtime?.ocrToken }
  return receiptRedactor([
    ...(options.additionalSecrets ?? []), runtime?.apiToken, runtime?.mcpToken, process.env.NUXT_API_TOKEN, process.env.NUXT_MCP_TOKEN,
    resolveFromState('sme-roster.miitCookie', context, saved).value, resolveFromState('core.ocrToken', context, saved).value,
  ])
}

export function receiptRedactor(secrets: readonly (string | null | undefined)[]): ReceiptRedactor {
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
