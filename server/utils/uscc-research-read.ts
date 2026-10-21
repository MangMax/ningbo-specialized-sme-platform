/** Request-local USCC research projections. Archive bodies stay in SQLite;
 * original evidence remains available through the existing evidence read APIs. */
import { and, asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../db/schema'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import { TITLE_ORDER } from '../../lib/labels'
import type { UsccChecklistFilter } from '../../lib/roster/uscc-research'
import { identityFunctions, identityUsccSql } from '../../lib/roster/enterprise-read-snapshot'
import { removedEnterpriseIds } from '../../lib/roster/enterprise-list-selection'
import type { PlatformEvidenceIndex } from './roster-duplicate-merge'

type Db = BetterSQLite3Database<typeof s>
const rank = (title: string) => { const i = TITLE_ORDER.indexOf(title); return i < 0 ? TITLE_ORDER.length : i }

export function readUsccTargets(db: Db, filter: Omit<UsccChecklistFilter, 'page' | 'pageSize'>) {
  identityFunctions(db)
  const missing = db.select({ id: s.enterprise.id, name: s.enterprise.name, nameNorm: s.enterprise.nameNorm, district: s.enterprise.district, city: s.enterprise.city })
    .from(s.enterprise).where(sql`${identityUsccSql(sql`${s.enterprise.usccNorm}`)} is null`).orderBy(s.enterprise.id).all()
  const ids = missing.map(row => row.id)
  const records = db.select({ id: s.record.id, enterpriseId: s.record.enterpriseId, titleCode: s.record.titleCode, source: s.record.source, district: s.record.district })
    .from(s.record).where(inArray(s.record.enterpriseId, ids)).orderBy(s.record.id).all()
  const aliases = db.select({ enterpriseId: s.enterpriseAlias.enterpriseId, name: s.enterpriseAlias.name })
    .from(s.enterpriseAlias).where(and(inArray(s.enterpriseAlias.enterpriseId, ids), eq(s.enterpriseAlias.verificationStatus, 'confirmed'))).all()
  const byEnterprise = new Map<number, typeof records>()
  for (const record of records) {
    const bucket = byEnterprise.get(record.enterpriseId) ?? []
    bucket.push(record); byEnterprise.set(record.enterpriseId, bucket)
  }
  const names = new Map<number, Set<string>>()
  for (const alias of aliases) {
    const bucket = names.get(alias.enterpriseId) ?? new Set<string>()
    bucket.add(alias.name); names.set(alias.enterpriseId, bucket)
  }
  const removed = removedEnterpriseIds(db, ids.filter(id => {
    const rows = byEnterprise.get(id) ?? []
    return rows.length > 0 && !rows.some(row => row.source === 'jxj')
  }))
  const needle = filter.q?.trim() ? normalizeName(filter.q) : null
  const rows = missing.filter(row => !removed.has(row.id)).map(row => {
    const records = byEnterprise.get(row.id) ?? []
    return {
      enterpriseId: row.id, name: row.name, city: row.city,
      district: row.district || records.find(record => record.district)?.district || null,
      titles: [...new Set(records.map(record => record.titleCode))].sort((a, b) => rank(a) - rank(b)),
      aliasNames: [...(names.get(row.id) ?? [])].sort(),
    }
  }).filter(row => (!filter.title?.length || row.titles.some(title => filter.title!.includes(title))) &&
    (!filter.district || row.district === filter.district) &&
    (!needle || normalizeName(row.name).includes(needle) || row.aliasNames.some(alias => normalizeName(alias).includes(needle))))
  const selectedIds = rows.map(row => row.enterpriseId)
  const selected = new Set(selectedIds)
  const selectedRecords = records.filter(row => selected.has(row.enterpriseId))
  const recordIds = selectedRecords.map(row => row.id)
  const events = db.select({ id: s.recordEvent.id, recordId: s.recordEvent.recordId }).from(s.recordEvent).where(inArray(s.recordEvent.recordId, recordIds)).all()
  const evidence = db.select({ recordEventId: s.recordEvidence.recordEventId, sourceFile: s.recordEvidence.sourceFile, attachment: s.recordEvidence.attachment, listNo: s.recordEvidence.listNo, page: s.recordEvidence.page })
    .from(s.recordEvidence).where(inArray(s.recordEvidence.recordEventId, events.map(row => row.id))).all()
  const differences = db.select({ id: s.differenceReason.id, enterpriseId: s.differenceReason.enterpriseId, titleCode: s.differenceReason.titleCode, direction: s.differenceReason.direction, recordedAt: s.differenceReason.recordedAt, status: s.differenceReason.status, reasonCode: s.differenceReason.reasonCode, reasonNote: s.differenceReason.reasonNote })
    .from(s.differenceReason).where(inArray(s.differenceReason.enterpriseId, selectedIds)).orderBy(s.differenceReason.id).all()
  const enterprises = missing.filter(row => selected.has(row.id))
  const keys = [...new Set(enterprises.map(row => `name:${row.nameNorm}`))]
  const queryScope = inArray(s.platformQuery.queryKey, keys)
  const queries = db.select({ id: s.platformQuery.id, interface: s.platformQuery.interface, queryKey: s.platformQuery.queryKey, rdjb: s.platformQuery.rdjb, queriedAt: s.platformQuery.queriedAt, status: s.platformQuery.status })
    .from(s.platformQuery).where(queryScope).orderBy(s.platformQuery.id).all()
  const relationCounts = db.select({ queryId: s.platformRelation.queryId, count: sql<number>`count(*)` }).from(s.platformRelation)
    .where(inArray(s.platformRelation.queryId, db.select({ id: s.platformQuery.id }).from(s.platformQuery).where(queryScope)))
    .groupBy(s.platformRelation.queryId).all()
  return { rows, enterprises, records: selectedRecords, events, evidence, differences, queries, relationCounts }
}

/** Hydrate each newly encountered candidate code once, in batches. All related
 * queries and relations are retained; no LIMIT can hide a second subject. */
export function usccResearchEvidence(db: Db) {
  identityFunctions(db)
  const index: PlatformEvidenceIndex = { queriesByUscc: new Map(), relationsByQuery: new Map() }
  const loaded = new Set<string>()
  const exportNames = new Map<string, string>()
  function load(codes: string[]) {
    const fresh = [...new Set(codes.map(normalizeUscc).filter(Boolean))].filter(code => !loaded.has(code))
    if (!fresh.length) return
    for (const code of fresh) loaded.add(code)
    // Chunk bind parameters, never per-target/per-candidate queries.
    for (let offset = 0; offset < fresh.length; offset += 400) {
      const chunk = fresh.slice(offset, offset + 400)
      const scope = inArray(identityUsccSql(sql`${s.platformQuery.queryKey}`), chunk)
      const queries = db.select({ ...getTableColumns(s.platformQuery), rawResponse: sql<null>`null`, collectionEvidence: sql<null>`null`, failureReason: sql<null>`null` })
        .from(s.platformQuery).where(scope).orderBy(s.platformQuery.id).all()
      for (const query of queries) {
        const key = normalizeUscc(query.queryKey)
        const bucket = index.queriesByUscc.get(key) ?? []
        bucket.push(query); index.queriesByUscc.set(key, bucket)
      }
      const relations = db.select({ ...getTableColumns(s.platformRelation), rawFields: sql<null>`null`, sourceText: sql<null>`null` }).from(s.platformRelation)
        .where(inArray(s.platformRelation.queryId, db.select({ id: s.platformQuery.id }).from(s.platformQuery).where(scope)))
        .orderBy(asc(s.platformRelation.queryId), asc(s.platformRelation.sequenceNo)).all()
      for (const relation of relations) {
        const bucket = index.relationsByQuery.get(relation.queryId) ?? []
        bucket.push(relation); index.relationsByQuery.set(relation.queryId, bucket)
      }
      // Same latest year/batch/source-row precedence as findExportSideName,
      // without fetching every export row's raw_fields for each ready item.
      const exports = db.select({ uscc: s.platformExportRow.usccRaw, name: s.platformExportRow.nameRaw }).from(s.platformExportRow)
        .innerJoin(s.platformExportBatch, eq(s.platformExportRow.batchId, s.platformExportBatch.id))
        .where(inArray(identityUsccSql(sql`${s.platformExportRow.usccRaw}`), chunk))
        .orderBy(sql`${s.platformExportBatch.year} desc`, sql`${s.platformExportBatch.id} desc`, s.platformExportRow.sourceRowNo).all()
      for (const row of exports) {
        const key = normalizeUscc(row.uscc)
        if (!exportNames.has(key) && row.name?.trim()) exportNames.set(key, row.name.trim())
      }
    }
  }
  return { index, load, exportName: (code: string) => exportNames.get(normalizeUscc(code)) ?? null }
}
