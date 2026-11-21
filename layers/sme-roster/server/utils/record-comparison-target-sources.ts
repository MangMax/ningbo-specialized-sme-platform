/** Comparison owns its page/query/row title rules. Source owners own normalized facts. */
import { and, eq, inArray, max } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { targetSchema as s } from '../../lib/platform/target-schema'
import { storedApplyProjection } from '../../lib/platform/apply-stored-schema'
import { storedProcessProjection } from '../../lib/platform/process-stored-schema'
import { storedRecognizedProjection } from '../../lib/platform/recognized-stored-schema'
import { readTargetDeclarationFacts } from './platform-declarations-target'
import { readTargetBusinessProcessFacts } from './platform-business-processes-target'
import { readTargetRecognizedFacts } from './platform-recognized-target'

type Db = BetterSQLite3Database<typeof schema>
const batches = <T>(rows: T[]) => Array.from({ length: Math.ceil(rows.length / 300) }, (_, i) => rows.slice(i * 300, i * 300 + 300))
export function readComparisonTargetQueryFacts(db: Db, ids: number[]) {
  const qa = s.platformLegacyQueryAlias, c = s.platformCollection
  const owners = batches(ids).flatMap(ids => db.select({ id: qa.oldId, collection: c }).from(qa).innerJoin(c, eq(c.id, qa.collectionId)).where(inArray(qa.oldId, ids)).orderBy(qa.oldId).all()).sort((a, b) => a.id - b.id)
  const collections = owners.map(r => r.collection.id)
  const pages = Map.groupBy(batches(collections).flatMap(ids => db.select().from(s.platformCollectionPage).where(inArray(s.platformCollectionPage.collectionId, ids)).orderBy(s.platformCollectionPage.ordinal).all()), r => r.collectionId)
  const conditions = Map.groupBy(batches(collections).flatMap(ids => db.select().from(s.platformCollectionCondition).where(inArray(s.platformCollectionCondition.collectionId, ids)).all()), r => r.collectionId)
  const scopes = Map.groupBy(batches(collections).flatMap(ids => db.select().from(s.platformQueryTitleScope).where(inArray(s.platformQueryTitleScope.collectionId, ids)).all()), r => r.collectionId)
  const unfinished = Map.groupBy(batches(collections).flatMap(ids => db.select().from(s.platformCollectionUnfinished).where(inArray(s.platformCollectionUnfinished.collectionId, ids)).orderBy(s.platformCollectionUnfinished.ordinal).all()), r => r.collectionId)
  return owners.map(({ id, collection: c }) => ({ id, collection: c, evidencePresent: c.provenanceState === 'captured' || c.provenanceState === 'conflict', pages: pages.get(c.id) ?? [],
    // Ordinary transport conditions are strings. Preserve null/absence rather than invent defaults.
    conditions: (c.provenanceState === 'captured' || c.provenanceState === 'conflict') && conditions.has(c.id) ? Object.fromEntries((conditions.get(c.id) ?? []).filter(r => r.valueKind !== 'absent').map(r => [r.name, r.valueKind === 'text' ? r.textValue : r.valueKind === 'boolean' ? Boolean(r.integerValue) : r.integerValue])) : null,
    // Normal collection commands bind rdjb to titleScope.rdjb.join(','); the membership index has no order.
    scopes: (scopes.get(c.id) ?? []).map(r => r.rdjb).sort((a, b) => c.rdjb.split(',').indexOf(a) - c.rdjb.split(',').indexOf(b)), unfinished: unfinished.get(c.id) ?? [],
  }))
}
export type ComparisonTargetQueryFacts = ReturnType<typeof readComparisonTargetQueryFacts>[number]

/** Current attribution and original source identity are different owners. No archive is parsed. */
export function readComparisonTargetIdentities(db: Db, ids: number[]) {
  const o = s.platformBusinessObservation, a = s.platformObservationAssignment, ra = s.platformLegacyRelationAlias, qa = s.platformLegacyQueryAlias
  const original = alias(a, 'comparison_original'), newer = alias(a, 'comparison_newer')
  return batches(ids).flatMap(ids => db.select({ id: ra.oldId, observationId: o.id, queryId: qa.oldId, sequenceNo: o.sequenceNo, relationKey: o.sourceRelationKey,
    enterpriseId: a.enterpriseId, matchBasis: a.matchBasis, verificationStatus: a.verificationStatus, nameRaw: original.nameRaw, usccRaw: original.usccRaw,
  }).from(qa).innerJoin(o, eq(o.collectionId, qa.collectionId)).innerJoin(ra, eq(ra.observationId, o.id))
    .innerJoin(a, and(eq(a.observationId, o.id), eq(a.revision, db.select({ n: max(newer.revision) }).from(newer).where(eq(newer.observationId, o.id)))))
    .innerJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
    .where(inArray(qa.oldId, ids)).orderBy(ra.oldId).all()).sort((a, b) => a.id - b.id)
}
export function readComparisonTargetRelations(db: Db, queryIds: number[]) {
  const identities = readComparisonTargetIdentities(db, queryIds)
  const ids = identities.map(r => r.id), observations = identities.map(r => r.observationId)
  const facts = new Map([...readTargetDeclarationFacts(db, ids), ...readTargetBusinessProcessFacts(db, ids, { scope: 'selected' }), ...readTargetRecognizedFacts(db, ids)])
  const titles = new Map(batches(observations).flatMap(ids => [storedApplyProjection, storedProcessProjection, storedRecognizedProjection].flatMap(p => db.select({ id: p.observationId, kind: p.sourceTitleKind, text: p.sourceTitleText, number: p.sourceTitleNumberText }).from(p).where(inArray(p.observationId, ids)).all())).map(r => [r.id, r.kind === 'text' ? r.text : r.kind === 'number' ? r.number : null]))
  return identities.map(row => {
    const fact = facts.get(row.id)
    if (!fact) throw new Error('comparison_observation_fact_missing')
    const normalized = fact.archiveProcessFacts ?? fact
    return { ...row, province: normalized.province, status: normalized.status, batch: normalized.batch, declareKind: normalized.declareKind,
      appliedAt: normalized.appliedAt, awardBatchLabel: normalized.awardBatchLabel, year: normalized.year, normalizationConflicts: fact.normalizationConflicts,
      rawFields: { rdjb: titles.get(row.observationId) ?? null } }
  })
}
