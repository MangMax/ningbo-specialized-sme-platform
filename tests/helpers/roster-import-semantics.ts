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
 * 于此之外一个字节都不改：所有列、所有 `item_results`、所有血缘都原样进快照。
 * 黄金文件与判据见 `tests/roster-import-semantics.test.ts`。
 */

import { schema, type useDb } from '../../db'

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

/** 快照当前库里所有相关表（未规范化前的原始行）。 */
function readTables(db: ReturnType<typeof useDb>): RosterStateTables {
  return {
    importBatch: canonical(db.select().from(schema.importBatch).all()),
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
export function createSemanticRecorder(db: ReturnType<typeof useDb>) {
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
      steps.push({ label, outcome, rowCounts, changed })
      previous = current
    },
  }
}
