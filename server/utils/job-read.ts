import type { useApplicationDb } from '../../db/client'
import { cookieRedactor } from '../../lib/platform/client'
import { credentialContext, resolveCredential } from '../../layers/core/server/utils/credential-state'
import { sanitizeEvidence } from './record-correspondence-read'
import type { JobDto, JobRow } from '../../layers/core/server/utils/job-store'
import { currentJobDto } from '../../layers/sme-roster/server/utils/current-export-artifact'

const sensitiveKey = /cookie|password|passwd|token|secret|credential|authorization|authentication|api.?key|session/i
// Relative artifact references and HTTP URLs are public data; absolute host paths
// are not. Match whole HTTP URLs first so query/path punctuation cannot turn
// a URL segment into an apparent host path. The API's own root-relative links remain usable.
const hostPath = /https?:\/\/[^\s"'<>;,)}\]]+|\bfile:\/\/\/[^\s"'<>;,)}\]]+|(?<=^|[\s"'<>;,)}\]=:(\[{])\/(?!\/|api(?:\/|$))[^\s"'<>;,)}\]]+|\b[A-Za-z]:\\[^\s"'<>;,)}\]]+/giu

/** One credential snapshot per full read, never per summary row. No persistence
 * changes to stored receipts: refresh artifact availability through its authority,
 * then redact only the public copy, retaining complete non-sensitive data. */
export function jobReadProjector(db: ReturnType<typeof useApplicationDb>): (row: JobRow) => Promise<JobDto> {
  const runtime = typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : undefined
  const context = { ...credentialContext(), db }
  const secrets = [runtime?.apiToken, runtime?.mcpToken, process.env.NUXT_API_TOKEN, process.env.NUXT_MCP_TOKEN,
    resolveCredential('sme-roster.miitCookie', context).value, resolveCredential('core.ocrToken', context).value]
  const redactors = [...new Set(secrets.filter((value): value is string => !!value))].map(cookieRedactor)
  const text = (value: string) => String(sanitizeEvidence(value, redactors))
    .replace(/\bBearer\s+[^\s";,]+/gi, 'Bearer [REDACTED]').replace(hostPath, reference => /^https?:\/\//i.test(reference) ? reference : '[REDACTED]')
  function redact(value: unknown): unknown {
    if (typeof value === 'string') return text(value)
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [text(key), sensitiveKey.test(key) ? '[REDACTED]' : redact(item)]))
    return value
  }
  return async row => {
    const dto = await currentJobDto(row, db.$client.name)
    return { ...dto, params: redact(dto.params) as JobDto['params'], result: redact(dto.result),
      error: dto.error === null ? null : text(dto.error) }
  }
}
