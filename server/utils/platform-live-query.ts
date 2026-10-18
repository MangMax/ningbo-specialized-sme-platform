import { APPLY_GRID, APPLY_LIST_PATH, BUSINESS_GRID, BUSINESS_LIST_PATH, PlatformSessionExpiredError, parsePlatformPage } from '../../lib/platform/adapter'
import { cookieRedactor, PlatformHttpError, postPlatformRequest, type PlatformQueryOptions } from '../../lib/platform/client'
import { platformQueryInputSchema, validPlatformQueryConditions, type PlatformLiveQueryResult, type PlatformQueryError } from '../../lib/platform/live-query'
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
  if (q.source === 'queryBusList') throw Object.assign(new Error('Platform source is not available'), { statusCode: 400, code: 'unsupported_source' })
  if (!validPlatformQueryConditions(q)) throw Object.assign(new Error('Invalid conditions for platform source'), { statusCode: 400, code: 'invalid_input' })
  const titles: (string | null)[] = q.source === 'businessList' ? q.rdjb === 'all' ? ['1', '2', '3'] : [q.rdjb!] : [null]
  let rdjb: string | null = titles[0]!
  const totals = new Map<string | null, number | null>()
  const started = Date.now()
  const result: PlatformLiveQueryResult = {
    source: q.source, status: 'not_queried', effectiveConditions: { ...(q.name ? { name: q.name } : {}), ...(q.uscc ? { uscc: q.uscc } : {}), combination: 'and' },
    titleScope: q.source === 'businessList' ? { mode: 'selected', rdjb: titles as string[] } : { mode: 'source_default', rdjb: [] }, queriedAt: new Date(started).toISOString(), completedAt: '', rows: [], pages: [], fetchedCount: 0, declaredTotal: null,
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
  const position = (page: number) => ({ source: q.source, rdjb, page })
  if (!cookie) {
    result.error = error('credential_unavailable', '平台凭据不可用，未查询。')
    result.unfinished = titles.map(title => ({ source: q.source, rdjb: title, page: q.startPage }))
    return finish()
  }
  let stop = false
  for (const title of titles) {
    rdjb = title
    const rowStart = result.rows.length
    let titleTotal: number | null = null
    if (stop) { result.unfinished.push(position(q.startPage)); continue }
    for (let page = q.startPage; ; page++) {
      const pos = position(page)
      if (result.pages.length >= q.maxRequests || result.rows.length >= q.maxRows || Date.now() - started >= q.maxDurationMs) {
        result.status = 'partial'; result.completeness = 'partial'; result.error = error('safety_limit', '查询达到安全上限，仍有未完成页。'); result.unfinished.push(pos); stop = true; break
      }
      try {
        const raw = await postPlatformRequest({ ...ctx.transport, uscc: q.uscc ?? '', cookie, retries: 0, deadlineMs: started + q.maxDurationMs, timeoutMs: Math.min(ctx.transport?.timeoutMs ?? 15000, q.maxDurationMs - (Date.now() - started)) }, q.source === 'businessList' ? BUSINESS_LIST_PATH : APPLY_LIST_PATH, {
          ...(q.source === 'businessList' ? { rdjb: rdjb! } : { qymc: q.name ?? '' }), tyshxydm: q.uscc ?? '', pageNum: String(page), numPerPage: String(Math.min(q.pageSize, q.maxRows)),
        })
        const parsedPage = parsePlatformPage(raw, q.source === 'businessList' ? BUSINESS_GRID : APPLY_GRID)
        const serialized = JSON.stringify(parsedPage.rows)
        if (JSON.stringify(sanitize(parsedPage.rows)) !== serialized || parsedPage.rows.some(row => Object.keys(row).some(key => /cookie|token|session|password|authorization|account|username/i.test(key)))) {
          throw error('sensitive_response', '平台响应含敏感资料，已阻止返回。')
        }
        if ((parsedPage.responsePage !== null && parsedPage.responsePage !== page) || (parsedPage.declaredTotal !== null && parsedPage.rows.length > parsedPage.declaredTotal)) throw error('invalid_response', '平台分页信息不一致。')
        if (result.rows.length + parsedPage.rows.length > q.maxRows) {
          result.status = 'partial'; result.completeness = 'partial'
          result.error = error('safety_limit', '记录数量达到安全上限，此页未纳入结果。')
          result.pages.push({ ...pos, status: 'failed', fetchedCount: 0, declaredTotal: parsedPage.declaredTotal, error: result.error })
          result.unfinished.push(pos); stop = true; break
        }
        if (!parsedPage.rows.length && parsedPage.declaredTotal !== null && (page - 1) * Math.min(q.pageSize, q.maxRows) < parsedPage.declaredTotal) throw error('invalid_response', '平台返回空页但声明仍有记录。')
        if (titleTotal !== null && parsedPage.declaredTotal !== null && titleTotal !== parsedPage.declaredTotal) throw error('invalid_response', '平台声明总数在查询中发生变化。')
        result.pages.push({ ...pos, status: 'success', fetchedCount: parsedPage.rows.length, declaredTotal: parsedPage.declaredTotal, error: null })
        titleTotal = parsedPage.declaredTotal
        totals.set(rdjb, titleTotal)
        result.declaredTotal = titleTotal
        result.rows.push(...parsedPage.rows)
        const consumed = (q.startPage - 1) * Math.min(q.pageSize, q.maxRows) + result.rows.length - rowStart
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
        result.completeness = 'partial'; result.error ??= failure; result.unfinished.push(pos); stop = failure.code === 'auth_failed'; break
      }
    }
  }
  if (q.source === 'businessList') {
    result.declaredTotal = totals.size === titles.length && [...totals.values()].every(n => n !== null) ? [...totals.values()].reduce<number>((sum, n) => sum + n!, 0) : null
    if (result.unfinished.length) {
      result.completeness = 'partial'
      result.status = result.pages.some(p => p.status === 'success') ? 'partial' : result.pages.some(p => p.status === 'auth_failed') ? 'auth_failed' : result.error?.code === 'safety_limit' ? 'partial' : 'failed'
    } else {
      result.status = result.rows.length ? 'success' : 'no_record'
      result.completeness = 'complete'
    }
  }
  return finish()
}
