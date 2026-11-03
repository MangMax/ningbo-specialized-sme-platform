/**
 * 平台两个接口的**薄客户端**(RL-03):可注入 `fetch`,离线可测。
 *
 * 与 {@link ./adapter} 的分工:`adapter.ts` 是纯解析(收一份原始响应 → 三态),
 * 本文件只负责「发请求 → 把原文交给 adapter 归类」。凭据由调用方注入,独立脚本可从环境读取;
 * 拿不到凭据时**不发请求**,四次查询一律记 `failed`(未查询 ≠ 无记录)。
 *
 * 生产上真实响应由父协调者在**已登录的桌面 Chrome 会话**里代取并落地为证据文件,
 * 由 `classifyPlatformResponse` 直接归类 —— 本客户端是同一口径下的取数路径,
 * 让适配层在没有真实凭证的环境里也能被完整测到。
 */
import {
  APPLY_GRID,
  APPLY_LIST_PATH,
  BUSINESS_GRID,
  BUSINESS_LIST_PATH,
  RECOGNIZED_LIST_PATH,
  PLATFORM_BASE,
  RDJB_VALUES,
  PlatformCredentialMissingError,
  PlatformResponseError,
  PlatformSessionExpiredError,
  assertSessionAlive,
  type PlatformRdjb,
  type PlatformResponseOutcome,
  type PlatformRow,
  classifyPlatformResponse,
  parsePlatformPage,
} from './adapter'
import type { PlatformInterface } from '../labels'
import type { PlatformQueryError, PlatformQueryPage, PlatformQueryPosition } from './live-query'
import { withPlatformRequestBudget } from './request-budget'
import { appLog, newLogContext, type LogContext } from '../logging'
import { logPlatformResult, platformOperation } from './logging'

export type PlatformFetch = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal?: AbortSignal
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** cookie 环境变量名。仓库里只留 `.env.example` 占位,真实值不入库。 */
export const COOKIE_ENV = 'MIIT_COOKIE'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'

export interface PlatformQueryOutcome extends Omit<PlatformResponseOutcome, 'status'> {
  status: PlatformResponseOutcome['status'] | 'partial'
  interface: PlatformInterface
  /** `business_list` 的 rdjb;`apply_list` 记空串(该接口不用此参数)。 */
  rdjb: string
  queryKey: string
  /** **真实查询时点**(ISO)。落 `platform_query.queried_at`;同一次实查重放要能幂等。 */
  queriedAt: string
  /** 原始响应原文,供 `platform_query.raw_response` 留证。 */
  raw: string
  rows: PlatformRow[]
  /** Exact stored JSON rows for an explicitly reused archive; absent for fresh legacy reads. */
  rawRows?: Record<string, unknown>[]
  /** Legacy traversal evidence lives in rawResponse, never recognized collectionEvidence. */
  collection?: LegacySlotCollection
}

export interface LegacySlotCollection {
  kind: 'legacy-slot-pages/v1'
  interface: PlatformInterface
  rdjb: string
  queryKey: string
  queriedAt: string
  completedAt: string
  completeness: 'complete' | 'partial' | 'not_queried'
  declaredTotal: number | null
  pages: (PlatformQueryPage & { queriedAt: string; raw: string })[]
  unfinished: PlatformQueryPosition[]
  requestCount: number
  failureReason: string | null
}

export interface PlatformQueryOptions {
  logContext?: LogContext
  uscc: string
  fetchImpl?: PlatformFetch
  /** 整条 Cookie 值,或惰性取值函数。缺省从 {@link COOKIE_ENV} 读。 */
  cookie?: string | (() => string) | null
  baseUrl?: string
  timeoutMs?: number
  /** **网络错误与 5xx** 的退避重试次数(默认 2)。4xx 与会话过期**一律不重试**。 */
  retries?: number
  /** Absolute operation deadline, including queue wait; used by bounded live queries. */
  deadlineMs?: number
  /** 退避等待;测试注入以减少空等。默认 `1000 * 3^(n-1)` 毫秒。 */
  sleep?: (ms: number) => Promise<void>
  /** 查询时点取值;默认当前时间。测试注入以固定 `queried_at`。 */
  now?: () => string
  shouldCancel?: () => boolean
  maxRequests?: number
  maxRows?: number
  maxDurationMs?: number
}

/**
 * 当前环境能不能拿到平台会话凭据。**不返回凭据值**,只回布尔 —— 调用方据此判断
 * 「这次实查能不能开始」;拿不到就不该产出「一片未查询」的假结果。
 *
 * 给了 `option` 就以它为准(测试注入、或服务端从运行时配置取),否则按
 * {@link COOKIE_ENV} 读环境。显式空字符串或返回空字符串的函数会禁止环境回退。
 */
export function hasPlatformCredential(option: PlatformQueryOptions['cookie'] = null): boolean {
  return resolveCookie(option).length > 0
}

export function resolveCookie(option: PlatformQueryOptions['cookie']): string {
  if (typeof option === 'function') return option().trim()
  if (typeof option === 'string') return option.trim()
  return process.env[COOKIE_ENV]?.trim() ?? ''
}

/** 干跑一次取数(不发请求),把结果归成三态 —— 供测试与「用已取回的原文入库」。 */
export function classifyRawQuery(
  raw: string,
  input: {
    interface: PlatformInterface
    rdjb?: string
    queryKey: string
    /** 真实查询时点;离线归类(回放已取回的原文)时可省,省略记空串。 */
    queriedAt?: string
  },
): PlatformQueryOutcome {
  const grid = input.interface === 'business_list' ? BUSINESS_GRID : APPLY_GRID
  const rdjb = input.rdjb ?? ''
  const outcome = classifyPlatformResponse(raw, grid, {
    interface: input.interface,
    queryKey: input.queryKey,
    rdjb,
  })
  return {
    ...outcome,
    interface: input.interface,
    rdjb,
    queryKey: input.queryKey,
    queriedAt: input.queriedAt ?? '',
    raw,
  }
}

/** Scrub complete headers, session/auth components, and long component values,
 * including escaped wire forms. Avoid replacing unrelated short routing identifiers. */
export function cookieRedactor(cookie: string): (text: string) => string {
  const values = [cookie, ...cookie.split(';').flatMap(part => {
    const index = part.indexOf('=')
    const value = index < 0 ? '' : part.slice(index + 1).trim()
    const sensitive = /session|token|auth|sid|ticket/i.test(part.slice(0, index))
    return value && (sensitive || value.length >= 8) ? [value] : []
  })].filter(Boolean)
  const forms = [...new Set(values.flatMap(value => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]))].sort((a, b) => b.length - a.length)
  return text => forms.reduce((result, value) => {
    if (value.length >= 8) return result.split(value).join('[REDACTED]')
    // A short component can also be an ordinary substring of a field name or identifier.
    const escaped = value.replace(/[^a-zA-Z0-9_]/g, '\\$&')
    return result.replace(new RegExp(`(?<![a-zA-Z0-9_])${escaped}(?![a-zA-Z0-9_])`, 'g'), '[REDACTED]')
  }, text)
}

/** Safe status discriminator for new consumers; remains a legacy response error. */
export class PlatformHttpError extends PlatformResponseError {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'PlatformHttpError' }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 一次 POST 的原始取回。**网络错误与 5xx 退避重试**;4xx / 会话过期不重试。 */
async function postWithoutBudget(
  options: PlatformQueryOptions,
  path: string,
  body: Record<string, string>,
): Promise<string> {
  const cookie = resolveCookie(options.cookie)
  if (!cookie) {
    throw new PlatformCredentialMissingError(
      `未配置平台会话凭据:请由调用方提供,或设置 ${COOKIE_ENV}(整条 Cookie 值)。`,
    )
  }
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as PlatformFetch)
  const base = options.baseUrl ?? PLATFORM_BASE
  const retries = Math.max(0, options.retries ?? 2)
  const sleep = options.sleep ?? defaultSleep
  const logContext = options.logContext ?? newLogContext()
  const source = path === APPLY_LIST_PATH ? 'queryList' : path === BUSINESS_LIST_PATH ? 'businessList' : path === RECOGNIZED_LIST_PATH ? 'queryBusList' : null

  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(1000 * 3 ** (attempt - 1), options.deadlineMs == null ? Infinity : Math.max(0, options.deadlineMs - Date.now())))
      if (source) appLog({ source: 'platform', operation: platformOperation(source, 'retry', body.rdjb ?? null), outcome: 'started', counts: { done: attempt },
        ...(Number.isSafeInteger(Number(body.pageNum)) && Number(body.pageNum) > 0 ? { page: Number(body.pageNum) } : {}) }, logContext)
    }
    if (options.shouldCancel?.()) throw new Error('平台查询已取消。')
    if (options.deadlineMs != null && Date.now() >= options.deadlineMs) throw new DOMException('平台查询超时。', 'TimeoutError')
    try {
      const response = await fetchImpl(new URL(path, base).toString(), {
        method: 'POST',
        headers: {
          Accept: 'text/html, */*; q=0.01',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Origin: 'https://zjtx.miit.gov.cn',
          Referer: 'https://zjtx.miit.gov.cn/zxqy/',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': USER_AGENT,
          Cookie: cookie,
        },
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 60_000, options.deadlineMs == null ? Infinity : options.deadlineMs - Date.now()))),
      })
      const text = await response.text()
      // 会话过期是 **HTTP 200**:不重试(重试也不会变好),但要立刻分清
      // 「失败」与「无记录」—— 判据在 adapter,这里只把它提前抛成不可重试的错误。
      if (response.ok) {
        assertSessionAlive(text)
        return text
      }
      // 4xx 是请求本身的问题(参数/权限),重试没有意义;5xx 才退避重试。
      if (response.status < 500) {
        throw new PlatformHttpError(response.status, `平台返回 HTTP ${response.status}:${cookieRedactor(cookie)(text).slice(0, 200)}`)
      }
      lastError = new PlatformHttpError(response.status, `平台返回 HTTP ${response.status}:${cookieRedactor(cookie)(text).slice(0, 200)}`)
    } catch (error) {
      // 已定性的错误直接抛出,不参与重试。
      if (
        error instanceof PlatformSessionExpiredError ||
        error instanceof PlatformCredentialMissingError ||
        error instanceof PlatformResponseError
        || (error instanceof PlatformHttpError && error.status < 500)
      ) {
        throw error
      }
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** Shared transport: all platform requests, retries and backoff own one global slot. */
export function postPlatformRequest(options: PlatformQueryOptions, path: string, body: Record<string, string>): Promise<string> {
  const signal = options.deadlineMs == null ? undefined : AbortSignal.timeout(Math.max(1, options.deadlineMs - Date.now()))
  return withPlatformRequestBudget(() => {
    signal?.throwIfAborted()
    return postWithoutBudget(options, path, body)
  }, signal)
}

function queryBody(queryKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { tyshxydm: queryKey, pageNum: '1', numPerPage: '50', ...extra }
}

/** 一个查询槽位:接口 + (business_list 的)`rdjb`。 */
export interface PlatformSlot {
  interface: PlatformInterface
  rdjb?: PlatformRdjb
}

/** Same page partition checks are used on admission and cache readback. */
function validateLegacyPage(parsed: ReturnType<typeof parsePlatformPage>, page: number, total: number | null): void {
  const declared = parsed.declaredTotal ?? total
  if (parsed.declaredTotal === null || parsed.responsePage !== page || parsed.responsePageSize !== 50 || parsed.rows.length > 50
    || (total !== null && parsed.declaredTotal !== null && parsed.declaredTotal !== total)
    || (declared !== null && (page > Math.max(1, Math.ceil(declared / 50))
      || parsed.rows.length !== Math.min(50, Math.max(0, declared - (page - 1) * 50))))) {
    throw new PlatformResponseError('平台分页信息不一致或缺少页号/分页大小/声明总数。')
  }
}

/** Old success alone proves nothing. Revalidate the original per-page bytes and
 * exact ordered archived rows before reusing a newly collected complete slot. */
export function readCompleteLegacySlot(raw: string | null, meta: { interface: PlatformInterface; rdjb: string; queryKey: string; queriedAt: string }, rows: PlatformRow[]): LegacySlotCollection | null {
  try {
    const value = JSON.parse(raw ?? '') as LegacySlotCollection
    if (value.kind !== 'legacy-slot-pages/v1' || value.completeness !== 'complete' || value.unfinished.length || value.failureReason
      || (['interface', 'rdjb', 'queryKey', 'queriedAt'] as const).some(key => value[key] !== meta[key])
      || !value.pages.length || value.pages.length > 100 || !Number.isSafeInteger(value.requestCount)
      || value.requestCount < value.pages.length || value.requestCount > 100
      || !Number.isFinite(Date.parse(value.completedAt)) || Date.parse(value.completedAt) < Date.parse(meta.queriedAt)) return null
    const collected: PlatformRow[] = []
    let total: number | null = null
    for (const [index, page] of value.pages.entries()) {
      if (page.status !== 'success' || page.error !== null || page.page !== index + 1
        || page.source !== (meta.interface === 'business_list' ? 'businessList' : 'queryList') || page.rdjb !== (meta.rdjb || null)
        || !Number.isFinite(Date.parse(page.queriedAt)) || (total !== null && collected.length === total)) return null
      const parsed = parsePlatformPage(page.raw, meta.interface === 'business_list' ? BUSINESS_GRID : APPLY_GRID)
      validateLegacyPage(parsed, index + 1, total)
      if (parsed.declaredTotal !== page.declaredTotal || page.fetchedCount !== parsed.rows.length) return null
      total ??= parsed.declaredTotal
      collected.push(...parsed.rows)
    }
    return total !== null && total === value.declaredTotal && total === collected.length && JSON.stringify(collected) === JSON.stringify(rows) ? value : null
  } catch { return null }
}

/**
 * 按**指定槽位**取数。每个槽位有界遍历所有页，逐槽归档(不合并、不互相覆盖)。
 *
 * 为什么要能只取一部分:全量核查里同一个 USCC 的四个槽位**各有各的新鲜度** ——
 * 24 小时内已经成功查过的槽位直接复用库里的证据,只补缺的那些。整组一起重查会把
 * 已经拿到的新鲜证据再打一遍,既慢又多出一批时点不同的行。
 */
export async function queryPlatformSlots(
  options: PlatformQueryOptions,
  slots: PlatformSlot[],
): Promise<PlatformQueryOutcome[]> {
  const { uscc } = options
  // One query operation owns one in-memory credential snapshot (including all retries/slots).
  let cookie = ''
  let credentialError = false
  try { cookie = resolveCookie(options.cookie) } catch { credentialError = true }
  const logContext = options.logContext ?? newLogContext()
  const fixed = { ...options, cookie: () => cookie, logContext }
  const redact = cookieRedactor(cookie)
  const sanitize = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value)
    if (Array.isArray(value)) return value.map(sanitize)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key), sanitize(entry)]))
    return value
  }
  const outcomes: PlatformQueryOutcome[] = []
  for (const slot of slots) {
    const started = Date.now()
    const base = { interface: slot.interface, rdjb: slot.rdjb ?? '', queryKey: uscc }
    const source = slot.interface === 'business_list' ? 'businessList' : 'queryList'
    const queriedAt = options.now?.() ?? new Date().toISOString()
    const collection: LegacySlotCollection = {
      kind: 'legacy-slot-pages/v1', ...base, queriedAt, completedAt: '',
      completeness: 'not_queried', declaredTotal: null, pages: [], unfinished: [], requestCount: 0, failureReason: null,
    }
    const rows: PlatformRow[] = []
    let responseSource: PlatformResponseOutcome['source'] = null
    let errorCode: PlatformQueryError['code'] | undefined
    const maxRequests = Math.max(1, Math.min(100, options.maxRequests ?? 100))
    const maxRows = Math.max(1, Math.min(5000, options.maxRows ?? 5000))
    const deadlineMs = Math.min(options.deadlineMs ?? Infinity, started + Math.max(1, Math.min(60000, options.maxDurationMs ?? 60000)))
    const transport: PlatformQueryOptions = {
      ...fixed, deadlineMs,
      fetchImpl: async (url, init) => {
        if (collection.requestCount >= maxRequests) throw new PlatformResponseError('平台查询达到请求安全上限。')
        collection.requestCount++
        return (options.fetchImpl ?? (globalThis.fetch as unknown as PlatformFetch))(url, init)
      },
    }
    for (let page = 1; ; page++) {
      const position = { source, rdjb: slot.rdjb || null, page } as PlatformQueryPosition
      let raw = ''
      let declaredTotal: number | null = null
      const pageTime = options.now?.() ?? new Date().toISOString()
      try {
        if (credentialError) throw new Error('平台凭据不可用，请检查凭据来源。')
        if (options.shouldCancel?.()) throw new Error('平台查询已取消。')
        if (Date.now() >= deadlineMs) throw new DOMException('平台查询超时。', 'TimeoutError')
        if (collection.requestCount >= maxRequests || rows.length >= maxRows) throw new PlatformResponseError('平台查询达到安全上限，仍有未完成页。')
        const path = slot.interface === 'business_list' ? BUSINESS_LIST_PATH : APPLY_LIST_PATH
        raw = await postPlatformRequest(transport, path, queryBody(uscc, { ...(slot.interface === 'business_list' ? { rdjb: slot.rdjb! } : {}), pageNum: String(page) }))
        if (Date.now() >= deadlineMs) throw new DOMException('平台查询超时。', 'TimeoutError')
        const parsed = parsePlatformPage(raw, slot.interface === 'business_list' ? BUSINESS_GRID : APPLY_GRID)
        declaredTotal = parsed.declaredTotal
        if (JSON.stringify(sanitize(parsed.rows)) !== JSON.stringify(parsed.rows)) throw new PlatformResponseError('平台业务响应含敏感凭据，已阻止作为业务证据使用。')
        validateLegacyPage(parsed, page, collection.declaredTotal)
        if (rows.length + parsed.rows.length > maxRows) throw new PlatformResponseError('平台查询达到记录安全上限，此页未纳入结果。')
        collection.declaredTotal ??= declaredTotal
        responseSource = parsed.source
        rows.push(...parsed.rows)
        collection.pages.push({ ...position, queriedAt: pageTime, raw: redact(raw), status: 'success', fetchedCount: parsed.rows.length, declaredTotal, error: null })
        // Legacy queryList/businessList terminate only on their own exact declared
        // page partition. queryBusList maxPage/nextPage rules do not apply here.
        if (collection.declaredTotal !== null && rows.length === collection.declaredTotal) {
          collection.completeness = 'complete'
          break
        }
      } catch (caught) {
        errorCode = credentialError || !cookie ? 'credential_unavailable' : caught instanceof PlatformSessionExpiredError || (caught instanceof PlatformHttpError && [401, 403].includes(caught.status)) ? 'auth_failed'
          : caught instanceof PlatformHttpError && caught.status === 429 ? 'rate_limited' : caught instanceof Error && /timeout|abort/i.test(caught.name) ? 'timeout' : 'upstream_failed'
        const reason = redact(caught instanceof Error ? caught.message : String(caught))
        collection.failureReason = reason
        collection.unfinished = [position]
        collection.completeness = collection.requestCount ? 'partial' : 'not_queried'
        collection.pages.push({ ...position, queriedAt: pageTime, raw: redact(raw), status: 'failed', fetchedCount: 0, declaredTotal, error: { code: errorCode, message: reason } })
        break
      }
    }
    collection.completedAt = options.now?.() ?? new Date().toISOString()
    const status = collection.completeness === 'complete' ? rows.length ? 'success' : 'no_record'
      : collection.pages.some(p => p.status === 'success') ? 'partial' : 'failed'
    outcomes.push({ ...base, queriedAt, status, rows, maxCount: collection.declaredTotal ?? 0, source: responseSource,
      failureReason: collection.failureReason, raw: JSON.stringify(collection), collection })
    logPlatformResult(platformOperation(source, 'slot', slot.rdjb ?? null), status,
      { ...logContext, page: collection.pages.at(-1)?.page ?? 1 }, { done: rows.length }, Date.now() - started, errorCode)
  }
  return outcomes
}

/**
 * 按 USCC 把 `businessList` 的 **rdjb=1/2/3 全查**(外加申报接口)。
 *
 * 为什么必须三个全查:实测 `91330211255994457P` 的 `rdjb=1` 与 `rdjb=2` 各 0 行、
 * `rdjb=3` 有 6 行 —— 曾用名证据就在那 6 行里。只查本地称号映射出的那一个 `rdjb`
 * (旧 `pipeline/scripts/reconcile.ts:262` 的做法)会**整条漏掉证据**。
 */
export async function queryAllRdjb(options: PlatformQueryOptions): Promise<PlatformQueryOutcome[]> {
  return queryPlatformSlots(options, [
    ...RDJB_VALUES.map((rdjb) => ({ interface: 'business_list' as const, rdjb })),
    { interface: 'apply_list' as const },
  ])
}
