/**
 * RL-03 平台核查测试的**共用夹具**:真响应夹具读取 + 可编程的假 fetch。
 *
 * ── 为什么要抽出来 ────────────────────────────────────────────────────────
 * 「按 (USCC, 接口, rdjb) 回一份夹具、记下每次调用、数清在飞并发峰值」这套脚手架在
 * 本票的四个测试文件里几乎逐字重复。票 19 的评审已经为同类情况抽过 `lib/csv.ts`
 * (「第 5 份照抄」的判据),这里照同一办法收口:改一处口径(比如记 `queriedAt`、
 * 加一次重试)不必再去四个地方同步。
 *
 * ── 不碰外网、不用真凭据 ──────────────────────────────────────────────────
 * 响应**一律**来自 `tests/fixtures/platform/`(父代理在已登录会话里代取并裁剪的真实
 * 响应,不含凭证)或调用方现场合成的行;凭据是注入值。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUSINESS_LIST_PATH, type PlatformFetch } from '../../lib/platform'

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'platform')

/** 读一份真响应夹具(路径固定,避免每个测试文件各拼一次)。 */
export function platformFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8')
}

/** 结构等价的「平台 0 行」申报响应(`queryList` 的真实信封形状,`pageSet` 为空)。 */
export const EMPTY_APPLY_RESPONSE =
  '{"zrarData":{"select":{},"form":{},"grid":{"applyGrid":{"maxCount":0,"page":1,"pageSize":50,"pageSet":[]}},"warn":"","json":{},"message":"","statusCode":"200"}}'

/** 一次请求的坐标。`uscc` 取自表单的 `tyshxydm`。 */
export interface PlatformCall {
  uscc: string
  interface: 'business_list' | 'apply_list'
  /** `business_list` 的 `rdjb`;`apply_list` 为空串。 */
  rdjb: string
}

/** 一跳的回复。`status` 省略即 200。 */
export interface PlatformReply {
  status?: number
  text: string
}

export interface PlatformReplay {
  fetchImpl: PlatformFetch
  /** 全部调用,按发生顺序(同一坐标的第几次看 `attemptOf`)。 */
  calls: PlatformCall[]
  /** 该坐标是第几次被请求(从 1 起)——用于构造「第一次 5xx、第二次成功」。 */
  attemptOf(call: PlatformCall): number
  /** 同时在飞的请求数峰值(并发上限的判据)。 */
  peak(): number
  reset(): void
}

/**
 * 一个可编程的假 fetch。`reply` 收 (坐标, 第几次) 回一跳的响应;
 * `delayMs` 用来制造重叠,让并发上限可观测(不然串行也能「不超过上限」)。
 */
export function platformReplay(
  reply: (call: PlatformCall, attempt: number) => PlatformReply | Promise<PlatformReply>,
  options: { delayMs?: number } = {},
): PlatformReplay {
  const calls: PlatformCall[] = []
  const attempts = new Map<string, number>()
  let inFlight = 0
  let highest = 0

  const keyOf = (call: PlatformCall) => `${call.uscc}|${call.interface}|${call.rdjb}`

  const fetchImpl: PlatformFetch = async (url, init) => {
    const body = new URLSearchParams(init.body)
    const isBusiness = url.includes(BUSINESS_LIST_PATH)
    const call: PlatformCall = {
      uscc: body.get('tyshxydm') ?? '',
      interface: isBusiness ? 'business_list' : 'apply_list',
      rdjb: body.get('rdjb') ?? '',
    }
    calls.push(call)
    const attempt = (attempts.get(keyOf(call)) ?? 0) + 1
    attempts.set(keyOf(call), attempt)

    inFlight += 1
    highest = Math.max(highest, inFlight)
    try {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      const result = await reply(call, attempt)
      const status = result.status ?? 200
      return { ok: status >= 200 && status < 300, status, text: async () => result.text }
    } finally {
      inFlight -= 1
    }
  }

  return {
    fetchImpl,
    calls,
    attemptOf: (call) => attempts.get(keyOf(call)) ?? 0,
    peak: () => highest,
    reset: () => {
      calls.length = 0
      attempts.clear()
      highest = 0
    },
  }
}

/** 一路 0 行(三个 rdjb 与申报接口都成功返空)——「平台确无记录」的最简场景。 */
export const emptyReply = (call: PlatformCall): PlatformReply => ({
  text:
    call.interface === 'business_list'
      ? platformFixture('business-list-rdjb1-empty.html')
      : EMPTY_APPLY_RESPONSE,
})
