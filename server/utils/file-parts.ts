import { and, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeAttachment } from '../../lib/attachment'
import {
  aggregateParts,
  compareParts,
  partKey,
  type FilePart,
  type PartEvidence,
  type StoredFilePart,
} from '../../lib/file-parts'

type Db = BetterSQLite3Database<typeof schema>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Executor = Db | Tx

/** 回填统计(用于接口回报与验收核对)。 */
export interface PartsBackfillStats {
  /** 落到了段的文件数。 */
  files: number
  /** evidence 聚合出的坐标数(含同坐标由 agent 行承接的部分)。 */
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
export function readEvidencePartRows(db: Executor, relPath?: string): EvidencePartRow[] {
  const query = db
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
  return (relPath === undefined
    ? query.all()
    : query.where(eq(schema.recordEvidence.sourceFile, relPath)).all()) as EvidencePartRow[]
}

/** 按文件读取并聚合 evidence,供代理全量替换时恢复被旧代理结果覆盖的派生坐标。 */
export function derivedPartsForFile(db: Executor, fileId: number): FilePart[] {
  const file = db
    .select({ relPath: schema.storedFile.relPath })
    .from(schema.storedFile)
    .where(eq(schema.storedFile.id, fileId))
    .get()
  if (!file) return []

  return aggregateParts(
    readEvidencePartRows(db, file.relPath).map((row) => ({
      titleCode: row.titleCode,
      eventKind: row.eventKind,
      year: row.year,
      batch: row.batch,
      attachment: normalizeAttachment(row.attachment),
    })),
  )
}

/** Refresh only affected files inside the caller's mutation transaction; declarations retain IDs/origins. */
export function refreshDerivedFileParts(db: Executor, sourceFiles: Iterable<string>): void {
  const paths = [...new Set(sourceFiles)]
  if (!paths.length) return
  const files = db.select({ id: schema.storedFile.id }).from(schema.storedFile)
    .where(inArray(schema.storedFile.relPath, paths)).all()
  for (const file of files) {
    const parts = derivedPartsForFile(db, file.id)
    const preserved = db.select().from(schema.storedFilePart)
      .where(and(eq(schema.storedFilePart.fileId, file.id), inArray(schema.storedFilePart.origin, ['agent', 'legacy']))).all()
    const byKey = new Map(preserved.map(row => [partKey(row), row]))
    const derivedByKey = new Map(parts.map(part => [partKey(part), part]))
    for (const row of preserved) {
      const derived = derivedByKey.get(partKey(row))
      // An independent declaration without ledger references is still a declaration, not a conflict.
      db.update(schema.storedFilePart).set({ hasConflict: !!derived && row.rowCount !== derived.rowCount })
        .where(eq(schema.storedFilePart.id, row.id)).run()
    }
    db.delete(schema.storedFilePart).where(and(eq(schema.storedFilePart.fileId, file.id), eq(schema.storedFilePart.origin, 'derived'))).run()
    for (const part of parts) {
      if (!byKey.has(partKey(part))) db.insert(schema.storedFilePart).values({ fileId: file.id, ...part, origin: 'derived', hasConflict: false }).run()
    }
  }
}

/**
 * 从 `record_evidence` 回填 `stored_file_part`。**幂等**:只删除每个文件的派生段,再按聚合结果
 * 插入;代理段保留,并与同坐标派生结果比较行数以刷新 `hasConflict`。
 *
 * 口径(票 17):
 *  - **只回填有引用的文件** —— 没有 `record_evidence` 的文件(实测 2 份 `.doc`)这时还不知道
 *    里面有什么,留空交给票 11 解析时按段写入,而不是猜一个。
 *  - **遍历全部 `stored_file` 行**(不只是有引用的那些),因为派生段整体来自 evidence:
 *    某个文件原先有引用、后来引用被清掉时,要把**派生段一起清掉**;代理段仍保留。
 *  - 有引用但库里没有对应 `stored_file` 行的路径(漏扫 / 已移出库)一并报出、跳过。
 *  - 附件名按 `lib/attachment.ts` 归一后再聚合 —— 「附 件 1」与「附件1」必须并成同一段。
 *  - 同坐标已有代理段时保留代理行;行数不一致则标记冲突,相等表示两来源一致。
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
    const preservedRows = tx
      .select()
      .from(schema.storedFilePart)
      .where(inArray(schema.storedFilePart.origin, ['agent', 'legacy']))
      .all()
    const preservedByFile = new Map<number, Map<string, (typeof preservedRows)[number]>>()
    for (const row of preservedRows) {
      const list = preservedByFile.get(row.fileId) ?? new Map()
      list.set(partKey(row), row)
      preservedByFile.set(row.fileId, list)
    }

    for (const file of files) {
      const parts = aggregateParts(byPath.get(file.relPath) ?? [])
      const preserved = preservedByFile.get(file.id) ?? new Map()

      // 每趟重新比较 evidence,所以冲突会随来源数据变化而清除或重现。
      tx.update(schema.storedFilePart)
        .set({ hasConflict: false })
        .where(
          and(
            eq(schema.storedFilePart.fileId, file.id),
            inArray(schema.storedFilePart.origin, ['agent', 'legacy']),
          ),
        )
        .run()
      tx.delete(schema.storedFilePart)
        .where(
          and(
            eq(schema.storedFilePart.fileId, file.id),
            eq(schema.storedFilePart.origin, 'derived'),
          ),
        )
        .run()

      for (const part of parts) {
        const existing = preserved.get(partKey(part))
        if (existing) {
          if (existing.rowCount !== part.rowCount) {
            tx.update(schema.storedFilePart)
              .set({ hasConflict: true })
              .where(eq(schema.storedFilePart.id, existing.id))
              .run()
          } else if (existing.origin === 'legacy') {
            // 这条旧行与当前派生结果完全相同,可安全归回 derived,后续回填就能正常重建。
            tx.update(schema.storedFilePart)
              .set({ origin: 'derived', hasConflict: false })
              .where(eq(schema.storedFilePart.id, existing.id))
              .run()
          }
          continue
        }

        tx.insert(schema.storedFilePart)
          .values({ fileId: file.id, ...part, origin: 'derived', hasConflict: false })
          .run()
      }

      if (parts.length) {
        stats.files += 1
        stats.parts += parts.length
      }
    }
  })

  return stats
}

/** 按文件取段,排好展示顺序。返回 `fileId → 段[]`(没有段的文件不出现在 Map 里)。 */
export function listFileParts(db: Db, fileIds: readonly number[]): Map<number, StoredFilePart[]> {
  const map = new Map<number, StoredFilePart[]>()
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
      origin: schema.storedFilePart.origin,
      hasConflict: schema.storedFilePart.hasConflict,
    })
    .from(schema.storedFilePart)
    .where(inArray(schema.storedFilePart.fileId, [...fileIds]))
    .all()

  for (const row of rows) {
    const part: StoredFilePart = {
      titleCode: row.titleCode,
      eventKind: row.eventKind,
      year: row.year,
      batch: row.batch,
      attachment: row.attachment,
      rowCount: row.rowCount,
      origin: row.origin,
      hasConflict: row.hasConflict,
    }
    const list = map.get(row.fileId)
    if (list) list.push(part)
    else map.set(row.fileId, [part])
  }

  for (const list of map.values()) list.sort(compareParts)
  return map
}
