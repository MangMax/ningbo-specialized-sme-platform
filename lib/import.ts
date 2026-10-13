import { and, eq, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { normalizeName } from './normalize'
import type { ParsedEntry } from './announcement'

type Db = BetterSQLite3Database<typeof schema>

export interface ImportStats {
  entries: number
  enterprises: number
  records: number
  events: number
}

export interface ImportContext {
  batchId: number
  /** 身份索引:归一化统代 → 企业 id */
  usccIndex: Map<string, number>
  /** 身份索引:归一化名称 → 企业 id */
  nameIndex: Map<string, number>
}

export function newImportContext(batchId: number): ImportContext {
  return { batchId, usccIndex: new Map(), nameIndex: new Map() }
}

/**
 * 幂等地取得/创建导入快照 `import_batch`。
 *
 * **快照身份 = label**。同一个 label(默认是导入当天日期)重复导入时**复用同一条
 * `import_batch`,不新建、不改 `imported_at`**,从而保证「同一目录 + 同一 label
 * 重跑两次,所有表行数不变」。换一份数据目录/换一个 label 时才会产生新快照。
 * 见 SPEC「每次导入产生一个不可变快照」「导入是幂等的」。
 */
export function openImportBatch(
  db: Db,
  label: string,
  sourceRoot: string,
  note?: string,
): number {
  const existing = db
    .select({ id: schema.importBatch.id })
    .from(schema.importBatch)
    .where(eq(schema.importBatch.label, label))
    .get()
  if (existing) return existing.id
  return db
    .insert(schema.importBatch)
    .values({ label, sourceRoot, note })
    .returning({ id: schema.importBatch.id })
    .get().id
}

/**
 * 归并企业:优先统代,缺失时按归一化名称。
 *
 * 关键:经信局公布文件多无统代(先按名称建企业),而工信部名单全带统代。
 * 当后续记录带来统代时,须与先前的“按名称”企业**合并**为同一主体,否则同一企业会重复。
 * 见 ADR-2026-10-13-uscc-as-identity。
 */
function resolveEnterprise(db: Db, ctx: ImportContext, uscc: string | null, name: string, district: string | null): number {
  const nnorm = normalizeName(name)
  const dist = district || null

  if (uscc) {
    const knownUscc = ctx.usccIndex.get(uscc) ?? db.select({ id: schema.enterprise.id }).from(schema.enterprise).where(eq(schema.enterprise.usccNorm, uscc)).get()?.id
    if (knownUscc !== undefined) {
      ctx.nameIndex.set(nnorm, knownUscc)
      return knownUscc
    }
    // 尚无此统代:若已有同名且无统代的企业,提升它(合并),而非新建。
    const byName = db
      .select({ id: schema.enterprise.id, usccNorm: schema.enterprise.usccNorm })
      .from(schema.enterprise)
      .where(and(eq(schema.enterprise.nameNorm, nnorm), isNull(schema.enterprise.usccNorm)))
      .get()
    if (byName) {
      db.update(schema.enterprise)
        .set({ usccNorm: uscc, qualityFlags: [] })
        .where(eq(schema.enterprise.id, byName.id))
        .run()
      ctx.usccIndex.set(uscc, byName.id)
      ctx.nameIndex.set(nnorm, byName.id)
      return byName.id
    }
    const created = db
      .insert(schema.enterprise)
      .values({ usccNorm: uscc, name, nameNorm: nnorm, district: dist })
      .returning({ id: schema.enterprise.id })
      .get().id
    ctx.usccIndex.set(uscc, created)
    ctx.nameIndex.set(nnorm, created)
    return created
  }

  const byNameId = db.select({ id: schema.enterprise.id }).from(schema.enterprise).where(eq(schema.enterprise.nameNorm, nnorm)).get()?.id
  if (byNameId !== undefined) {
    ctx.nameIndex.set(nnorm, byNameId)
    return byNameId
  }
  const created = db
    .insert(schema.enterprise)
    .values({ usccNorm: null, name, nameNorm: nnorm, district: dist, qualityFlags: ['uscc_missing'] })
    .returning({ id: schema.enterprise.id })
    .get().id
  ctx.nameIndex.set(nnorm, created)
  return created
}

/**
 * 记录 = (企业, 称号, 来源);按身份键全局复用其 id。
 *
 * **快照归属:采用「跟随最近一次包含该记录的导入」**(更新为本次 `ctx.batchId`),
 * 而非「保留首次归属」。理由:看板需要「切换到某个快照 = 看那次导入当时的记录集」;
 * 若保留首次归属,则新快照筛选几乎为空、无法表达「本次导入带来了哪些记录」。
 * 依赖「快照身份 = label」:同 label 重跑时 batchId 不变,故这里不会产生任何写操作,
 * 幂等性不受影响。
 */
function resolveRecord(
  db: Db,
  ctx: ImportContext,
  enterpriseId: number,
  titleCode: string,
  source: 'jxj' | 'miit',
  district: string | null,
): number {
  const existing = db
    .select({ id: schema.record.id, importBatchId: schema.record.importBatchId })
    .from(schema.record)
    .where(
      and(
        eq(schema.record.enterpriseId, enterpriseId),
        eq(schema.record.titleCode, titleCode),
        eq(schema.record.source, source),
      ),
    )
    .get()
  if (existing) {
    if (existing.importBatchId !== ctx.batchId) {
      db.update(schema.record)
        .set({ importBatchId: ctx.batchId })
        .where(eq(schema.record.id, existing.id))
        .run()
    }
    return existing.id
  }
  return db
    .insert(schema.record)
    .values({ importBatchId: ctx.batchId, enterpriseId, titleCode, source, district })
    .returning({ id: schema.record.id })
    .get().id
}

/** 幂等写入一批已解析的记录。 */
export function importEntries(db: Db, ctx: ImportContext, titleCode: string, entries: ParsedEntry[]): ImportStats {
  const stats: ImportStats = { entries: entries.length, enterprises: 0, records: 0, events: 0 }
  const seenEnterprise = new Set<number>()
  const seenRecord = new Set<number>()

  for (const e of entries) {
    const enterpriseId = resolveEnterprise(db, ctx, e.uscc, e.name, e.district)
    if (!seenEnterprise.has(enterpriseId)) {
      seenEnterprise.add(enterpriseId)
      stats.enterprises++
    }

    const recordId = resolveRecord(db, ctx, enterpriseId, titleCode, e.source, e.district || null)
    if (!seenRecord.has(recordId)) {
      seenRecord.add(recordId)
      stats.records++
    }

    const eventExists = db
      .select({ id: schema.recordEvent.id })
      .from(schema.recordEvent)
      .where(
        and(
          eq(schema.recordEvent.recordId, recordId),
          eq(schema.recordEvent.eventType, e.eventType),
          e.year === null ? isNull(schema.recordEvent.year) : eq(schema.recordEvent.year, e.year),
          e.seq === null ? isNull(schema.recordEvent.batchSeq) : eq(schema.recordEvent.batchSeq, e.seq),
        ),
      )
      .get()
    if (eventExists) continue

    const eventId = db
      .insert(schema.recordEvent)
      .values({
        recordId,
        eventType: e.eventType,
        year: e.year,
        batchSeq: e.seq,
        sortKey: (e.year ?? 0) * 10 + (e.seq ?? 0),
      })
      .returning({ id: schema.recordEvent.id })
      .get().id
    stats.events++

    db.insert(schema.recordEvidence)
      .values({ recordEventId: eventId, sourceFile: e.sourceFile, attachment: e.attachment, listNo: e.listNo })
      .run()
  }
  return stats
}
