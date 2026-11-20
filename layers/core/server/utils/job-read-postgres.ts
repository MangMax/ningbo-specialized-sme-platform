import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { registeredCredentials } from '../../../../lib/app-modules'
import { postgresJobHandler } from './job-runner-postgres'
import type { JobDto } from './job-store'
import { readPostgresCredentialState } from './credential-state-postgres'

const sensitiveKey = /cookie|password|passwd|token|secret|credential|authorization|authentication|api.?key|session|raw.?response/i
const credential = String.raw`(?:cookie|password|passwd|(?:access|refresh|id)[-_]?token|token|secret|credential|authorization|authentication|api[-_]?key|session(?:id)?)`
const assignment = new RegExp(String.raw`(["']?\b${credential}\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;,&}\]]+)`, 'gi')
const hostPath = /https?:\/\/[^\s"'<>;,)}\]]+|\b(?:file|postgres(?:ql)?):\/\/[^\s"'<>;,)}\]]+|(?<=^|[\s"'<>;,)}\]=:(\[{])\/(?!\/|api(?:\/|$))[^\s"'<>;,)}\]]+|\b[A-Za-z]:\\[^\s"'<>;,)}\]]+/giu
const mask = '[REDACTED]'

/** Project public copies only. Historical bytes and private claim data stay in storage. */
export async function postgresJobReadProjector(db: NodePgDatabase, config: { apiToken?: string; mcpToken?: string; ocrToken?: string }) {
  const saved = await readPostgresCredentialState(db)
  const secrets = [
    config.apiToken, config.mcpToken, config.ocrToken, process.env.NUXT_API_TOKEN, process.env.NUXT_MCP_TOKEN,
    ...Object.values(saved).map(entry => entry?.value),
    ...Array.from(registeredCredentials.values()).flatMap(credential => (credential.environment ?? []).map(key => process.env[key])),
  ].filter((value): value is string => !!value)
  const forms = [...new Set(secrets.flatMap(value => [value, ...value.split(';').flatMap(part => {
    const equals = part.indexOf('=')
    const component = equals < 0 ? '' : part.slice(equals + 1).trim()
    return component.length >= 8 ? [component] : []
  })].flatMap(value => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)])))].sort((a, b) => b.length - a.length)

  function text(raw: string) {
    const scrub = (value: string) => value.replace(/\bBearer\s+[^\s";,]+/gi, 'Bearer [REDACTED]')
      .replace(assignment, (_match, prefix: string) => prefix + mask)
    let value = raw
    for (const form of forms) {
      if (form.length >= 8) value = value.replaceAll(form, mask)
      else {
        const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        value = value.replace(new RegExp(`(?<![a-zA-Z0-9_])${escaped}(?![a-zA-Z0-9_])`, 'g'), mask)
      }
    }
    const direct = scrub(value)
    // Treat encoded credentials as credentials while leaving innocent encoded text byte-for-byte.
    const decoded = value.replace(/(?:%[0-9a-f]{2})+/gi, match => {
      try { return decodeURIComponent(match) } catch { return match }
    }).replace(/\\(["\\])/g, '$1')
    const normalized = scrub(decoded)
    return (normalized === decoded ? direct : normalized).replace(hostPath, reference =>
      /^https?:\/\//i.test(reference) ? reference.replace(/^(https?:\/\/)[^/@]+@/i, '$1[REDACTED]@') : mask)
  }

  function redact(value: unknown): unknown {
    if (typeof value === 'string') return text(value)
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [text(key), sensitiveKey.test(key) ? mask : redact(item)]))
    return value
  }

  return async (job: JobDto, refreshResult = true): Promise<JobDto> => {
    const project = refreshResult ? postgresJobHandler(job.kind)?.projectResult : undefined
    const result = project ? await project(db, job) : job.result
    return { ...job, params: redact(job.params) as JobDto['params'], result: redact(result), error: job.error === null ? null : text(job.error) }
  }
}
