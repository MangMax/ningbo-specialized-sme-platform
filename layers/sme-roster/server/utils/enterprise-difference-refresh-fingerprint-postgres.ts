import { isCurrentPlatformObservation } from '../../lib/platform/current-observation-postgres'
import { and, desc, eq, getTableColumns, gt, inArray, isNotNull, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise, enterpriseAlias } from '../../../../db/postgresql/enterprise-tables'
import { record, recordEvidence, recordEvent } from '../../../../db/postgresql/ledger-tables'
import { platformApplyProjection, platformBusinessProjection, platformRecognizedProjection,
  platformBusinessObservation as observation, platformBusinessRecordVersion as version, platformCollection as collection,
  platformObservationAssignment as assignment } from '../../../../db/postgresql/platform-tables'
import { recordCorrespondence as correspondence } from '../../../../db/postgresql/qualification-tables'
import { platformObservationVersionDefaults } from '../../lib/platform/postgres-observation-facts'
import { refreshRelationFields, refreshSourceKeys } from '../../lib/platform/difference-hash-keys'
import type { PlatformFactInterface } from '../../lib/platform/observation-facts'
import { CURRENT_TITLES } from '../../lib/roster/current-titles'
import type { PostgresQualificationTransaction } from '../../lib/roster/current-qualification-postgres'
import { hashRefreshInputs, projectRefreshObservation, refreshProjectionColumns } from './enterprise-difference-refresh-contract'

type Tx = PostgresQualificationTransaction
type Collection = Parameters<typeof projectRefreshObservation>[0]
type Material = Record<string, unknown>
const NATIVE_REFRESH_STATE = 'platform-business-state-v2'

const sourceKeys = new Set<string>(refreshSourceKeys)

async function readNativePlatformRefreshFacts(tx: Tx, selected: ReturnType<typeof sql>) {
  const current = tx.select({ matchBasis: assignment.matchBasis, verificationStatus: assignment.verificationStatus })
    .from(assignment).where(eq(assignment.observationId, observation.id)).orderBy(desc(assignment.revision)).limit(1).as('current_assignment')
  const original = alias(assignment, 'original_assignment')
  const sources = await tx.select({
    collectionId: observation.collectionId, matchBasis: current.matchBasis, verificationStatus: current.verificationStatus,
    source: collection.interface, sourceValues: observation.sourceValues, versionId: observation.versionId,
    relationKey: observation.sourceRelationKey, nameRaw: original.nameRaw, usccRaw: original.usccRaw, aliasNameRaw: original.aliasNameRaw,
    apply: platformApplyProjection, business: platformBusinessProjection, recognized: platformRecognizedProjection,
    observationFields: observation.businessFields, versionFields: version.businessFields,
  }).from(observation)
    .innerJoin(collection, eq(collection.id, observation.collectionId))
    .innerJoin(original, and(eq(original.observationId, observation.id), eq(original.revision, 1)))
    .leftJoin(version, eq(version.id, observation.versionId))
    .leftJoin(platformApplyProjection, eq(platformApplyProjection.versionId, observation.versionId))
    .leftJoin(platformBusinessProjection, eq(platformBusinessProjection.versionId, observation.versionId))
    .leftJoin(platformRecognizedProjection, eq(platformRecognizedProjection.versionId, observation.versionId))
    .innerJoinLateral(current, sql`true`)
    .where(and(sql`${observation.collectionId} = any(${selected})`, isNotNull(observation.sourceValues), isCurrentPlatformObservation(tx)))
  const relations = Map.groupBy(sources.map(row => {
    const source = row.source as PlatformFactInterface
    const typed = source === 'apply_list' ? row.apply : source === 'business_list' ? row.business : row.recognized
    const stored: Record<string, unknown> = {
      ...platformObservationVersionDefaults(source, typed), ...row.sourceValues,
      relationKey: row.relationKey, nameRaw: row.nameRaw, usccRaw: row.usccRaw, aliasNameRaw: row.aliasNameRaw,
    }
    const fields = Object.fromEntries(refreshRelationFields.map(name => [
      name, stored[name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] ?? null,
    ]))
    const raw = row.versionId === null ? row.observationFields : row.versionFields
    const sourceBusiness = raw === null ? undefined : Object.fromEntries(Object.entries(raw).filter(([name]) => sourceKeys.has(name)))
    return { collectionId: row.collectionId, material: {
      ...fields, match_basis: row.matchBasis, verification_status: row.verificationStatus,
      ...(sourceBusiness === undefined ? {} : { sourceBusiness }),
    } as Material }
  }), row => row.collectionId)
  const metadataRows = await tx.select({ id: collection.id, coverage: collection.sourceCoverage })
    .from(collection).where(sql`${collection.id} = any(${selected})`)
  const metadata = new Map(metadataRows.map(({ id, coverage }) => [id, coverage === null ? null : JSON.stringify(coverage)]))
  return { relations, metadata }
}

async function readPlatformMaterials(tx: Tx, enterpriseIds: readonly number[], readFacts: typeof readNativePlatformRefreshFacts) {
  const owners = inArray(enterprise.id, enterpriseIds)
  // Drizzle 0.45.4 has no coalesce, concatenation or window rank builders.
  const keys = tx.$with('keys').as(tx.select({
    owner: sql<number>`${enterprise.id}`.mapWith(enterprise.id).as('owner'), key: sql<string>`coalesce(${enterprise.usccNorm}, '')`.as('key'),
  }).from(enterprise).where(owners).unionAll(
    tx.select({ owner: enterprise.id, key: sql<string>`'name:' || ${enterprise.nameNorm}` }).from(enterprise).where(owners),
  ).unionAll(tx.select({
    owner: enterpriseAlias.enterpriseId, key: sql<string>`'name:' || ${enterpriseAlias.nameNorm}`,
  }).from(enterpriseAlias).where(and(inArray(enterpriseAlias.enterpriseId, enterpriseIds), eq(enterpriseAlias.verificationStatus, 'confirmed')))))
  const later = alias(assignment, 'later')
  const candidates = tx.$with('candidates').as(tx.select({ owner: keys.owner, id: collection.id })
    .from(keys).innerJoin(collection, eq(collection.queryKey, keys.key)).union(
      tx.select({ owner: sql<number>`${assignment.enterpriseId}`, id: observation.collectionId }).from(assignment)
        .innerJoin(observation, eq(observation.id, assignment.observationId))
        .where(and(inArray(assignment.enterpriseId, enterpriseIds), notExists(
          tx.select({ id: later.observationId }).from(later)
            .where(and(eq(later.observationId, assignment.observationId), gt(later.revision, assignment.revision))),
        ))),
    ))
  const latest = tx.$with('latest').as(tx.select({
    owner: candidates.owner, id: collection.id, interface: collection.interface, queryKey: collection.queryKey,
    rdjb: collection.rdjb, titleCode: collection.titleCode, queriedAt: collection.queriedAt, status: collection.status,
    rank: sql<number>`rank() over (partition by ${candidates.owner}, ${collection.interface}, ${collection.queryKey},
      ${collection.rdjb}, ${collection.titleCode} order by ${collection.queriedAt} collate "C" desc)`.as('rank'),
  }).from(candidates).innerJoin(collection, eq(collection.id, candidates.id)))
  const rows = (await tx.with(keys, candidates, latest).select({
    owner: latest.owner, id: latest.id, interface: latest.interface, queryKey: latest.queryKey,
    rdjb: latest.rdjb, titleCode: latest.titleCode, queriedAt: latest.queriedAt, status: latest.status,
  }).from(latest).where(eq(latest.rank, 1))).map(({ owner, ...material }) => ({ owner, collection: material as Collection }))
  const collectionIds = [...new Set(rows.map(row => row.collection.id))]
  if (!collectionIds.length) return new Map<number, { titleCode: string | null; material: Material }[]>()
  // Keep the selected IDs in one bound array for large observation histories.
  const selected = sql`${sql.param(collectionIds)}::bigint[]`
  const { relations, metadata } = await readFacts(tx, selected)
  const projectionTables = {
    platform_apply_projection: platformApplyProjection,
    platform_business_projection: platformBusinessProjection,
    platform_recognized_projection: platformRecognizedProjection,
  } satisfies Record<keyof typeof refreshProjectionColumns, typeof platformApplyProjection | typeof platformBusinessProjection | typeof platformRecognizedProjection>
  const typed = []
  for (const name of Object.keys(projectionTables) as (keyof typeof projectionTables)[]) {
    const table = projectionTables[name]
    const names = refreshProjectionColumns[name]
    const columns = Object.values(getTableColumns(table))
    const material = Object.fromEntries(names.map(name => [name, columns.find(column => column.name === name)!]))
    const rows = await tx.select({ collectionId: observation.collectionId, material }).from(observation)
      .innerJoin(table, eq(table.versionId, observation.versionId)).where(and(sql`${observation.collectionId} = any(${selected})`, isCurrentPlatformObservation(tx)))
    typed.push(Map.groupBy(rows, row => row.collectionId))
  }
  const projections = new Map<number, Material>()
  for (const { collection } of rows) {
    if (projections.has(collection.id)) continue
    projections.set(collection.id, projectRefreshObservation(collection, {
      relations: (relations.get(collection.id) ?? []).map(row => row.material),
      typed: typed.map(kind => (kind.get(collection.id) ?? []).map(row => row.material)),
      metadata: metadata.get(collection.id) ?? null,
    }))
  }
  return new Map([...Map.groupBy(rows, row => row.owner)].map(([owner, collections]) =>
    [owner, collections.map(({ collection }) => ({ titleCode: collection.titleCode, material: projections.get(collection.id)! }))]))
}

export async function readPostgresRefreshFingerprints(tx: Tx, enterpriseIds: readonly number[], readFacts = readNativePlatformRefreshFacts) {
  const enterprises = await tx.select({ id: enterprise.id, enterprise: {
    name: enterprise.name, name_norm: enterprise.nameNorm, uscc_norm: enterprise.usccNorm, city: enterprise.city, district: enterprise.district,
  } }).from(enterprise).where(inArray(enterprise.id, enterpriseIds)).orderBy(enterprise.id)
  const aliases = await tx.select({ owner: enterpriseAlias.enterpriseId, material: {
    name_norm: enterpriseAlias.nameNorm, verification_status: enterpriseAlias.verificationStatus,
  } }).from(enterpriseAlias).where(and(inArray(enterpriseAlias.enterpriseId, enterpriseIds), eq(enterpriseAlias.verificationStatus, 'confirmed')))
  const aliasesByOwner = Map.groupBy(aliases, row => row.owner)
  const recordOwners = inArray(record.enterpriseId, enterpriseIds)
  const formal = await tx.select({ owner: record.enterpriseId, title: record.titleCode,
    source: record.source, title_code: record.titleCode, name_raw: record.nameRaw, uscc_raw: record.usccRaw,
    event_type: recordEvent.eventType, year: recordEvent.year, batch_seq: recordEvent.batchSeq,
    decided_year: recordEvent.decidedYear, review_outcome: recordEvent.reviewOutcome, formal_validity: recordEvent.formalValidity,
  }).from(record).leftJoin(recordEvent, eq(recordEvent.recordId, record.id)).where(recordOwners)
  const evidence = await tx.select({ owner: record.enterpriseId, title: record.titleCode,
    source_file: recordEvidence.sourceFile, attachment: recordEvidence.attachment, list_no: recordEvidence.listNo, page: recordEvidence.page,
    event_type: recordEvent.eventType, year: recordEvent.year, batch_seq: recordEvent.batchSeq,
  }).from(record).innerJoin(recordEvent, eq(recordEvent.recordId, record.id))
    .innerJoin(recordEvidence, eq(recordEvidence.recordEventId, recordEvent.id)).where(recordOwners)
  const predecessor = alias(recordEvent, 'predecessor')
  const correspondences = await tx.select({ owner: correspondence.enterpriseId, title: correspondence.titleCode,
    type: correspondence.type, role: correspondence.role, status: correspondence.status,
    ended: isNotNull(correspondence.endedAt).mapWith(value => Number(value)),
    relation_key: observation.sourceRelationKey, event_type: recordEvent.eventType, year: recordEvent.year, batch_seq: recordEvent.batchSeq,
    decided_year: recordEvent.decidedYear, review_outcome: recordEvent.reviewOutcome, predecessor_type: predecessor.eventType,
    predecessor_year: predecessor.year, predecessor_batch: predecessor.batchSeq,
  }).from(correspondence).leftJoin(observation, eq(observation.id, correspondence.observationId))
    .leftJoin(recordEvent, eq(recordEvent.id, correspondence.eventId)).leftJoin(predecessor, eq(predecessor.id, correspondence.predecessorEventId))
    .where(inArray(correspondence.enterpriseId, enterpriseIds))
  const group = (rows: ({ owner: number | null; title: string } & Material)[]) => Map.groupBy(
    rows.map(({ owner, title, ...material }) => ({ owner, title, material })), row => row.owner + ':' + row.title,
  )
  const formalByTitle = group(formal), evidenceByTitle = group(evidence), correspondenceByTitle = group(correspondences)
  const platform = await readPlatformMaterials(tx, enterpriseIds, readFacts)
  return enterprises.map(({ id, enterprise }) => ({
    subject: { id, ...enterprise },
    fingerprints: new Map(CURRENT_TITLES.map(title => {
      const key = id + ':' + title
      const fingerprint = hashRefreshInputs({ enterprise, aliases: (aliasesByOwner.get(id) ?? []).map(row => row.material),
        formal: (formalByTitle.get(key) ?? []).map(row => row.material),
        evidence: (evidenceByTitle.get(key) ?? []).map(row => row.material),
        correspondences: (correspondenceByTitle.get(key) ?? []).map(row => row.material),
        observations: (platform.get(id) ?? []).filter(row => row.titleCode === null || row.titleCode === title).map(row => row.material),
      }, readFacts === readNativePlatformRefreshFacts ? NATIVE_REFRESH_STATE : undefined)
      return [title, fingerprint]
    })),
  }))
}
