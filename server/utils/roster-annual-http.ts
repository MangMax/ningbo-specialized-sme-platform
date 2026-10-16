/**
 * 年度名录增量预览的 **HTTP 面**(RL-07,契约 §8.12)。
 *
 * 与 `server/utils/roster-import-http.ts` 同一个分法:**不 import h3**,只吃一个最小的
 * 请求描述(method / headers / body / query),于是同一份实现既能被 Nitro 路由调用,也能被
 * **真实 HTTP 回放测试**(`tests/roster-annual-http.test.ts` 起 `node:http` 真端口)直接驱动 ——
 * 契约只有一份,测试打的不是替身。
 *
 * ── 鉴权:预览**不鉴权**,应用才鉴权 ────────────────────────────────────
 * 契约 §8 开头的鉴权管的是**写面**;本仓读面一律不鉴权(「读不鉴权、写/任务鉴权」,§7 开头)。
 * 年度预览**一行都不写**(见 `roster-annual.ts` 顶部),所以它是读面,与
 * `/api/roster/enterprises` 同一档。真正落库的那一步仍然是
 * `POST /api/roster/import/commit`(带 token、单批事务、幂等键),一个字没变 ——
 * 预览因此**不可能**成为绕过写面鉴权的入口。
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { previewAnnualIncrement, validateAnnualBundle } from './roster-annual'
import { listImportBatches } from './roster-import'

type Db = BetterSQLite3Database<typeof schema>

export interface AnnualHttpRequest {
  /** 大写 HTTP 方法。 */
  method: string
  /** 已解析的请求体(JSON);解析失败给 `null`。 */
  body?: unknown
  /** 已解析的查询串(h3 `getQuery` 口径);不传按空处理。 */
  query?: Record<string, unknown>
}

export interface AnnualHttpResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

/** `POST /api/roster/import/annual/preview` —— 只读预览(不鉴权、不写任何行)。 */
export function handleAnnualPreviewRequest(request: AnnualHttpRequest, deps: { db: Db }): AnnualHttpResponse {
  if (request.method !== 'POST') return json(405, { message: '本端点是 POST：/api/roster/import/annual/preview' })

  const validated = validateAnnualBundle(request.body)
  if (!validated.ok) return json(validated.status, { message: validated.message })

  return json(200, previewAnnualIncrement(deps.db, validated.value))
}

/**
 * `GET /api/roster/import/batches` —— 最近的导入批次(可追溯 / 可重试的那一半)。
 *
 * 「应用结果和失败项可追溯」不需要新表:批次行本来就记着幂等键、来源、状态、摘要、
 * 逐项结果与错误(`import_batch`)。这里只按 id 倒序取最近若干条,不重算任何东西。
 */
export function handleImportBatchesRequest(request: AnnualHttpRequest, deps: { db: Db }): AnnualHttpResponse {
  if (request.method !== 'GET') return json(405, { message: '本端点是 GET：/api/roster/import/batches' })
  const limit = parseLimit(request.query?.limit)
  return json(200, { batches: listImportBatches(deps.db, limit) })
}

const DEFAULT_BATCH_LIMIT = 20
const MAX_BATCH_LIMIT = 200

function parseLimit(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_BATCH_LIMIT
  return Math.min(MAX_BATCH_LIMIT, Math.trunc(value))
}

function json(status: number, body: unknown): AnnualHttpResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body }
}
