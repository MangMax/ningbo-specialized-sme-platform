import { and, count, desc, eq, exists, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { enterprise, enterpriseAlias } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { importPostgresReceiptRedactor } from '../server/utils/import-receipt-redaction'
import { readPostgresPublishedNames } from './roster/official-published-presentation-postgres'
import type { OfficialPublishedFact } from './roster/official-published-presentation'
import { normalizeName } from './domain'
import { TITLE_ORDER } from './labels'
import {
  MAX_PAGE_SIZE, matchesLedgerDerivedFilters, projectLedgerRows,
  prepareLedgerExportProjection, projectEnterpriseDetail, type RecordQuery, type RecordFilterQuery,
} from './query-projection'

const groupFields = { enterpriseId: record.enterpriseId, titleCode: record.titleCode }
const sourceFields = {
  ...groupFields,
  recordId: record.id,
  name: enterprise.name,
  uscc: enterprise.usccNorm,
  district: record.district,
  source: record.source,
}
const eventFields = {
  id: recordEvent.id,
  recordId: recordEvent.recordId,
  type: recordEvent.eventType,
  year: recordEvent.year,
  seq: recordEvent.batchSeq,
}
const evidenceFields = {
  id: recordEvidence.id,
  recordEventId: recordEvidence.recordEventId,
  sourceFile: recordEvidence.sourceFile,
  attachment: recordEvidence.attachment,
  listNo: recordEvidence.listNo,
  page: recordEvidence.page,
}

// Drizzle has no expression-level collation helper. C preserves the legacy bytewise order.
const bytewise = (column: AnyPgColumn) => sql`${column} COLLATE "C"`

// Drizzle inArray expands every value into a parameter. ANY keeps unbounded export IDs in
// one bound PostgreSQL array and avoids the driver's parameter limit.
const anyId = (column: AnyPgColumn, ids: number[]) => sql`${column} = ANY(${sql.param(ids)}::bigint[])`

function qualityFlags(value: string | null): string[] | null {
  return value === null ? null : JSON.parse(value)
}

export function readPostgresLedgerEnterpriseDetail(db: NodePgDatabase, id: number) {
  if (!Number.isSafeInteger(id)) return null
  return db.transaction(async tx => {
    const [subject] = await tx.select({
      id: enterprise.id, name: enterprise.name, uscc: enterprise.usccNorm,
      district: enterprise.district, qualityFlags: enterprise.qualityFlags,
    }).from(enterprise).where(eq(enterprise.id, id))
    if (!subject) return null
    const records = await tx.select({
      id: record.id, titleCode: record.titleCode, source: record.source, district: record.district,
    }).from(record).where(eq(record.enterpriseId, id))
      .orderBy(bytewise(record.titleCode), bytewise(record.source))
    const [first] = subject.district == null ? await tx.select({ district: record.district })
      .from(record).where(eq(record.enterpriseId, id)).orderBy(record.id).limit(1) : []
    const events = await tx.select(eventFields).from(recordEvent)
      .where(anyId(recordEvent.recordId, records.map(row => row.id))).orderBy(recordEvent.sortKey, recordEvent.id)
    const evidence = await tx.select(evidenceFields).from(recordEvidence)
      .where(anyId(recordEvidence.recordEventId, events.map(row => row.id))).orderBy(recordEvidence.id)
    const published = await readPostgresPublishedNames(tx,
      evidence.map(row => ({ evidenceId: row.id, eventId: row.recordEventId })), await importPostgresReceiptRedactor(tx))
    return projectEnterpriseDetail({ ...subject, qualityFlags: qualityFlags(subject.qualityFlags) },
      first?.district ?? null, records, events, evidence, published)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

// Drizzle's like helper has no ESCAPE option. ASCII translate and an empty escape
// preserve SQLite's case matching and treat a backslash as an ordinary character.
function contains(column: AnyPgColumn, needle: string) {
  const lower = (value: AnyPgColumn | SQL) =>
    sql`translate(${value}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`
  return needle.includes('\0') ? inArray(column, []) :
    sql`${lower(column)} COLLATE "C" LIKE ${lower(sql`${'%' + needle + '%'}::text`)} ESCAPE ''`
}

function ledgerScope(db: NodePgDatabase, params: RecordFilterQuery) {
  const filters: (SQL | undefined)[] = []
  if (params.title?.length) filters.push(inArray(record.titleCode, params.title))
  if (params.source?.length) filters.push(inArray(sql<string>`${record.source}`, params.source))
  if (params.district) filters.push(params.district.includes('\0') ? inArray(record.district, []) : eq(record.district, params.district))
  if (params.q) {
    const name = normalizeName(params.q)
    const uscc = contains(enterprise.usccNorm, params.q.trim().toUpperCase())
    filters.push(name ? or(uscc, contains(enterprise.nameNorm, name), exists(
      db.select({ id: enterpriseAlias.enterpriseId }).from(enterpriseAlias).where(and(
        eq(enterpriseAlias.enterpriseId, enterprise.id),
        eq(enterpriseAlias.verificationStatus, 'confirmed'),
        contains(enterpriseAlias.nameNorm, name),
      )),
    )) : uscc)
  }
  const flags = params.flags?.split(',').map(flag => flag.trim()).filter(Boolean) ?? []
  if (flags.length) filters.push(or(...flags.map(flag =>
    flag === 'uscc_missing' ? isNull(enterprise.usccNorm) : contains(enterprise.qualityFlags, flag))))
  if (params.eventType?.length || params.year?.length) {
    filters.push(exists(db.select({ id: recordEvent.id }).from(recordEvent).where(and(
      eq(recordEvent.recordId, record.id),
      params.eventType?.length ? inArray(sql<string>`${recordEvent.eventType}`, params.eventType) : undefined,
      params.year?.length ? anyId(recordEvent.year, params.year.filter(Number.isSafeInteger)) : undefined,
    ))))
  }
  return and(...filters)
}

export function listPostgresLedgerRecords(db: NodePgDatabase, params: RecordQuery) {
  return db.transaction(async tx => {
    const page = Math.max(1, params.page ?? 1)
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? 25))
    const offset = (page - 1) * pageSize
    const derived = params.dueYear != null || params.firstYear?.length || params.firstStatus?.length
    const scope = ledgerScope(tx, params)
    const matching = tx.selectDistinct(groupFields).from(record)
      .innerJoin(enterprise, eq(enterprise.id, record.enterpriseId)).where(scope).as('matching')
    const total = derived ? 0 : (await tx.select({ total: count() }).from(matching))[0]!.total
    if (!derived && offset >= total) return { rows: [], total }

    // Drizzle has no array_position helper for the title order, which also ranks legacy codes after known titles.
    const titleRank = sql`coalesce(array_position(${sql.param(TITLE_ORDER)}::text[], ${record.titleCode}), ${TITLE_ORDER.length + 1}::integer)`
    const groupsQuery = tx.selectDistinct({
      ...groupFields,
      titleRank: titleRank.as('title_rank'),
      nameKey: bytewise(enterprise.name).as('name_key'),
      titleKey: bytewise(record.titleCode).as('title_key'),
    }).from(record).innerJoin(enterprise, eq(enterprise.id, record.enterpriseId)).where(scope)
      .orderBy(fields => [fields.titleRank, fields.nameKey, fields.enterpriseId, fields.titleKey]).$dynamic()
    if (!derived) groupsQuery.limit(pageSize).offset(offset)

    const groups = tx.$with('groups').as(groupsQuery)
    const sources = await tx.with(groups).select({ ...sourceFields, flags: enterprise.qualityFlags })
      .from(groups).innerJoin(record, and(eq(record.enterpriseId, groups.enterpriseId), eq(record.titleCode, groups.titleCode)))
      .innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
      .orderBy(groups.titleRank, groups.nameKey, groups.enterpriseId, groups.titleKey, desc(record.id))
    if (!sources.length) return { rows: [], total }

    const pageGroups = Array.from(new Map(sources.map(({ enterpriseId, titleCode }) =>
      [JSON.stringify([enterpriseId, titleCode]), { enterpriseId, titleCode }])).values())
    const events = await tx.select({
      ...eventFields, decidedYear: recordEvent.decidedYear, reviewOutcome: recordEvent.reviewOutcome, sortKey: recordEvent.sortKey,
    }).from(recordEvent).where(anyId(recordEvent.recordId, sources.map(row => row.recordId)))
    const evidence = await tx.select(evidenceFields).from(recordEvidence)
      .where(anyId(recordEvidence.recordEventId, events.map(row => row.id))).orderBy(recordEvidence.id)
    const projected = projectLedgerRows(pageGroups, sources.map(row => ({ ...row, flags: qualityFlags(row.flags) })), events, evidence)
    if (!derived) return { rows: projected, total }
    const filtered = projected.filter(row => matchesLedgerDerivedFilters(row, params))
    return { rows: filtered.slice(offset, offset + pageSize), total: filtered.length }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export function allPostgresLedgerRecords(db: NodePgDatabase, params: RecordFilterQuery) {
  return db.transaction(async tx => {
    const groups = tx.$with('groups').as(tx.selectDistinct(groupFields).from(record)
      .innerJoin(enterprise, eq(enterprise.id, record.enterpriseId)).where(ledgerScope(tx, params)))
    const sources = await tx.with(groups).select(sourceFields).from(groups)
      .innerJoin(record, and(eq(record.enterpriseId, groups.enterpriseId), eq(record.titleCode, groups.titleCode)))
      .innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
      .orderBy(bytewise(record.titleCode), bytewise(enterprise.name), record.id)
    if (!sources.length) return []
    const events = await tx.select({ ...eventFields, sortKey: recordEvent.sortKey }).from(recordEvent)
      .where(anyId(recordEvent.recordId, sources.map(row => row.recordId)))
    const evidence = await tx.select(evidenceFields).from(recordEvidence)
      .where(anyId(recordEvidence.recordEventId, events.map(row => row.id))).orderBy(recordEvidence.id)
    const projection = prepareLedgerExportProjection(sources, events, evidence)
    const published = new Map<number, OfficialPublishedFact>()
    const redact = await importPostgresReceiptRedactor(tx)
    for (let start = 0; start < projection.scopes.length; start += 40) {
      const scopes = projection.scopes.slice(start, start + 40)
      const batch = await readPostgresPublishedNames(tx, scopes.flat(), redact)
      if (batch.availability === 'available') {
        for (const fact of batch.facts) published.set(fact.evidenceId, fact)
      } else {
        for (const scope of scopes) {
          const group = await readPostgresPublishedNames(tx, scope, redact)
          for (const fact of group.facts) published.set(fact.evidenceId, fact)
        }
      }
    }
    return projection.rows(published)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
