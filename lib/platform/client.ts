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
}

function resolveCookie(option: PlatformQueryOptions['cookie']): string {
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
  input: { interface: PlatformInterface; rdjb?: string; queryKey: string },
): PlatformQueryOutcome {
  const grid = input.interface === 'business_list' ? BUSINESS_GRID : APPLY_GRID
  const rdjb = input.rdjb ?? ''
  const outcome = classifyPlatformResponse(raw, grid, {
    interface: input.interface,
    queryKey: input.queryKey,
    rdjb,
  })
  return { ...outcome, interface: input.interface, rdjb, queryKey: input.queryKey, raw }
}

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
  if (!response.ok) {
    throw new Error(`平台返回 HTTP ${response.status}:${text.slice(0, 200)}`)
  }
  return text
}

function queryBody(queryKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { tyshxydm: queryKey, pageNum: '1', numPerPage: '50', ...extra }
}

/**
 * 按 USCC 把 `businessList` 的 **rdjb=1/2/3 全查**。
 *
 * 为什么必须三个全查:实测 `91330211255994457P` 的 `rdjb=1` 与 `rdjb=2` 各 0 行、
 * `rdjb=3` 有 6 行 —— 曾用名证据就在那 6 行里。只查本地称号映射出的那一个 `rdjb`
 * (旧 `pipeline/scripts/reconcile.ts:262` 的做法)会**整条漏掉证据**。
 */
export async function queryAllRdjb(options: PlatformQueryOptions): Promise<PlatformQueryOutcome[]> {
  const { uscc } = options
  const tasks: { interface: PlatformInterface; rdjb?: PlatformRdjb; path: string; body: Record<string, string> }[] = [
    ...RDJB_VALUES.map((rdjb) => ({
      interface: 'business_list' as const,
      rdjb,
      path: BUSINESS_LIST_PATH,
      body: queryBody(uscc, { rdjb }),
    })),
    { interface: 'apply_list', path: APPLY_LIST_PATH, body: queryBody(uscc) },
  ]

  const outcomes: PlatformQueryOutcome[] = []
  for (const task of tasks) {
    const base = { interface: task.interface, rdjb: task.rdjb ?? '', queryKey: uscc }
    try {
      const raw = await post(options, task.path, task.body)
      outcomes.push(classifyRawQuery(raw, base))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      outcomes.push({
        ...base,
        status: 'failed',
        rows: [],
        maxCount: 0,
        source: null,
        failureReason: reason,
        raw: '',
      })
    }
  }
  return outcomes
}
