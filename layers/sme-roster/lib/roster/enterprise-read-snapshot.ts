import type { PlatformStoredQuery } from '../../../../lib/platform/read'
import type { PlatformStoredRelation } from '../../../../lib/platform/read'
import { differencePublicColumns } from '../../../../lib/platform/difference-reference-target'
/** Enterprise-only reads. No raw platform archives enter a list aggregation. */
import { eq, getTableColumns, inArray, sql, asc, and } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../../../db/schema'
import type { Database } from 'better-sqlite3'
import { normalizeName, normalizeUscc } from '../domain'
import { isPageCapable } from '../../../../lib/roster/evidence-page'
import { readEnterpriseTargetPlatformHistory } from './enterprise-platform-history'
import { canonicalEnterpriseId, currentEnterpriseIdentity } from './enterprise-identity'

type Db = BetterSQLite3Database<typeof s>
// Connection-local deterministic normalizers preserve the shared JS contract,
// including Unicode casing and legacy whitespace. No schema/cache is created.
const registered = new WeakSet<object>()
export function identityFunctions(db: Db) {
  const client = (db as Db & { $client: Database }).$client
  if (registered.has(client)) return
  client.function('roster84_uscc', { deterministic: true }, (value: unknown) => normalizeUscc(value as string | null) || null)
  client.function('roster84_name', { deterministic: true }, (value: unknown) => normalizeName(value as string | null))
  client.function('roster84_upper', { deterministic: true }, (value: string | null) => value?.toUpperCase() ?? '')
  // JSON transports lone UTF-16 code units without SQLite replacing them with
  // U+FFFD. JS includes can match a half inside a valid supplementary character.
  client.function('roster84_includes_utf16', { deterministic: true }, (value: string | null, encoded: string) => Number((value ?? '').includes(JSON.parse(encoded))))
  registered.add(client)
}
// Punctuation and lowercase ASCII (including name:/synthetic keys) are valid
// inputs too. SQLite upper is identical to JS only in this ASCII fast path.
// Whitespace/Unicode keep the shared normalizer; never approximate their casing.
export const identityUsccSql = (value: ReturnType<typeof sql>) => sql`case when instr(${value},char(0))>0 or ${value} glob '*[^!-~]*' then roster84_uscc(${value}) else nullif(upper(${value}), '') end`
const uscc = identityUsccSql
// normalizeName without evidence only removes these characters. Plain Chinese
// names can stay native; legacy whitespace/parentheses/punctuation use JS.
const nameSpecial = '*[\t\n\v\f\r \u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u3000\ufeff（）()√✓、,，.。;；]*'
export const identityNameSql = (value: ReturnType<typeof sql>) => sql`case when instr(${value},char(0))>0 or ${value} glob ${nameSpecial} then roster84_name(${value}) else coalesce(${value}, '') end`
const name = identityNameSql

export function readEnterpriseHistories(db: Db, ids?: number[]) {
  const scope = (column: typeof s.enterprise.id | typeof s.record.enterpriseId | typeof s.enterpriseAlias.enterpriseId | typeof s.differenceReason.enterpriseId) => ids == null ? undefined : inArray(column, ids)
  if (ids?.length === 0) return {
    records: [] as typeof s.record.$inferSelect[], events: [] as typeof s.recordEvent.$inferSelect[], evidence: [] as typeof s.recordEvidence.$inferSelect[],
    aliases: [] as typeof s.enterpriseAlias.$inferSelect[], differences: [] as (Omit<typeof s.differenceReason.$inferSelect, 'evidenceCollectionId' | 'evidenceObservationId'> & { evidenceQueryId: number | null; evidenceRelationId: number | null })[],
    recordsByEnterprise: new Map<number, typeof s.record.$inferSelect[]>(), eventsByRecord: new Map<number, typeof s.recordEvent.$inferSelect[]>(),
  }
  const recordScope = scope(s.record.enterpriseId)
  const recordIds = db.select({ id: s.record.id }).from(s.record).where(recordScope)
  const eventScope = ids == null ? undefined : inArray(s.recordEvent.recordId, recordIds)
  const eventIds = db.select({ id: s.recordEvent.id }).from(s.recordEvent).where(eventScope)
  const records = db.select(getTableColumns(s.record)).from(s.record).where(recordScope).all()
  const events = db.select().from(s.recordEvent).where(eventScope).all()
  const evidence = db.select().from(s.recordEvidence).where(ids == null ? undefined : inArray(s.recordEvidence.recordEventId, eventIds)).all().map(row => isPageCapable(row.sourceFile) ? row : { ...row, page: null })
  const aliases = db.select().from(s.enterpriseAlias).where(scope(s.enterpriseAlias.enterpriseId)).all()
  const differences = db.select(differencePublicColumns(db)).from(s.differenceReason).where(scope(s.differenceReason.enterpriseId)).all()
  const recordsByEnterprise = new Map<number, typeof records>()
  for (const record of records) {
    const list = recordsByEnterprise.get(record.enterpriseId) ?? []
    list.push(record); recordsByEnterprise.set(record.enterpriseId, list)
  }
  const eventsByRecord = new Map<number, typeof events>()
  for (const event of events) {
    const list = eventsByRecord.get(event.recordId) ?? []
    list.push(event); eventsByRecord.set(event.recordId, list)
  }
  return { records, events, evidence, aliases, differences, recordsByEnterprise, eventsByRecord }
}

export function readEnterpriseSnapshot(db: Db, id?: number) {
  if (id !== undefined) id = canonicalEnterpriseId(db, id) ?? id
  const enterprises = db.select().from(s.enterprise).where(and(currentEnterpriseIdentity(db), id == null ? undefined : eq(s.enterprise.id, id))).orderBy(asc(s.enterprise.id)).all()
  const history = readEnterpriseHistories(db, id == null ? [] : [id])
  const differences = id == null ? db.select(differencePublicColumns(db)).from(s.differenceReason).all() : history.differences
  // Only identity and membership are used; export raw_fields are never needed here.
  const exportColumns = { ...getTableColumns(s.platformExportRow), rawFields: sql<null>`null`, district: sql<null>`null`, province: sql<null>`null`, city: sql<null>`null`, regStatus: sql<null>`null`, createdAt: sql<string>`''` }
  const batchColumns = getTableColumns(s.platformExportBatch)
  let exportRows: (typeof s.platformExportRow.$inferSelect)[]
  let exportBatches: (typeof s.platformExportBatch.$inferSelect)[]
  let queries: PlatformStoredQuery[] = []
  let relations: PlatformStoredRelation[] = []
  let ownQueryIds: number[] = []
  let targetHistory: ReturnType<typeof readEnterpriseTargetPlatformHistory> | undefined
  if (id == null) {
    exportRows = db.select(exportColumns).from(s.platformExportRow).all()
    exportBatches = db.select(batchColumns).from(s.platformExportBatch).all()
  } else {
    identityFunctions(db)
    // Preserve normalized USCC-first/name-fallback and last-identity-wins semantics,
    // including duplicate names and historical noncanonical raw identity values.
    const owner = sql`coalesce(
      (select e.id from enterprise e where ${currentEnterpriseIdentity(db, sql`e.id`)} and ${uscc(sql`e.uscc_norm`)} = ${uscc(sql`${s.platformExportRow.usccRaw}`)} order by e.id desc limit 1),
      (select e.id from enterprise e where ${currentEnterpriseIdentity(db, sql`e.id`)} and e.name_norm = ${name(sql`${s.platformExportRow.nameRaw}`)} and ${s.platformExportRow.nameRaw} is not null and ${s.platformExportRow.nameRaw} != '' order by e.id desc limit 1))`
    exportRows = db.select(exportColumns).from(s.platformExportRow).where(sql`(${uscc(sql`${s.platformExportRow.usccRaw}`)} = ${normalizeUscc(enterprises[0]?.usccNorm) || null} or ${name(sql`${s.platformExportRow.nameRaw}`)} = ${enterprises[0]?.nameNorm ?? null}) and ${owner} = ${id}`).all()
    // Only latest batch per title is required to decide membership, plus the batches
    // referenced by this enterprise's rows. No unrelated batch metadata is materialized.
    exportBatches = db.select(batchColumns).from(s.platformExportBatch).where(sql`
      ${s.platformExportBatch.id} in (select b.id from platform_export_batch b where not exists
        (select 1 from platform_export_batch newer where newer.title_code = b.title_code and
          (newer.year > b.year or (newer.year = b.year and newer.id > b.id))))
      or ${inArray(s.platformExportBatch.id, [...new Set(exportRows.map(row => row.batchId))])}`).all()
    const enterprise = enterprises[0]
    if (enterprise) {
      const evidenceIds = [...new Set(differences.map(row => row.evidenceQueryId).filter((id): id is number => id != null))]
      targetHistory = readEnterpriseTargetPlatformHistory(db, enterprise, evidenceIds)
      ;({ queries, relations, ownQueryIds } = targetHistory)

    }
  }
  return { enterprises, ...history, differences, exportRows, exportBatches, queries, relations, ownQueryIds,
    platformLegacyById: targetHistory?.legacyById, platformPositionsById: targetHistory?.positionsById }
}

/** Same USCC set difference as getComparison, scoped before materialization. */
export function enterpriseComparisonCoordinates(db: Db, id?: number) {
  return db.all<{ enterpriseId: number; titleCode: string; direction: 'missing_in_miit' | 'extra_in_miit' }>(sql`
    select distinct r.enterprise_id as enterpriseId, r.title_code as titleCode,
      case when r.source = 'jxj' then 'missing_in_miit' else 'extra_in_miit' end as direction
    from record r join enterprise e on e.id = r.enterprise_id
    where ${id == null ? sql`1` : sql`r.enterprise_id = ${id}`} and r.title_code in ('little_giant', 'specialized_sme', 'innovative_sme')
      and (e.uscc_norm is null or not exists (
        select 1 from record other join enterprise oe on oe.id = other.enterprise_id
        where oe.uscc_norm = e.uscc_norm and other.title_code = r.title_code and (other.source = 'jxj') != (r.source = 'jxj') and oe.uscc_norm = e.uscc_norm))
    order by r.id`)
}
