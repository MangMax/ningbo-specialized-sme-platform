import { APPLY_GRID, APPLY_LIST_PATH, BUSINESS_GRID, BUSINESS_LIST_PATH, RECOGNIZED_GRID, RECOGNIZED_LIST_PATH, PlatformSessionExpiredError, parsePlatformPage } from '../../lib/platform/adapter'
import { cookieRedactor, PlatformHttpError, postPlatformRequest, type PlatformQueryOptions } from '../../lib/platform/client'
import { platformQueryInputSchema, platformQueryTitles, recognizedConditionShape, type PlatformLiveQueryResult, type PlatformQueryPage, type PlatformQueryError } from '../../lib/platform/live-query'
import { resolvePlatformCookie, type CredentialContext } from './credential-state'
import { newLogContext, type LogContext } from '../../lib/logging'
import { logPlatformResult, platformOperation, platformQueryOperation } from '../../lib/platform/logging'

export interface PlatformLiveQueryContext {
  logContext?: LogContext
  onProgress?: (result: PlatformLiveQueryResult) => void
  maxResultBytes?: number
  credentials?: CredentialContext
  /** In-memory snapshot for batch consumers; never put this context in persistent job params. */
  cookie?: string
  /** Previously observed per-title totals constrain explicit batch continuations. */
  declaredTotals?: ReadonlyMap<string | null, number>
  /** Actual accepted rows covering every page before startPage, by title. */
  priorFetchedCounts?: ReadonlyMap<string | null, number>
  transport?: Pick<PlatformQueryOptions, 'fetchImpl' | 'baseUrl' | 'timeoutMs'>
}
const error = (code: PlatformQueryError['code'], message: string): PlatformQueryError => ({ code, message })
const sensitiveKey = /cookie|token|session|password|authorization|account|username/i
function hasSensitiveKey(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.entries(value).some(([key, item]) => sensitiveKey.test(key) || hasSensitiveKey(item))
}
/** Raw HTML is never executed. Only one JSON data island or an empty legacy
 * data wrapper can be verified; any other script makes the whole page inadmissible. */
function originalHtmlData(raw: string): { envelope: unknown; markup: string } | null {
  const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  const script = scripts.exec(raw)
  if (!script) return /<script\b/i.test(raw) ? null : { envelope: null, markup: raw }
  if (scripts.exec(raw)) return null
  const attributes = script[1]?.trim()
  const content = script[2]
  if (attributes === undefined || content === undefined) return null
  const literal = /^type\s*=\s*(["'])application\/json\1$/i.test(attributes)
    ? content
    : attributes === '' ? /^\s*\(\s*function\s*\(\s*data\s*\)\s*\{\s*\}\s*\)\s*\(([\s\S]*)\)\s*;?\s*$/.exec(content)?.[1] : undefined
  if (literal === undefined) return null
  const markup = raw.slice(0, script.index) + raw.slice(script.index + script[0].length)
  if (/<script\b/i.test(markup)) return null
  try { return { envelope: JSON.parse(literal), markup } } catch { return null }
}
const inertTags = new Set(['html', 'head', 'title', 'body', 'div', 'span', 'p', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td'])
/** Admission only, never sanitization: unknown HTML, controls, attributes or
 * encoded non-data text are refused with the original page left unpublished. */
function verifiableMarkup(markup: string): boolean {
  const text = markup.replace(/<!doctype html>/gi, '')
  if (/[\\&%]/.test(text) || sensitiveKey.test(text)) return false
  let valid = true
  const remaining = text.replace(/<(\/?)([a-z][a-z0-9]*)([^<>]*)>/gi, (_tag, closing: string, name: string, attributes: string) => {
    if (!inertTags.has(name.toLowerCase()) || (closing && attributes.trim())) valid = false
    let rest = attributes.trim().replace(/\/$/, '').trim()
    // At most the four known inert attributes; no arbitrary HTML grammar walk.
    for (let count = 0; rest && count < 4; count++) {
      const attr = /^([a-z][a-z0-9]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([a-z0-9_-]+))/i.exec(rest)
      if (!attr) { valid = false; break }
      const key = attr[1]?.toLowerCase()
      if (key === undefined) { valid = false; break }
      const value = attr[2] ?? attr[3] ?? attr[4] ?? ''
      if (!['id', 'class'].includes(key)
        && !(key === 'name' && name.toLowerCase() === 'table' && ['applyGrid', 'businessListGrid', 'businessGrid'].includes(value))
        && !(['currentpage', 'numperpage'].includes(key) && name.toLowerCase() === 'div' && /^\d+$/.test(value))) valid = false
      rest = rest.slice(attr[0].length)
      if (rest && !/^\s/.test(rest)) valid = false
      rest = rest.trimStart()
    }
    if (rest) valid = false
    return ''
  })
  return valid && !/[<>]/.test(remaining)
}
export async function runPlatformLiveQuery(input: unknown, ctx: PlatformLiveQueryContext = {}): Promise<PlatformLiveQueryResult> {
  const parsed = platformQueryInputSchema.safeParse(input)
  // Fixed error text: never echo unknown input, upstream body or credential storage errors.
  if (!parsed.success) throw Object.assign(new Error('Invalid platform query parameters'), { statusCode: 400, code: 'invalid_input' })
  const q = parsed.data
  if (!q.name && !q.uscc) throw Object.assign(new Error('Provide name or uscc'), { statusCode: 400, code: 'invalid_input' })
  const titles = platformQueryTitles(q)
  const totals = new Map<string | null, number | null>(titles.filter(title => ctx.declaredTotals?.has(title)).map(title => [title, ctx.declaredTotals!.get(title)!]))
  const declaredTotal = () => titles.every(t => totals.has(t) && totals.get(t) !== null) ? [...totals.values()].reduce<number>((sum, n) => sum + n!, 0) : null
  const started = Date.now()
  const logContext = ctx.logContext ?? newLogContext()
  const result: PlatformLiveQueryResult = {
    source: q.source, status: 'not_queried', effectiveConditions: { ...(q.name ? { name: q.name } : {}), ...(q.uscc ? { uscc: q.uscc } : {}), combination: 'and', ...Object.fromEntries(Object.keys(recognizedConditionShape).filter(key => q[key as keyof typeof q] !== undefined).map(key => [key, q[key as keyof typeof q]])) },
    titleScope: q.source !== 'queryList' ? { mode: 'selected', rdjb: titles as string[] } : { mode: 'source_default', rdjb: [] }, queriedAt: new Date(started).toISOString(), completedAt: '', rows: [], pages: [], fetchedCount: 0, declaredTotal: declaredTotal(),
    ...(q.rawDataVersion === 1 ? { rawData: { version: 1 as const, rows: [], pages: [] } } : {}),
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
    for (const key of ['name', 'uscc', ...Object.keys(recognizedConditionShape)] as (keyof typeof result.effectiveConditions)[]) {
      if (result.effectiveConditions[key]) (result.effectiveConditions as Record<string, string>)[key] = redactString(result.effectiveConditions[key]!)
    }
    logPlatformResult(platformQueryOperation(q.source, titles), result.status, { ...logContext, page: q.startPage },
      { done: result.pages.filter(page => page.status === 'success').length, total: result.pages.length, failed: result.pages.filter(page => page.status !== 'success').length }, Date.now() - started, result.error?.code)
    return result
  }
  const recordPage = (page: PlatformQueryPage, pageStarted: number) => {
    result.pages.push(page)
    // Only the admission point emits page outcomes; checkpoint persistence and
    // retries of other pages cannot repeat an accepted page's completion.
    logPlatformResult(platformOperation(q.source, 'page', page.rdjb), page.status, { ...logContext, page: page.page }, { done: page.fetchedCount }, Date.now() - pageStarted, page.error?.code)
  }
  const position = (page: number, rdjb: string | null) => ({ source: q.source, rdjb, page })
  const remaining = (index: number, page: number) => [position(page, titles[index]!), ...titles.slice(index + 1).map(title => position(q.startPage, title))]
  if (!cookie) {
    result.error = error('credential_unavailable', '平台凭据不可用，未查询。')
    result.unfinished = titles.map(title => position(q.startPage, title))
    return finish()
  }
  outer: for (const [index, title] of titles.entries()) {
    let fetchedForTitle = 0
    const priorFetched = q.startPage === 1 ? 0 : ctx.priorFetchedCounts?.get(title) ?? null
    let maxPageForTitle: number | null = null
    for (let page = q.startPage; ; page++) {
      const pos = position(page, title)
      if (result.pages.length >= q.maxRequests || result.rows.length >= q.maxRows || Date.now() - started >= q.maxDurationMs) {
        result.status = 'partial'; result.completeness = 'partial'; result.error = error('safety_limit', '查询达到安全上限，仍有未完成页。'); result.unfinished.push(...remaining(index, page)); break outer
      }
      const pageStarted = Date.now()
      try {
        const raw = await postPlatformRequest({ ...ctx.transport, logContext, uscc: q.uscc ?? '', cookie, retries: 0, deadlineMs: started + q.maxDurationMs, timeoutMs: Math.min(ctx.transport?.timeoutMs ?? 15000, q.maxDurationMs - (Date.now() - started)) }, q.source === 'businessList' ? BUSINESS_LIST_PATH : q.source === 'queryBusList' ? RECOGNIZED_LIST_PATH : APPLY_LIST_PATH, {
          ...(q.source === 'queryBusList' ? { rdjb: title!, sqsj: q.sqsj ?? '', rddqrq: q.rddqrq ?? '', whpcyear: q.whpcyear ?? '', whpc: q.whpc ?? '', szq: q.szq ?? '', orderField: q.orderField ?? '', orderDirection: q.orderDirection ?? '', ...(q.orderField ? { target: 'businessGrid' } : {}) } : {}),
          ...(q.source === 'businessList' ? { rdjb: title! } : { qymc: q.name ?? '' }), tyshxydm: q.uscc ?? '', pageNum: String(page), numPerPage: String(Math.min(q.pageSize, q.maxRows)),
        })
        const parsedPage = parsePlatformPage(raw, q.source === 'businessList' ? BUSINESS_GRID : q.source === 'queryBusList' ? RECOGNIZED_GRID : APPLY_GRID)
        const serialized = JSON.stringify(parsedPage.rows)
        let sourceEnvelope: unknown = null
        let unverifiableHtml = false
        if (q.rawDataVersion === 1) {
          if (parsedPage.source === 'json') sourceEnvelope = JSON.parse(raw)
          else {
            const html = originalHtmlData(raw)
            unverifiableHtml = html === null || !verifiableMarkup(html.markup)
            sourceEnvelope = html?.envelope ?? null
          }
        }
        const sensitiveLegacyRows = JSON.stringify(sanitize(parsedPage.rows)) !== serialized || parsedPage.rows.some(row => Object.keys(row).some(key => sensitiveKey.test(key)))
        const sensitiveOriginal = q.rawDataVersion === 1 && (unverifiableHtml || redactString(raw) !== raw
          || /["'][^"']*(?:cookie|token|session|password|authorization|account|username)[^"']*["']\s*:/i.test(raw)
          || hasSensitiveKey(sourceEnvelope) || hasSensitiveKey(parsedPage.rawRows)
          || JSON.stringify(sanitize(sourceEnvelope)) !== JSON.stringify(sourceEnvelope)
          || JSON.stringify(sanitize(parsedPage.rawRows)) !== JSON.stringify(parsedPage.rawRows))
        if (sensitiveLegacyRows || sensitiveOriginal) {
          throw error('sensitive_response', '平台响应含敏感资料或无法核实整页原文，已阻止返回。')
        }
        if ((parsedPage.responsePage !== null && parsedPage.responsePage !== page) || (parsedPage.declaredTotal !== null && parsedPage.rows.length > parsedPage.declaredTotal)) throw error('invalid_response', '平台分页信息不一致。')
        if (parsedPage.responsePageSize !== null && parsedPage.responsePageSize !== result.limits.pageSize) throw error('invalid_response', '平台分页大小与请求不一致。')
        const total = parsedPage.declaredTotal ?? totals.get(title) ?? null
        if (totals.get(title) != null && parsedPage.declaredTotal !== null && totals.get(title) !== parsedPage.declaredTotal) throw error('invalid_response', '平台声明总数在查询中发生变化。')
        if (q.source === 'queryBusList') {
          const size = result.limits.pageSize
          const maxPage = parsedPage.responseMaxPage
          // nextPage is demonstrably unreliable even on intermediate pages. Validate
          // actual page/count/maxPage and advance by one within the operation bounds.
          if (parsedPage.responsePage !== page || parsedPage.responsePageSize !== size
            || parsedPage.rows.length > size
            || (maxPage !== null && (!Number.isSafeInteger(maxPage) || maxPage < 1 || page > maxPage))
            || (maxPageForTitle !== null && maxPage !== maxPageForTitle)
            || (total !== null && maxPage !== null && maxPage !== Math.max(1, Math.ceil(total / size)))
            || (total !== null && (page > Math.max(1, Math.ceil(total / size)) || parsedPage.rows.length !== Math.min(size, Math.max(0, total - (page - 1) * size))))
            || (maxPage !== null && page < maxPage && parsedPage.rows.length !== size)) {
            throw error('invalid_response', '平台分页信息不一致。')
          }
          maxPageForTitle = maxPage
        }
        const rawPage = { ...pos, format: parsedPage.source, body: raw }
        const rawData = result.rawData ? { version: 1 as const, rows: [...result.rawData.rows, ...parsedPage.rawRows], pages: [...result.rawData.pages, rawPage] } : undefined
        if (result.rows.length + parsedPage.rows.length > q.maxRows || Buffer.byteLength(JSON.stringify({ ...result, rows: [...result.rows, ...parsedPage.rows], ...(rawData ? { rawData } : {}) }), 'utf8') + 2048 > (ctx.maxResultBytes ?? (rawData ? 8388608 : Infinity))) {
          result.status = 'partial'; result.completeness = 'partial'
          result.error = error('safety_limit', '记录数量达到安全上限，此页未纳入结果。')
          recordPage({ ...pos, status: 'failed', fetchedCount: 0, declaredTotal: parsedPage.declaredTotal, error: result.error }, pageStarted)
          result.unfinished.push(...remaining(index, page)); break outer
        }
        // A standalone continuation can use a returned, verified page partition.
        // Requested size alone cannot establish rows accepted before this attempt.
        const priorCoverage = priorFetched ?? (parsedPage.responsePage === page && parsedPage.responsePageSize === result.limits.pageSize ? (q.startPage - 1) * result.limits.pageSize : null)
        if (!parsedPage.rows.length && total !== null && total > 0 && (priorCoverage === null || priorCoverage + fetchedForTitle < total)) throw error('invalid_response', '平台返回空页但无法确认已取全声明记录。')
        recordPage({ ...pos, ...(q.source === 'queryBusList' ? { maxPage: parsedPage.responseMaxPage } : {}), status: 'success', fetchedCount: parsedPage.rows.length, declaredTotal: parsedPage.declaredTotal, error: null }, pageStarted)
        totals.set(title, total)
        result.declaredTotal = declaredTotal()
        result.rows.push(...parsedPage.rows)
        if (rawData) result.rawData = rawData
        fetchedForTitle += parsedPage.rows.length
        const consumed = priorCoverage === null ? null : priorCoverage + fetchedForTitle
        const titleComplete = total !== null ? total === 0 || (consumed !== null && consumed >= total) : (q.source === 'queryBusList' && maxPageForTitle !== null ? page === maxPageForTitle : parsedPage.rows.length === 0)
        if (ctx.onProgress) {
          const unfinished = [...result.unfinished, ...(titleComplete ? titles.slice(index + 1).map(t => position(q.startPage, t)) : remaining(index, page + 1))]
          const snapshot = structuredClone({ ...result, fetchedCount: result.rows.length, completedAt: new Date().toISOString(), unfinished, status: unfinished.length ? 'partial' : result.rows.length ? 'success' : 'no_record', completeness: unfinished.length ? 'partial' : 'complete' } as PlatformLiveQueryResult)
          // Checkpoint echoes use the same redaction as final responses.
          for (const key of ['name', 'uscc', ...Object.keys(recognizedConditionShape)]) {
            const conditions = snapshot.effectiveConditions as Record<string, string>
            if (conditions[key]) conditions[key] = redactString(conditions[key]!)
          }
          ctx.onProgress(snapshot)
        }
        if (titleComplete) {
          result.status = result.rows.length ? 'success' : 'no_record'; result.completeness = 'complete'; break
        }
        if (!parsedPage.rows.length) throw error('invalid_response', '平台返回空页但声明仍有记录。')
      } catch (caught) {
        const e = caught as { code?: string; message?: string; name?: string }
        const failure = caught instanceof PlatformSessionExpiredError || (caught instanceof PlatformHttpError && [401, 403].includes(caught.status)) ? error('auth_failed', '平台会话失效，请更新服务端凭据。')
          : e.code === 'sensitive_response' || e.code === 'invalid_response' ? e as PlatformQueryError
          : error(caught instanceof PlatformHttpError && caught.status === 429 ? 'rate_limited' : /timeout|abort/i.test(`${e.name ?? ''} ${e.message ?? ''}`) ? 'timeout' : 'upstream_failed', '平台请求失败，未完成查询。')
        recordPage({ ...pos, status: failure.code === 'auth_failed' ? 'auth_failed' : 'failed', fetchedCount: 0, declaredTotal: null, error: failure }, pageStarted)
        result.status = result.pages.some(p => p.status === 'success') ? 'partial' : failure.code === 'auth_failed' ? 'auth_failed' : 'failed'
        result.completeness = 'partial'; result.error ??= failure
        if (q.source === 'businessList' && failure.code !== 'auth_failed') {
          result.unfinished.push(pos); break
        }
        result.unfinished.push(...remaining(index, page)); break outer
      }
    }
  }
  if (q.source === 'businessList' && result.unfinished.length) {
    result.completeness = 'partial'
    result.status = result.pages.some(p => p.status === 'success') ? 'partial' : result.pages.some(p => p.status === 'auth_failed') ? 'auth_failed' : result.error?.code === 'safety_limit' ? 'partial' : 'failed'
  }
  return finish()
}
