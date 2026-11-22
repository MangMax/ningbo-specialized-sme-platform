import { platformOnlyUsccTargets, selectUsccTargetRows } from './uscc-target-selection'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { currentEnterpriseIdentity } from '../../lib/roster/enterprise-identity'
import { removedEnterpriseIds } from '../../lib/roster/enterprise-list-selection'
import { identityFunctions, identityUsccSql } from '../../lib/roster/enterprise-read-snapshot'
import type { UsccChecklistFilter } from '../../lib/roster/uscc-research'
import { targetCandidateTables } from './candidate-target-sources'
import type { PlatformEvidenceIndex } from './roster-duplicate-merge-model'
type Db = BetterSQLite3Database<typeof s>
export function readUsccTargets(db: Db, filter: Omit<UsccChecklistFilter, 'page' | 'pageSize'>) {
  identityFunctions(db)
  const { q, r } = targetCandidateTables(db)
  const missing = db.select({ id: s.enterprise.id, name: s.enterprise.name, nameNorm: s.enterprise.nameNorm, district: s.enterprise.district, city: s.enterprise.city })
    .from(s.enterprise).where(and(currentEnterpriseIdentity(db), sql`${identityUsccSql(sql`${s.enterprise.usccNorm}`)} is null`)).orderBy(s.enterprise.id).all()
  const ids = missing.map(row => row.id)
  const records = db.select({ id: s.record.id, enterpriseId: s.record.enterpriseId, titleCode: s.record.titleCode, source: s.record.source, district: s.record.district })
    .from(s.record).where(inArray(s.record.enterpriseId, ids)).orderBy(s.record.id).all()
  const aliases = db.select({ enterpriseId: s.enterpriseAlias.enterpriseId, name: s.enterpriseAlias.name })
    .from(s.enterpriseAlias).where(and(inArray(s.enterpriseAlias.enterpriseId, ids), eq(s.enterpriseAlias.verificationStatus, 'confirmed'))).all()
  const platformOnly = [...platformOnlyUsccTargets(records)]
  const rows = selectUsccTargetRows(missing, records, aliases, removedEnterpriseIds(db, platformOnly), filter)
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
  const queryScope = inArray(q.queryKey, keys)
  const queries = db.select({ id: q.id, interface: q.interface, queryKey: q.queryKey, rdjb: q.rdjb, queriedAt: q.queriedAt, status: q.status })
    .from(q).where(queryScope).orderBy(q.id).all()
  const relationCounts = db.select({ queryId: r.queryId, count: sql<number>`count(*)` }).from(r)
    .where(inArray(sql<number>`${r.queryId}`, db.select({ id: q.id }).from(q).where(queryScope)))
    .groupBy(sql<number>`${r.queryId}`).all()
  return { rows, enterprises, records: selectedRecords, events, evidence, differences, queries, relationCounts }
}
/** Hydrate each newly encountered candidate code once, in batches. All related
 * queries and relations are retained; no LIMIT can hide a second subject. */
export function usccResearchEvidence(db: Db) {
  identityFunctions(db)
  const { q, r } = targetCandidateTables(db)
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
      const scope = inArray(identityUsccSql(sql`${q.queryKey}`), chunk)
      const queries = db.select({ id: q.id, interface: q.interface, queryKey: q.queryKey, rdjb: q.rdjb, queriedAt: q.queriedAt })
        .from(q).where(scope).orderBy(q.id).all()
      for (const query of queries) {
        const key = normalizeUscc(query.queryKey)
        const bucket = index.queriesByUscc.get(key) ?? []
        bucket.push(query); index.queriesByUscc.set(key, bucket)
      }
      const relations = db.select({ id: r.id, queryId: r.queryId, sequenceNo: r.sequenceNo, relationKey: r.relationKey, nameRaw: r.nameRaw, usccRaw: r.usccRaw }).from(r)
        .where(inArray(sql<number>`${r.queryId}`, db.select({ id: q.id }).from(q).where(scope)))
        .orderBy(asc(r.queryId), asc(r.sequenceNo)).all()
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
export { platformOnlyUsccTargets, selectUsccTargetRows } from './uscc-target-selection'
