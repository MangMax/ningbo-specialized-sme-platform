/**
 * 平台两个接口的**薄客户端**(RL-03):可注入 `fetch`,离线可测。
 *
 * 与 {@link ./adapter} 的分工:`adapter.ts` 是纯解析(收一份原始响应 → 三态),
 * 本文件只负责「发请求 → 把原文交给 adapter 归类」。**凭据只从环境读、不入库、不进日志**;
 * 拿不到凭据时**不发请求**,四次查询一律记 `failed`(未查询 ≠ 无记录)。
 *
 * 生产上真实响应由父协调者在**已登录的桌面 Chrome 会话**里代取并落地为证据文件,
 * 由 `classifyPlatformResponse` 直接归类 —— 本客户端是同一口径下的取数路径,
 * 让适配层在没有真实凭证的环境里也能被完整测到。
 */
import { existsSync, readFileSync } from 'node:fs'
import {
  APPLY_GRID,
  APPLY_LIST_PATH,
  BUSINESS_GRID,
  BUSINESS_LIST_PATH,
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
} from './adapter'
import type { PlatformInterface } from '../labels'

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
export const COOKIE_FILE_ENV = 'MIIT_COOKIE_FILE'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'

export interface PlatformQueryOutcome extends PlatformResponseOutcome {
  interface: PlatformInterface
  /** `business_list` 的 rdjb;`apply_list` 记空串(该接口不用此参数)。 */
  rdjb: string
  queryKey: string
  /** **真实查询时点**(ISO)。落 `platform_query.queried_at`;同一次实查重放要能幂等。 */
  queriedAt: string
  /** 原始响应原文,供 `platform_query.raw_response` 留证。 */
  raw: string
  rows: PlatformRow[]
}

export interface PlatformQueryOptions {
  uscc: string
  fetchImpl?: PlatformFetch
  /** 整条 Cookie 值,或惰性取值函数。缺省从 {@link COOKIE_ENV} 读。 */
  cookie?: string | (() => string) | null
  baseUrl?: string
  timeoutMs?: number
  /** **网络错误与 5xx** 的退避重试次数(默认 2)。4xx 与会话过期**一律不重试**。 */
  retries?: number
  /** 退避等待;测试注入以减少空等。默认 `1000 * 3^(n-1)` 毫秒。 */
  sleep?: (ms: number) => Promise<void>
  /** 查询时点取值;默认当前时间。测试注入以固定 `queried_at`。 */
  now?: () => string
}

/**
 * 当前环境能不能拿到平台会话凭据。**不返回凭据值**,只回布尔 —— 调用方据此判断
 * 「这次实查能不能开始」;拿不到就不该产出「一片未查询」的假结果。
 *
 * 给了 `option` 就以它为准(测试注入、或服务端从运行时配置取),否则按
 * {@link COOKIE_ENV} → {@link COOKIE_FILE_ENV} 的顺序读环境。
 */
export function hasPlatformCredential(option: PlatformQueryOptions['cookie'] = null): boolean {
  return resolveCookie(option).length > 0
}

export function resolveCookie(option: PlatformQueryOptions['cookie']): string {
  if (typeof option === 'function') return option().trim()
  if (option) return option.trim()
  const inline = process.env[COOKIE_ENV]?.trim()
  if (inline) return inline
  const file = process.env[COOKIE_FILE_ENV]?.trim()
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim()
  return ''
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
function cookieRedactor(cookie: string): (text: string) => string {
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

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 一次 POST 的原始取回。**网络错误与 5xx 退避重试**;4xx / 会话过期不重试。 */
async function post(
  options: PlatformQueryOptions,
  path: string,
  body: Record<string, string>,
): Promise<string> {
  const cookie = resolveCookie(options.cookie)
  if (!cookie) {
    throw new PlatformCredentialMissingError(
      `未配置平台会话凭据:请设 ${COOKIE_ENV}(整条 Cookie 值)或 ${COOKIE_FILE_ENV}(文件路径)。凭据不入库,仓库只留 .env.example 占位。`,
    )
  }
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as PlatformFetch)
  const base = options.baseUrl ?? PLATFORM_BASE
  const retries = Math.max(0, options.retries ?? 2)
  const sleep = options.sleep ?? defaultSleep

  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 3 ** (attempt - 1))
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
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
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
        throw new PlatformResponseError(`平台返回 HTTP ${response.status}:${cookieRedactor(cookie)(text).slice(0, 200)}`)
      }
      lastError = new PlatformResponseError(`平台返回 HTTP ${response.status}:${cookieRedactor(cookie)(text).slice(0, 200)}`)
    } catch (error) {
      // 已定性的错误直接抛出,不参与重试。
      if (
        error instanceof PlatformSessionExpiredError ||
        error instanceof PlatformCredentialMissingError ||
        error instanceof PlatformResponseError
      ) {
        throw error
      }
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function queryBody(queryKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { tyshxydm: queryKey, pageNum: '1', numPerPage: '50', ...extra }
}

/** 一个查询槽位:接口 + (business_list 的)`rdjb`。 */
export interface PlatformSlot {
  interface: PlatformInterface
  rdjb?: PlatformRdjb
}

/**
 * 按**指定槽位**取数。每个槽位一次 POST,逐次归类(不合并、不互相覆盖)。
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
  const fixed = { ...options, cookie: () => cookie }
  const redact = cookieRedactor(cookie)
  const sanitize = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value)
    if (Array.isArray(value)) return value.map(sanitize)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key), sanitize(entry)]))
    return value
  }
  const outcomes: PlatformQueryOutcome[] = []
  for (const slot of slots) {
    const base = { interface: slot.interface, rdjb: slot.rdjb ?? '', queryKey: uscc }
    // 时点在**请求发出前**取:它就是这次查询的时刻(`platform_query.queried_at`)。
    const queriedAt = options.now?.() ?? new Date().toISOString()
    try {
      const path = slot.interface === 'business_list' ? BUSINESS_LIST_PATH : APPLY_LIST_PATH
      const body = slot.interface === 'business_list' ? queryBody(uscc, { rdjb: slot.rdjb! }) : queryBody(uscc)
      if (credentialError) throw new Error('平台凭据文件不可用，请检查权限。')
      const raw = await post(fixed, path, body)
      const outcome = classifyRawQuery(raw, { ...base, queriedAt })
      const rows = sanitize(outcome.rows) as PlatformRow[]
      // Never turn a redaction placeholder into an enterprise name, alias or relation.
      const containsCredential = JSON.stringify(rows) !== JSON.stringify(outcome.rows)
      outcomes.push(containsCredential
        ? { ...outcome, status: 'failed', maxCount: 0, rows: [], raw: redact(raw), failureReason: '平台业务响应含敏感凭据，已阻止作为业务证据使用。' }
        : { ...outcome, raw: redact(raw), rows, failureReason: outcome.failureReason ? redact(outcome.failureReason) : outcome.failureReason })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      outcomes.push({
        ...base,
        queriedAt,
        status: 'failed',
        rows: [],
        maxCount: 0,
        source: null,
        failureReason: redact(reason),
        raw: '',
      })
    }
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
