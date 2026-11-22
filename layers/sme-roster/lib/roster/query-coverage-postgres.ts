import { and, eq, gt, isNotNull, isNull, lte, notExists, or, sql, type SQLWrapper } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { platformQueryTitleScope as title } from '../../../../db/postgresql/platform-query-scope-tables'
import { platformBusinessObservation as observation, platformCollection as collection, platformCollectionPage as page,
  platformObservationAssignment as assignment } from '../../../../db/postgresql/platform-tables'
import { normalizeUscc } from '../domain'
import { projectDifferenceCollectionScope, type DifferenceCollectionScopeRows } from '../platform/difference-collection-scope'
import { postgresCollectionConditionValues, projectPostgresConditionRows, projectPostgresUnfinishedPositions } from '../platform/postgres-collection-scope'
import { isCurrentPlatformCollection, isCurrentPlatformObservation } from '../platform/current-observation-postgres'
import { TITLE_RDJB_CODES } from '../platform/recognized-evidence'
import { qualificationUsccCandidate } from './platform-qualification-postgres'
import { projectQueryCoverage } from './query-assessment-projection'

type ScopeReader = Pick<NodePgDatabase, 'select'>
type Reader = Pick<NodePgDatabase, '$with' | 'with' | 'select' | 'selectDistinct'>
type CoverageSubject = { id: number; uscc_norm: string | null; name_norm: string }
type PostgresQueryCoverage = ReturnType<typeof projectQueryCoverage>

export async function readPostgresQueryCoverage(db: Reader, subjects: readonly CoverageSubject[], titleCodes: readonly string[]) {
  const coverages = new Map<number, Map<string, PostgresQueryCoverage>>()
  for (const { id, titleCode, input } of await readPostgresQueryCoverageInputs(db, subjects, titleCodes)) {
    const titled = coverages.get(id) ?? new Map()
    titled.set(titleCode, projectQueryCoverage(input, { titleCode }))
    coverages.set(id, titled)
  }
  return coverages
}

export async function readPostgresQueryCoverageInputs(db: Reader, subjects: readonly CoverageSubject[], titleCodes: readonly string[],
  exactStoredKey = false,
) {
  if (!subjects.length || !titleCodes.length) return []
  const codes = [...new Set(subjects.map(subject => normalizeUscc(subject.uscc_norm)).filter(Boolean))]
  const variants = new Map<string, string[]>()
  if (codes.length) {
    const rows = await db.selectDistinct({ key: collection.queryKey }).from(collection)
      .where(qualificationUsccCandidate(collection.queryKey, codes))
    for (const { key } of rows) {
      const normalized = normalizeUscc(key)
      if (normalized === key || !codes.includes(normalized)) continue
      const keys = variants.get(normalized) ?? []
      keys.push(key)
      variants.set(normalized, keys)
    }
  }
  const targets = subjects.flatMap(subject => titleCodes.map(titleCode => {
    const uscc = normalizeUscc(subject.uscc_norm) || null
    return { enterprise_id: subject.id, title_code: titleCode, rdjb: TITLE_RDJB_CODES[titleCode] ?? '',
      uscc, query_keys: [`name:${subject.name_norm}`, ...(exactStoredKey ? [subject.uscc_norm ?? ''] : []), ...(uscc ? [uscc, ...variants.get(uscc) ?? []] : [])] }
  }))
  // No Drizzle builder exposes JSON set-returning functions with ordinality or
  // window ranking. The target batch travels as one bound JSON parameter.
  const targetJson = sql`json_array_elements(${JSON.stringify(targets)}::json) WITH ORDINALITY AS j(target, ordinal)`
  const wanted = db.$with('targets').as(db.select({
    slot: sql<number>`(j.ordinal - 1)::integer`.as('target_slot'),
    enterpriseId: sql<number>`(j.target ->> 'enterprise_id')::bigint`.as('target_enterprise_id'),
    titleCode: sql<string>`j.target ->> 'title_code'`.as('target_title_code'),
    rdjb: sql<string>`j.target ->> 'rdjb'`.as('target_rdjb'),
    queryKeys: sql<string[]>`ARRAY(SELECT json_array_elements_text(j.target -> 'query_keys'))`.as('query_keys'),
  }).from(targetJson))
  const newer = alias(assignment, 'newer')
  const owners = db.$with('owners').as(db.selectDistinct({
    enterpriseId: assignment.enterpriseId, collectionId: observation.collectionId,
  }).from(assignment).innerJoin(observation, eq(observation.id, assignment.observationId))
    .where(and(isCurrentPlatformObservation(db), matchesIds(assignment.enterpriseId, subjects.map(subject => subject.id)),
      notExists(db.select({ revision: newer.revision }).from(newer)
        .where(and(eq(newer.observationId, assignment.observationId), gt(newer.revision, assignment.revision)))))))
  // Drizzle cannot express column = ANY(array) or split the stored title list.
  // Drizzle renders SQL-derived select aliases unqualified, so use distinct target and candidate names.
  const candidateSlot = sql<number>`${wanted.slot}`.as('candidate_slot')
  const byKey = db.select({ slot: candidateSlot, collectionId: collection.id }).from(wanted)
    .innerJoin(collection, sql`${collection.queryKey} = ANY(${wanted.queryKeys})`)
  const byOwner = db.select({ slot: candidateSlot, collectionId: owners.collectionId }).from(wanted)
    .innerJoin(owners, eq(owners.enterpriseId, wanted.enterpriseId))
  const candidates = db.$with('candidates').as(byKey.union(byOwner))
  const ranked = db.$with('ranked').as(db.select({
    slot: wanted.slot, id: collection.publicId, collectionId: collection.id,
    matched: sql<boolean>`${isNotNull(owners.enterpriseId)}`.as('matched'),
    rank: sql<number>`row_number() OVER (PARTITION BY ${wanted.slot} ORDER BY ${collection.queriedAt} COLLATE "C" DESC, ${collection.publicId} DESC)`.as('rank'),
  }).from(candidates).innerJoin(wanted, eq(wanted.slot, candidates.slot))
    .innerJoin(collection, eq(collection.id, candidates.collectionId))
    .leftJoin(owners, and(eq(owners.enterpriseId, wanted.enterpriseId), eq(owners.collectionId, collection.id)))
    .where(and(isCurrentPlatformCollection(db), or(eq(collection.interface, 'apply_list'), eq(collection.titleCode, wanted.titleCode),
      sql`${wanted.rdjb} = ANY(string_to_array(${collection.rdjb}, ','))`,
      and(eq(collection.rdjb, ''), isNull(collection.titleCode))))))
  const rows = await db.with(wanted, owners, candidates, ranked).select({
    slot: ranked.slot, id: ranked.id, matched: ranked.matched,
    collection: {
      id: collection.id, interface: collection.interface, queryKey: collection.queryKey, titleCode: collection.titleCode,
      rdjb: collection.rdjb, queriedAt: collection.queriedAt, status: collection.status,
      provenanceState: collection.provenanceState, parseState: collection.parseState, source: collection.source,
      evidenceStatus: collection.evidenceStatus, scopeMode: collection.scopeMode, completeness: collection.completeness,
      fullRange: collection.fullRange, errorCode: collection.errorCode, errorMessage: collection.errorMessage,
      maxRequests: collection.maxRequests, maxRows: collection.maxRows, maxDurationMs: collection.maxDurationMs,
      pageSize: collection.pageSize, fetchedCount: collection.fetchedCount, declaredTotal: collection.declaredTotal,
    },
  }).from(ranked).innerJoin(collection, eq(collection.id, ranked.collectionId))
    .where(lte(ranked.rank, 51)).orderBy(ranked.slot, ranked.rank)
  const byTarget = Map.groupBy(rows, row => row.slot)
  const retained = [...byTarget.values()].flatMap(rows => rows.slice(0, 50))
  const metadata = await readPostgresCollectionScopes(db, [...new Map(retained.map(row => [row.collection.id, row.collection as DifferenceCollectionScopeRows['collection']])).values()])
  return targets.map((target, slot) => {
    const { enterprise_id: id, title_code: titleCode, uscc } = target
    const result = byTarget.get(slot) ?? []
    const sources = result.slice(0, 50).map(({ collection, id, matched }) => ({
      id, matched: Number(matched), interface: collection.interface as DifferenceCollectionScopeRows['collection']['interface'], queryKey: collection.queryKey, titleCode: collection.titleCode,
      rdjb: collection.rdjb, queriedAt: collection.queriedAt, status: collection.status as DifferenceCollectionScopeRows['collection']['status'],
      metadata: collection.provenanceState === 'legacy_supplement' ? null : JSON.stringify(metadata.get(collection.id)!.metadata),
    }))
    return { id, titleCode, input: { rows: sources, uscc, truncated: result.length > 50 } }
  })
}

// Preserve one parameter per batch. Drizzle inArray emits one per coordinate.
const matchesIds = (column: SQLWrapper, ids: readonly number[]) => sql`${column} = ANY(${sql.param(ids)}::bigint[])`

export async function readPostgresCollectionScopes(db: ScopeReader, collections: DifferenceCollectionScopeRows['collection'][]) {
  const ids = collections.map(collection => collection.id)
  if (!ids.length) return new Map<number, ReturnType<typeof projectDifferenceCollectionScope>>()
  const parts = await db.select({
    id: collection.id, conditions: postgresCollectionConditionValues(collection.conditionFacts),
    unfinished: collection.unfinishedPositions,
  }).from(collection).where(matchesIds(collection.id, ids))
  const byId = new Map(parts.map(row => [row.id, row]))
  const pageRows = await db.select().from(page).where(matchesIds(page.collectionId, ids)).orderBy(page.collectionId, page.ordinal)
  const pages = Map.groupBy(pageRows, row => row.collectionId)
  const titles = Map.groupBy(await db.select().from(title).where(matchesIds(title.collectionId, ids))
    .orderBy(title.collectionId, sql`${title.rdjb} COLLATE "C"`), row => row.collectionId)
  return new Map(collections.map(collection => [collection.id, projectDifferenceCollectionScope({
    collection, conditions: projectPostgresConditionRows(byId.get(collection.id)!.conditions),
    pages: (pages.get(collection.id) ?? []) as DifferenceCollectionScopeRows['pages'],
    unfinished: projectPostgresUnfinishedPositions(collection.id, byId.get(collection.id)!.unfinished),
    titles: (titles.get(collection.id) ?? []).map(row => row.rdjb),
  })]))
}
