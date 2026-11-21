import { sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import { BUSINESS_PROCESS_OBSERVATION_LIMIT, BUSINESS_PROCESS_VERSION_LIMIT, type BusinessProcessFilter } from '../../lib/platform/business-processes'
import { DECLARATION_OBSERVATION_LIMIT, DECLARATION_VERSION_LIMIT, type DeclarationFilter } from '../../lib/platform/declarations'
import type { PlatformFilterOptionsQuery } from '../../lib/platform/filter-options'
import { normalizeDeclareKind } from '../../lib/platform/identity'
import { RECOGNIZED_DIRECTORY_OBSERVATION_LIMIT, RECOGNIZED_DIRECTORY_VERSION_LIMIT, type RecognizedDirectoryFilter } from '../../lib/platform/recognized-directory'
import { fail, orderedScopes, pageOf } from './platform-business-read'

type Reader = Pick<NodePgDatabase, 'execute'>
type Source = PlatformFilterOptionsQuery['source']
type ArchiveFilter = DeclarationFilter & Partial<BusinessProcessFilter & RecognizedDirectoryFilter>
type Fields = Readonly<Record<string, string>>
type Options = Record<'titles' | 'declareKinds' | 'years' | 'statuses' | 'batches' | 'districts' | 'validityDates', string>
const snapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const

const commonVersionFields = { titleRaw: 'title_raw', nameRaw: 'name_raw', usccRaw: 'uscc_raw', ruleVersion: 'rule_version' }
const processFields = { declareKind: 'declare_kind', appliedAt: 'applied_at', status: 'status' }
const storedProcessFields = { titleRaw: 'exact_title_raw', declareKind: 'exact_declare_kind', appliedAt: 'exact_applied_at', status: 'exact_status' }
const catalogs = {
  declarations: {
    table: 'platform_apply_projection',
    interface: 'apply_list',
    fields: { ...commonVersionFields, ...processFields, declarationYear: 'declaration_year' },
    exact: { ...storedProcessFields, declarationYear: 'exact_year' },
    options: { titles: 'title_raw', declareKinds: 'declare_kind', years: 'declaration_year', statuses: 'status' },
    exactOptions: { titles: 'exact_title_raw', declareKinds: 'exact_declare_kind', years: 'exact_year', statuses: 'exact_status' },
    limits: { versions: DECLARATION_VERSION_LIMIT, observations: DECLARATION_OBSERVATION_LIMIT },
    idCode: 'invalid_declaration_id', notFoundCode: 'declaration_not_found', notFoundMessage: 'Declaration record not found',
    notIndexedCode: 'apply_target_not_indexed', notIndexedMessage: 'Declaration observation is not indexed',
  },
  'business-processes': {
    table: 'platform_business_projection',
    interface: 'business_list',
    fields: { ...commonVersionFields, ...processFields, businessYear: 'business_year', batch: 'batch', awardBatchLabel: 'award_batch_label', province: 'province' },
    exact: { ...storedProcessFields, businessYear: 'exact_year', batch: 'exact_batch', awardBatchLabel: 'exact_award_batch_label', province: 'exact_province' },
    options: { titles: 'title_raw', declareKinds: 'declare_kind', years: 'business_year', statuses: 'status', batches: 'batch' },
    exactOptions: { titles: 'exact_title_raw', declareKinds: 'exact_declare_kind', years: 'exact_year', statuses: 'exact_status', batches: 'exact_batch' },
    limits: { versions: BUSINESS_PROCESS_VERSION_LIMIT, observations: BUSINESS_PROCESS_OBSERVATION_LIMIT },
    idCode: 'invalid_business_process_id', notFoundCode: 'business_process_not_found', notFoundMessage: 'Business process record not found',
    notIndexedCode: 'process_target_not_indexed', notIndexedMessage: 'Record observation is not indexed',
  },
  'recognized-directory': {
    table: 'platform_recognized_projection',
    interface: 'recognized_list',
    fields: { ...commonVersionFields, validityDateRaw: 'validity_date_raw', maintenanceYear: 'maintenance_year', maintenanceBatch: 'maintenance_batch', district: 'district', awardNote: 'award_note' },
    exact: { titleRaw: 'exact_title_raw' },
    options: { titles: 'title_raw', batches: 'maintenance_batch', districts: 'district', validityDates: 'validity_date_raw' },
    exactOptions: { titles: 'exact_title_raw' },
    limits: { versions: RECOGNIZED_DIRECTORY_VERSION_LIMIT, observations: RECOGNIZED_DIRECTORY_OBSERVATION_LIMIT },
    idCode: 'invalid_recognized_record_id', notFoundCode: 'recognized_record_not_found', notFoundMessage: 'Recognized directory record not found',
    notIndexedCode: 'recognized_target_not_indexed', notIndexedMessage: 'Record observation is not indexed',
  },
} as const satisfies Record<Source, {
  table: string; interface: string; fields: Fields; exact: Fields; options: Partial<Options>; exactOptions: Partial<Options>
  limits: { versions: number; observations: number }
  idCode: string; notFoundCode: string; notFoundMessage: string; notIndexedCode: string; notIndexedMessage: string
}>
type Catalog = typeof catalogs[Source]

async function rows<T extends Record<string, unknown>>(tx: Reader, statement: SQL) {
  return (await tx.execute<T>(statement)).rows
}

const assignments = sql`
  LEFT JOIN business.platform_observation_assignment a ON a.observation_id = o.id
    AND a.revision = (SELECT max(revision) FROM business.platform_observation_assignment WHERE observation_id = o.id)
  LEFT JOIN business.enterprise e ON e.id = a.enterprise_id`
const originalAssignment = sql`
  LEFT JOIN business.platform_observation_assignment original ON original.observation_id = o.id AND original.revision = 1`
const observationsFrom = sql`
  FROM business.platform_business_observation o
  JOIN business.platform_collection c ON c.id = o.collection_id`
const aliases = (join: SQL) => sql`
  ${join} business.platform_legacy_query_alias qa ON qa.collection_id = c.id
  ${join} business.platform_legacy_relation_alias ra ON ra.observation_id = o.id`
const isolated = sql`(o.identity_state <> 'resolved' OR o.content_state <> 'verified' OR o.version_id IS NULL)`

function projectionTable(catalog: Catalog) {
  return sql`business.${sql.identifier(catalog.table)} p`
}

function projectionColumn(name: string) {
  return sql`p.${sql.identifier(name)}`
}

function equals(column: SQL, value: string | number | undefined) {
  if (value === undefined) return sql`true`
  // Ordinary PostgreSQL text excludes NUL. Exact mixed storage cells use bytea.
  if (typeof value === 'string' && value.includes('\0')) return sql`false`
  return sql`${column} = ${value}`
}

/** SQLite LIKE folds ASCII only and uses no escape character by default. */
function like(column: SQL, pattern: string) {
  const folded = pattern.replace(/[A-Z]/g, char => char.toLowerCase()).split('\0')[0]
  return sql`translate(${column}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') COLLATE "C"
    LIKE ${folded} ESCAPE ''`
}

function enterpriseFilter(filter: ArchiveFilter) {
  const keyword = filter.q
    ? sql`(${like(sql`e.name_norm`, `%${normalizeName(filter.q)}%`)} OR ${like(sql`e.uscc_norm`, `%${normalizeUscc(filter.q)}%`)})`
    : sql`true`
  return sql`${equals(sql`a.enterprise_id`, filter.enterpriseId)} AND ${keyword}`
}

// PostgreSQL materialization must retain these exact cells as bytea with the
// staging tool's SQLite storage tags. Typed projection columns stay text/bigint.
function exactEquals(name: string, value: string | number | undefined) {
  if (value === undefined) return sql`true`
  const cell = projectionColumn(name)
  const storage = projectionColumn(name + '_sqlite_storage')
  if (typeof value === 'string') {
    return sql`(${storage} = 'text' AND ${cell} = ${Buffer.from(value)})`
  }
  const integer = Buffer.alloc(8), real = Buffer.alloc(8)
  integer.writeBigInt64BE(BigInt(value))
  real.writeDoubleBE(value)
  return sql`((${storage} = 'integer' AND ${cell} = ${integer}) OR (${storage} = 'real' AND ${cell} = ${real}))`
}

interface ExactCell { storage: string | null; value: Buffer | null }

function exactValue({ storage, value }: ExactCell) {
  if (value === null) return null
  switch (storage) {
    case 'text': return value.toString('utf8')
    case 'blob': return value
    case 'integer': return Number(value.readBigInt64BE())
    case 'real': return value.readDoubleBE()
    default: throw new Error('Invalid archived SQLite storage class')
  }
}

function exactSelection(fields: Fields) {
  return sql.join(Object.entries(fields).flatMap(([key, name]) => [
    sql`${projectionColumn(name)} AS ${sql.identifier(key)}`,
    sql`${projectionColumn(name + '_sqlite_storage')} AS ${sql.identifier(key + 'Storage')}`,
  ]), sql`, `)
}

function decodeExactFields(row: Record<string, unknown>, fields: Fields) {
  for (const key of Object.keys(fields)) {
    row[key] = exactValue({ value: row[key] as ExactCell['value'], storage: row[key + 'Storage'] as ExactCell['storage'] })
    delete row[key + 'Storage']
  }
  return row
}

const typeOrder: Record<string, number> = { integer: 0, real: 0, text: 1, blob: 2 }
function compareExactCells(a: ExactCell, b: ExactCell) {
  const rank = typeOrder[a.storage!]! - typeOrder[b.storage!]!
  if (rank) return rank
  if (a.storage === 'text' || a.storage === 'blob') return Buffer.compare(a.value!, b.value!)
  const left = a.storage === 'integer' ? a.value!.readBigInt64BE() : a.value!.readDoubleBE()
  const right = b.storage === 'integer' ? b.value!.readBigInt64BE() : b.value!.readDoubleBE()
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

async function captureGate(tx: Reader, catalog: Catalog, recordId?: number) {
  if (catalog.interface === 'apply_list') {
    const missing = await rows(tx, sql`SELECT 1 ${observationsFrom}
      LEFT JOIN ${projectionTable(catalog)} ON p.observation_id = o.id
      WHERE c.interface = 'apply_list' AND ${equals(sql`o.record_id`, recordId)}
        AND (p.id IS NULL OR p.exact_stored_state IS DISTINCT FROM 'captured'
          OR p.sql_fact_title_state IS DISTINCT FROM 'captured')
      LIMIT 1`)
    if (missing.length) fail(409, 'apply_stored_uncaptured', 'Declaration observation has uncaptured stored facts')
    return
  }

  const process = catalog.interface === 'business_list'
  const capture = process ? sql`
    p.exact_stored_state IS DISTINCT FROM 'captured' OR p.sql_fact_title_state IS DISTINCT FROM 'captured'
    OR p.exact_stored_rule IS DISTINCT FROM 'process-stored-cells-v1'
    OR p.sql_fact_title_rule IS DISTINCT FROM 'process-legacy-sql-fact-title-v1'`
    : sql`p.exact_title_state IS DISTINCT FROM 'captured'`
  const missing = await rows(tx, sql`SELECT 1 ${observationsFrom}
    LEFT JOIN ${projectionTable(catalog)} ON p.observation_id = o.id
    ${assignments} ${originalAssignment} ${aliases(sql`LEFT JOIN`)}
    WHERE c.interface = ${catalog.interface}
      AND (p.id IS NULL OR ${capture} OR a.observation_id IS NULL OR original.observation_id IS NULL
        OR ra.old_id IS NULL OR qa.old_id IS NULL)
    LIMIT 1`)
  if (missing.length) {
    if (process) fail(409, 'process_target_uncaptured', 'Process observation has uncaptured original facts or assignment')
    fail(409, 'recognized_target_uncaptured', 'Recognized observation has uncaptured original facts or assignment')
  }
}

function scopeMatch(rdjb: string) {
  return sql`(strpos(',' || c.rdjb || ',', ${',' + rdjb + ','}) > 0
    OR EXISTS (SELECT 1 FROM business.platform_query_title_scope s WHERE s.collection_id = c.id AND s.rdjb = ${rdjb}))`
}

const jsWhitespace = ' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'

function scopeArray(collections: SQL) {
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

const recordVersionsFrom = (catalog: Catalog) => sql`
  FROM business.platform_business_record_version v
  JOIN business.platform_business_record b ON b.id = v.record_id
  LEFT JOIN ${projectionTable(catalog)} ON p.version_id = v.id`

function versionSelection(catalog: Catalog, id: SQL) {
  const numeric = new Set(['declaration_year', 'business_year', 'maintenance_year'])
  const fields = Object.entries(catalog.fields).map(([key, name]) =>
    sql`${projectionColumn(name)}${numeric.has(name) ? sql`::double precision` : sql.empty()} AS ${sql.identifier(key)}`)
  return sql`${id}::double precision AS "versionId", ${sql.join(fields, sql`, `)}`
}

const observationFields = sql`
  ra.old_id::double precision AS "relationId", qa.old_id::double precision AS "queryId",
  c.queried_at AS "queriedAt", c.query_key AS "queryKey", c.status AS "queryStatus",
  o.sequence_no::double precision AS "sequenceNo", o.identity_state AS "identityState", o.content_state AS "contentState",
  a.enterprise_id::double precision AS "enterpriseId", e.name AS "enterpriseName"`

interface RecordSummary extends Record<string, unknown> {
  enterpriseIds: number[]
  enterpriseNames: string[]
  titleScopes: string[] | null
  titleConflict: boolean
  unverifiable: boolean
  assignmentConflict: boolean
  observationCount: number
  versionCount: number
  latestObservationAt: string | null
}

const owners = sql`
  SELECT DISTINCT a.enterprise_id, e.name FROM business.platform_business_observation o ${assignments}
  WHERE o.record_id = b.id AND a.enterprise_id IS NOT NULL`
const recordScopes = scopeArray(sql`
  SELECT DISTINCT c.id, c.rdjb ${observationsFrom} WHERE o.record_id = b.id`)

function recordTitleConflict(catalog: Catalog) {
  if (catalog.interface !== 'recognized_list') return sql`false`
  const list = sql`translate(c.rdjb, ${' \t\n\r'}, '')`
  return sql`EXISTS (SELECT 1 ${observationsFrom}
    JOIN ${projectionTable(catalog)} ON p.version_id = o.version_id
    WHERE o.record_id = b.id AND p.title_raw IN ('1', '2', '3')
      AND (replace(${list}, ',', '') <> '' OR EXISTS (SELECT 1 FROM business.platform_query_title_scope s
        WHERE s.collection_id = c.id AND btrim(s.rdjb) <> ''))
      AND strpos(',' || ${list} || ',', ',' || p.title_raw || ',') = 0
      AND NOT EXISTS (SELECT 1 FROM business.platform_query_title_scope s
        WHERE s.collection_id = c.id AND s.rdjb = p.title_raw))`
}

function recordSummary(catalog: Catalog) {
  return sql`
    (SELECT count(*)::double precision FROM business.platform_business_record_version WHERE record_id = b.id) AS "versionCount",
    (SELECT count(*)::double precision FROM business.platform_business_observation WHERE record_id = b.id) AS "observationCount",
    ARRAY(SELECT enterprise_id::double precision FROM owners ORDER BY enterprise_id) AS "enterpriseIds",
    ARRAY(SELECT name FROM owners WHERE name <> '' ORDER BY enterprise_id) AS "enterpriseNames",
    ${catalog.interface === 'apply_list' ? sql`NULL` : recordScopes} AS "titleScopes",
    ${recordConflictFields(catalog)}`
}

type RecordConflicts = Pick<RecordSummary, 'titleConflict' | 'unverifiable' | 'assignmentConflict'>

function recordConflictFields(catalog: Catalog) {
  return sql`
    ${recordTitleConflict(catalog)} AS "titleConflict",
    EXISTS (SELECT 1 FROM business.platform_business_observation WHERE record_id = b.id AND content_state = 'unverifiable') AS unverifiable,
    (SELECT count(*) > 1 FROM owners) AS "assignmentConflict"`
}

function summaryConflicts(summary: RecordConflicts) {
  return [
    ...(summary.titleConflict ? ['title_conflict'] : []),
    ...(summary.unverifiable ? ['unverifiable_observation'] : []),
    ...(summary.assignmentConflict ? ['enterprise_assignment_conflict'] : []),
  ]
}

interface MatchedRow extends RecordSummary {
  recordId: number
  platformKey: string
  matchedVersion: Record<string, unknown>
  matchedVersionCount: number
}

function recordFilter(catalog: Catalog, filter: ArchiveFilter) {
  const scope = filter.rdjb
    ? sql`EXISTS (SELECT 1 ${observationsFrom} WHERE o.version_id = v.id AND ${scopeMatch(filter.rdjb)})`
    : sql`true`
  const owner = filter.enterpriseId !== undefined || filter.q
    ? sql`EXISTS (SELECT 1 FROM business.platform_business_observation o ${assignments}
        WHERE o.record_id = b.id AND ${enterpriseFilter(filter)})`
    : sql`true`
  const common = sql`b.interface = ${catalog.interface}
    AND ${equals(sql`b.platform_key`, filter.platformKey)} AND ${equals(sql`p.title_raw`, filter.titleRaw)}
    AND ${scope} AND ${owner}`

  if (catalog.interface === 'recognized_list') {
    return sql`${common} AND ${equals(sql`p.validity_date_raw`, filter.rddqrq)}
      AND ${equals(sql`p.maintenance_year`, filter.whpcyear)} AND ${equals(sql`p.maintenance_batch`, filter.whpc)}
      AND ${equals(sql`p.district`, filter.szq)}`
  }
  const year = projectionColumn(catalog.interface === 'apply_list' ? 'declaration_year' : 'business_year')
  const batch = catalog.interface === 'business_list' ? equals(sql`p.batch`, filter.batch) : sql`true`
  return sql`${common} AND ${equals(sql`p.declare_kind`, normalizeDeclareKind(filter.declareKind) ?? undefined)}
    AND ${equals(year, filter.year)} AND ${equals(sql`p.status`, filter.status)} AND ${batch}`
}

async function listRecords(tx: Reader, catalog: Catalog, filter: ArchiveFilter) {
  const { page, pageSize, offset } = pageOf(filter)
  const from = recordVersionsFrom(catalog)
  const where = recordFilter(catalog, filter)
  const [count] = await rows<{ total: number }>(tx, sql`
    SELECT count(DISTINCT b.id)::double precision AS total ${from} WHERE ${where}`)
  const versionOrder = catalog.interface === 'recognized_list' ? sql`v.id DESC`
    : sql`p.applied_at COLLATE "C" DESC NULLS LAST, v.id DESC`
  const matched = await rows<MatchedRow>(tx, sql`
    WITH matched AS (
      SELECT v.record_id, v.id,
        count(*) OVER (PARTITION BY v.record_id)::double precision AS matched_count,
        row_number() OVER (PARTITION BY v.record_id ORDER BY ${versionOrder}) AS rank
      ${from} WHERE ${where}
    ), page AS (
      SELECT m.*, (SELECT max(coalesce(c.last_collected_at, c.queried_at) COLLATE "C")
        ${observationsFrom} WHERE o.record_id = m.record_id) AS latest
      FROM matched m WHERE m.rank = 1
      ORDER BY latest DESC NULLS LAST, record_id DESC LIMIT ${pageSize} OFFSET ${BigInt(offset)}
    )
    SELECT b.id::double precision AS "recordId", b.platform_key AS "platformKey",
      page.latest AS "latestObservationAt", page.matched_count AS "matchedVersionCount",
      (SELECT row_to_json(fields) FROM (SELECT ${versionSelection(catalog, sql`v.id`)}) fields) AS "matchedVersion",
      summary.*
    FROM page JOIN business.platform_business_record b ON b.id = page.record_id
    JOIN business.platform_business_record_version v ON v.id = page.id
    LEFT JOIN ${projectionTable(catalog)} ON p.version_id = v.id
    CROSS JOIN LATERAL (WITH owners AS (${owners}) SELECT ${recordSummary(catalog)}) summary
    ORDER BY page.latest DESC NULLS LAST, b.id DESC`)
  return {
    view: 'records' as const, page, pageSize, total: count!.total,
    rows: matched.map(({ recordId, platformKey, matchedVersion, matchedVersionCount, ...summary }) => ({
      kind: 'record' as const, record: { id: recordId, platformKey, interface: catalog.interface },
      matchedVersion, matchedVersionCount, versionCount: summary.versionCount,
      observationCount: summary.observationCount, latestObservationAt: summary.latestObservationAt,
      enterpriseIds: summary.enterpriseIds, enterpriseNames: summary.enterpriseNames,
      ...(summary.titleScopes && { titleScopes: orderedScopes(summary.titleScopes) }),
      conflicts: summaryConflicts(summary),
    })),
  }
}

async function listIsolated(tx: Reader, catalog: Catalog, filter: ArchiveFilter) {
  const { page, pageSize, offset } = pageOf(filter)
  const base = { view: 'isolated' as const, page, pageSize }
  const recognized = catalog.interface === 'recognized_list'
  if (recognized && [filter.rddqrq, filter.whpcyear, filter.whpc, filter.szq].some(value => value !== undefined)) {
    return { ...base, total: 0, rows: [] }
  }
  const from = sql`${observationsFrom} JOIN ${projectionTable(catalog)} ON p.observation_id = o.id ${assignments}`
  const processFilters = recognized ? sql`true` : sql`
    ${exactEquals('exact_declare_kind', normalizeDeclareKind(filter.declareKind) ?? undefined)}
    AND ${exactEquals('exact_year', filter.year)} AND ${exactEquals('exact_status', filter.status)}`
  const scope = filter.rdjb ? scopeMatch(filter.rdjb) : sql`true`
  const batch = catalog.interface === 'business_list' ? exactEquals('exact_batch', filter.batch) : sql`true`
  const where = sql`WHERE c.interface = ${catalog.interface} AND ${isolated} AND ${enterpriseFilter(filter)}
    AND ${equals(sql`o.source_relation_key`, filter.platformKey)} AND ${exactEquals('exact_title_raw', filter.titleRaw)}
    AND ${processFilters} AND ${scope} AND ${batch}`
  const results = await rows<{ total: number }>(tx, sql`
    SELECT count(*)::double precision AS total ${from} ${where}`)
  const scopeSelection = catalog.interface === 'apply_list' ? sql.empty() : sql`, ${collectionScopes} AS "titleScopes"`
  const observations = await rows<{ titleScopes?: string[] }>(tx, sql`
    SELECT ${observationFields}, original.name_raw AS "nameRaw", original.uscc_raw AS "usccRaw",
      ${exactSelection(catalog.exact)} ${scopeSelection}
    ${from} ${aliases(sql`JOIN`)} ${originalAssignment} ${where}
    ORDER BY c.queried_at COLLATE "C" DESC, ra.old_id DESC LIMIT ${pageSize} OFFSET ${BigInt(offset)}`)
  return {
    ...base, total: results[0]!.total,
    rows: observations.map(row => ({
      kind: 'observation' as const, ...decodeExactFields(row, catalog.exact),
      ...(row.titleScopes && { titleScopes: orderedScopes(row.titleScopes) }),
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

export function readPostgresPlatformArchiveOptions(db: NodePgDatabase, { source, view }: PlatformFilterOptionsQuery) {
  const catalog = catalogs[source]
  return db.transaction(async tx => {
    await captureGate(tx, catalog)
    const result = { titles: [], declareKinds: [], years: [], statuses: [], batches: [], districts: [], validityDates: [] } as Record<keyof Options, unknown[]>
    const exact = view === 'isolated'
    const from = exact ? sql`${observationsFrom}
      JOIN ${projectionTable(catalog)} ON p.observation_id = o.id
      WHERE c.interface = ${catalog.interface} AND ${isolated}`
      : sql`FROM ${projectionTable(catalog)}
        JOIN business.platform_business_record_version v ON v.id = p.version_id
        JOIN business.platform_business_record b ON b.id = v.record_id WHERE b.interface = ${catalog.interface}`
    for (const [key, name] of Object.entries(exact ? catalog.exactOptions : catalog.options)) {
      const option = key as keyof Options
      const column = projectionColumn(name)
      if (!exact) {
        const value = option === 'years' ? sql`${column}::double precision` : sql`${column} COLLATE "C"`
        const where = option === 'years'
          ? sql`${column} BETWEEN 1 AND 9007199254740991`
          : sql`btrim(${column}) <> ''`
        const order = option === 'years' ? sql`DESC` : sql`ASC`
        result[option] = (await rows<{ value: unknown }>(tx, sql`
          SELECT DISTINCT ${value} AS value ${from} AND ${where} ORDER BY value ${order}`)).map(row => row.value)
        continue
      }
      const storage = projectionColumn(name + '_sqlite_storage')
      // SQLite trim() casts BLOBs to text for the empty check. Work on their
      // original bytes so arbitrary octets (including NUL) survive.
      const where = option === 'years' ? sql`${storage} IN ('integer', 'real')`
        : sql`(${storage} IN ('integer', 'real') OR encode(${column}, 'hex') !~ '^(20)*$')`
      const cells = await rows<ExactCell & Record<string, unknown>>(tx, sql`
        SELECT DISTINCT ${column} AS value, ${storage} AS storage
        ${from} AND ${column} IS NOT NULL AND ${where}`)
      if (option === 'years') {
        result.years = [...new Set(cells.map(exactValue)
          .filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0))]
          .sort((a, b) => b - a)
      } else {
        // SQLite DISTINCT treats equal INTEGER/REAL values as one candidate.
        cells.sort(compareExactCells)
        result[option] = cells
          .filter((cell, i) => i === 0 || compareExactCells(cells[i - 1]!, cell) !== 0)
          .map(exactValue)
      }
    }
    return result
  }, snapshot)
}

interface DetailObservation extends Record<string, unknown> {
  titleScopes?: string[]
  version: { titleRaw: string | null } | null
  identityState: string
  contentState: string
  keySource: string | null
  projectionRuleVersion: string | null
}

export function readPostgresPlatformArchiveDetail(db: NodePgDatabase, source: Source, recordId: number) {
  const catalog = catalogs[source]
  if (!Number.isSafeInteger(recordId) || recordId < 1) {
    fail(400, catalog.idCode, 'recordId must be a positive safe integer')
  }
  const scoped = catalog.interface !== 'apply_list'
  const recognized = catalog.interface === 'recognized_list'

  return db.transaction(async tx => {
    if (scoped) await captureGate(tx, catalog)
    const [record] = await rows(tx, sql`
      SELECT id::double precision AS id, platform_key AS "platformKey",
        identity_rule_version AS "identityRuleVersion", created_at AS "createdAt"
      FROM business.platform_business_record WHERE id = ${recordId} AND interface = ${catalog.interface}`)
    if (!record) fail(404, catalog.notFoundCode, catalog.notFoundMessage)
    if (!scoped) await captureGate(tx, catalog, recordId)

    const totals = (await rows<{ versions: number; observations: number }>(tx, sql`
      SELECT (SELECT count(*)::double precision FROM business.platform_business_record_version WHERE record_id = ${recordId}) AS versions,
        (SELECT count(*)::double precision FROM business.platform_business_observation WHERE record_id = ${recordId}) AS observations`))[0]!
    const versionScopes = scoped ? sql`, ${scopeArray(sql`
      SELECT DISTINCT c.id, c.rdjb ${observationsFrom} WHERE o.version_id = v.id`)} AS "titleScopes"` : sql.empty()
    const versions = await rows<{ titleScopes?: string[] }>(tx, sql`
      SELECT ${versionSelection(catalog, sql`v.id`)}, v.hash_algorithm AS "hashAlgorithm",
        v.content_hash AS "contentHash", v.created_at AS "createdAt", stats.*
        ${versionScopes}
      FROM (SELECT id, hash_algorithm, content_hash, created_at
        FROM business.platform_business_record_version WHERE record_id = ${recordId}
        ORDER BY id DESC LIMIT ${catalog.limits.versions}) v
      LEFT JOIN ${projectionTable(catalog)} ON p.version_id = v.id
      CROSS JOIN LATERAL (
        SELECT count(*)::double precision AS "observationCount", min(c.queried_at COLLATE "C") AS "firstObservedAt",
          max(coalesce(c.last_collected_at, c.queried_at) COLLATE "C") AS "lastObservedAt"
        ${observationsFrom} WHERE o.record_id = ${recordId} AND o.version_id = v.id
      ) stats
      ORDER BY v.id DESC`)

    const scopedFields = scoped ? sql`,
      ${collectionScopes} AS "titleScopes",
      coalesce((SELECT json_agg(json_build_object('id', r.id, 'status', r.status, 'revision', r.revision) ORDER BY r.id)
        FROM business.record_correspondence r WHERE r.observation_id = o.id), '[]'::json) AS "correspondenceRefs"` : sql.empty()
    const observations = await rows<DetailObservation>(tx, sql`
      SELECT ${observationFields}, o.key_source AS "keySource", o.projection_rule_version AS "projectionRuleVersion",
        o.version_id::double precision AS "versionId",
        CASE WHEN o.version_id IS NOT NULL
          THEN (SELECT row_to_json(fields) FROM (SELECT ${versionSelection(catalog, sql`o.version_id`)}) fields)
        END AS version ${scopedFields}
      ${observationsFrom} ${aliases(sql`JOIN`)} ${assignments}
      LEFT JOIN ${projectionTable(catalog)} ON p.version_id = o.version_id AND p.record_id = o.record_id
      WHERE o.record_id = ${recordId}
      ORDER BY c.queried_at COLLATE "C" DESC, ra.old_id DESC LIMIT ${catalog.limits.observations}`)

    const detailObservations = observations.map(row => {
      if (row.identityState === 'not_indexed' || row.contentState === 'not_indexed'
        || row.keySource === null || row.projectionRuleVersion === null) {
        fail(409, catalog.notIndexedCode, catalog.notIndexedMessage)
      }
      if (row.titleScopes) row.titleScopes = orderedScopes(row.titleScopes)
      if (!recognized) return row
      const title = row.version?.titleRaw
      const scopes = row.titleScopes ?? []
      return { ...row, titleConflict: !!title && ['1', '2', '3'].includes(title) && scopes.length > 0 && !scopes.includes(title) }
    })
    const summary = recognized ? (await rows<RecordConflicts>(tx, sql`
      SELECT summary.* FROM business.platform_business_record b
      CROSS JOIN LATERAL (WITH owners AS (${owners}) SELECT ${recordConflictFields(catalog)}) summary
      WHERE b.id = ${recordId}`))[0] : undefined

    return {
      record: { ...record, interface: catalog.interface },
      versions: versions.map(row => row.titleScopes ? { ...row, titleScopes: orderedScopes(row.titleScopes) } : row),
      observations: detailObservations,
      counts: {
        ...totals, versionsTruncated: totals.versions > versions.length,
        observationsTruncated: totals.observations > observations.length,
      },
      ...(summary && { conflicts: summaryConflicts(summary) }),
    }
  }, snapshot)
}
