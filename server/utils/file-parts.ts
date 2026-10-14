import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeAttachment } from '../../lib/attachment'
import { aggregateParts, compareParts, type FilePart, type PartEvidence } from '../../lib/file-parts'

type Db = BetterSQLite3Database<typeof schema>

/** 回填统计(用于接口回报与验收核对)。 */
export interface PartsBackfillStats {
  /** 落到了段的文件数。 */
  files: number
  /** 写入的段总数。 */
  parts: number
  /** 有 `record_evidence` 引用、但库里没有对应 `stored_file` 行的路径(跳过,不猜)。 */
  orphanPaths: string[]
}

/** 一条 `record_evidence` 折算出的段坐标,外加它属于哪个文件。 */
interface EvidencePartRow extends PartEvidence {
  relPath: string
}

/**
 * 把 `record_evidence` 连同它的记录/事件**摊平**成「这条引用落在哪个文件、哪一段」。
 *
 * 一次 join 出全部坐标(约两万行,SQLite 上毫秒级),聚合与排序交给纯函数
 * `lib/file-parts.ts` 的 `aggregateParts` —— 口径可单测,不埋在 SQL 里。
 */
export function readEvidencePartRows(db: Db): EvidencePartRow[] {
  return db
    .select({
      relPath: schema.recordEvidence.sourceFile,
      titleCode: schema.record.titleCode,
      eventKind: schema.recordEvent.eventType,
      year: schema.recordEvent.year,
      batch: schema.recordEvent.batchSeq,
      attachment: schema.recordEvidence.attachment,
    })
    .from(schema.recordEvidence)
    .innerJoin(schema.recordEvent, eq(schema.recordEvent.id, schema.recordEvidence.recordEventId))
    .innerJoin(schema.record, eq(schema.record.id, schema.recordEvent.recordId))
    .all() as EvidencePartRow[]
}

/**
 * 从 `record_evidence` 回填 `stored_file_part`。**幂等**:每个文件先删段、再按聚合结果插入,
 * 重跑结果完全一致。
 *
 * 口径(票 17):
 *  - **只回填有引用的文件** —— 没有 `record_evidence` 的文件(实测 2 份 `.doc`)这时还不知道
 *    里面有什么,留空交给票 11 解析时按段写入,而不是猜一个。
 *  - **遍历全部 `stored_file` 行**(不只是有引用的那些),因为段整体派生于 evidence:
 *    某个文件原先有引用、后来引用被清掉时,这样才会把**残留的段一起清掉**,
 *    而不是留下一份与 evidence 对不上的旧段。
 *  - 有引用但库里没有对应 `stored_file` 行的路径(漏扫 / 已移出库)一并报出、跳过。
 *  - 附件名按 `lib/attachment.ts` 归一后再聚合 —— 「附 件 1」与「附件1」必须并成同一段。
 */
export function backfillFileParts(db: Db): PartsBackfillStats {
  const byPath = new Map<string, PartEvidence[]>()
  for (const row of readEvidencePartRows(db)) {
    const evidence: PartEvidence = {
      titleCode: row.titleCode,
      eventKind: row.eventKind,
      year: row.year,
      batch: row.batch,
      attachment: normalizeAttachment(row.attachment),
    }
    const list = byPath.get(row.relPath)
    if (list) list.push(evidence)
    else byPath.set(row.relPath, [evidence])
  }

  const files = db
    .select({ id: schema.storedFile.id, relPath: schema.storedFile.relPath })
    .from(schema.storedFile)
    .all()
  const knownPaths = new Set(files.map((f) => f.relPath))

  const stats: PartsBackfillStats = { files: 0, parts: 0, orphanPaths: [] }
  for (const relPath of byPath.keys()) {
    if (!knownPaths.has(relPath)) stats.orphanPaths.push(relPath)
  }

  db.transaction((tx) => {
    for (const file of files) {
      const parts = aggregateParts(byPath.get(file.relPath) ?? [])
      // 先删后插:本表全部派生于 evidence,重建无损;这一条既保证重跑幂等,
      // 也保证「evidence 没了 → 段跟着没」。
      tx.delete(schema.storedFilePart).where(eq(schema.storedFilePart.fileId, file.id)).run()
      if (!parts.length) continue
      tx.insert(schema.storedFilePart)
        .values(parts.map((p) => ({ fileId: file.id, ...p })))
        .run()
      stats.files += 1
      stats.parts += parts.length
    }
  })

  return stats
}

/** 按文件取段,排好展示顺序。返回 `fileId → 段[]`(没有段的文件不出现在 Map 里)。 */
export function listFileParts(db: Db, fileIds: readonly number[]): Map<number, FilePart[]> {
  const map = new Map<number, FilePart[]>()
  if (!fileIds.length) return map

  const rows = db
    .select({
      fileId: schema.storedFilePart.fileId,
      titleCode: schema.storedFilePart.titleCode,
      eventKind: schema.storedFilePart.eventKind,
      year: schema.storedFilePart.year,
      batch: schema.storedFilePart.batch,
      attachment: schema.storedFilePart.attachment,
      rowCount: schema.storedFilePart.rowCount,
    })
    .from(schema.storedFilePart)
    .where(inArray(schema.storedFilePart.fileId, [...fileIds]))
    .all()

  for (const row of rows) {
    const part: FilePart = {
      titleCode: row.titleCode,
      eventKind: row.eventKind,
      year: row.year,
      batch: row.batch,
      attachment: row.attachment,
      rowCount: row.rowCount,
    }
    const list = map.get(row.fileId)
    if (list) list.push(part)
    else map.set(row.fileId, [part])
  }

  for (const list of map.values()) list.sort(compareParts)
  return map
}
