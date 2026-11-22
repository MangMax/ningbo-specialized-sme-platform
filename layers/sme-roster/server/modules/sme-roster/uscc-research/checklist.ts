import { coreWordOf, type UsccChecklistFilter, type UsccChecklistResult, type UsccChecklistRow, type UsccInterfaceTrace, type UsccQueryTrace, type UsccSourceEvidence } from '#sme-roster/lib/roster/uscc-research'
import { TITLE_ORDER } from '#sme-roster/lib/labels'
import { MAX_PAGE_SIZE } from '#sme-roster/lib/query-limits'
import type { enterprise } from '../../../../../../db/postgresql/enterprise-tables'
import type { record, recordEvent, recordEvidence } from '../../../../../../db/postgresql/ledger-tables'
import type { differenceReason } from '../../../../../../db/postgresql/roster-selection-tables'
import type { PlatformStoredQuery } from '#sme-roster/lib/platform/read'
import type { selectUsccTargetRows } from '../../../utils/uscc-target-selection'

const DEFAULT_PAGE_SIZE = 50

export function projectUsccTargets(snap: UsccTargetSnapshot): UsccChecklistRow[] {
  const missing = snap.rows
  const recordsByEnterprise = new Map<number, (typeof snap.records)[number][]>()
  for (const record of snap.records) {
    const bucket = recordsByEnterprise.get(record.enterpriseId)
    if (bucket) bucket.push(record)
    else recordsByEnterprise.set(record.enterpriseId, [record])
  }
  // 索引一次后再按企业取：出处要沿 record → event → evidence 走三层，
  // 逐企业在全表里 filter 会把 133 × 记录数 × 事件数 × 出处数 变成天文数字。
  const eventsByRecord = new Map<number, (typeof snap.events)[number][]>()
  for (const event of snap.events) {
    const bucket = eventsByRecord.get(event.recordId)
    if (bucket) bucket.push(event)
    else eventsByRecord.set(event.recordId, [event])
  }
  const evidenceByEvent = new Map<number, (typeof snap.evidence)[number][]>()
  for (const item of snap.evidence) {
    const bucket = evidenceByEvent.get(item.recordEventId)
    if (bucket) bucket.push(item)
    else evidenceByEvent.set(item.recordEventId, [item])
  }
  const tracesByEnterprise = new Map<number, UsccInterfaceTrace[]>()
  for (const row of currentTraces(snap)) {
    const bucket = tracesByEnterprise.get(row.enterpriseId)
    if (bucket) bucket.push(row)
    else tracesByEnterprise.set(row.enterpriseId, [row])
  }
  // 平台**按名**查过的查询（`queryKey = name:<nameNorm>`）—— 无统代企业唯一可能查得到的形态。
  const nameQueries = snap.queries.filter((query) => query.queryKey.startsWith('name:'))
  const relationsByQuery = new Map<number, number>()
  for (const relation of snap.relationCounts) {
    relationsByQuery.set(relation.queryId, relation.count)
  }
  const queryTraceByEnterprise = new Map<number, UsccQueryTrace[]>()
  for (const query of nameQueries) {
    const norm = query.queryKey.slice('name:'.length)
    for (const enterprise of snap.enterprises) {
      if (enterprise.nameNorm !== norm) continue
      const bucket = queryTraceByEnterprise.get(enterprise.id) ?? []
      bucket.push({
        interface: query.interface,
        queryKey: query.queryKey,
        rdjb: query.rdjb,
        queriedAt: query.queriedAt,
        status: query.status,
        relationCount: relationsByQuery.get(query.id) ?? 0,
      })
      queryTraceByEnterprise.set(enterprise.id, bucket)
    }
  }

  const rows: UsccChecklistRow[] = missing.map((row) => {
    const evidence: UsccSourceEvidence[] = []
    for (const record of recordsByEnterprise.get(row.enterpriseId) ?? []) {
      for (const event of eventsByRecord.get(record.id) ?? []) {
        for (const item of evidenceByEvent.get(event.id) ?? []) {
          evidence.push({
            titleCode: record.titleCode,
            sourceFile: item.sourceFile,
            attachment: item.attachment,
            listNo: item.listNo,
            page: item.page,
          })
        }
      }
    }
    return {
      enterpriseId: row.enterpriseId,
      name: row.name,
      district: row.district,
      city: row.city,
      titles: row.titles,
      aliasNames: row.aliasNames,
      traces: (tracesByEnterprise.get(row.enterpriseId) ?? []).sort(
        (a, b) => titleRank(a.titleCode) - titleRank(b.titleCode) || a.direction.localeCompare(b.direction),
      ),
      evidence: evidence.sort(
        (a, b) =>
          titleRank(a.titleCode) - titleRank(b.titleCode) ||
          a.sourceFile.localeCompare(b.sourceFile) ||
          (a.listNo ?? 0) - (b.listNo ?? 0) ||
          (a.page ?? 0) - (b.page ?? 0),
      ),
      queries: (queryTraceByEnterprise.get(row.enterpriseId) ?? []).sort((a, b) =>
        a.queriedAt < b.queriedAt ? -1 : a.queriedAt > b.queriedAt ? 1 : 0,
      ),
      coreWord: coreWordOf(row.name),
    }
  })

  return rows.sort((a, b) => titleRank(a.titles[0] ?? '') - titleRank(b.titles[0] ?? '') || a.enterpriseId - b.enterpriseId)
}

/** 在**已取好的**清单行上分页（与 `listUsccChecklist` 同一口径，只是不重复全表扫描）。 */
export function pageUsccChecklist(
  targets: readonly UsccChecklistRow[],
  filter: Pick<UsccChecklistFilter, 'page' | 'pageSize'> = {},
): UsccChecklistResult {
  const titles: Record<string, number> = Object.fromEntries(TITLE_ORDER.map((code) => [code, 0]))
  for (const row of targets) for (const code of row.titles) titles[code] = (titles[code] ?? 0) + 1

  const page = Number.isFinite(filter.page) && (filter.page as number) >= 1 ? Math.floor(filter.page as number) : 1
  const size =
    Number.isFinite(filter.pageSize) && (filter.pageSize as number) >= 1
      ? Math.min(Math.floor(filter.pageSize as number), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE
  return {
    rows: [...targets].slice((page - 1) * size, page * size),
    counts: { total: targets.length, titles },
    page,
    pageSize: size,
  }
}

function titleRank(code: string): number {
  const i = TITLE_ORDER.indexOf(code)
  return i === -1 ? TITLE_ORDER.length : i
}

/**
 * 每 (企业 × 称号 × 方向) 的**当前**解释 = `recordedAt` 最新那条。
 * 与读侧（`layers/sme-roster/lib/roster/enterprise-roster.ts` 的 `currentExplanations`）同一口径。
 */
function currentTraces(snap: UsccTargetSnapshot): UsccInterfaceTrace[] {
  const current = new Map<string, (typeof snap.differences)[number]>()
  for (const row of snap.differences) {
    const key = `${row.enterpriseId}|${row.titleCode}|${row.direction}`
    const kept = current.get(key)
    if (!kept || row.recordedAt > kept.recordedAt) current.set(key, row)
  }
  return [...current.values()].map((row) => ({
    explanationId: row.id,
    enterpriseId: row.enterpriseId,
    titleCode: row.titleCode,
    direction: row.direction,
    status: row.status,
    reasonCode: row.reasonCode,
    reasonNote: row.reasonNote,
  }))
}

export type UsccTargetSnapshot = {
  rows: ReturnType<typeof selectUsccTargetRows>
  enterprises: Pick<typeof enterprise.$inferSelect, 'id' | 'name' | 'nameNorm' | 'district' | 'city'>[]
  records: Pick<typeof record.$inferSelect, 'id' | 'enterpriseId' | 'titleCode' | 'source' | 'district'>[]
  events: Pick<typeof recordEvent.$inferSelect, 'id' | 'recordId'>[]
  evidence: Pick<typeof recordEvidence.$inferSelect, 'recordEventId' | 'sourceFile' | 'attachment' | 'listNo' | 'page'>[]
  differences: Pick<typeof differenceReason.$inferSelect, 'id' | 'enterpriseId' | 'titleCode' | 'direction' | 'recordedAt' | 'status' | 'reasonCode' | 'reasonNote'>[]
  queries: Pick<PlatformStoredQuery, 'id' | 'interface' | 'queryKey' | 'rdjb' | 'queriedAt' | 'status'>[]
  relationCounts: { queryId: number; count: number }[]
}
