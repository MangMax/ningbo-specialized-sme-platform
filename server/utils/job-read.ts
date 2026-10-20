import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import { cookieRedactor } from '../../lib/platform/client'
import { credentialContext, resolveCredential } from './credential-state'
import { sanitizeEvidence } from './record-correspondence-read'
import { toJobDto, type JobDto, type JobRow } from './job-store'

const sensitiveKey = /cookie|password|passwd|token|secret|credential|authorization|authentication|api.?key|session/i
// Relative artifact references and HTTP URLs are public data; absolute host paths
// are not. The API's own root-relative links remain usable.
const hostPath = /\bfile:\/\/\/[^\s"'<>;,)}\]]+|(?<![\w/])\/(?!\/|api(?:\/|$))[^\s"'<>;,)}\]]+|\b[A-Za-z]:\\[^\s"'<>;,)}\]]+/g

/** One credential snapshot per full read, never per summary row. No persistence
 * changes: redact only the public copy, retaining complete non-sensitive data. */
export function jobReadProjector(db: BetterSQLite3Database<typeof schema>): (row: JobRow) => JobDto {
  const runtime = typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : undefined
  const context = { ...credentialContext(), db }
  const secrets = [runtime?.apiToken, runtime?.mcpToken, process.env.NUXT_API_TOKEN, process.env.NUXT_MCP_TOKEN,
    resolveCredential('miitCookie', context).value, resolveCredential('ocrToken', context).value]
  const redactors = [...new Set(secrets.filter((value): value is string => !!value))].map(cookieRedactor)
  const text = (value: string) => String(sanitizeEvidence(value, redactors))
    .replace(/\bBearer\s+[^\s";,]+/gi, 'Bearer [REDACTED]').replace(hostPath, '[REDACTED]')
  function redact(value: unknown): unknown {
    if (typeof value === 'string') return text(value)
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [text(key), sensitiveKey.test(key) ? '[REDACTED]' : redact(item)]))
    return value
  }
  return row => {
    const dto = toJobDto(row)
    return { ...dto, params: redact(dto.params) as JobDto['params'], result: redact(dto.result),
      error: dto.error === null ? null : text(dto.error) }
  }
}
