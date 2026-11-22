import { MAX_PAGE_SIZE } from './query-limits'
import { type OfficialPublishedFact } from './roster/official-published-presentation'
import { readPublicPublishedNames } from './roster/official-published-presentation-sqlite'
import { and, desc, eq, exists, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm'
import { compact } from 'es-toolkit'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../db/schema'
import { normalizeName } from './domain'
import { TITLE_ORDER } from './labels'
import {
  groupKey, matchesLedgerDerivedFilters, projectLedgerRows, projectEnterpriseDetail, prepareLedgerExportProjection,
  type EnterpriseDetail, type ExportRow, type RecordQuery, type RecordFilterQuery, type RecordRow, type LedgerGroup, type Source,
} from './query-projection'

export * from './query-projection'
type Db = BetterSQLite3Database<typeof schema>

function buildWhere(db: Db, params: RecordFilterQuery): SQL | undefined {
  const conds: (SQL | undefined)[] = []
  if (params.title?.length) conds.push(inArray(schema.record.titleCode, params.title))
  if (params.source?.length) conds.push(inArray(schema.record.source, params.source as Source[]))
  if (params.district) conds.push(eq(schema.record.district, params.district))
  if (params.q) {
    // 名称按**归一化键**匹配(与归并口径一致),统代按归一化大写匹配。
    const name$ = normalizeName(params.q)
    const uscc$ = `%${params.q.trim().toUpperCase()}%`
    const hits: SQL[] = [like(schema.enterprise.usccNorm, uscc$)]
    if (name$) hits.push(like(schema.enterprise.nameNorm, `%${name$}%`))
    // 曾用名(RL-17 增量):只认 `confirmed` 的别名(契约 §1.2,`pending` 不参与搜索)。
    // 为什么加在这里:合并后的名录台账三个视图共用**同一个搜索框**,框上写着
    // 「企业名 / 曾用名 / 统一社会信用代码」。企业粒度那边一直认已确认曾用名,
    // 这一侧不认的话,同一个关键词在「按企业×称号」下会**静默返回 0 行** ——
    // 和「失败 ≠ 无记录」是同一类错误:筛选悄悄失效,用户只看到空结果。
    if (name$) {
      hits.push(
        exists(
          db
            .select({ hit: sql<number>`1` })
            .from(schema.enterpriseAlias)
            .where(
              and(
                eq(schema.enterpriseAlias.enterpriseId, schema.enterprise.id),
                eq(schema.enterpriseAlias.verificationStatus, 'confirmed'),
                like(schema.enterpriseAlias.nameNorm, `%${name$}%`),
              ),
            ),
        ),
      )
    }
    conds.push(or(...hits))
  }
  const flagConds = buildFlagConds(params.flags)
  if (flagConds) conds.push(flagConds)
  const eventCond = buildEventExists(db, params)
  if (eventCond) conds.push(eventCond)
  const filtered = compact(conds)
  return filtered.length ? and(...filtered) : undefined
}

/**
 * 质量标记筛选:逗号分隔的多个标记命中**任一**即匹配。
 * `uscc_missing` 直接看 `uscc_norm` 是否为空(与导入写入的 quality_flags 一致);
 * 其余标记按 `enterprise.quality_flags`(JSON 文本)包含判定。
 */
function buildFlagConds(flags: string | undefined): SQL | undefined {
  if (!flags) return undefined
  const list = flags
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
  if (!list.length) return undefined
  const conds = list.map((f): SQL =>
    f === 'uscc_missing'
      ? isNull(schema.enterprise.usccNorm)
      : like(schema.enterprise.qualityFlags, `%${f}%`),
  )
  return conds.length === 1 ? conds[0] : or(...conds)
}

/**
 * 「组合下存在某类型 / 某年份事件」的相关 EXISTS 子查询。
 * 命中 record_event 中 record_id = record.id、且类型 ∈ 所选类型、年份 ∈ 所选年份的**同一条**事件。
 * 多值筛选在各自 `IN` 内命中任一即可。
 */
function buildEventExists(db: Db, params: RecordQuery): SQL | undefined {
  const types = params.eventType?.length ? params.eventType : undefined
  const years = params.year?.length ? params.year : undefined
  if (!types && !years) return undefined
  const sub: SQL[] = [eq(schema.recordEvent.recordId, schema.record.id)]
  if (types) sub.push(inArray(schema.recordEvent.eventType, types))
  if (years) sub.push(inArray(schema.recordEvent.year, years))
  return exists(
    db
      .select({ hit: sql<number>`1` })
      .from(schema.recordEvent)
      .where(and(...sub)),
  )
}

/**
 * 分页列出「企业 × 称号」组合,合并该组合下**全部来源、历史事件与出处**。
 *
 * `year` 先按事件年份选中组合；`dueYear`、`firstYear` 与 `firstStatus` 则在完整事件历史上筛选。
 * 派生值必须在分页前计算，否则 total 和分页结果都会错。
 */
export function listRecords(db: Db, params: RecordQuery): { rows: RecordRow[]; total: number } {
  const where = buildWhere(db, params)
  const page = Math.max(1, params.page ?? 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? 25))
  const titleRank = sql`case ${schema.record.titleCode} ${sql.join(
    TITLE_ORDER.map((code, i) => sql`when ${code} then ${i}`),
    sql` `,
  )} else ${TITLE_ORDER.length} end`
  const groupsQuery = () =>
    db
      .select({
        enterpriseId: schema.record.enterpriseId,
        titleCode: schema.record.titleCode,
      })
      .from(schema.record)
      .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
      .where(where)
      .groupBy(schema.record.enterpriseId, schema.record.titleCode)
      .orderBy(sql`min(${titleRank})`, sql`min(${schema.enterprise.name})`, schema.record.enterpriseId, schema.record.titleCode)

  if (params.dueYear != null || params.firstYear?.length || params.firstStatus?.length) {
    // 生命周期到期年、首次认定年与首次认定状态都是派生值，先对所有候选组合计算，再排序/分页。
    const candidates = groupsQuery().all()
    if (!candidates.length) return { rows: [], total: 0 }
    const derivedRows = buildRecordRows(db, candidates).filter(row => matchesLedgerDerivedFilters(row, params))
    return {
      rows: derivedRows.slice((page - 1) * pageSize, page * pageSize),
      total: derivedRows.length,
    }
  }

  const total =
    db
      .select({
        n: sql<number>`count(distinct ${schema.record.enterpriseId} || '/' || ${schema.record.titleCode})`,
      })
      .from(schema.record)
      .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
      .where(where)
      .get()?.n ?? 0

  const pageGroups = groupsQuery().limit(pageSize).offset((page - 1) * pageSize).all()
  return { rows: buildRecordRows(db, pageGroups), total }
}

function buildRecordRows(
  db: Db,
  pageGroups: LedgerGroup[],
): RecordRow[] {
  if (!pageGroups.length) return []
  const groupKeys = pageGroups.map((g) => groupKey(g.enterpriseId, g.titleCode))
  const keyExpr = sql`${schema.record.enterpriseId} || '/' || ${schema.record.titleCode}`
  const matched = db
    .select({
      recordId: schema.record.id,
      enterpriseId: schema.enterprise.id,
      name: schema.enterprise.name,
      uscc: schema.enterprise.usccNorm,
      district: schema.record.district,
      titleCode: schema.record.titleCode,
      source: schema.record.source,
      flags: schema.enterprise.qualityFlags,
    })
    .from(schema.record)
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .where(inArray(keyExpr, groupKeys))
    .orderBy(desc(schema.record.id))
    .all()

  const ids = matched.map((r) => r.recordId)
  const rawEvents = ids.length
    ? db
        .select({
          id: schema.recordEvent.id,
          recordId: schema.recordEvent.recordId,
          type: schema.recordEvent.eventType,
          year: schema.recordEvent.year,
          decidedYear: schema.recordEvent.decidedYear,
          reviewOutcome: schema.recordEvent.reviewOutcome,
          seq: schema.recordEvent.batchSeq,
          sortKey: schema.recordEvent.sortKey,
        })
        .from(schema.recordEvent)
        .where(inArray(schema.recordEvent.recordId, ids))
        .all()
    : []
  const eventIds = rawEvents.map((e) => e.id)
  const evidence = eventIds.length
    ? db
        .select({
          id: schema.recordEvidence.id,
          recordEventId: schema.recordEvidence.recordEventId,
          sourceFile: schema.recordEvidence.sourceFile,
          attachment: schema.recordEvidence.attachment,
          listNo: schema.recordEvidence.listNo,
          page: schema.recordEvidence.page,
        })
        .from(schema.recordEvidence)
        .where(inArray(schema.recordEvidence.recordEventId, eventIds))
        .all()
    : []

  return projectLedgerRows(pageGroups, matched, rawEvents, evidence)
}

export function getEnterpriseDetail(db: Db, id: number): EnterpriseDetail | null {
  return db.transaction(() => enterpriseDetailSnapshot(db, id))
}

function enterpriseDetailSnapshot(db: Db, id: number): EnterpriseDetail | null {
  const ent = db
    .select({
      id: schema.enterprise.id,
      name: schema.enterprise.name,
      uscc: schema.enterprise.usccNorm,
      district: schema.enterprise.district,
      qualityFlags: schema.enterprise.qualityFlags,
    })
    .from(schema.enterprise)
    .where(eq(schema.enterprise.id, id))
    .get()
  if (!ent) return null

  const anyRecord = db
    .select({ district: schema.record.district })
    .from(schema.record)
    .where(eq(schema.record.enterpriseId, id))
    .get()

  const records = db
    .select({
      id: schema.record.id,
      titleCode: schema.record.titleCode,
      source: schema.record.source,
      district: schema.record.district,
    })
    .from(schema.record)
    .where(eq(schema.record.enterpriseId, id))
    .orderBy(schema.record.titleCode, schema.record.source)
    .all()

  const recordIds = records.map((r) => r.id)
  const events = recordIds.length
    ? db
        .select({
          id: schema.recordEvent.id,
          recordId: schema.recordEvent.recordId,
          type: schema.recordEvent.eventType,
          year: schema.recordEvent.year,
          seq: schema.recordEvent.batchSeq,
        })
        .from(schema.recordEvent)
        .where(sql`${schema.recordEvent.recordId} in ${recordIds}`)
        .orderBy(schema.recordEvent.sortKey)
        .all()
    : []
  const eventIds = events.map((e) => e.id)
  const evidence = eventIds.length
    ? db
        .select()
        .from(schema.recordEvidence)
        .where(sql`${schema.recordEvidence.recordEventId} in ${eventIds}`)
        .all()
    : []

  const publishedPresentation = readPublicPublishedNames(db, evidence.map(v => ({ evidenceId: v.id, eventId: v.recordEventId })))
  return projectEnterpriseDetail(ent, anyRecord?.district ?? null, records, events, evidence, publishedPresentation)
}

export function allRecords(db: Db, params: RecordFilterQuery): ExportRow[] {
  return db.transaction(() => ledgerRecordsSnapshot(db, params))
}

function ledgerRecordsSnapshot(db: Db, params: RecordFilterQuery): ExportRow[] {
  const where = buildWhere(db, params)

  // 先按筛选挑出「企业 × 称号」组合,再取这些组合下的**全部**记录。
  // 筛选只决定导出哪些行,行内的来源与事件保持完整(与列表一致)。
  const groups = db
    .select({ enterpriseId: schema.record.enterpriseId, titleCode: schema.record.titleCode })
    .from(schema.record)
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .where(where)
    .groupBy(schema.record.enterpriseId, schema.record.titleCode)
    .all()

  if (!groups.length) return []
  const keys = groups.map((g) => groupKey(g.enterpriseId, g.titleCode))
  const keyExpr = sql`${schema.record.enterpriseId} || '/' || ${schema.record.titleCode}`

  const matched = db
    .select({
      recordId: schema.record.id,
      enterpriseId: schema.record.enterpriseId,
      name: schema.enterprise.name,
      uscc: schema.enterprise.usccNorm,
      district: schema.record.district,
      titleCode: schema.record.titleCode,
      source: schema.record.source,
    })
    .from(schema.record)
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .where(inArray(keyExpr, keys))
    .orderBy(schema.record.titleCode, schema.enterprise.name, schema.record.id)
    .all()

  const ids = matched.map((r) => r.recordId)
  const events = ids.length
    ? db
        .select({
          id: schema.recordEvent.id,
          recordId: schema.recordEvent.recordId,
          type: schema.recordEvent.eventType,
          year: schema.recordEvent.year,
          seq: schema.recordEvent.batchSeq,
          sortKey: schema.recordEvent.sortKey,
        })
        .from(schema.recordEvent)
        .where(inArray(schema.recordEvent.recordId, ids))
        .all()
    : []
  const eventIds = events.map((e) => e.id)
  const evidence = eventIds.length
    ? db
        .select()
        .from(schema.recordEvidence)
        .where(inArray(schema.recordEvidence.recordEventId, eventIds))
        .all()
    : []
  const projection = prepareLedgerExportProjection(matched, events, evidence)
  const publishedByEvidence = new Map<number, OfficialPublishedFact>()
  for (let start = 0; start < projection.scopes.length; start += 40) {
    const scopes = projection.scopes.slice(start, start + 40)
    const batch = readPublicPublishedNames(db, scopes.flat())
    const results = batch.availability === 'available' ? [batch] : scopes.map(scope => readPublicPublishedNames(db, scope))
    for (const result of results) for (const fact of result.facts) publishedByEvidence.set(fact.evidenceId, fact)
  }
  return projection.rows(publishedByEvidence)
}
