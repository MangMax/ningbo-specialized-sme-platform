import { and, asc, between, count, countDistinct, desc, eq, exists, getTableColumns, gt, inArray, notExists, isNotNull, isNull, ne, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import type { AnyPgColumn, PgSelect, PgTable } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  platformApplyProjection as applyProjection,
  platformBusinessProjection as processProjection,
  platformRecognizedProjection as recognizedProjection,
  platformBusinessObservation as observation,
  platformBusinessRecord as businessRecord,
  platformBusinessRecordVersion as recordVersion,
  platformCollection as collection,
  platformObservationAssignment as assignment,
} from '../../../../db/postgresql/platform-tables'
import { platformSourceCellValue, type PlatformSourceCell, type PlatformSourceValues } from '../../../../db/postgresql/platform-source-values'
import { platformQueryTitleScope as titleScope } from '../../../../db/postgresql/platform-query-scope-tables'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { recordCorrespondence } from '../../../../db/postgresql/qualification-tables'
import { alias } from 'drizzle-orm/pg-core'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import { BUSINESS_PROCESS_OBSERVATION_LIMIT, BUSINESS_PROCESS_VERSION_LIMIT, type BusinessProcessFilter } from '../../lib/platform/business-processes'
import { DECLARATION_OBSERVATION_LIMIT, DECLARATION_VERSION_LIMIT, type DeclarationFilter } from '../../lib/platform/declarations'
import type { PlatformFilterOptionsQuery } from '../../lib/platform/filter-options'
import { normalizeDeclareKind } from '../../lib/platform/identity'
import { RECOGNIZED_DIRECTORY_OBSERVATION_LIMIT, RECOGNIZED_DIRECTORY_VERSION_LIMIT, type RecognizedDirectoryFilter } from '../../lib/platform/recognized-directory'
import { failPlatformBusinessRequest, orderedScopes, platformBusinessPage } from './platform-business-projection'

type Reader = Pick<NodePgDatabase, 'select' | 'selectDistinct' | '$with' | 'with' | '$count'>
type Source = PlatformFilterOptionsQuery['source']
type ArchiveFilter = DeclarationFilter & Partial<BusinessProcessFilter & RecognizedDirectoryFilter>
type Fields = Readonly<Record<string, string>>
type Options = Record<'titles' | 'declareKinds' | 'years' | 'statuses' | 'batches' | 'districts' | 'validityDates', string>
const snapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const

const commonVersionFields = { titleRaw: 'title_raw', nameRaw: 'name_raw', usccRaw: 'uscc_raw', ruleVersion: 'rule_version' }
const processFields = { declareKind: 'declare_kind', appliedAt: 'applied_at', status: 'status' }
const storedProcessFields = { titleRaw: 'titleRaw', declareKind: 'declareKind', appliedAt: 'appliedAt', status: 'status' } as const
type SourceValueKey = keyof PlatformSourceValues
const catalogs = {
  declarations: {
    table: applyProjection,
    interface: 'apply_list',
    fields: { ...commonVersionFields, ...processFields, declarationYear: 'declaration_year' },
    exact: { ...storedProcessFields, declarationYear: 'year' },
    options: { titles: 'title_raw', declareKinds: 'declare_kind', years: 'declaration_year', statuses: 'status' },
    exactOptions: { titles: 'titleRaw', declareKinds: 'declareKind', years: 'year', statuses: 'status' },
    limits: { versions: DECLARATION_VERSION_LIMIT, observations: DECLARATION_OBSERVATION_LIMIT },
    idCode: 'invalid_declaration_id', notFoundCode: 'declaration_not_found', notFoundMessage: 'Declaration record not found',
    notIndexedCode: 'apply_target_not_indexed', notIndexedMessage: 'Declaration observation is not indexed',
  },
  'business-processes': {
    table: processProjection,
    interface: 'business_list',
    fields: { ...commonVersionFields, ...processFields, businessYear: 'business_year', batch: 'batch', awardBatchLabel: 'award_batch_label', province: 'province' },
    exact: { ...storedProcessFields, businessYear: 'year', batch: 'batch', awardBatchLabel: 'awardBatchLabel', province: 'province' },
    options: { titles: 'title_raw', declareKinds: 'declare_kind', years: 'business_year', statuses: 'status', batches: 'batch' },
    exactOptions: { titles: 'titleRaw', declareKinds: 'declareKind', years: 'year', statuses: 'status', batches: 'batch' },
    limits: { versions: BUSINESS_PROCESS_VERSION_LIMIT, observations: BUSINESS_PROCESS_OBSERVATION_LIMIT },
    idCode: 'invalid_business_process_id', notFoundCode: 'business_process_not_found', notFoundMessage: 'Business process record not found',
    notIndexedCode: 'process_target_not_indexed', notIndexedMessage: 'Record observation is not indexed',
  },
  'recognized-directory': {
    table: recognizedProjection,
    interface: 'recognized_list',
    fields: { ...commonVersionFields, validityDateRaw: 'validity_date_raw', maintenanceYear: 'maintenance_year', maintenanceBatch: 'maintenance_batch', district: 'district', awardNote: 'award_note' },
    exact: { titleRaw: 'titleRaw' },
    options: { titles: 'title_raw', batches: 'maintenance_batch', districts: 'district', validityDates: 'validity_date_raw' },
    exactOptions: { titles: 'titleRaw' },
    limits: { versions: RECOGNIZED_DIRECTORY_VERSION_LIMIT, observations: RECOGNIZED_DIRECTORY_OBSERVATION_LIMIT },
    idCode: 'invalid_recognized_record_id', notFoundCode: 'recognized_record_not_found', notFoundMessage: 'Recognized directory record not found',
    notIndexedCode: 'recognized_target_not_indexed', notIndexedMessage: 'Record observation is not indexed',
  },
} as const satisfies Record<Source, {
  table: typeof applyProjection | typeof processProjection | typeof recognizedProjection; interface: string; fields: Fields;
  exact: Readonly<Record<string, SourceValueKey>>; options: Partial<Options>; exactOptions: Partial<Record<keyof Options, SourceValueKey>>
  limits: { versions: number; observations: number }
  idCode: string; notFoundCode: string; notFoundMessage: string; notIndexedCode: string; notIndexedMessage: string
}>
type Catalog = typeof catalogs[Source]

const record = alias(businessRecord, 'b')
const version = alias(recordVersion, 'v')
const archivedObservation = alias(observation, 'o')
const archivedCollection = alias(collection, 'c')

function namedColumn(table: PgTable, name: string): AnyPgColumn {
  return Object.values(getTableColumns(table)).find(column => column.name === name)!
}

function equals(column: AnyPgColumn, value: string | number | undefined) {
  if (value === undefined) return undefined
  // Ordinary PostgreSQL text excludes NUL. Exact mixed storage cells use bytea.
  return typeof value === 'string' && value.includes('\0') ? ne(column, column) : eq(column, value)
}

/** SQLite LIKE folds ASCII only and uses no escape character by default. */
function like(column: AnyPgColumn, pattern: string) {
  const folded = pattern.replace(/[A-Z]/g, char => char.toLowerCase()).split('\0')[0]
  // Drizzle 0.45 has no PostgreSQL translate, collation or custom LIKE escape builder.
  return sql`translate(${column}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') COLLATE "C"
    LIKE ${folded} ESCAPE ''`
}

function enterpriseKeyword(table: typeof enterprise, keyword: string | undefined) {
  if (!keyword) return undefined
  return or(like(table.nameNorm, `%${normalizeName(keyword)}%`),
    like(table.usccNorm, `%${normalizeUscc(keyword)}%`))
}

type ObservationTable = typeof observation | typeof archivedObservation

function sourceCell(table: ObservationTable, key: SourceValueKey) {
  return sql<PlatformSourceCell>`${table.sourceValues} -> ${key}::text`
}

// SQLite puts integer and real in the same order bucket, ahead of text and BLOB.
function sourceStorageOrder(cell: SQL<PlatformSourceCell>) {
  return sql<number | null>`CASE jsonb_typeof(${cell})
    WHEN 'number' THEN 0 WHEN 'string' THEN 1
    WHEN 'object' THEN CASE WHEN ${cell} ->> 'storage' = 'text' THEN 1 ELSE 2 END END`
}

function sourceBytes(cell: SQL<PlatformSourceCell>) {
  return sql<Buffer | null>`CASE jsonb_typeof(${cell})
    WHEN 'string' THEN convert_to(${cell} #>> '{}', 'UTF8')
    WHEN 'object' THEN decode(${cell} ->> 'base64', 'base64') END`
}

function exactEquals(cell: SQL<PlatformSourceCell>, value: string | number | undefined) {
  if (value === undefined) return undefined
  if (typeof value === 'string') return and(eq(sourceStorageOrder(cell), 1), eq(sourceBytes(cell), Buffer.from(value)))
  return eq(cell, sql`to_jsonb(${value}::bigint)`)
}

function decodeExactFields(row: Record<string, unknown>, fields: Catalog['exact']) {
  for (const key of Object.keys(fields)) row[key] = platformSourceCellValue(row[key] as PlatformSourceCell)
  return row
}

async function captureGate(tx: Reader, catalog: Catalog, recordId?: number) {
  const base = tx.select({ id: observation.id }).from(observation)
    .innerJoin(collection, eq(collection.id, observation.collectionId))
  if (catalog.interface === 'apply_list') {
    const [missing] = await base.where(and(
      eq(collection.interface, 'apply_list'),
      recordId === undefined ? undefined : eq(observation.recordId, recordId),
      isNull(observation.sourceValues),
    )).limit(1)
    if (missing) failPlatformBusinessRequest(409, 'apply_stored_uncaptured', 'Declaration observation has uncaptured stored facts')
    return
  }

  const process = catalog.interface === 'business_list'
  const original = alias(assignment, 'original')
  const [missing] = await base.leftJoin(original, and(eq(original.observationId, observation.id), eq(original.revision, 1)))
    .where(and(eq(collection.interface, catalog.interface),
      or(isNull(observation.sourceValues), isNull(original.observationId))))
    .limit(1)
  if (missing) {
    if (process) failPlatformBusinessRequest(409, 'process_target_uncaptured', 'Process observation has uncaptured original facts or assignment')
    failPlatformBusinessRequest(409, 'recognized_target_uncaptured', 'Recognized observation has uncaptured original facts or assignment')
  }
}

function scopeMatch(tx: Reader, rdjb: string) {
  const supplemental = tx.select({ id: titleScope.collectionId }).from(titleScope)
    .where(and(eq(titleScope.collectionId, archivedCollection.id), eq(titleScope.rdjb, rdjb)))
  // Drizzle 0.45 has no strpos or string concatenation operators.
  return or(gt(sql<number>`strpos(',' || ${archivedCollection.rdjb} || ',', ${',' + rdjb + ','})`, 0), exists(supplemental))
}

const jsWhitespace = ' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'

// Drizzle 0.45 cannot expand a delimited field as a PostgreSQL table function.
function scopeArray(collections: SQLWrapper) {
  return sql`ARRAY(
    WITH collections AS (${collections})
    SELECT btrim(part.value, ${jsWhitespace}) COLLATE "C" FROM collections
    CROSS JOIN LATERAL unnest(string_to_array(collections.rdjb, ',')) part(value)
    WHERE btrim(part.value, ${jsWhitespace}) <> ''
    UNION
    SELECT s.rdjb COLLATE "C" FROM collections
    JOIN business.platform_query_title_scope s ON s.collection_id = collections.id WHERE s.rdjb <> ''
  )`
}

const collectionScopes = scopeArray(sql`SELECT c.id, c.rdjb`)

function versionFields(catalog: Catalog, table: PgTable) {
  return Object.fromEntries(Object.entries(catalog.fields).map(([key, name]) => [key, namedColumn(table, name)]))
}

function versionData(catalog: Catalog, versionId: number, projection: Readonly<Record<string, unknown>> | null): Record<string, unknown> & { versionId: number } {
  return { versionId, ...Object.fromEntries(Object.keys(catalog.fields).map(key => [key, projection?.[key] ?? null])) }
}

function recordOwners(tx: Reader) {
  const owner = tx.select({ enterpriseId: assignment.enterpriseId }).from(assignment)
    .where(eq(assignment.observationId, observation.id)).orderBy(desc(assignment.revision)).limit(1).as('record_owner')
  return tx.selectDistinct({ enterpriseId: owner.enterpriseId, name: enterprise.name })
    .from(observation).innerJoinLateral(owner, eq(observation.id, observation.id))
    .leftJoin(enterprise, eq(enterprise.id, owner.enterpriseId))
    .where(and(eq(observation.recordId, record.id), isNotNull(owner.enterpriseId)))
}

function recordTitleConflict(tx: Reader, catalog: Catalog) {
  if (catalog.interface !== 'recognized_list') return sql`FALSE`
  const projection = recognizedProjection
  const list = sql<string>`translate(${collection.rdjb}, ${' \t\n\r'}, '')`
  const supplemental = tx.select({ id: titleScope.collectionId }).from(titleScope)
    .where(and(eq(titleScope.collectionId, collection.id), ne(sql<string>`btrim(${titleScope.rdjb})`, '')))
  const acceptedTitle = tx.select({ id: titleScope.collectionId }).from(titleScope)
    .where(and(eq(titleScope.collectionId, collection.id), eq(titleScope.rdjb, projection.titleRaw)))
  const conflict = tx.select({ id: observation.id }).from(observation)
    .innerJoin(collection, eq(collection.id, observation.collectionId))
    .innerJoin(projection, eq(projection.versionId, observation.versionId))
    .where(and(
      eq(observation.recordId, record.id),
      inArray(projection.titleRaw, ['1', '2', '3']),
      or(ne(sql<string>`replace(${list}, ',', '')`, ''), exists(supplemental)),
      eq(sql<number>`strpos(',' || ${list} || ',', ',' || ${projection.titleRaw} || ',')`, 0),
      notExists(acceptedTitle),
    ))
  return exists(conflict)
}

function recordSummary(tx: Reader, catalog: Catalog) {
  const owners = tx.$with('owners').as(recordOwners(tx))
  const ids = tx.select({ id: owners.enterpriseId }).from(owners).orderBy(asc(owners.enterpriseId))
  const names = tx.select({ name: owners.name }).from(owners).where(ne(owners.name, '')).orderBy(asc(owners.enterpriseId))
  const collections = tx.selectDistinct({ id: collection.id, rdjb: collection.rdjb }).from(observation)
    .innerJoin(collection, eq(collection.id, observation.collectionId)).where(eq(observation.recordId, record.id))
  // Drizzle 0.45 has no ARRAY(subquery) expression. Keep the order in the typed subqueries.
  return tx.with(owners).select({
    versionCount: tx.$count(recordVersion, eq(recordVersion.recordId, record.id)).as('version_count'),
    observationCount: tx.$count(observation, eq(observation.recordId, record.id)).as('observation_count'),
    enterpriseIds: sql<string[]>`ARRAY(${ids})`.mapWith((values: string[]) => values.map(Number)).as('enterprise_ids'),
    enterpriseNames: sql<string[]>`ARRAY(${names})`.as('enterprise_names'),
    titleScopes: (catalog.interface === 'apply_list' ? sql<null>`NULL` : scopeArray(collections) as SQL<string[]>).as('title_scopes'),
    ...recordConflictFields(tx, catalog),
  }).from(owners).as('record_summary')
}

interface RecordConflicts {
  titleConflict: boolean
  unverifiable: boolean
  assignmentConflict: boolean
}

function recordConflictFields(tx: Reader, catalog: Catalog) {
  const unverifiable = tx.select({ id: observation.id }).from(observation)
    .where(and(eq(observation.recordId, record.id), eq(observation.contentState, 'unverifiable')))
  return {
    titleConflict: recordTitleConflict(tx, catalog).mapWith(Boolean).as('title_conflict'),
    unverifiable: exists(unverifiable).mapWith(Boolean).as('unverifiable'),
    assignmentConflict: gt(count(), 1).mapWith(Boolean).as('assignment_conflict'),
  }
}

function summaryConflicts(summary: RecordConflicts) {
  return [
    ...(summary.titleConflict ? ['title_conflict'] : []),
    ...(summary.unverifiable ? ['unverifiable_observation'] : []),
    ...(summary.assignmentConflict ? ['enterprise_assignment_conflict'] : []),
  ]
}

function recordFilter(tx: Reader, catalog: Catalog, filter: ArchiveFilter, projection: PgTable) {
  const scope = filter.rdjb
    ? exists(tx.select({ id: archivedObservation.id }).from(archivedObservation)
        .innerJoin(archivedCollection, eq(archivedCollection.id, archivedObservation.collectionId))
        .where(and(eq(archivedObservation.versionId, version.id), scopeMatch(tx, filter.rdjb))))
    : undefined
  const currentOwner = tx.select({ enterpriseId: assignment.enterpriseId }).from(assignment)
    .where(eq(assignment.observationId, observation.id)).orderBy(desc(assignment.revision)).limit(1).as('filter_owner')
  const owner = filter.enterpriseId !== undefined || filter.q
    ? exists(tx.select({ id: observation.id }).from(observation)
        .leftJoinLateral(currentOwner, eq(observation.id, observation.id))
        .leftJoin(enterprise, eq(enterprise.id, currentOwner.enterpriseId))
        .where(and(eq(observation.recordId, record.id),
          filter.enterpriseId === undefined ? undefined : eq(currentOwner.enterpriseId, filter.enterpriseId),
          enterpriseKeyword(enterprise, filter.q))))
    : undefined
  const column = (name: string) => namedColumn(projection, name)
  const common = and(eq(record.interface, catalog.interface), equals(record.platformKey, filter.platformKey),
    equals(column('title_raw'), filter.titleRaw), scope, owner)

  if (catalog.interface === 'recognized_list') {
    return and(common, equals(column('validity_date_raw'), filter.rddqrq), equals(column('maintenance_year'), filter.whpcyear),
      equals(column('maintenance_batch'), filter.whpc), equals(column('district'), filter.szq))
  }
  const year = column(catalog.interface === 'apply_list' ? 'declaration_year' : 'business_year')
  const batch = catalog.interface === 'business_list' ? equals(column('batch'), filter.batch) : undefined
  return and(common, equals(column('declare_kind'), normalizeDeclareKind(filter.declareKind) ?? undefined),
    equals(year, filter.year), equals(column('status'), filter.status), batch)
}

async function listRecords(tx: Reader, catalog: Catalog, filter: ArchiveFilter) {
  const { page, pageSize, offset } = platformBusinessPage(filter)
  const projection = alias(catalog.table, 'p')
  const where = recordFilter(tx, catalog, filter, projection)
  const matching = <T extends PgSelect>(query: T) => query.innerJoin(record, eq(record.id, version.recordId))
    .leftJoin(projection, eq(projection.versionId, version.id)).where(where)
  const [total] = await matching(tx.select({ total: countDistinct(record.id) }).from(version).$dynamic())
  // Drizzle 0.45 has no window functions or NULLS LAST modifier. Rank versions per record before paging records.
  const versionOrder = catalog.interface === 'recognized_list' ? desc(version.id)
    : sql`${namedColumn(projection, 'applied_at')} COLLATE "C" DESC NULLS LAST, ${desc(version.id)}`
  const ranked = tx.$with('matched').as(matching(tx.select({
    recordId: version.recordId,
    id: version.id,
    matchedVersionCount: sql<number>`count(*) OVER (PARTITION BY ${version.recordId})`.mapWith(Number).as('matched_count'),
    rank: sql<number>`row_number() OVER (PARTITION BY ${version.recordId} ORDER BY ${versionOrder})`.mapWith(Number).as('rank'),
  }).from(version).$dynamic()))
  const latest = tx.select({ value: sql<string | null>`max(coalesce(${collection.lastCollectedAt}, ${collection.queriedAt}) COLLATE "C")` })
    .from(observation).innerJoin(collection, eq(collection.id, observation.collectionId))
    .where(eq(observation.recordId, ranked.recordId))
  const pageRows = tx.$with('page').as(tx.select({
    recordId: ranked.recordId, id: ranked.id, matchedVersionCount: ranked.matchedVersionCount,
    latest: sql<string | null>`(${latest})`.as('latest'),
  }).from(ranked).where(eq(ranked.rank, 1))
    .orderBy(sql`latest DESC NULLS LAST`, desc(ranked.recordId)).limit(pageSize).offset(offset))
  const summary = recordSummary(tx, catalog)
  const matched = await tx.with(ranked, pageRows).select({
    recordId: record.id,
    platformKey: record.platformKey,
    matchedVersionCount: pageRows.matchedVersionCount,
    versionId: version.id,
    // Drizzle uses the first field of a joined object to detect a missing row.
    projectedVersion: { projectionId: projection.id, ...versionFields(catalog, projection) },
    summary: {
      versionCount: summary.versionCount, observationCount: summary.observationCount,
      enterpriseIds: summary.enterpriseIds, enterpriseNames: summary.enterpriseNames, titleScopes: summary.titleScopes,
      titleConflict: summary.titleConflict, unverifiable: summary.unverifiable, assignmentConflict: summary.assignmentConflict,
    },
    latestObservationAt: pageRows.latest,
  }).from(pageRows)
    .innerJoin(record, eq(record.id, pageRows.recordId))
    .innerJoin(version, eq(version.id, pageRows.id))
    .leftJoin(projection, eq(projection.versionId, version.id))
    .innerJoinLateral(summary, eq(record.id, record.id))
    .orderBy(sql`${pageRows.latest} DESC NULLS LAST`, desc(record.id))
  return {
    view: 'records' as const, page, pageSize, total: total!.total,
    rows: matched.map(({ recordId, platformKey, versionId, projectedVersion, matchedVersionCount, latestObservationAt, summary }) => ({
      kind: 'record' as const, record: { id: recordId, platformKey, interface: catalog.interface },
      matchedVersion: versionData(catalog, versionId, projectedVersion), matchedVersionCount, versionCount: summary.versionCount,
      observationCount: summary.observationCount, latestObservationAt,
      enterpriseIds: summary.enterpriseIds, enterpriseNames: summary.enterpriseNames,
      ...(summary.titleScopes && { titleScopes: orderedScopes(summary.titleScopes) }),
      conflicts: summaryConflicts(summary),
    })),
  }
}

function isolatedObservation(obs: ObservationTable) {
  return or(ne(obs.identityState, 'resolved'), ne(obs.contentState, 'verified'), isNull(obs.versionId))
}

async function listIsolated(tx: Reader, catalog: Catalog, filter: ArchiveFilter) {
  const { page, pageSize, offset } = platformBusinessPage(filter)
  const base = { view: 'isolated' as const, page, pageSize }
  const recognized = catalog.interface === 'recognized_list'
  if (recognized && [filter.rddqrq, filter.whpcyear, filter.whpc, filter.szq].some(value => value !== undefined)) {
    return { ...base, total: 0, rows: [] }
  }
  const obs = archivedObservation
  const col = archivedCollection
  const owner = alias(assignment, 'owner')
  const original = alias(assignment, 'original')
  const exact = (key: SourceValueKey, value: string | number | undefined) => exactEquals(sourceCell(obs, key), value)
  const current = tx.select({ enterpriseId: owner.enterpriseId }).from(owner)
    .where(eq(owner.observationId, obs.id)).orderBy(desc(owner.revision)).limit(1).as('a')
  const keyword = enterpriseKeyword(enterprise, filter.q)
  const criteria = and(
    eq(col.interface, catalog.interface),
    isolatedObservation(obs),
    filter.enterpriseId === undefined ? undefined : eq(current.enterpriseId, filter.enterpriseId),
    keyword,
    filter.platformKey === undefined ? undefined : filter.platformKey.includes('\0') ? ne(obs.id, obs.id) : eq(obs.sourceRelationKey, filter.platformKey),
    exact('titleRaw', filter.titleRaw),
    recognized ? undefined : exact('declareKind', normalizeDeclareKind(filter.declareKind) ?? undefined),
    recognized ? undefined : exact('year', filter.year),
    recognized ? undefined : exact('status', filter.status),
    catalog.interface === 'business_list' ? exact('batch', filter.batch) : undefined,
    filter.rdjb ? scopeMatch(tx, filter.rdjb) : undefined,
  )
  const query = <T extends PgSelect>(selection: T) => selection
    .innerJoin(col, eq(col.id, obs.collectionId))
    .leftJoinLateral(current, eq(obs.id, obs.id)).leftJoin(enterprise, eq(enterprise.id, current.enterpriseId))
  const [result] = await query(tx.select({ total: count() }).from(obs).$dynamic()).where(criteria)
  const cells = Object.fromEntries(Object.entries(catalog.exact).map(([key, name]) => [key, sourceCell(obs, name)]))
  const observations = await query(tx.select({
    relationId: obs.publicId, queryId: col.publicId, queriedAt: col.queriedAt, queryKey: col.queryKey, queryStatus: col.status,
    sequenceNo: obs.sequenceNo, identityState: obs.identityState, contentState: obs.contentState,
    enterpriseId: current.enterpriseId, enterpriseName: enterprise.name,
    nameRaw: original.nameRaw, usccRaw: original.usccRaw, ...cells,
    titleScopes: catalog.interface === 'apply_list' ? sql<null>`NULL` : collectionScopes as SQL<string[]>,
  }).from(obs).$dynamic())
    .leftJoin(original, and(eq(original.observationId, obs.id), eq(original.revision, 1)))
    .where(criteria)
    // Drizzle 0.45 cannot express explicit bytewise collation.
    .orderBy(desc(sql`${col.queriedAt} COLLATE "C"`), desc(obs.publicId))
    .limit(pageSize).offset(offset)
  return {
    ...base, total: result!.total,
    rows: observations.map(({ titleScopes, ...row }) => ({
      kind: 'observation' as const, ...decodeExactFields(row, catalog.exact),
      ...(titleScopes && { titleScopes: orderedScopes(titleScopes) }),
    })),
  }
}

export function listPostgresPlatformArchive(db: NodePgDatabase, source: Source, filter: ArchiveFilter) {
  const catalog = catalogs[source]
  return db.transaction(async tx => {
    await captureGate(tx, catalog)
    return filter.view === 'records' ? listRecords(tx, catalog, filter) : listIsolated(tx, catalog, filter)
  }, snapshot)
}

async function readIsolatedOptions(tx: Reader, catalog: Catalog, option: string, name: SourceValueKey) {
  const cell = sourceCell(observation, name)
  const storage = sourceStorageOrder(cell).as('storage')
  const bytes = sourceBytes(cell).as('bytes')
  // PostgreSQL numeric retains order and equality before node-postgres turns the result into a JS number.
  const numeric = sql<string | null>`CASE WHEN jsonb_typeof(${cell}) = 'number'
    THEN (${cell} #>> '{}')::numeric END`.as('numeric_value')
  const years = option === 'years'
  // SQLite trim() casts BLOBs to text when checking for an empty option.
  const nonempty = or(eq(storage.sql, 0), sql`encode(${bytes.sql}, 'hex') !~ '^(20)*$'`)
  const cells = await tx.selectDistinct({ storage, bytes, numeric }).from(observation)
    .innerJoin(collection, eq(observation.collectionId, collection.id))
    .where(and(eq(collection.interface, catalog.interface), isolatedObservation(observation), years ? eq(storage.sql, 0) : nonempty))
    .orderBy(asc(storage), asc(bytes), years ? desc(numeric) : asc(numeric))
  if (years) return [...new Set(cells.map(cell => Number(cell.numeric)).filter(value => Number.isSafeInteger(value) && value > 0))]
  return cells.map(({ storage, bytes, numeric }) => {
    if (storage === 0) return Number(numeric)
    if (storage === 1) return bytes!.toString('utf8')
    return bytes
  })
}

export function readPostgresPlatformArchiveOptions(db: NodePgDatabase, { source, view }: PlatformFilterOptionsQuery) {
  const catalog = catalogs[source]
  return db.transaction(async tx => {
    await captureGate(tx, catalog)
    const result = { titles: [], declareKinds: [], years: [], statuses: [], batches: [], districts: [], validityDates: [] } as Record<keyof Options, unknown[]>
    if (view === 'isolated') {
      for (const [option, name] of Object.entries(catalog.exactOptions)) {
        result[option as keyof Options] = await readIsolatedOptions(tx, catalog, option, name)
      }
      return result
    }

    const projection = catalog.table
    for (const [option, name] of Object.entries(catalog.options)) {
      const column = namedColumn(projection, name)
      // Drizzle 0.45 cannot express COLLATE or btrim.
      const value = option === 'years' ? sql<number>`${column}`.mapWith(Number) : sql<string>`${column} COLLATE "C"`
      const where = option === 'years' ? between(column, 1, Number.MAX_SAFE_INTEGER) : sql`btrim(${column}) <> ''`
      result[option as keyof Options] = (await tx.selectDistinct({ value }).from(projection)
        .innerJoin(recordVersion, eq(projection.versionId, recordVersion.id))
        .innerJoin(businessRecord, eq(recordVersion.recordId, businessRecord.id))
        .where(and(eq(businessRecord.interface, catalog.interface), where))
        .orderBy(option === 'years' ? desc(value) : asc(value))).map(row => row.value)
    }
    return result
  }, snapshot)
}

export function readPostgresPlatformArchiveDetail(db: NodePgDatabase, source: Source, recordId: number) {
  const catalog = catalogs[source]
  if (!Number.isSafeInteger(recordId) || recordId < 1) {
    failPlatformBusinessRequest(400, catalog.idCode, 'recordId must be a positive safe integer')
  }
  const scoped = catalog.interface !== 'apply_list'
  const recognized = catalog.interface === 'recognized_list'

  return db.transaction(async tx => {
    if (scoped) await captureGate(tx, catalog)
    const [recordInfo] = await tx.select({
      id: businessRecord.id, platformKey: businessRecord.platformKey,
      identityRuleVersion: businessRecord.identityRuleVersion, createdAt: businessRecord.createdAt,
    }).from(businessRecord).where(and(eq(businessRecord.id, recordId), eq(businessRecord.interface, catalog.interface)))
    if (!recordInfo) failPlatformBusinessRequest(404, catalog.notFoundCode, catalog.notFoundMessage)
    if (!scoped) await captureGate(tx, catalog, recordId)

    const totals = {
      versions: await tx.$count(recordVersion, eq(recordVersion.recordId, recordId)),
      observations: await tx.$count(observation, eq(observation.recordId, recordId)),
    }
    const { table } = catalog
    const projectionFields = versionFields(catalog, table)
    const version = tx.select({
      id: recordVersion.id, hashAlgorithm: recordVersion.hashAlgorithm,
      contentHash: recordVersion.contentHash, createdAt: recordVersion.createdAt,
    }).from(recordVersion).where(eq(recordVersion.recordId, recordId))
      .orderBy(desc(recordVersion.id)).limit(catalog.limits.versions).as('v')
    // Preserve explicit collation for the chronological aggregates.
    const stats = tx.select({
      observationCount: count().as('observation_count'),
      firstObservedAt: sql<string | null>`min(${collection.queriedAt} COLLATE "C")`.as('first_observed_at'),
      lastObservedAt: sql<string | null>`max(coalesce(${collection.lastCollectedAt}, ${collection.queriedAt}) COLLATE "C")`.as('last_observed_at'),
    }).from(observation).innerJoin(collection, eq(collection.id, observation.collectionId))
      .where(and(eq(observation.recordId, recordId), eq(observation.versionId, version.id))).as('stats')
    const scopeCollections = tx.selectDistinct({ id: collection.id, rdjb: collection.rdjb }).from(observation)
      .innerJoin(collection, eq(collection.id, observation.collectionId)).where(eq(observation.versionId, version.id))
    const versions = await tx.select({
      versionId: version.id, ...projectionFields,
      hashAlgorithm: version.hashAlgorithm, contentHash: version.contentHash, createdAt: version.createdAt,
      observationCount: stats.observationCount, firstObservedAt: stats.firstObservedAt, lastObservedAt: stats.lastObservedAt,
      titleScopes: scoped ? scopeArray(scopeCollections) as SQL<string[]> : sql<null>`NULL`,
    }).from(version).leftJoin(table, eq(table.versionId, version.id)).innerJoinLateral(stats, eq(version.id, version.id))
      .orderBy(desc(version.id))

    const obs = archivedObservation
    const col = archivedCollection
    const current = tx.select({ enterpriseId: assignment.enterpriseId }).from(assignment)
      .where(eq(assignment.observationId, obs.id)).orderBy(desc(assignment.revision)).limit(1).as('owner')
    // Drizzle 0.45 has no ordered JSON aggregation.
    const links = tx.select({
      refs: sql`json_agg(json_build_object('id', ${recordCorrespondence.id}, 'status', ${recordCorrespondence.status},
        'revision', ${recordCorrespondence.revision}) ORDER BY ${recordCorrespondence.id})`,
    }).from(recordCorrespondence).where(eq(recordCorrespondence.observationId, obs.id))
    const correspondenceRefs = scoped ? sql`coalesce((${links}), '[]'::json)` : sql<null>`NULL`
    const observations = await tx.select({
      relationId: obs.publicId, queryId: col.publicId, queriedAt: col.queriedAt,
      queryKey: col.queryKey, queryStatus: col.status, sequenceNo: obs.sequenceNo,
      identityState: obs.identityState, contentState: obs.contentState,
      enterpriseId: current.enterpriseId, enterpriseName: enterprise.name, keySource: obs.keySource,
      projectionRuleVersion: obs.projectionRuleVersion, versionId: obs.versionId,
      projection: { projectionId: table.id, ...projectionFields },
      titleScopes: scoped ? collectionScopes as SQL<string[]> : sql<null>`NULL`,
      correspondenceRefs,
    }).from(obs).innerJoin(col, eq(col.id, obs.collectionId))
      .leftJoinLateral(current, eq(obs.id, obs.id)).leftJoin(enterprise, eq(enterprise.id, current.enterpriseId))
      .leftJoin(table, and(eq(table.versionId, obs.versionId), eq(table.recordId, obs.recordId)))
      .where(eq(obs.recordId, recordId))
      .orderBy(desc(sql`${col.queriedAt} COLLATE "C"`), desc(obs.publicId)).limit(catalog.limits.observations)

    const detailObservations = observations.map(({ projection, titleScopes, correspondenceRefs, ...fields }) => {
      const version = fields.versionId === null ? null : versionData(catalog, fields.versionId, projection)
      const row = { ...fields, version, ...(titleScopes === null ? {} : { titleScopes: orderedScopes(titleScopes), correspondenceRefs }) }
      if (row.identityState === 'not_indexed' || row.contentState === 'not_indexed'
        || row.keySource === null || row.projectionRuleVersion === null) {
        failPlatformBusinessRequest(409, catalog.notIndexedCode, catalog.notIndexedMessage)
      }
      if (!recognized) return row
      const title = row.version?.titleRaw as string | null | undefined
      const scopes = titleScopes ?? []
      return { ...row, titleConflict: !!title && ['1', '2', '3'].includes(title) && scopes.length > 0 && !scopes.includes(title) }
    })
    const owners = tx.$with('owners').as(recordOwners(tx))
    const conflicts = tx.with(owners).select(recordConflictFields(tx, catalog)).from(owners).as('record_conflicts')
    const [summary] = recognized ? await tx.select({
      titleConflict: conflicts.titleConflict, unverifiable: conflicts.unverifiable, assignmentConflict: conflicts.assignmentConflict,
    }).from(record).innerJoinLateral(conflicts, eq(record.id, record.id)).where(eq(record.id, recordId)) : []

    return {
      record: { ...recordInfo, interface: catalog.interface },
      versions: versions.map(({ titleScopes, ...row }) => titleScopes === null ? row : { ...row, titleScopes: orderedScopes(titleScopes) }),
      observations: detailObservations,
      counts: {
        ...totals, versionsTruncated: totals.versions > versions.length,
        observationsTruncated: totals.observations > observations.length,
      },
      ...(summary && { conflicts: summaryConflicts(summary) }),
    }
  }, snapshot)
}
