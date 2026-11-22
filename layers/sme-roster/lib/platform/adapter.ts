/**
 * 工信部优质中小企业梯度培育平台 **两个接口**的适配与解析(RL-03)。
 *
 * ── 为什么 app 侧要自己实现一遍 ─────────────────────────────────────────────
 * 项目外 `pipeline/` 已有一份适配器,但 #3 的**新写入路径**必须收敛到 app 的公开 API
 * (契约 §0 第 3 条、SPEC「一切写入走应用公开 API」),不能反向依赖项目外代码。
 * 本模块是**纯函数 + 可注入 fetch**,不读环境、不落盘、可离线测:
 * 平台响应要么来自夹具,要么由调用方注入的 `fetchImpl` 取回。
 *
 * ── 三条已经实测的坑(照抄 pipeline 的口径,理由见 02-RESEARCH-platform-interfaces.md)──
 * 1. **`businessList` 回 HTML,数据不在 `<table>` 里**:`<tbody>` 空、页脚写「共 0 条」,
 *    真数据在页尾 `(function(data){…})( {"zrarData":…} )` 脚本里。
 *    只抓 `<table>` 会**静默得 0 行**,把「平台有记录」误判成「平台无记录」。
 * 2. **`Content-Type` 不可信**:实测 `queryList` 回 `text/html` 而 body 是纯 JSON。
 *    判形态只能**嗅 body 首字符**(`{` 开头当 JSON),不能按响应头分流。
 * 3. **会话过期回 HTTP 200**:body 是 `{"statusCode":"301","message":"登录超时,请重新登录"}`。
 *    只看状态码会把过期当成成功,缓存一个空/登录页响应 ⇒ 这是 `failed`,不是 `no_record`。
 *
 * 解析顺序:**JSON 信封 → HTML 内嵌 zrarData → 已渲染 `<table>`**;三级都拿不到就抛
 * {@link PlatformResponseError},绝不静默返回空 —— 「看不懂」与「没有记录」是两回事。
 */
import type { PlatformInterface } from '../labels'

/** 平台基址(常量唯一出处)。 */
export const PLATFORM_BASE = 'https://zjtx.miit.gov.cn/zxqy/'
export const BUSINESS_LIST_PATH = 'ZjtxxjrBusInfoManageBLH/businessList'
export const APPLY_LIST_PATH = 'YzzxqyApplayBLH/queryList'
export const BUSINESS_GRID = 'businessListGrid'
export const APPLY_GRID = 'applyGrid'
/** Independently validated recognized-enterprise source; never alias businessList. */
export const RECOGNIZED_LIST_PATH = 'ZjtxxjrBusInfoManageBLH/queryBusList'
export const RECOGNIZED_GRID = 'businessGrid'

/**
 * `businessList` 的 `rdjb`(认定级别)**取值集**:1 创新型 / 2 专精特新中小企业 / 3 小巨人。
 *
 * ⚠️ 与 `layers/sme-roster/lib/labels.ts` 的 `PLATFORM_RDJBS`(`Record<string,string>`,code → 中文)是
 * **两个不同的东西**——此处是「要查哪几个取值」,那里是「怎么显示」。所以这里叫
 * `RDJB_VALUES`(旧名 `PLATFORM_RDJBS` 与 labels 同名不同义,import 时必须加别名)。
 */
export const RDJB_VALUES = ['1', '2', '3'] as const
export type PlatformRdjb = (typeof RDJB_VALUES)[number]

/** 平台一行(字段名沿用接口的 `id`,如 `qymc` / `tyshxydm` / `szsfmc`)。值一律字符串化。 */
export type PlatformRow = Record<string, string>
/** JSON observations; never derive these from legacy string rows. */
export type PlatformJsonValue = string | number | boolean | null | PlatformJsonValue[] | { [key: string]: PlatformJsonValue }
export type PlatformRawRow = Record<string, PlatformJsonValue>

export interface PlatformListResult {
  grid: string
  rows: PlatformRow[]
  /** 平台自报的 total。**不等于 `rows.length`**(分页时);展示与判断用 `rows.length`。 */
  maxCount: number
  page: number
  pageSize: number
  /** 走的是哪条解析路:`json` / `html-script` / `html-table`。 */
  source: 'json' | 'html-script' | 'html-table'
}

/** 会话过期(平台回 HTTP 200)。判为 `failed`,绝不判成 `no_record`。 */
export class PlatformSessionExpiredError extends Error {
  constructor(message = '登录超时,请重新登录') {
    super(message)
    this.name = 'PlatformSessionExpiredError'
  }
}

/** 响应结构无法识别(平台改版)。判为 `failed`。 */
export class PlatformResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlatformResponseError'
  }
}

/** 需要真实请求但拿不到会话凭据。判为 `failed`(未查询 ≠ 无记录)。 */
export class PlatformCredentialMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlatformCredentialMissingError'
  }
}

/** 从响应体里尽力取 `message`(用于失败原因文案)。 */
function messageOf(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const payload = JSON.parse(trimmed) as { message?: unknown }
      if (typeof payload.message === 'string' && payload.message.trim()) {
        return payload.message.trim()
      }
    } catch {
      // 落到正则兜底
    }
  }
  return /"message"\s*:\s*"([^"]*)"/.exec(raw)?.[1]?.trim() || null
}

/**
 * 会话过期判据:平台对过期 cookie 回 `statusCode=301` + 「登录超时」。
 * 放在解析**之前** —— 过期响应体不含 `zrarData`,先判会话才能给出准确的失败原因。
 */
export function assertSessionAlive(raw: string): void {
  if (/登录超时/.test(raw) || /"statusCode"\s*:\s*"?301"?/.test(raw)) {
    throw new PlatformSessionExpiredError(messageOf(raw) ?? '登录超时,请重新登录')
  }
}

/**
 * 会话失效时平台也可能**直接渲染登录页** —— 只在确认不是数据页时才这么判
 * (含 `zrarData` 就绝不判成登录页)。
 */
export function looksLikeLoginPage(html: string): boolean {
  if (/zrarData/.test(html)) return false
  return /(id|name)\s*=\s*["']?(loginForm|j_username|j_password|password)["']?/i.test(html)
}

function tryJson(text: string): unknown {
  if (!text.startsWith('{')) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 从 dwz 页尾的 `(function(data){…})( {"zrarData":…} )` 脚本里抠出 JSON。
 * 用**大括号配对**而不是正则:载荷里含大量嵌套对象与转义引号。
 */
export function extractEmbeddedZrar(html: string): unknown {
  const key = html.indexOf('"zrarData"')
  if (key < 0) return null
  const start = html.lastIndexOf('{', key)
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < html.length; i++) {
    const ch = html[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function gridOf(payload: unknown, gridName: string): Record<string, unknown> | null {
  const grid = (payload as { zrarData?: { grid?: Record<string, unknown> } } | null)?.zrarData?.grid
  const one = grid?.[gridName]
  return one && typeof one === 'object' ? (one as Record<string, unknown>) : null
}

/** 把任意标量字符串化(与 pipeline 的 `rowsFromGrid` 同规则),空值 → 空串。 */
export function platformDataRowStringProjection(row: PlatformRawRow): PlatformRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key, value === null ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value),
  ]))
}

function normalizeRow(row: Record<string, unknown>): PlatformRow {
  const out: PlatformRow = {}
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) out[key] = ''
    else if (typeof value === 'string') out[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value)
    else out[key] = JSON.stringify(value)
  }
  return out
}

function rowsFromGrid(grid: Record<string, unknown>): PlatformRow[] {
  const pageSet = grid.pageSet
  if (!Array.isArray(pageSet)) return []
  return pageSet
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    .map(normalizeRow)
}

function num(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 第三级回退:把 `<table name="<grid>">` 的 `<th id>` 当列名、`<tbody><tr><td>` 当数据行。
 *
 * 用**轻量解析**而不是真 DOM:本仓 vitest 跑在裸 node,没有 DOMParser;而这一支
 * 平台从没真跑过(`pipeline/src/platform.ts` 主动不问 `businessList?type=cx`),
 * 真实样本为零 —— 它的作用是「平台改行为时别静默 0 行」。**一行都没有时返回 `null`**,
 * 交给调用方报 `failed`,绝不把「表体空」当成「没有记录」。
 */
function rowsFromTable(html: string, gridName: string, rawRows?: PlatformRawRow[]): PlatformListResult | null {
  const tableRe = new RegExp(
    `<table[^>]*\\bname\\s*=\\s*["']${gridName}["'][^>]*>([\\s\\S]*?)</table>`,
    'i',
  )
  const tableMatch = tableRe.exec(html)
  if (!tableMatch) return null
  const body = tableMatch[1]!

  const headers = [...body.matchAll(/<th\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(
    (m) => m[1]!,
  )
  const tbodyMatch = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(body)
  const tbody = tbodyMatch ? tbodyMatch[1]! : ''
  const rows: PlatformRow[] = []
  for (const tr of tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      m[1]!.replace(/<[^>]*>/g, '').trim(),
    )
    if (!cells.length) continue
    const row: PlatformRow = {}
    cells.forEach((value, index) => {
      const key = headers[index]
      if (key) row[key] = value
    })
    // Build observations from actual cells, not the legacy assignment projection:
    // Object.fromEntries defines __proto__ as an own data property safely.
    if (rawRows) rawRows.push(Object.fromEntries(cells.flatMap((value, index): [string, string][] => {
      const key = headers[index]
      return key ? [[key, value]] : []
    })))
    rows.push(row)
  }
  if (rows.length === 0) return null

  const pagination = /<div[^>]*class\s*=\s*["'][^"']*pagination[^"']*["'][^>]*>/i.exec(body)
  const attr = (name: string) =>
    pagination ? new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(pagination[0])?.[1] : undefined
  return {
    grid: gridName,
    rows,
    maxCount: rows.length,
    page: num(attr('currentPage'), 1),
    pageSize: num(attr('numPerPage'), rows.length || 20),
    source: 'html-table',
  }
}

/**
 * 解析列表响应。顺序:**JSON 信封 → HTML 内嵌 zrarData → 已渲染 `<table>`**。
 * 三级都不成 ⇒ 抛 {@link PlatformResponseError}。
 */
export function parsePlatformList(raw: string, gridName: string): PlatformListResult {
  assertSessionAlive(raw)
  const text = raw.trim()

  const json = tryJson(text)
  const embedded = json ? null : extractEmbeddedZrar(text)
  const envelope = json ?? embedded
  if (envelope) {
    const grid = gridOf(envelope, gridName)
    if (grid) {
      return {
        grid: gridName,
        rows: rowsFromGrid(grid),
        maxCount: num(grid.maxCount, 0),
        page: num(grid.page, 1),
        pageSize: num(grid.pageSize, 20),
        source: json ? 'json' : 'html-script',
      }
    }
  }

  const table = rowsFromTable(text, gridName)
  if (table) return table

  if (looksLikeLoginPage(text)) throw new PlatformSessionExpiredError()
  throw new PlatformResponseError(
    `无法从平台响应解析出 ${gridName}(页面结构可能已变)。响应开头:${text.slice(0, 200)}`,
  )
}

// ---------------------------------------------------------------------------
// 四态归类(纯函数;写入侧与读侧共用同一口径)
// ---------------------------------------------------------------------------

export interface PlatformResponseMeta {
  interface: PlatformInterface
  queryKey: string
  rdjb?: string
}

export interface PlatformResponseOutcome {
  /** `success`(≥1 行)/ `no_record`(查询成功但 0 行)/ `failed`(没成功执行)。 */
  status: 'success' | 'no_record' | 'failed'
  rows: PlatformRow[]
  maxCount: number
  source: PlatformListResult['source'] | null
  failureReason: string | null
}

function describe(meta: PlatformResponseMeta): string {
  return `${meta.interface}${meta.rdjb ? ` rdjb=${meta.rdjb}` : ''} queryKey=${meta.queryKey}`
}

/**
 * 把一份**已取回的原始响应**归成三态之一(第四态 `not_queried` 由「没有这一行」表达,
 * 不由本函数产出)。这是「失败 ≠ 无记录」的唯一判据,写入侧与测试共用。
 */
export function classifyPlatformResponse(
  raw: string,
  gridName: string,
  meta: PlatformResponseMeta,
): PlatformResponseOutcome {
  try {
    const parsed = parsePlatformList(raw, gridName)
    if (parsed.rows.length === 0) {
      return {
        status: 'no_record',
        rows: [],
        maxCount: parsed.maxCount,
        source: parsed.source,
        failureReason: null,
      }
    }
    return {
      status: 'success',
      rows: parsed.rows,
      maxCount: parsed.maxCount,
      source: parsed.source,
      failureReason: null,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      status: 'failed',
      rows: [],
      maxCount: 0,
      source: null,
      failureReason: `${describe(meta)}:${reason}`,
    }
  }
}

/** Live callers need a reliable total: legacy maxCount=0 fallback is not proof of zero.
 * Keep the historic parser and stored evidence contracts unchanged.
 */
export function parsePlatformPage(raw: string, gridName: string) {
  const parsed = parsePlatformList(raw, gridName)
  const text = raw.trim()
  const envelope = tryJson(text) ?? extractEmbeddedZrar(text)
  const grid = gridOf(envelope, gridName)
  if (grid && (!Array.isArray(grid.pageSet) || grid.pageSet.some(row => !row || typeof row !== 'object' || Array.isArray(row)))) {
    throw new PlatformResponseError('Invalid platform rows')
  }
  const integer = (value: unknown): number | null => {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value.trim()))) return null
    const number = Number(value)
    return Number.isSafeInteger(number) && number >= 0 ? number : null
  }
  // Missing optional metadata stays absent; malformed supplied metadata must fail
  // the live caller's consistency checks, never become a valid page/count via coercion.
  const metadataInteger = (value: unknown) => value == null ? null : integer(value) ?? NaN
  const declaredTotal = integer(grid?.maxCount)
  // Parsing the original envelope preserves null/missing, nested types and own
  // prototype-named keys. Table fallback only observes rendered cell strings.
  const rawRows: PlatformRawRow[] = grid ? grid.pageSet as PlatformRawRow[] : []
  if (!grid) rowsFromTable(text, gridName, rawRows)
  return { ...parsed, rawRows, declaredTotal, responsePage: metadataInteger(grid?.page), responseMaxPage: metadataInteger(grid?.maxPage), responsePageSize: metadataInteger(grid?.pageSize) }
}
