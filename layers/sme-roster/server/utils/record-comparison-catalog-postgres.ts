import { and, count, desc, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise, enterpriseAlias } from '../../../../db/postgresql/enterprise-tables'
import { storedFile } from '../../../../db/postgresql/file-tables'
import {
  platformBusinessObservation, platformCollection, platformCollectionCondition, platformExportBatch,
  platformLegacyQueryAlias, platformLegacyRelationAlias, platformObservationAssignment,
} from '../../../../db/postgresql/platform-tables'
import * as schema from '../../../../db/schema'
import { normalizeName } from '../../lib/domain'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { comparisonSourceCatalogInput, type ComparisonSourceCatalogInput } from '../../lib/roster/record-comparison'
import { officialSourceDirectory, type OfficialSourceDocument } from './official-source-directory'
import type { StoredFileContentIdentity } from '../../../core/server/utils/file-content-identity'
import { comparisonCatalogWindows, projectCatalogDocument, projectCatalogExport, projectCatalogQuery, projectSourceEnterpriseLinks } from './record-comparison'

type Reader = Pick<NodePgDatabase, 'select'>
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`

export async function readPostgresComparisonIdentities(db: Reader, queryIds: readonly number[]) {
  const q = platformLegacyQueryAlias, o = platformBusinessObservation, ra = platformLegacyRelationAlias
  const a = platformObservationAssignment, original = alias(a, 'original')
  type Link = Parameters<typeof projectSourceEnterpriseLinks>[0][number]
  const latest = db.select({ enterpriseId: a.enterpriseId, matchBasis: a.matchBasis, verificationStatus: a.verificationStatus })
    .from(a).where(eq(a.observationId, o.id)).orderBy(desc(a.revision)).limit(1).as('assignment')
  const rows = await db.select({
    id: ra.oldId, relationId: ra.oldId, observationId: o.id, queryId: q.oldId, sequenceNo: o.sequenceNo,
    relationKey: o.sourceRelationKey, enterpriseId: latest.enterpriseId, enterpriseName: enterprise.name,
    matchBasis: latest.matchBasis, verificationStatus: latest.verificationStatus, nameRaw: original.nameRaw, usccRaw: original.usccRaw,
  }).from(q).innerJoin(o, eq(o.collectionId, q.collectionId)).innerJoin(ra, eq(ra.observationId, o.id))
    .innerJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
    .innerJoinLateral(latest, sql`true`).leftJoin(enterprise, eq(enterprise.id, latest.enterpriseId))
    .where(eq(q.oldId, sql`ANY(${ids(queryIds)})`)).orderBy(ra.oldId)
  return rows as Link[]
}

async function readQueryEnterpriseLinks(db: Reader, queryIds: number[]) {
  const rows = await readPostgresComparisonIdentities(db, queryIds)
  const confirmed = rows.filter(row => row.verificationStatus === 'confirmed' && row.enterpriseId != null && row.enterpriseName != null)
  const a = enterpriseAlias
  const aliases = await db.select({ enterpriseId: a.enterpriseId, nameNorm: a.nameNorm, note: a.note })
    .from(a).where(and(
      eq(a.verificationStatus, 'confirmed'),
      eq(a.enterpriseId, sql`ANY(${ids([...new Set(confirmed.map(row => row.enterpriseId!))])})`),
      eq(a.nameNorm, sql`ANY(${sql.param([...new Set(confirmed.flatMap(row => row.nameRaw ? [normalizeName(row.nameRaw)] : []))])}::text[])`),
    ))
  return projectSourceEnterpriseLinks(rows, new Map(aliases.map(row => [`${row.enterpriseId}\u0000${row.nameNorm}`, row])))
}

export function readPostgresRecordComparisonSources(db: NodePgDatabase, input: ComparisonSourceCatalogInput, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const filter = comparisonSourceCatalogInput.parse(input)
  return db.transaction(async tx => {
    const q = platformLegacyQueryAlias, b = alias(platformExportBatch, 'b'), c = alias(platformCollection, 'c')
    const condition = platformCollectionCondition
    const byId = (column: typeof q.oldId | typeof b.id) => filter.ids === undefined ? undefined : inArray(column, filter.ids)
    const docFilter = filter.ids === undefined ? undefined : inArray(sql<number>`d.id`, filter.ids)
    const queryFilter = byId(q.oldId), batchFilter = byId(b.id)
    const docCount = tx.select({ n: count() }).from(sql`${officialSourceDirectory} d`).where(docFilter)
    const queryCount = tx.select({ n: count() }).from(q).where(queryFilter)
    const batchCount = tx.select({ n: count() }).from(b).where(batchFilter)
    const [totals] = await tx.select({
      official_document: sql<number>`(${docCount})::float8`,
      query: sql<number>`(${queryCount})::float8`,
      export_batch: sql<number>`(${batchCount})::float8`,
    }).from(sql`(VALUES (1)) AS catalog_count(dummy)`)
    const counts = totals!
    signal?.throwIfAborted()
    const { dw, qw, bw } = comparisonCatalogWindows(filter, counts)
    const f = storedFile
    const documents = dw.limit ? (await tx.select({
      row: sql<OfficialSourceDocument>`json_build_object('id',d.id,'source',d.source,'title',d.title,'docNumber',d."docNumber",'issueDate',d."issueDate",'path',d.path)`,
      registered: sql<StoredFileContentIdentity | null>`CASE WHEN ${f.id} IS NOT NULL THEN json_build_object(
        'fileId',${f.id},'relPath',${f.relPath},'sha256',${f.sha256},'bytes',${f.bytes}) END`,
    }).from(sql`${officialSourceDirectory} d`).leftJoin(f, eq(f.relPath, sql`d.path`)).where(docFilter)
      .orderBy(sql`d.id`).limit(dw.limit).offset(dw.offset)).map(({ row, registered }) => projectCatalogDocument(row, registered)) : []
    const batches = bw.limit ? (await tx.select({
      row: sql<typeof schema.platformExportBatch.$inferSelect>`${postgresRosterRow(schema.platformExportBatch,'b')}`,
    }).from(b).where(batchFilter).orderBy(b.id).limit(bw.limit).offset(bw.offset)).map(({ row }) => projectCatalogExport(row)) : []
    const conditions = tx.select({
      value: sql`CASE WHEN count(*)>0 THEN coalesce(json_object_agg(${condition.name}, CASE ${condition.valueKind}
        WHEN 'text' THEN to_json(${condition.textValue}) WHEN 'boolean' THEN to_json(${condition.integerValue} <> 0)
        ELSE to_json(${condition.integerValue}) END ORDER BY ${condition.name} COLLATE "C")
        FILTER (WHERE ${condition.valueKind} <> 'absent'),'{}'::json) END`,
    }).from(condition).where(eq(condition.collectionId, c.id))
    const queryPage = qw.limit ? await tx.select({
      id: q.oldId,
      collection: sql<typeof schema.platformCollection.$inferSelect>`${postgresRosterRow(schema.platformCollection,'c')}`,
      conditions: sql<Record<string, unknown> | null>`CASE WHEN ${c.provenanceState} IN ('captured','conflict') THEN (${conditions}) END`,
    }).from(q).innerJoin(c, eq(c.id, q.collectionId)).where(queryFilter).orderBy(q.oldId).limit(qw.limit).offset(qw.offset) : []
    signal?.throwIfAborted()
    const links = queryPage.length ? await readQueryEnterpriseLinks(tx, queryPage.map(row => row.id)) : new Map()
    const queries = queryPage.map(({ id, collection, conditions }) => {
      const present = ['captured', 'conflict'].includes(collection.provenanceState)
      return projectCatalogQuery({ ...collection, id, completeness: present ? collection.completeness : 'unknown',
        fullRange: present ? collection.fullRange : null, conditions }, links)
    })
    signal?.throwIfAborted()
    return { rows: [...documents, ...queries, ...batches], total: filter.kind ? counts[filter.kind] : counts.official_document + counts.query + counts.export_batch,
      page: filter.page, pageSize: filter.pageSize, counts, selection: 'explicit', completeness: 'not_implied_by_catalog' }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
