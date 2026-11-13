/** Explicit target evidence DISPLAY only. Never import into candidate membership/count/filter/sort,
 * correspondence decisions/roles/authorization/validity, qualification, annual closure or proof.
 * Selection and attribution use structured owners; archives are decoded only after selection.
 * This is not sourceReader: correspondence links and their authorization closure stay with H1.
 */
import {requireH1cReady} from './h1c-catalog'
import {sqliteConnection} from './target-connection'
import { createHash } from 'node:crypto'
import { and, eq, inArray, max, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import { targetSchema as s } from './target-schema'
import { storedApplyProjection } from './apply-stored-schema'
import { storedProcessProjection } from './process-stored-schema'
import { storedRecognizedProjection } from './recognized-stored-schema'
import { cellExpression, snapshotSchema } from './target-evidence-read'
import { sourcePositionForSequence } from './recognized-evidence'
import { resolveSelectedLegacyProvenance, readResolvedLegacyDisplay, type SelectedLegacyProvenance } from './target-legacy-provenance'
import { assertTargetDisplayBudget } from './target-query-budget'
import { requireLegacyProvenanceReady } from './legacy-provenance-catalog'
import { legacySourcePositionForSequence } from './legacy-provenance'

export type RelationEvidenceDisplaySelection = Readonly<{ relationId: number; queryId?: number }>
/** Original display presentation, deliberately not a PlatformObservationFact or decision input.
 * Callers render it or attach separately authorized links; no correspondences property is fabricated.
 */
export type RelationEvidenceDisplay = Record<string, unknown> | null
const archiveShape = z.object({ storageClass: z.enum(['null', 'text', 'blob']), bytes: z.instanceof(Buffer).nullable(), byteLength: z.number().nullable(), sha256: z.string().nullable(), sealed: z.literal(1) })
function authenticatedBytes(value: unknown) {
  const a = archiveShape.parse(value)
  if (a.storageClass === 'null') {
    if (a.bytes !== null || a.byteLength !== null || a.sha256 !== null) throw new Error('Contradictory NULL evidence archive')
  } else if (!a.bytes || a.bytes.length !== a.byteLength || createHash('sha256').update(a.bytes).digest('hex') !== a.sha256) {
    throw new Error('Evidence archive byte/hash drift')
  }
  return a
}
function chunks<T>(items: readonly T[]) {
  return Array.from({ length: Math.ceil(items.length / 300) }, (_, i) => items.slice(i * 300, (i + 1) * 300))
}
const fields = [
  ['province', 'reconciledProvince', 'provinceConflict', 'storedProvince', 'parsedProvince'],
  ['status', 'reconciledStatus', 'statusConflict', 'storedStatus', 'parsedStatus'],
  ['batch', 'reconciledBatch', 'batchConflict', 'storedBatch', 'parsedBatch'],
  ['declareKind', 'reconciledDeclareKind', 'declareKindConflict', 'storedDeclareKind', 'parsedDeclareKind'],
  ['appliedAt', 'reconciledAppliedAt', 'appliedAtConflict', 'storedAppliedAt', 'parsedAppliedAt'],
  ['awardBatchLabel', 'reconciledAwardBatchLabel', 'awardBatchLabelConflict', 'storedAwardBatchLabel', 'parsedAwardBatchLabel'],
  ['year', 'reconciledYear', 'yearConflict', 'storedYear', 'parsedYear'],
] as const

export function readTargetRelationDisplay<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>, selections: readonly RelationEvidenceDisplaySelection[], options: { fullCollectionEvidence?: boolean; legacy?: SelectedLegacyProvenance; budgetChecked?: boolean } = {},
): Readonly<{ purpose: 'platform_relation_evidence_display'; sources: ReadonlyMap<number, RelationEvidenceDisplay> }> {
  const selected = new Map<number, RelationEvidenceDisplaySelection>()
  for (const selection of selections) {
    if (![selection.relationId, ...(selection.queryId === undefined ? [] : [selection.queryId])].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid evidence display alias')
    if (selected.has(selection.relationId) && selected.get(selection.relationId)?.queryId !== selection.queryId) throw new Error('Conflicting evidence display alias pair')
    selected.set(selection.relationId, selection)
  }
  return db.transaction(tx => {
    const phase = tx.get<{ user_version: number }>(sql`PRAGMA user_version`)?.user_version
    if (phase !== 71610 && phase !== 71611 && phase !== 71612 && phase !== 71613) throw new Error('Explicit 71610 evidence display target required')
    if (phase === 71613) requireLegacyProvenanceReady(sqliteConnection(tx))
    if ((phase === 71611 || phase === 71612)) requireH1cReady(sqliteConnection(tx))
    const sources = new Map<number, RelationEvidenceDisplay>([...selected.keys()].map(id => [id, null]))
    const a = s.platformObservationAssignment, original = alias(a, 'display_original_assignment'), newer = alias(a, 'display_newer_assignment')
    const o = s.platformBusinessObservation, ra = s.platformLegacyRelationAlias, qa = s.platformLegacyQueryAlias, c = s.platformCollection
    // No evidence BLOB is read before this structured, external-alias selection and pairing.
    const owners = chunks([...selected.keys()]).flatMap(ids => tx.select({ relationId: ra.oldId, queryId: qa.oldId, observation: o, collection: c, assignment: a, original })
      .from(ra).innerJoin(o, eq(o.id, ra.observationId)).innerJoin(c, eq(c.id, o.collectionId))
      .leftJoin(qa, eq(qa.collectionId, c.id))
      .leftJoin(a, and(eq(a.observationId, o.id), eq(a.revision, tx.select({ revision: max(newer.revision) }).from(newer).where(eq(newer.observationId, o.id)))))
      .leftJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
      .where(inArray(ra.oldId, ids)).all()).filter(owner => {
        if (owner.queryId === null) throw new Error('Missing collection alias')
        return selected.get(owner.relationId)?.queryId === undefined || selected.get(owner.relationId)?.queryId === owner.queryId
      })
    if (!owners.length) return { purpose: 'platform_relation_evidence_display', sources }
    const distinctOwners = [...new Map(owners.map(owner => [owner.collection.id, owner])).values()]
    const selectedCollections = distinctOwners.map(owner => ({ collection: owner.collection, id: owner.queryId! }))
    const legacy = options.legacy ?? resolveSelectedLegacyProvenance(tx, selectedCollections)
    if (!options.budgetChecked) assertTargetDisplayBudget(tx, selectedCollections, legacy)
    const observationIds = owners.map(owner => owner.observation.id)
    const collectionIds = [...new Set(owners.map(owner => owner.collection.id))]
    const cr = s.platformCollectionArchiveRef, ar = s.platformObservationArchiveRef, v = s.platformArchiveValue
    const collectionArchives = chunks(collectionIds).flatMap(ids => tx.select({ ownerId: cr.ownerId, field: cr.field, sealed: cr.sealed, archiveId: v.id, storageClass: v.storageClass, byteLength: v.byteLength, sha256: v.sha256,
      bytes: sql<Buffer | null>`CASE WHEN ${cr.field} = 'collectionEvidence' THEN ${v.bytes} ELSE NULL END`,
    }).from(cr).leftJoin(v, eq(v.id, cr.archiveId)).where(inArray(cr.ownerId, ids)).all())
    const observationArchives = chunks(observationIds).flatMap(ids => tx.select({ ownerId: ar.ownerId, field: ar.field, sealed: ar.sealed, storageClass: v.storageClass, bytes: v.bytes, byteLength: v.byteLength, sha256: v.sha256 })
      .from(ar).leftJoin(v, eq(v.id, ar.archiveId)).where(inArray(ar.ownerId, ids)).all())
    const collectionById = Map.groupBy(collectionArchives, row => row.ownerId)
    const observationById = Map.groupBy(observationArchives, row => row.ownerId)
    const projections = new Map(chunks(observationIds).flatMap(ids => [
      ...tx.select().from(storedApplyProjection).where(inArray(storedApplyProjection.observationId, ids)).all().map(row => ({ source: 'apply_list', row, title: row.exactTitleRaw, captured: row.exactStoredState === 'captured' })),
      ...tx.select().from(storedProcessProjection).where(inArray(storedProcessProjection.observationId, ids)).all().map(row => ({ source: 'business_list', row, title: row.exactTitleRaw, captured: row.exactStoredState === 'captured' })),
      ...tx.select().from(storedRecognizedProjection).where(inArray(storedRecognizedProjection.observationId, ids)).all().map(row => ({ source: 'recognized_list', row, title: row.exactTitleRaw, captured: row.exactTitleState === 'captured' })),
    ]).map(p => [p.row.observationId, p]))
    // A collection's evidence and provenance are authenticated/decoded once per request,
    // even if hundreds of selected observations share it. Never retained across a request.
    const collectionDisplays = new Map<number, { query: object; position: (sequence: number) => ReturnType<typeof sourcePositionForSequence> }>()
    for (const owner of distinctOwners) {
      const collection = owner.collection, refs = collectionById.get(collection.id) ?? []
      const evidenceArchive = authenticatedBytes(refs.find(ref => ref.field === 'collectionEvidence'))
      const value = tx.get<{evidence: string | null}>(sql`select ${options.fullCollectionEvidence ? sql`cast(${evidenceArchive.bytes} as text)` : sql`json_remove(cast(${evidenceArchive.bytes} as text), '$.rows')`} AS evidence`)!
      const evidence = value.evidence === null ? null : JSON.parse(value.evidence)
      const resolved = legacy.get(collection.id)
      const provenance = resolved ? readResolvedLegacyDisplay(tx, resolved) : undefined
      const query = { id: owner.queryId, interface: collection.interface, queryKey: collection.queryKey, rdjb: collection.rdjb, titleCode: collection.titleCode, queriedAt: collection.queriedAt, lastCollectedAt: collection.lastCollectedAt, status: collection.status, failureReason: collection.failureReason, collectionEvidence: evidence, createdAt: collection.createdAt, ...(provenance ? { legacyProvenance: provenance } : {}) }
      collectionDisplays.set(collection.id, { query, position: sequence => provenance ? legacySourcePositionForSequence(provenance.collection, sequence) : sourcePositionForSequence(evidence, sequence) })
    }
    const snapshots = new Map(owners.map(owner => {
      const archive = authenticatedBytes(observationById.get(owner.observation.id)?.find(ref => ref.field === 'legacyRowSnapshot'))
      if (!archive.bytes) throw new Error('Missing sealed original relation snapshot')
      return [owner.observation.id, snapshotSchema.parse(JSON.parse(archive.bytes.toString('utf8'))).fields] as const
    }))
    const originalDisplayJobs = owners.map(owner => {
      const created = snapshots.get(owner.observation.id)!.find(cell => cell.name === 'created_at')
      if (!created) throw new Error('Missing original relation cell: created_at')
      const sourceAlias = snapshots.get(owner.observation.id)!.find(cell => cell.name === 'alias_name_raw')
      if (!sourceAlias) throw new Error('Missing original relation cell: alias_name_raw')
      const sourceText = snapshots.get(owner.observation.id)!.find(cell => cell.name === 'source_text')
      if (!sourceText) throw new Error('Missing original relation cell: source_text')
      // The source alias is original evidence text, not the assignment command's alias assertion.
      return sql`SELECT ${owner.observation.id} AS id, ${cellExpression(created)} AS createdAt, ${cellExpression(sourceAlias)} AS aliasNameRaw, ${cellExpression(sourceText)} AS sourceText`
    })
    const originalDisplayById = new Map(chunks(originalDisplayJobs).flatMap(jobs => tx.all<{id: number; createdAt: unknown; aliasNameRaw: unknown; sourceText: unknown}>(sql.join(jobs, sql` UNION ALL `))).map(row => [row.id, row]))
    for (const owner of owners) {
      const id = owner.observation.id, projection = projections.get(id), archives = observationById.get(id) ?? []
      if (!owner.assignment || !owner.original) throw new Error('Missing observation assignment')
      if (!projection || projection.source !== owner.collection.interface || !projection.captured || projection.row.sourceTitleRuleVersion !== 't05b-source-projections-v1') throw new Error('Missing required source display capture')
      const raw = authenticatedBytes(archives.find(ref => ref.field === 'rawFields'))
      authenticatedBytes(archives.find(ref => ref.field === 'sourceText'))
      const display = collectionDisplays.get(owner.collection.id)!, facts = projection.row
      const normalizationConflicts = fields.flatMap(([field, , conflict, stored, parsed]) => facts[conflict] && facts[stored] !== null && facts[parsed] !== null ? [{ field, storedValue: facts[stored], rawValue: facts[parsed] }] : [])
      const normalized = Object.fromEntries(fields.map(([field, reconciled]) => [field, facts[reconciled]]))
      const dto = { id: owner.relationId, queryId: owner.queryId, sequenceNo: owner.observation.sequenceNo, relationKey: owner.observation.sourceRelationKey,
        enterpriseId: owner.assignment.enterpriseId, rawFields: raw.bytes === null ? null : JSON.parse(raw.bytes.toString('utf8')), titleRaw: projection.title,
        sourceText: originalDisplayById.get(id)!.sourceText,
        usccRaw: owner.original.usccRaw, nameRaw: owner.original.nameRaw, aliasNameRaw: originalDisplayById.get(id)!.aliasNameRaw,
        ...normalized, matchBasis: owner.assignment.matchBasis, verificationStatus: owner.assignment.verificationStatus,
        createdAt: originalDisplayById.get(id)!.createdAt,
        normalizationConflicts, ...display.position(owner.observation.sequenceNo), query: display.query,
      }
      sources.set(owner.relationId, dto)
    }
    return { purpose: 'platform_relation_evidence_display', sources }
  })
}
