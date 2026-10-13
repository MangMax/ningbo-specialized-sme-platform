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
  /** in-memory cache: merge key -> enterprise id */
  enterpriseCache: Map<string, number>
}

export function newImportContext(batchId: number): ImportContext {
  return { batchId, enterpriseCache: new Map() }
}

function mergeKey(uscc: string | null, name: string): string {
  return uscc ? `uscc:${uscc}` : `name:${normalizeName(name)}`
}

/** 按身份键归并企业:优先统代,缺失时按归一化名称。命中缓存则复用。 */
function resolveEnterprise(db: Db, ctx: ImportContext, uscc: string | null, name: string): number {
  const key = mergeKey(uscc, name)
  const cached = ctx.enterpriseCache.get(key)
  if (cached !== undefined) return cached

  const existing = db
    .select({ id: schema.enterprise.id })
    .from(schema.enterprise)
    .where(uscc ? eq(schema.enterprise.usccNorm, uscc) : eq(schema.enterprise.nameNorm, normalizeName(name)))
    .get()

  const id =
    existing?.id ??
    db
      .insert(schema.enterprise)
      .values({
        usccNorm: uscc,
        name,
        nameNorm: normalizeName(name),
        qualityFlags: uscc ? [] : ['uscc_missing'],
      })
      .returning({ id: schema.enterprise.id })
      .get().id

  ctx.enterpriseCache.set(key, id)
  return id
}

/** 记录 = (企业, 称号, 来源);已存在则复用其 id。 */
function resolveRecord(db: Db, ctx: ImportContext, enterpriseId: number, titleCode: string, district: string | null): number {
  const existing = db
    .select({ id: schema.record.id })
    .from(schema.record)
    .where(
      and(
        eq(schema.record.enterpriseId, enterpriseId),
        eq(schema.record.titleCode, titleCode),
        eq(schema.record.source, 'jxj'),
      ),
    )
    .get()
  if (existing) return existing.id
  return db
    .insert(schema.record)
    .values({ importBatchId: ctx.batchId, enterpriseId, titleCode, source: 'jxj', district })
    .returning({ id: schema.record.id })
    .get().id
}

/** 幂等写入一批已解析的公布文件记录。 */
export function importEntries(db: Db, ctx: ImportContext, titleCode: string, entries: ParsedEntry[]): ImportStats {
  const stats: ImportStats = { entries: entries.length, enterprises: 0, records: 0, events: 0 }
  const seenEnterprise = new Set<number>()
  const seenRecord = new Set<number>()

  for (const e of entries) {
    const enterpriseId = resolveEnterprise(db, ctx, e.uscc, e.name)
    if (!seenEnterprise.has(enterpriseId)) {
      seenEnterprise.add(enterpriseId)
      stats.enterprises++
    }

    const recordId = resolveRecord(db, ctx, enterpriseId, titleCode, e.district || null)
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
