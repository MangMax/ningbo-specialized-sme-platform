import { and, count, desc, eq, exists, inArray, or, sql, type SQLWrapper } from 'drizzle-orm'
import { isCurrentPlatformCaptureRow, isCurrentPlatformCollection } from '../../lib/platform/current-observation-postgres'
import { postgresCollectionConditionValues, projectPostgresComparisonConditions } from '../../lib/platform/postgres-collection-scope'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise, enterpriseAlias } from '../../../../db/postgresql/enterprise-tables'
import { storedFile } from '../../../../db/postgresql/file-tables'
import {
  platformBusinessObservation, platformCollection, platformExportBatch,
  platformObservationAssignment,
} from '../../../../db/postgresql/platform-tables'
import type { platformCollection as PlatformCollectionTable, platformExportBatch as PlatformExportBatchTable } from '../../../../db/postgresql/platform-tables'
import { normalizeName } from '../../lib/domain'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { comparisonSourceCatalogInput, type ComparisonSourceCatalogInput } from '../../lib/roster/record-comparison'
import { postgresOfficialSourceDirectory, type OfficialSourceDocument } from './official-source-directory-postgres'
import { comparisonCatalogWindows, projectCatalogDocument, projectCatalogExport, projectCatalogQuery, projectSourceEnterpriseLinks } from './record-comparison-model'

type Reader = Pick<NodePgDatabase, 'select'>
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`

export function isSelectablePostgresComparisonQuery(db: Reader, query: Parameters<typeof isCurrentPlatformCollection>[1] & { status: SQLWrapper }) {
  const observation = platformBusinessObservation
  const currentRows = db.select({ id: observation.id }).from(observation)
    .where(and(eq(observation.collectionId, query.id), isCurrentPlatformCaptureRow(db)))
  return or(
    isCurrentPlatformCollection(db, query),
    and(inArray(query.status, ['success', 'partial']), exists(currentRows)),
    and(eq(query.status, 'no_record'), isCurrentPlatformCollection(db, query, 'evidence')),
  )
}

export async function readPostgresComparisonIdentities(db: Reader, queryIds: readonly number[]) {
  const q = platformCollection, o = platformBusinessObservation
  const a = platformObservationAssignment, original = alias(a, 'original')
  type Link = Parameters<typeof projectSourceEnterpriseLinks>[0][number]
  const latest = db.select({ enterpriseId: a.enterpriseId, matchBasis: a.matchBasis, verificationStatus: a.verificationStatus })
    .from(a).where(eq(a.observationId, o.id)).orderBy(desc(a.revision)).limit(1).as('assignment')
  const rows = await db.select({
    id: o.publicId, relationId: o.publicId, observationId: o.id, queryId: q.publicId, sequenceNo: o.sequenceNo,
    relationKey: o.sourceRelationKey, enterpriseId: latest.enterpriseId, enterpriseName: enterprise.name,
    matchBasis: latest.matchBasis, verificationStatus: latest.verificationStatus, nameRaw: original.nameRaw, usccRaw: original.usccRaw,
  }).from(q).innerJoin(o, eq(o.collectionId, q.id))
    .innerJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
    .innerJoinLateral(latest, sql`true`).leftJoin(enterprise, eq(enterprise.id, latest.enterpriseId))
    .where(and(eq(q.publicId, sql`ANY(${ids(queryIds)})`), isCurrentPlatformCaptureRow(db))).orderBy(o.publicId)
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
    const b = alias(platformExportBatch, 'b'), c = alias(platformCollection, 'c')
    const byId = (column: typeof c.publicId | typeof b.id) => filter.ids === undefined ? undefined : inArray(column, filter.ids)
    const d = postgresOfficialSourceDirectory(tx)
    // Derived SQL aliases render unqualified in Drizzle 0.45, and stored_file
    // also has an id. Keep this reference qualified when joining file identity.
    const documentId = sql`${sql.identifier('official_directory')}.${sql.identifier('id')}`.mapWith(Number)
    const docFilter = filter.ids === undefined ? undefined : inArray(documentId, filter.ids)
    const queryFilter = and(byId(c.publicId), isSelectablePostgresComparisonQuery(tx, c)), batchFilter = byId(b.id)
    const [documentCount] = await tx.select({ n: count() }).from(d).where(docFilter)
    const [queryCount] = await tx.select({ n: count() }).from(c).where(queryFilter)
    const [batchCount] = await tx.select({ n: count() }).from(b).where(batchFilter)
    const counts = { official_document: documentCount!.n, query: queryCount!.n, export_batch: batchCount!.n }
    signal?.throwIfAborted()
    const { dw, qw, bw } = comparisonCatalogWindows(filter, counts)
    const f = storedFile
    const documents = dw.limit ? (await tx.select({
      row: { id: documentId, source: d.source, title: d.title, docNumber: d.docNumber, issueDate: d.issueDate, path: d.path },
      registered: { fileId: f.id, relPath: f.relPath, sha256: f.sha256, bytes: f.bytes },
    }).from(d).leftJoin(f, eq(f.relPath, d.path)).where(docFilter)
      .orderBy(documentId).limit(dw.limit).offset(dw.offset)).map(({ row, registered }) => projectCatalogDocument(
        row as OfficialSourceDocument, registered ? { ...registered, bytes: Number(registered.bytes) } : null,
      )) : []
    const batches = bw.limit ? (await tx.select({
      row: sql<typeof PlatformExportBatchTable.$inferSelect>`${postgresRosterRow(platformExportBatch,'b')}`,
    }).from(b).where(batchFilter).orderBy(b.id).limit(bw.limit).offset(bw.offset)).map(({ row }) => projectCatalogExport(row)) : []
    const queryPage = qw.limit ? await tx.select({
      id: c.publicId,
      collection: sql<typeof PlatformCollectionTable.$inferSelect>`${postgresRosterRow(platformCollection,'c')}`,
      conditions: postgresCollectionConditionValues(c.conditionFacts),
    }).from(c).where(queryFilter).orderBy(c.publicId).limit(qw.limit).offset(qw.offset) : []
    signal?.throwIfAborted()
    const links = queryPage.length ? await readQueryEnterpriseLinks(tx, queryPage.map(row => row.id)) : new Map()
    const queries = queryPage.map(({ id, collection, conditions }) => {
      const present = ['captured', 'conflict'].includes(collection.provenanceState)
      return projectCatalogQuery({ ...collection, id, completeness: present ? collection.completeness : 'unknown',
        fullRange: present ? collection.fullRange : null, conditions: present ? projectPostgresComparisonConditions(conditions) : null }, links)
    })
    signal?.throwIfAborted()
    return { rows: [...documents, ...queries, ...batches], total: filter.kind ? counts[filter.kind] : counts.official_document + counts.query + counts.export_batch,
      page: filter.page, pageSize: filter.pageSize, counts, selection: 'explicit', completeness: 'not_implied_by_catalog' }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
