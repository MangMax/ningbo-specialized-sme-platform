import { APPLY_GRID, APPLY_LIST_PATH, PlatformSessionExpiredError, parsePlatformPage } from '../../lib/platform/adapter'
import { cookieRedactor, PlatformHttpError, postPlatformRequest, type PlatformQueryOptions } from '../../lib/platform/client'
import { platformQueryInputSchema, type PlatformLiveQueryResult, type PlatformQueryError } from '../../lib/platform/live-query'
import { resolvePlatformCookie, type CredentialContext } from './credential-state'

export interface PlatformLiveQueryContext {
  credentials?: CredentialContext
  /** In-memory snapshot for batch consumers; never put this context in persistent job params. */
  cookie?: string
  transport?: Pick<PlatformQueryOptions, 'fetchImpl' | 'baseUrl' | 'timeoutMs'>
}
const error = (code: PlatformQueryError['code'], message: string): PlatformQueryError => ({ code, message })
export async function runPlatformLiveQuery(input: unknown, ctx: PlatformLiveQueryContext = {}): Promise<PlatformLiveQueryResult> {
  const parsed = platformQueryInputSchema.safeParse(input)
  // Fixed error text: never echo unknown input, upstream body or credential storage errors.
  if (!parsed.success) throw Object.assign(new Error('Invalid platform query parameters'), { statusCode: 400, code: 'invalid_input' })
  const q = parsed.data
  if (q.source !== 'queryList') throw Object.assign(new Error('Platform source is not available'), { statusCode: 400, code: 'unsupported_source' })
  if (!q.name && !q.uscc) throw Object.assign(new Error('Provide name or uscc'), { statusCode: 400, code: 'invalid_input' })
  const started = Date.now()
  const result: PlatformLiveQueryResult = {
    source: q.source, status: 'not_queried', effectiveConditions: { ...(q.name ? { name: q.name } : {}), ...(q.uscc ? { uscc: q.uscc } : {}), combination: 'and' },
    titleScope: { mode: 'source_default', rdjb: [] }, queriedAt: new Date(started).toISOString(), completedAt: '', rows: [], pages: [], fetchedCount: 0, declaredTotal: null,
    completeness: 'not_queried', fullRange: q.startPage === 1, unfinished: [], error: null,
    limits: { maxRequests: q.maxRequests, maxRows: q.maxRows, maxDurationMs: q.maxDurationMs, pageSize: Math.min(q.pageSize, q.maxRows) },
  }
  let cookie = ''
  try { cookie = ctx.cookie ?? resolvePlatformCookie(undefined, ctx.credentials) } catch { /* fixed failure below */ }
  const redact = cookieRedactor(cookie)
  const redactString = (value: string): string => {
    try {
      const decoded = decodeURIComponent(value)
      if (redact(decoded) !== decoded) return '[REDACTED]'
    } catch { /* Business strings need not be valid URI components. */ }
    return redact(value)
  }
  const sanitize = (value: unknown): unknown => {
    if (typeof value === 'string') return redactString(value)
    if (Array.isArray(value)) return value.map(sanitize)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactString(key), sanitize(item)]))
    return value
  }
  const finish = () => {
    result.fetchedCount = result.rows.length
    result.completedAt = new Date().toISOString()
    // Only untrusted condition echoes need scrubbing here. Rows were checked before
    // admission; fixed enums/timestamps must survive coincidental short secret matches.
    if (result.effectiveConditions.name) result.effectiveConditions.name = redactString(result.effectiveConditions.name)
    if (result.effectiveConditions.uscc) result.effectiveConditions.uscc = redactString(result.effectiveConditions.uscc)
    return result
  }
  const position = (page: number) => ({ source: q.source, rdjb: null, page })
  if (!cookie) {
    result.error = error('credential_unavailable', '平台凭据不可用，未查询。')
    result.unfinished = [position(q.startPage)]
    return finish()
  }
  for (let page = q.startPage; ; page++) {
    const pos = position(page)
    if (result.pages.length >= q.maxRequests || result.rows.length >= q.maxRows || Date.now() - started >= q.maxDurationMs) {
      result.status = 'partial'; result.completeness = 'partial'; result.error = error('safety_limit', '查询达到安全上限，仍有未完成页。'); result.unfinished = [pos]; break
    }
    try {
      const raw = await postPlatformRequest({ ...ctx.transport, uscc: q.uscc ?? '', cookie, retries: 0, deadlineMs: started + q.maxDurationMs, timeoutMs: Math.min(ctx.transport?.timeoutMs ?? 15000, q.maxDurationMs - (Date.now() - started)) }, APPLY_LIST_PATH, {
        qymc: q.name ?? '', tyshxydm: q.uscc ?? '', pageNum: String(page), numPerPage: String(Math.min(q.pageSize, q.maxRows)),
      })
      const parsedPage = parsePlatformPage(raw, APPLY_GRID)
      const serialized = JSON.stringify(parsedPage.rows)
      if (JSON.stringify(sanitize(parsedPage.rows)) !== serialized || parsedPage.rows.some(row => Object.keys(row).some(key => /cookie|token|session|password|authorization|account|username/i.test(key)))) {
        throw error('sensitive_response', '平台响应含敏感资料，已阻止返回。')
      }
      if ((parsedPage.responsePage !== null && parsedPage.responsePage !== page) || (parsedPage.declaredTotal !== null && parsedPage.rows.length > parsedPage.declaredTotal)) throw error('invalid_response', '平台分页信息不一致。')
      if (result.rows.length + parsedPage.rows.length > q.maxRows) {
        result.status = 'partial'; result.completeness = 'partial'
        result.error = error('safety_limit', '记录数量达到安全上限，此页未纳入结果。')
        result.pages.push({ ...pos, status: 'failed', fetchedCount: 0, declaredTotal: parsedPage.declaredTotal, error: result.error })
        result.unfinished = [pos]; break
      }
      if (!parsedPage.rows.length && parsedPage.declaredTotal !== null && (page - 1) * Math.min(q.pageSize, q.maxRows) < parsedPage.declaredTotal) throw error('invalid_response', '平台返回空页但声明仍有记录。')
      if (result.declaredTotal !== null && parsedPage.declaredTotal !== null && result.declaredTotal !== parsedPage.declaredTotal) throw error('invalid_response', '平台声明总数在查询中发生变化。')
      result.pages.push({ ...pos, status: 'success', fetchedCount: parsedPage.rows.length, declaredTotal: parsedPage.declaredTotal, error: null })
      result.declaredTotal = parsedPage.declaredTotal
      result.rows.push(...parsedPage.rows)
      const consumed = (q.startPage - 1) * Math.min(q.pageSize, q.maxRows) + result.rows.length
      if (parsedPage.declaredTotal !== null ? consumed >= parsedPage.declaredTotal : parsedPage.rows.length === 0) {
        result.status = result.rows.length ? 'success' : 'no_record'; result.completeness = 'complete'; break
      }
      if (!parsedPage.rows.length) throw error('invalid_response', '平台返回空页但声明仍有记录。')
    } catch (caught) {
      const e = caught as { code?: string; message?: string; name?: string }
      const failure = caught instanceof PlatformSessionExpiredError || (caught instanceof PlatformHttpError && [401, 403].includes(caught.status)) ? error('auth_failed', '平台会话失效，请更新服务端凭据。')
        : e.code === 'sensitive_response' || e.code === 'invalid_response' ? e as PlatformQueryError
        : error(caught instanceof PlatformHttpError && caught.status === 429 ? 'rate_limited' : /timeout|abort/i.test(`${e.name ?? ''} ${e.message ?? ''}`) ? 'timeout' : 'upstream_failed', '平台请求失败，未完成查询。')
      result.pages.push({ ...pos, status: failure.code === 'auth_failed' ? 'auth_failed' : 'failed', fetchedCount: 0, declaredTotal: null, error: failure })
      result.status = result.pages.some(p => p.status === 'success') ? 'partial' : failure.code === 'auth_failed' ? 'auth_failed' : 'failed'
      result.completeness = 'partial'; result.error = failure; result.unfinished = [pos]; break
    }
  }
  return finish()
}
