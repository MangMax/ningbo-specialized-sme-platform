/**
 * 平台导出快照**读接口的 HTTP 面**(RL-05)—— 把核心逻辑翻成状态码 + JSON(契约 §7.7)。
 *
 * ── 为什么与 `roster-import-http.ts` 同一个分法 ───────────────────────────
 * 判据(参数怎么读、非法怎么报)留成**不 import h3** 的纯函数,贴到 Nitro 上只是最薄的
 * 一层。于是同一份实现既能被路由调用,也能被**真实 HTTP 回放测试**
 * (`tests/helpers/platform-snapshot-http-server.ts` 起一个 node:http 服务)直接驱动
 * —— 契约只有一份,测试打的不是另写的替身(与 RL-11 的 `handleRosterImportRequest` 同构)。
 *
 * 读接口**不鉴权**(与既有分法一致:读不鉴权,写/任务鉴权)。
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import {
  diffPlatformSnapshots,
  getPlatformExportRows,
  getPlatformSnapshotBatch,
  listPlatformSnapshots,
  type PlatformSnapshotBatch,
} from '../../lib/platform-snapshots'
import { parseIntegerList, parsePositiveInt, toList } from './platform-snapshot-query'

type Db = BetterSQLite3Database<typeof schema>

export type PlatformSnapshotAction = 'snapshots' | 'diff'

export interface PlatformSnapshotHttpRequest {
  /** 大写 HTTP 方法;本面只接受 GET。 */
  method: string
  /** 已解析的查询参数(h3 `getQuery` / URLSearchParams 都可)。 */
  query: Record<string, unknown>
}

export interface PlatformSnapshotHttpResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

/** 处理一次快照读请求。`db` 由调用方给(路由用 `useDb()`;测试用临时库)。 */
export function handlePlatformSnapshotRequest(
  action: PlatformSnapshotAction,
  request: PlatformSnapshotHttpRequest,
  deps: { db: Db },
): PlatformSnapshotHttpResponse {
  const path = action === 'diff' ? '/api/platform/snapshots/diff' : '/api/platform/snapshots'
  if (request.method !== 'GET') return json(405, { message: `本端点是 GET:${path}` })
  return action === 'diff' ? diffAction(deps.db, request.query) : listAction(deps.db, request.query)
}

function listAction(db: Db, query: Record<string, unknown>): PlatformSnapshotHttpResponse {
  const { values: years, invalid } = parseIntegerList(query.year)
  if (invalid.length) {
    return json(400, { message: `年度参数必须是正整数:${invalid.join(',')}` })
  }
  const rows = listPlatformSnapshots(db, { title: toList(query.title), year: years })
  return json(200, { rows, count: rows.length })
}

function diffAction(db: Db, query: Record<string, unknown>): PlatformSnapshotHttpResponse {
  const fromId = parsePositiveInt(query.from)
  const toId = parsePositiveInt(query.to)
  if (fromId === null || toId === null) {
    return json(400, { message: '需要正整数参数 from 与 to(两个快照批次 id)。' })
  }

  const from = getPlatformSnapshotBatch(db, fromId)
  const to = getPlatformSnapshotBatch(db, toId)
  if (!from || !to) {
    return json(404, { message: `快照批次不存在:${!from ? `from=${fromId} ` : ''}${!to ? `to=${toId}` : ''}` })
  }
  if (from.titleCode !== to.titleCode) {
    return json(400, { message: `两批称号不同(${from.titleCode} vs ${to.titleCode}),不能相互比较。` })
  }

  const diff = diffPlatformSnapshots(getPlatformExportRows(db, fromId), getPlatformExportRows(db, toId))
  return json(200, { from: summarize(from), to: summarize(to), diff })
}

/** 比较结果里附带的批次摘要(够看清是哪两版,不塞整批行)。 */
function summarize(batch: PlatformSnapshotBatch) {
  return {
    id: batch.id,
    titleCode: batch.titleCode,
    year: batch.year,
    collectedOn: batch.collectedOn,
    originalFilename: batch.originalFilename,
    sha256: batch.sha256,
    importStatus: batch.importStatus,
    replacedBatchId: batch.replacedBatchId,
  }
}

function json(status: number, body: unknown): PlatformSnapshotHttpResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body }
}
