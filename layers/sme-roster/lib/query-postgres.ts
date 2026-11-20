import { sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { importPostgresReceiptRedactor } from '../server/utils/import-receipt-redaction'
import { readPostgresPublishedNames } from './roster/official-published-presentation-postgres'
import type { OfficialPublishedFact } from './roster/official-published-presentation'
import { normalizeName } from './domain'
import { TITLE_ORDER } from './labels'
import { MAX_PAGE_SIZE, matchesLedgerDerivedFilters, projectLedgerRows,
  prepareLedgerExportProjection, type LedgerExportEvent, type LedgerExportEvidence, type LedgerExportSource, type LedgerEvidence, type LedgerEvent, type LedgerGroup, type LedgerSource, type RecordQuery, type RecordFilterQuery } from './query'

const array = (values: readonly (number | string)[]) => sql`${sql.param(values)}`

// SQLite LIKE ignores case in ASCII only and does not use a default escape character.
function contains(column: SQL, needle: string) {
  const lower = (value: SQL) => sql`translate(${value}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`
  return needle.includes('\0') ? sql`FALSE` : sql`${lower(column)} COLLATE "C" LIKE ${lower(sql`${'%' + needle + '%'}::text`)} ESCAPE ''`
}

function ledgerScope(params: RecordQuery) {
  const tests: SQL[] = []
  if (params.title?.length) tests.push(sql`r.title_code = ANY(${array(params.title)}::text[])`)
  if (params.source?.length) tests.push(sql`r.source = ANY(${array(params.source)}::text[])`)
  if (params.district) tests.push(params.district.includes('\0') ? sql`FALSE` : sql`r.district = ${params.district}`)
  if (params.q) {
    const name = normalizeName(params.q)
    const uscc = contains(sql`e.uscc_norm`, params.q.trim().toUpperCase())
    tests.push(name ? sql`(${uscc} OR ${contains(sql`e.name_norm`, name)} OR EXISTS (
      SELECT 1 FROM enterprise_alias a WHERE a.enterprise_id = e.id AND a.verification_status = 'confirmed'
        AND ${contains(sql`a.name_norm`, name)}))` : uscc)
  }
  const flags = params.flags?.split(',').map(flag => flag.trim()).filter(Boolean) ?? []
  if (flags.length) tests.push(sql`(${sql.join(flags.map(flag => flag === 'uscc_missing'
    ? sql`e.uscc_norm IS NULL` : contains(sql`e.quality_flags`, flag)), sql` OR `)})`)
  if (params.eventType?.length || params.year?.length) {
    tests.push(sql`EXISTS (
      SELECT 1 FROM record_event v WHERE v.record_id = r.id
      ${params.eventType?.length ? sql`AND v.event_type = ANY(${array(params.eventType)}::text[])` : sql.empty()}
      ${params.year?.length ? sql`AND v.year = ANY(${array(params.year.filter(Number.isSafeInteger))}::bigint[])` : sql.empty()})`)
  }
  return sql`FROM record r JOIN enterprise e ON e.id = r.enterprise_id
    ${tests.length ? sql`WHERE ${sql.join(tests, sql` AND `)}` : sql.empty()}`
}

export function listPostgresLedgerRecords(db: NodePgDatabase, params: RecordQuery) {
  return db.transaction(async tx => {
    const page = Math.max(1, params.page ?? 1)
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? 25))
    const offset = (page - 1) * pageSize
    const derived = params.dueYear != null || params.firstYear?.length || params.firstStatus?.length
    const scope = ledgerScope(params)
    const rank = sql`coalesce(array_position(${array(TITLE_ORDER)}::text[],r.title_code), ${TITLE_ORDER.length + 1}::integer)`
    const total = derived ? 0 : Number((await tx.execute<{ total: string }>(sql`
      SELECT count(*) AS total FROM (SELECT DISTINCT r.enterprise_id,r.title_code ${scope}) matching`)).rows[0]!.total)
    if (!derived && offset >= total) return { rows: [], total }
    const { rows: groups } = await tx.execute<{ data: LedgerGroup }>(sql`
      SELECT json_build_object('enterpriseId',r.enterprise_id,'titleCode',r.title_code) AS data
      ${scope} GROUP BY r.enterprise_id,r.title_code
      ORDER BY ${rank}, min(e.name COLLATE "C"), r.enterprise_id, r.title_code COLLATE "C"
      ${derived ? sql.empty() : sql`LIMIT ${pageSize} OFFSET ${offset}`}`)
    if (!groups.length) return { rows: [], total }

    const ids = array(groups.map(({ data }) => data.enterpriseId))
    const titles = array(groups.map(({ data }) => data.titleCode))
    const { rows: sources } = await tx.execute<{ data: LedgerSource }>(sql`
      SELECT json_build_object('recordId',r.id,'enterpriseId',e.id,'name',e.name,'uscc',e.uscc_norm,
        'district',r.district,'titleCode',r.title_code,'source',r.source,'flags',e.quality_flags::json) AS data
      FROM unnest(${ids}::bigint[], ${titles}::text[]) AS g(enterprise_id,title_code)
      JOIN record r USING (enterprise_id,title_code) JOIN enterprise e ON e.id = r.enterprise_id
      ORDER BY r.id DESC`)
    const recordIds = array(sources.map(({ data }) => data.recordId))
    const { rows: events } = await tx.execute<{ data: LedgerEvent }>(sql`
      SELECT json_build_object('id',v.id,'recordId',v.record_id,'type',v.event_type,'year',v.year,
        'decidedYear',v.decided_year,'reviewOutcome',v.review_outcome,'seq',v.batch_seq,'sortKey',v.sort_key) AS data
      FROM record_event v WHERE v.record_id = ANY(${recordIds}::bigint[])`)
    const { rows: evidence } = await tx.execute<{ data: LedgerEvidence }>(sql`
      SELECT json_build_object('recordEventId',record_event_id,'sourceFile',source_file,
        'attachment',attachment,'listNo',list_no,'page',page) AS data
      FROM record_evidence WHERE record_event_id = ANY(${array(events.map(({ data }) => data.id))}::bigint[]) ORDER BY id`)
    const projected = projectLedgerRows(groups.map(row => row.data), sources.map(row => row.data),
      events.map(row => row.data), evidence.map(row => row.data))
    if (!derived) return { rows: projected, total }
    const filtered = projected.filter(row => matchesLedgerDerivedFilters(row, params))
    return { rows: filtered.slice(offset, offset + pageSize), total: filtered.length }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export function allPostgresLedgerRecords(db: NodePgDatabase, params: RecordFilterQuery) {
  return db.transaction(async tx => {
    const { rows: sources } = await tx.execute<{ data: LedgerExportSource }>(sql`
      WITH groups AS (SELECT DISTINCT r.enterprise_id, r.title_code ${ledgerScope(params)})
      SELECT json_build_object('recordId',r.id,'enterpriseId',e.id,'name',e.name,'uscc',e.uscc_norm,
        'district',r.district,'titleCode',r.title_code,'source',r.source) AS data
      FROM groups JOIN record r USING (enterprise_id,title_code) JOIN enterprise e ON e.id=r.enterprise_id
      ORDER BY r.title_code COLLATE "C", e.name COLLATE "C", r.id`)
    if (!sources.length) return []
    const { rows: events } = await tx.execute<{ data: LedgerExportEvent }>(sql`
      SELECT json_build_object('id',id,'recordId',record_id,'type',event_type,'year',year,'seq',batch_seq,'sortKey',sort_key) AS data
      FROM record_event WHERE record_id = ANY(${array(sources.map(row => row.data.recordId))}::bigint[])`)
    const { rows: evidence } = await tx.execute<{ data: LedgerExportEvidence }>(sql`
      SELECT json_build_object('id',id,'recordEventId',record_event_id,'sourceFile',source_file,
        'attachment',attachment,'listNo',list_no,'page',page) AS data
      FROM record_evidence WHERE record_event_id = ANY(${array(events.map(row => row.data.id))}::bigint[]) ORDER BY id`)
    const projection = prepareLedgerExportProjection(sources.map(row => row.data), events.map(row => row.data), evidence.map(row => row.data))
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
