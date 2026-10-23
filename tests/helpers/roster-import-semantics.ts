/**
 * RL-18 —— 写入侧的**语义快照**夹具（改前/改后逐字比对用）。
 *
 * 本票只改「怎么找既有行」，**不改**「找到之后做什么」。这句话要能被机器验证，
 * 而不是只写在汇报里：于是这里把一整套有代表性的批次（七张表 + 事件/出处 + 重名候选 +
 * 归并血缘 + 幂等重放 + 逐项错误的失败批次 + 导出快照）跑进一个全新库，然后把
 * **可观察的写入结果**规范化成一份可逐字比对的 JSON。
 *
 * ── 规范化只做三件事，别的一律原样留 ────────────────────────────────────────
 *  1. **丢掉挂钟时间列** `createdAt` / `committedAt` —— 它们是 `new Date().toISOString()`，
 *     同一份输入跑两次也不相等，留着就没法逐字比对；
 *  2. **按 `id` 升序** —— 自增 id 在「全新库 + 同一插入顺序」下是确定的，排序让顺序也确定；
 *  3. **逐步只记变化的表** —— 每一步都记 `rowCounts`（全部表，用来抓「多出来/少掉了行」），
 *     但 `changed` 里只放内容**与上一步不同**的表。按顺序把 `changed` 叠起来就是每一步的
 *     完整状态；不叠的话同一批行会在 7 个步骤里重复 7 遍，黄金文件白白大三倍。
 *
 * `item_results` 摘要按调用方可见投影计算；重放目标快照与请求指纹属于服务端记账，
 * 由 replay 路径另行覆盖，不纳入 API 可观察语义黄金。其他结果与所有列仍按原样进快照。
 * 黄金文件与判据见 `tests/roster-import-semantics.test.ts`。
 * #244 的 canonicalProjection 是独立验收的增量响应（platform-business-record*.test.ts）。
 * 本记录器仅在预检/摘要/item.detail 的明确位置去掉它，继续与旧黄金逐字比较全部旧字段；
 * 不改 rawFields、不重生成旧黄金，也不忽略其它差异。
 */

import { createHash } from 'node:crypto'
import { schema, useDb } from '../../db'

/** 本文件里到处要用的库句柄类型（与 `tests/roster-import-api.test.ts` 的 `makeDb()` 同一个返回值）。 */
type TestDb = ReturnType<typeof useDb>

/** 名录写入面能碰到的全部表。 */
export interface RosterStateTables {
  importBatch: unknown[]
  enterprise: unknown[]
  sourceDocument: unknown[]
  record: unknown[]
  recordEvent: unknown[]
  recordEvidence: unknown[]
  enterpriseAlias: unknown[]
  platformQuery: unknown[]
  platformRelation: unknown[]
  differenceReason: unknown[]
  platformExportBatch: unknown[]
  platformExportRow: unknown[]
}

export type RosterStateTableName = keyof RosterStateTables

/** 规范化一张表的全部行（丢挂钟时间列 + 按 `id` 升序）。 */
function canonical(rows: Array<Record<string, unknown>>): unknown[] {
  return rows
    .map((row) => {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(row).sort()) {
        if (key === 'createdAt' || key === 'committedAt') continue
        out[key] = row[key]
      }
      return out
    })
    .sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0))
}

/**
 * 一块大 JSON 列的**摘要**。
 *
 * `import_batch` 的 `preflightResult` / `itemResults` / `summary` 是整批逐项结果的原文，
 * 一块就几 KB —— 直接进黄金文件的话，光是它们就占了这个夹具三分之二的字节，而它们
 * **逐步都与同一步的 `outcome` 逐字重复**（`outcome` 就是那一次调用的返回值，里面
 * 带着同一份 `items` / `summary`）。所以这里留摘要：内容一变摘要就变，回归照样抓得住，
 * 而人读的那一份在 `outcome` 里。
 */
function digest(value: unknown): string | null {
  if (value == null) return null
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

/** 去掉仅供 replay 使用的内部细节，与统一导入 API 的 item 响应投影保持一致。 */
function observableItemResults(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const item = raw as Record<string, unknown>
    if (!item.detail || typeof item.detail !== 'object' || Array.isArray(item.detail)) return raw
    const originalDetail = item.detail as Record<string, unknown>
    const detail = { ...originalDetail }
    delete detail.evidenceRepointTargets
    delete detail.evidenceRepointPlanFingerprint
    delete detail.canonicalProjection
    if (Object.keys(detail).length === Object.keys(originalDetail).length) return raw
    const projected = { ...item }
    if (Object.keys(detail).length > 0) projected.detail = detail
    else delete projected.detail
    return projected
  })
}

function legacyProjectionFields(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const { canonicalProjection: _projection, platformObservationSources: _sources, ...legacy } = value as Record<string, unknown>
  return legacy
}

function legacyOutcome(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const out = { ...value as Record<string, unknown> }
  if ('preflight' in out) out.preflight = legacyProjectionFields(out.preflight)
  if ('summary' in out) out.summary = legacyProjectionFields(out.summary)
  if ('items' in out) out.items = observableItemResults(out.items)
  return out
}

/** `import_batch` 行：三块大 JSON 列换成 {@link digest}。 */
function bookkeepingRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (key === 'preflightResult') out.preflightResultSha = digest(legacyProjectionFields(value))
    else if (key === 'itemResults') out.itemResultsSha = digest(observableItemResults(value))
    else if (key === 'summary') out.summarySha = digest(legacyProjectionFields(value))
    else out[key] = value
  }
  return out
}

/** 快照当前库里所有相关表（未规范化前的原始行）。 */
function readTables(db: TestDb): RosterStateTables {
  return {
    importBatch: canonical(db.select().from(schema.importBatch).all().map(bookkeepingRow)),
    enterprise: canonical(db.select().from(schema.enterprise).all()),
    sourceDocument: canonical(db.select().from(schema.sourceDocument).all()),
    record: canonical(db.select().from(schema.record).all()),
    recordEvent: canonical(db.select().from(schema.recordEvent).all()),
    recordEvidence: canonical(db.select().from(schema.recordEvidence).all()),
    enterpriseAlias: canonical(db.select().from(schema.enterpriseAlias).all()),
    platformQuery: canonical(db.select().from(schema.platformQuery).all()),
    platformRelation: canonical(db.select().from(schema.platformRelation).all()),
    differenceReason: canonical(db.select().from(schema.differenceReason).all()),
    platformExportBatch: canonical(db.select().from(schema.platformExportBatch).all()),
    platformExportRow: canonical(db.select().from(schema.platformExportRow).all()),
  }
}

/** 一步操作后的快照。 */
export interface SnapshotStep {
  /** 夹具给的标签，说明这一步做了什么。 */
  label: string
  /** `commitRosterImport` / `preflightRosterImport` 返回值里**稳定**的那几项。 */
  outcome: unknown
  /** 每一步都记：各表行数（抓「多出来/少掉了行」）。 */
  rowCounts: Record<string, number>
  /** 只放内容与上一步不同的表（见文件头第 3 条）。 */
  changed: Partial<RosterStateTables>
}

/**
 * 造一个**逐步记录器**：每调一次就把当前状态与上一步比，只留变了的表。
 * 传入同一个 `db`，并且**按时间顺序**调用。
 */
export function createSemanticRecorder(db: TestDb) {
  let previous: RosterStateTables | null = null
  const steps: SnapshotStep[] = []
  return {
    steps,
    /** 记一步。`outcome` 是那一次 `preflight` / `commit` 的返回值。 */
    capture(label: string, outcome: unknown): void {
      const current = readTables(db)
      const rowCounts: Record<string, number> = {}
      const changed: Partial<RosterStateTables> = {}
      for (const name of Object.keys(current) as RosterStateTableName[]) {
        rowCounts[name] = current[name].length
        if (!previous || JSON.stringify(previous[name]) !== JSON.stringify(current[name])) {
          changed[name] = current[name]
        }
      }
      steps.push({ label, outcome: legacyOutcome(outcome), rowCounts, changed })
      previous = current
    },
  }
}
