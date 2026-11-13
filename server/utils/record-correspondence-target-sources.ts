import { platformNormalizationConflict } from '../../lib/platform/normalization'
/** Structured decision facts, plus original cells solely for historical fingerprints. */
import { and, eq, getTableColumns, inArray, max, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as legacy from '../../db/schema'
import { targetSchema as s } from '../../lib/platform/target-schema'
import { cellExpression, snapshotSchema } from '../../lib/platform/target-evidence-read'
import { storedApplyProjection } from '../../lib/platform/apply-stored-schema'
import { storedProcessProjection } from '../../lib/platform/process-stored-schema'
import { storedRecognizedProjection } from '../../lib/platform/recognized-stored-schema'
import type { PlatformNormalizationConflict } from '../../lib/platform/normalization'

type Db = BetterSQLite3Database<typeof legacy>
const fields = [
  ['province', 'reconciledProvince', 'provinceConflict', 'storedProvince', 'parsedProvince'],
  ['status', 'reconciledStatus', 'statusConflict', 'storedStatus', 'parsedStatus'],
  ['batch', 'reconciledBatch', 'batchConflict', 'storedBatch', 'parsedBatch'],
  ['declareKind', 'reconciledDeclareKind', 'declareKindConflict', 'storedDeclareKind', 'parsedDeclareKind'],
  ['appliedAt', 'reconciledAppliedAt', 'appliedAtConflict', 'storedAppliedAt', 'parsedAppliedAt'],
  ['awardBatchLabel', 'reconciledAwardBatchLabel', 'awardBatchLabelConflict', 'storedAwardBatchLabel', 'parsedAwardBatchLabel'],
  ['year', 'reconciledYear', 'yearConflict', 'storedYear', 'parsedYear'],
] as const
function chunks<T>(values: T[]) { return Array.from({ length: Math.ceil(values.length / 300) }, (_, i) => values.slice(i * 300, (i + 1) * 300)) }
export function readCorrespondenceTargetSources(db: Db, ids: number[]) {
  const o = s.platformBusinessObservation, a = s.platformObservationAssignment, ra = s.platformLegacyRelationAlias, qa = s.platformLegacyQueryAlias, c = s.platformCollection
  const newer = alias(a, 'correspondence_newer_assignment'), original = alias(a, 'correspondence_original_assignment')
  const owners = chunks([...new Set(ids)]).flatMap(ids => db.select({ id: ra.oldId, queryId: qa.oldId, observation: o, collection: c, assignment: a, original }).from(ra)
    .innerJoin(o, eq(o.id, ra.observationId)).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(qa, eq(qa.collectionId, c.id))
    .innerJoin(a, and(eq(a.observationId, o.id), eq(a.revision, db.select({ revision: max(newer.revision) }).from(newer).where(eq(newer.observationId, o.id)))))
    .innerJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
    .where(inArray(ra.oldId, ids)).all())
  const observationIds = owners.map(r => r.observation.id)
  const projections = new Map(chunks(observationIds).flatMap(ids => [
    ...db.select().from(storedApplyProjection).where(inArray(storedApplyProjection.observationId, ids)).all(),
    ...db.select().from(storedProcessProjection).where(inArray(storedProcessProjection.observationId, ids)).all(),
    ...db.select().from(storedRecognizedProjection).where(inArray(storedRecognizedProjection.observationId, ids)).all(),
  ]).map(p => [p.observationId, p]))
  const r = s.platformObservationArchiveRef, v = s.platformArchiveValue
  const snapshots = new Map(chunks(observationIds).flatMap(ids => db.select({ id: r.ownerId, bytes: v.bytes }).from(r).innerJoin(v, eq(v.id, r.archiveId)).where(and(inArray(r.ownerId, ids), eq(r.field, 'legacyRowSnapshot'))).all()).map(r => {
    if (!r.bytes) throw new Error('Missing original correspondence fingerprint snapshot')
    return [r.id, snapshotSchema.parse(JSON.parse(r.bytes.toString('utf8'))).fields] as const
  }))
  const relationColumns = getTableColumns(legacy.platformRelation)
  const jobs = owners.map(owner => {
    const cells = snapshots.get(owner.observation.id)!
    const expressions = Object.entries(relationColumns).map(([key, column]) => {
      const current = key === 'id' ? sql`${owner.id}` : key === 'queryId' ? sql`${owner.queryId}` : key === 'enterpriseId' ? sql`${owner.assignment.enterpriseId}` : key === 'matchBasis' ? sql`${owner.assignment.matchBasis}` : key === 'verificationStatus' ? sql`${owner.assignment.verificationStatus}` : null
      const cell = cells.find(c => c.name === column.name)
      if (!current && !cell) throw new Error(`Missing fingerprint cell ${column.name}`)
      return sql`${current ?? cellExpression(cell!)} AS ${sql.identifier(key)}`
    })
    return sql`SELECT ${sql.join(expressions, sql`, `)}`
  })
  // Original SQLite cells are decoded in batches only for existing hash/serialized evidence inputs.
  const originals = new Map(chunks(jobs).flatMap(jobs => db.all<Record<string, unknown>>(sql.join(jobs, sql` UNION ALL `))).map(row => {
    const value = Object.fromEntries(Object.entries(relationColumns).map(([key, column]) => [key, row[key] == null ? null : column.mapFromDriverValue(row[key])])) as typeof legacy.platformRelation.$inferSelect
    return [value.id, value] as const
  }))
  const queries = readCorrespondenceTargetQueries(db, owners.map(owner => owner.queryId))
  return owners.map(owner => {
    const p = projections.get(owner.observation.id)
    if (!p) throw new Error('Missing correspondence source projection')
    const normalizationConflicts: PlatformNormalizationConflict[] = fields.flatMap(([field, , conflict, stored, parsed]) => p[conflict] && p[stored] !== null && p[parsed] !== null ? [platformNormalizationConflict(field, p[stored], p[parsed])] : [])
    const position = queries.get(owner.queryId)!.pages.find(page => page.status === 'success' && page.sequenceStart !== null && page.sequenceEnd !== null && owner.observation.sequenceNo >= page.sequenceStart && owner.observation.sequenceNo <= page.sequenceEnd)
    const query = queries.get(owner.queryId)!.query
    const relation = originals.get(owner.id)!
    const facts = { id: owner.id, queryId: owner.queryId, sequenceNo: owner.observation.sequenceNo, enterpriseId: owner.assignment.enterpriseId, usccRaw: owner.original.usccRaw, verificationStatus: owner.assignment.verificationStatus,
      province: p.reconciledProvince, status: p.reconciledStatus, batch: p.reconciledBatch, declareKind: p.reconciledDeclareKind, appliedAt: p.reconciledAppliedAt, awardBatchLabel: p.reconciledAwardBatchLabel, year: p.reconciledYear, normalizationConflicts,
      rawFields: { rdjb: p.sourceTitleKind === 'text' ? p.sourceTitleText : p.sourceTitleKind === 'number' ? p.sourceTitleNumberText : null }, sourceRdjb: position?.rdjb ?? null }
    // usccRaw is an original source fact captured at assignment revision 1, never its mutable attribution.
    return { relation, query, facts, observationId: owner.observation.id }
  })
}

/** Collection predicates use these structured rows; query is only the original fingerprint input. */
export function readCorrespondenceTargetQueries(db: Db, ids: number[], options: { rawResponse?: boolean } = {}) {
  const qa = s.platformLegacyQueryAlias, c = s.platformCollection, r = s.platformCollectionArchiveRef, v = s.platformArchiveValue
  const owners = chunks([...new Set(ids)]).flatMap(ids => db.select({ queryId: qa.oldId, collection: c }).from(qa).innerJoin(c, eq(c.id, qa.collectionId)).where(inArray(qa.oldId, ids)).all())
  const collectionIds = owners.map(row => row.collection.id)
  const archives = Map.groupBy(chunks(collectionIds).flatMap(ids => db.select({ id: r.ownerId, field: r.field, bytes: v.bytes }).from(r).innerJoin(v, eq(v.id, r.archiveId)).where(and(inArray(r.ownerId, ids), inArray(r.field, options.rawResponse === false ? ['collectionEvidence'] : ['rawResponse', 'collectionEvidence']))).all()), r => r.id)
  const pages = Map.groupBy(chunks(collectionIds).flatMap(ids => db.select().from(s.platformCollectionPage).where(inArray(s.platformCollectionPage.collectionId, ids)).orderBy(s.platformCollectionPage.ordinal).all()), r => r.collectionId)
  const conditions = Map.groupBy(chunks(collectionIds).flatMap(ids => db.select().from(s.platformCollectionCondition).where(inArray(s.platformCollectionCondition.collectionId, ids)).all()), r => r.collectionId)
  const scopes = Map.groupBy(chunks(collectionIds).flatMap(ids => db.select().from(s.platformQueryTitleScope).where(inArray(s.platformQueryTitleScope.collectionId, ids)).all()), r => r.collectionId)
  const unfinished = Map.groupBy(chunks(collectionIds).flatMap(ids => db.select().from(s.platformCollectionUnfinished).where(inArray(s.platformCollectionUnfinished.collectionId, ids)).all()), r => r.collectionId)
  return new Map(owners.map(owner => {
    const c = owner.collection
    const bytes = (field: string) => archives.get(c.id)?.find(r => r.field === field)?.bytes ?? null
    const query: typeof legacy.platformQuery.$inferSelect = { id: owner.queryId, interface: c.interface, queryKey: c.queryKey, rdjb: c.rdjb, titleCode: c.titleCode, queriedAt: c.queriedAt, lastCollectedAt: c.lastCollectedAt, status: c.status, failureReason: c.failureReason, rawResponse: bytes('rawResponse')?.toString('utf8') ?? null, collectionEvidence: bytes('collectionEvidence') === null ? null : JSON.parse(bytes('collectionEvidence')!.toString('utf8')), createdAt: c.createdAt }
    return [owner.queryId, { query, collection: c, pages: pages.get(c.id) ?? [], conditions: conditions.get(c.id) ?? [], scopes: scopes.get(c.id) ?? [], unfinished: unfinished.get(c.id) ?? [] }] as const
  }))
}
export function correspondenceRelationQueryId(db: Db, id: number) {
  const a = s.platformLegacyRelationAlias, o = s.platformBusinessObservation, q = s.platformLegacyQueryAlias
  return db.select({ queryId: q.oldId }).from(a).innerJoin(o, eq(o.id, a.observationId)).innerJoin(q, eq(q.collectionId, o.collectionId)).where(eq(a.oldId, id)).get()?.queryId
}
export function correspondenceQueryRelationIds(db: Db, queryId: number) {
  const a = s.platformLegacyRelationAlias, o = s.platformBusinessObservation, q = s.platformLegacyQueryAlias
  return db.select({ id: a.oldId }).from(q).innerJoin(o, eq(o.collectionId, q.collectionId)).innerJoin(a, eq(a.observationId, o.id)).where(eq(q.oldId, queryId)).orderBy(a.oldId).all().map(row => row.id)
}
