import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { type PlatformSnapshotBatch, type PlatformSnapshotListItem, type PlatformSnapshotQuery, type SnapshotRow } from '../../lib/platform-snapshots'
import { diffPlatformSnapshots } from '../../lib/platform-snapshot-diff'
import { readPostgresSnapshotBatches, readPostgresSnapshotRows } from '../../lib/platform-snapshots-postgres'
import { parseIntegerList, parsePositiveInt, toList } from './platform-snapshot-query'

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

export async function handlePostgresPlatformSnapshotRequest(
  action: PlatformSnapshotAction, request: PlatformSnapshotHttpRequest, db: NodePgDatabase,
): Promise<PlatformSnapshotHttpResponse> {
  const selection = parseSnapshotRequest(action, request)
  if ('status' in selection) return selection
  if (selection.action === 'snapshots') {
    const batches = await readPostgresSnapshotBatches(db, selection.filter)
    return listResult(batches.map(batch => ({
      batch, replacedBatchId: batch.replacedBatchId, rowCount: batch.rowCount, importStatus: batch.importStatus,
    })))
  }
  const { fromId, toId } = selection
  return db.transaction(async tx => {
    const batches = await readPostgresSnapshotBatches(tx, { batchIds: [fromId, toId] })
    const from = batches.find(batch => batch.id === fromId)
    const to = batches.find(batch => batch.id === toId)
    if (!from || !to || from.titleCode !== to.titleCode) return invalidDiff(fromId, toId, from, to)
    const rows = await readPostgresSnapshotRows(tx, [fromId, toId])
    return diffResult(from, to, rows.get(fromId) ?? [], rows.get(toId) ?? [])
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export function parseSnapshotRequest(action: PlatformSnapshotAction, { method, query }: PlatformSnapshotHttpRequest):
  | { action: 'snapshots'; filter: PlatformSnapshotQuery }
  | { action: 'diff'; fromId: number; toId: number }
  | PlatformSnapshotHttpResponse {
  if (method !== 'GET') {
    const path = action === 'diff' ? '/api/platform/snapshots/diff' : '/api/platform/snapshots'
    return json(405, { message: `本端点是 GET:${path}` })
  }
  if (action === 'snapshots') {
    const { values: year, invalid } = parseIntegerList(query.year)
    if (invalid.length) return json(400, { message: `年度参数必须是正整数:${invalid.join(',')}` })
    return { action, filter: { title: toList(query.title), year } }
  }
  const fromId = parsePositiveInt(query.from)
  const toId = parsePositiveInt(query.to)
  if (fromId === null || toId === null) return json(400, { message: '需要正整数参数 from 与 to(两个快照批次 id)。' })
  return { action, fromId, toId }
}

export function listResult(rows: PlatformSnapshotListItem[]) {
  return json(200, { rows, count: rows.length })
}

export function invalidDiff(fromId: number, toId: number, from: PlatformSnapshotBatch | null | undefined, to: PlatformSnapshotBatch | null | undefined) {
  if (!from || !to) {
    return json(404, { message: `快照批次不存在:${!from ? `from=${fromId} ` : ''}${!to ? `to=${toId}` : ''}` })
  }
  return json(400, { message: `两批称号不同(${from.titleCode} vs ${to.titleCode}),不能相互比较。` })
}

export function diffResult(from: PlatformSnapshotBatch, to: PlatformSnapshotBatch, fromRows: SnapshotRow[], toRows: SnapshotRow[]) {
  return json(200, { from: summarize(from), to: summarize(to), diff: diffPlatformSnapshots(fromRows, toRows) })
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
