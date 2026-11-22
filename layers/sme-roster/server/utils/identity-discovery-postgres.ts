import { isCurrentPlatformObservation } from '../../lib/platform/current-observation-postgres'
import { and, count, desc, eq, gt, lte, ne, notExists, or, sql, type SQLWrapper } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise, enterpriseAlias, enterpriseMerge } from '../../../../db/postgresql/enterprise-tables'
import { importBatch } from '../../../../db/postgresql/import-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { platformBusinessObservation, platformCollection, platformExportBatch, platformExportRow,
  platformObservationAssignment } from '../../../../db/postgresql/platform-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import { postgresCanonicalEnterpriseId } from '../../../core/server/public'
import { normalizeUscc } from '../../lib/domain'
import { formerPlatformMembers } from '../../lib/roster/enterprise-list-postgres'
import { duplicateCandidatesFromBatch } from '../../lib/roster/duplicate-merge'
import type { RosterImportItemResult, RosterImportPreflight } from '../../lib/roster-import-client'
import { planPostgresPlatformQueries } from './collection-import-postgres'
import { duplicateMergeSourceIdentity, findIndexedUsccEvidence, projectDuplicateMerge, type PlatformEvidenceIndex, type PlatformEvidenceQuery, type PlatformEvidenceRelation } from './roster-duplicate-merge-model'
import { prepareUsccClaims, type UsccQueryParse } from './uscc-research-query'
import { platformOnlyUsccTargets, selectUsccTargetRows } from './uscc-target-selection'
import { pageUsccChecklist, prepareUsccResearch, projectUsccDictionary, projectUsccResearch, projectUsccTargets, type UsccTargetSnapshot } from './uscc-research-model'

type Reader = Pick<NodePgDatabase, 'select'>
// Drizzle inArray binds each element separately. The checklist and its evidence
// sets can span more IDs or keys than PostgreSQL permits in one Bind message.
const containsIds = (column: SQLWrapper, ids: number[]) => sql`${column} = ANY(${sql.param(ids)}::bigint[])`
const containsKeys = (column: SQLWrapper, values: string[]) => sql`${column} = ANY(${sql.param(values)}::text[])`
const representable = (text: string) => !text.includes('\0') && text.isWellFormed()
const currentIdentity = (db: Reader) => notExists(db.select({ id: enterpriseMerge.fromEnterpriseId })
  .from(enterpriseMerge).where(eq(enterpriseMerge.fromEnterpriseId, enterprise.id)))
const usccWhitespace = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u200b\u200c\u200d\u2028\u2029\u202f\u205f\u3000\ufeff'

function potentiallyMatchingUscc(column: SQLWrapper, codes: string[]) {
  // These PostgreSQL scalar expressions narrow the scan. The JS normalizer is
  // authoritative, including Unicode uppercase expansions.
  const stripped = sql`translate(${column}, ${usccWhitespace}, '')`
  const length = sql`length(${stripped})`
  return or(
    containsKeys(column, codes),
    containsKeys(sql`upper(${stripped} COLLATE "C")`, codes),
    and(
      gt(sql`octet_length(${stripped})`, length),
      lte(length, codes.reduce((max, code) => Math.max(max, code.length), 0)),
      codes.some(code => code.startsWith('NAME:')) ? undefined : ne(sql`lower(left(${stripped}, 5) COLLATE "C")`, 'name:'),
    ),
  )
}

const queryFields = {
  id: platformCollection.publicId,
  interface: sql<PlatformEvidenceQuery['interface']>`${platformCollection.interface}`,
  queryKey: platformCollection.queryKey,
  rdjb: platformCollection.rdjb,
  queriedAt: platformCollection.queriedAt,
}
const initialAssignment = and(
  eq(platformObservationAssignment.observationId, platformBusinessObservation.id),
  eq(platformObservationAssignment.revision, 1),
)
const parseJson = <T>(value: string | null): T | null => value === null ? null : JSON.parse(value)

type Owner = Parameters<typeof projectUsccDictionary>[0][number] & { city: string | null }
type Alias = Parameters<typeof projectUsccDictionary>[1][number]

async function readTargets(db: NodePgDatabase, owners: Owner[], aliases: Alias[], filter: Extract<UsccQueryParse, { ok: true }>["planFilter"]): Promise<UsccTargetSnapshot> {
  const missing = owners.filter(owner => !normalizeUscc(owner.usccNorm))
  const records = await db.select({
    id: record.id, enterpriseId: record.enterpriseId, titleCode: record.titleCode,
    source: record.source, district: record.district,
  }).from(record).where(containsIds(record.enterpriseId, missing.map(owner => owner.id))).orderBy(record.id)
  const platformOnly = platformOnlyUsccTargets(records)
  const removed = platformOnly.size ? (await formerPlatformMembers(db)).intersection(platformOnly) : new Set<number>()
  const rows = selectUsccTargetRows(missing, records, aliases, removed, filter)
  const selectedIds = new Set(rows.map(row => row.enterpriseId))
  const enterprises = missing.filter(row => selectedIds.has(row.id))
  const selectedRecords = records.filter(row => selectedIds.has(row.enterpriseId))
  const keys = [...new Set(enterprises.map(row => 'name:' + row.nameNorm))].filter(representable)
  const events = await db.select({ id: recordEvent.id, recordId: recordEvent.recordId }).from(recordEvent)
    .where(containsIds(recordEvent.recordId, selectedRecords.map(row => row.id))).orderBy(recordEvent.id)
  const evidence = await db.select({
    recordEventId: recordEvidence.recordEventId, sourceFile: recordEvidence.sourceFile, attachment: recordEvidence.attachment,
    listNo: recordEvidence.listNo, page: recordEvidence.page,
  }).from(recordEvidence).where(containsIds(recordEvidence.recordEventId, events.map(row => row.id))).orderBy(recordEvidence.id)
  const differences = await db.select({
    id: differenceReason.id, enterpriseId: differenceReason.enterpriseId, titleCode: differenceReason.titleCode,
    direction: differenceReason.direction, recordedAt: differenceReason.recordedAt, status: differenceReason.status,
    reasonCode: differenceReason.reasonCode, reasonNote: differenceReason.reasonNote,
  }).from(differenceReason).where(containsIds(differenceReason.enterpriseId, [...selectedIds])).orderBy(differenceReason.id)
  const relationCount = db.select({ count: count() }).from(platformBusinessObservation)
    .innerJoin(platformObservationAssignment, initialAssignment).where(and(eq(platformBusinessObservation.collectionId, platformCollection.id), isCurrentPlatformObservation(db)))
  const traces = await db.select({
    ...queryFields, status: sql<UsccTargetSnapshot['queries'][number]['status']>`${platformCollection.status}`,
    count: sql<number>`${relationCount}`.mapWith(Number),
  }).from(platformCollection)
    .where(containsKeys(platformCollection.queryKey, keys)).orderBy(platformCollection.publicId)
  return { rows, enterprises, records: selectedRecords, events, evidence, differences,
    queries: traces, relationCounts: traces.map(row => ({ queryId: row.id, count: row.count })) }
}

async function readEvidence(db: Reader, requested: string[]) {
  const codes = [...new Set(requested.map(normalizeUscc).filter(code => code && representable(code)))]
  const wanted = new Set(codes)
  const index: PlatformEvidenceIndex = { queriesByUscc: new Map(), relationsByQuery: new Map() }
  const exportNames = new Map<string, string>()
  if (codes.length) {
    const rows = await db.select(queryFields).from(platformCollection)
      .where(potentiallyMatchingUscc(platformCollection.queryKey, codes)).orderBy(platformCollection.publicId)
    const queryIds: number[] = []
    for (const query of rows) {
      const code = normalizeUscc(query.queryKey)
      if (!wanted.has(code)) continue
      queryIds.push(query.id)
      const bucket = index.queriesByUscc.get(code) ?? []
      bucket.push(query)
      index.queriesByUscc.set(code, bucket)
    }
    const relations: PlatformEvidenceRelation[] = await db.select({
      id: platformBusinessObservation.publicId, queryId: platformCollection.publicId,
      sequenceNo: platformBusinessObservation.sequenceNo, relationKey: platformBusinessObservation.sourceRelationKey,
      nameRaw: platformObservationAssignment.nameRaw, usccRaw: platformObservationAssignment.usccRaw,
    }).from(platformCollection)
      .innerJoin(platformBusinessObservation, eq(platformBusinessObservation.collectionId, platformCollection.id))
      .innerJoin(platformObservationAssignment, initialAssignment)
      .where(and(containsIds(platformCollection.publicId, queryIds), isCurrentPlatformObservation(db)))
      .orderBy(platformCollection.publicId, platformBusinessObservation.sequenceNo, platformBusinessObservation.publicId)
    for (const relation of relations) {
      const bucket = index.relationsByQuery.get(relation.queryId) ?? []
      bucket.push(relation)
      index.relationsByQuery.set(relation.queryId, bucket)
    }
    const exports = await db.select({ uscc: platformExportRow.usccRaw, name: platformExportRow.nameRaw })
      .from(platformExportRow).innerJoin(platformExportBatch, eq(platformExportBatch.id, platformExportRow.batchId))
      .where(potentiallyMatchingUscc(platformExportRow.usccRaw, codes))
      .orderBy(desc(platformExportBatch.year), desc(platformExportBatch.id), platformExportRow.sourceRowNo)
    for (const row of exports) {
      const code = normalizeUscc(row.uscc)
      if (wanted.has(code) && !exportNames.has(code) && row.name?.trim()) exportNames.set(code, row.name.trim())
    }
  }
  return { index, exportName: (code: string) => exportNames.get(code) ?? null }
}

export function readPostgresUsccResearch(db: NodePgDatabase, parsed: Extract<UsccQueryParse, { ok: true }>) {
  return db.transaction(async tx => {
    const owners: Owner[] = await tx.select({
      id: enterprise.id, name: enterprise.name, nameNorm: enterprise.nameNorm, usccNorm: enterprise.usccNorm,
      district: enterprise.district, city: enterprise.city,
    }).from(enterprise).where(currentIdentity(tx)).orderBy(enterprise.id)
    const aliases: Alias[] = await tx.select({
      enterpriseId: enterpriseAlias.enterpriseId, name: enterpriseAlias.name, nameNorm: enterpriseAlias.nameNorm,
    }).from(enterpriseAlias).innerJoin(enterprise, eq(enterprise.id, enterpriseAlias.enterpriseId))
      .where(and(eq(enterpriseAlias.verificationStatus, 'confirmed'), currentIdentity(tx))).orderBy(enterpriseAlias.id)
    const targets = projectUsccTargets(await readTargets(tx, owners, aliases, parsed.planFilter))
    const { claims, verdicts } = prepareUsccClaims(parsed)
    const inputs = prepareUsccResearch(targets, projectUsccDictionary(owners, aliases), claims)
    const plan = projectUsccResearch(inputs, await readEvidence(tx, inputs.codes), claims)
    let step = plan.next()
    while (!step.done) {
      const { conflicts } = await planPostgresPlatformQueries(tx, step.value.payload.platformQueries!)
      step = plan.next(conflicts)
    }
    return {
      checklist: pageUsccChecklist(targets, parsed.filter),
      plan: step.value,
      ...(verdicts ? { verdicts } : {}),
    }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function readPostgresDuplicateMerge(db: NodePgDatabase, batchKey: string) {
  if (!representable(batchKey)) return null
  return db.transaction(async tx => {
    const [batch] = await tx.select({
      batchId: importBatch.id, items: importBatch.itemResults, preflight: importBatch.preflightResult,
    }).from(importBatch).where(eq(importBatch.idempotencyKey, batchKey))
    if (!batch) return null
    const duplicateCandidates = duplicateCandidatesFromBatch(
      parseJson<RosterImportItemResult[]>(batch.items), parseJson<RosterImportPreflight>(batch.preflight),
    )
    const [executed] = await tx.select({ id: importBatch.id, idempotencyKey: importBatch.idempotencyKey })
      .from(importBatch).where(and(
        eq(importBatch.sourceIdentity, duplicateMergeSourceIdentity(batchKey)), eq(importBatch.status, 'committed'),
      )).orderBy(desc(importBatch.id)).limit(1)
    const evidence = await readEvidence(tx, duplicateCandidates.map(candidate => normalizeUscc(candidate.newUscc)))
    async function byId(id: number) {
      const canonical = Number.isSafeInteger(id) ? await postgresCanonicalEnterpriseId(tx, id) : null
      if (canonical == null) return null
      const [owner] = await tx.select({ id: enterprise.id, name: enterprise.name, usccNorm: enterprise.usccNorm })
        .from(enterprise).where(eq(enterprise.id, canonical))
      return owner ?? null
    }
    return projectDuplicateMerge(batchKey, { batchId: batch.batchId, duplicateCandidates }, executed, {
      byId,
      async byUscc(uscc) {
        if (!representable(uscc)) return null
        const [owner] = await tx.select({ id: enterprise.id }).from(enterprise).where(eq(enterprise.usccNorm, uscc))
        return owner ? byId(owner.id) : null
      },
      evidence: (uscc, name) => findIndexedUsccEvidence(evidence.index, { uscc, name }),
      exportName: evidence.exportName,
    })
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
