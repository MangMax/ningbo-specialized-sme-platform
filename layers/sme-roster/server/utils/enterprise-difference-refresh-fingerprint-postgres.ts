import { and, desc, eq, getTableColumns, gt, inArray, isNotNull, notExists, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise, enterpriseAlias } from '../../../../db/postgresql/enterprise-tables'
import { record, recordEvidence, recordEvent } from '../../../../db/postgresql/ledger-tables'
import { platformCollectionArchiveRef as collectionRef, platformArchiveValue as archive,
  platformObservationArchiveRef as observationRef } from '../../../../db/postgresql/platform-archive-tables'
import { platformApplyProjection, platformBusinessProjection, platformRecognizedProjection,
  platformBusinessObservation as observation, platformCollection as collection, platformLegacyQueryAlias as queryAlias,
  platformLegacyRelationAlias as relationAlias, platformObservationAssignment as assignment } from '../../../../db/postgresql/platform-tables'
import { recordCorrespondence as correspondence } from '../../../../db/postgresql/qualification-tables'
import { refreshMetadataKeys, refreshRelationFields, refreshSourceKeys } from '../../lib/platform/difference-hash-keys'
import { snapshotSchema } from '../../lib/platform/evidence-snapshot-model'
import { CURRENT_TITLES } from '../../lib/roster/current-titles'
import type { PostgresQualificationTransaction } from '../../lib/roster/current-qualification-postgres'
import { hashRefreshInputs, projectRefreshObservation, refreshProjectionColumns } from './enterprise-difference-refresh-contract'

type Tx = PostgresQualificationTransaction
type Collection = Parameters<typeof projectRefreshObservation>[0]
type Material = Record<string, unknown>

// SQLite JSON paths take the first occurrence of a key. Keep JSON token
// values intact for the existing JS number, string and nested object handling.
function firstJsonFields(document: SQL, keys: readonly string[]) {
  return sql`
    SELECT DISTINCT ON (key COLLATE "C") key, value
    FROM json_each(CASE WHEN json_typeof(${document})='object' THEN ${document} ELSE '{}'::json END)
      WITH ORDINALITY fields(key, value, ordinal)
    WHERE key COLLATE "C"=ANY(${sql.param(keys)}::text[])
    ORDER BY key COLLATE "C", ordinal`
}

// json_each decodes strings as it scans, including fields we discard. Quote
// escapes PostgreSQL text cannot represent, along with literal backslashes
// that could be mistaken for the quoting, before projecting raw JSON tokens.
function jsonProjectionInput(tx: Tx, value: SQL) {
  const raw = sql`source_json.raw`
  const codeUnit = 'u(?:0000|[dD][89a-fA-F][0-9a-fA-F]{2})'
  const unsafeEscape = String.raw`\\${codeUnit}`
  const tokens = String.raw`\\\\|\\(${codeUnit})`
  const replacement = String.raw`\\\\|\1|`
  return tx.select({
    raw: sql<string | null>`${raw}`.as('raw'),
    document: sql`CASE WHEN ${raw} IS JSON THEN
      CASE WHEN ${raw} ~ ${unsafeEscape} THEN regexp_replace(${raw}, ${tokens}, ${replacement}, 'g')::json
        ELSE ${raw}::json END
      END`.as('document'),
    quoted: sql<boolean | null>`${raw} ~ ${unsafeEscape}`.as('quoted'),
    // A lateral VALUES row names the bytea conversion without reading another table.
    // Drizzle 0.45.4 has no VALUES relation builder.
  }).from(sql`(values (${value})) as source_json(raw)`).as('input')
}

function restoreJsonEscapes(text: string, quoted: boolean | null) {
  return quoted ? text.replace(/\\\\\|(u[0-9a-fA-F]{4})?\|/g, (_, escape: string | undefined) => escape ? '\\' + escape : '\\\\') : text
}

function archiveJsonText(bytes: SQL) {
  return sql`CASE WHEN position(decode('00','hex') in ${bytes})>0 THEN '{' ELSE convert_from(${bytes},'UTF8') END`
}

function relationMaterial(snapshot: unknown, match_basis: string | null, verification_status: string, business: string | null, quoted: boolean | null) {
  const cells = new Map(snapshotSchema.parse(snapshot).fields.map(cell => [cell.name, cell]))
  const original = (name: string) => {
    const cell = cells.get(name)
    if (!cell || cell.storageClass === 'null') return null
    const value = Buffer.from(cell.hex, 'hex').toString('utf8')
    if (cell.storageClass === 'integer' || cell.storageClass === 'real') return Number(value)
    if (cell.storageClass === 'blob') throw new Error('Difference refresh cannot hash a binary relation field')
    return value
  }
  const fields = { ...Object.fromEntries(refreshRelationFields.map(name => [name, original(name)])), match_basis, verification_status }
  if (business === null) return fields
  if (business === '{') return { ...fields, sourceBusinessMalformed: true }
  return { ...fields, sourceBusiness: JSON.parse(restoreJsonEscapes(business, quoted)) }
}

async function readPlatformMaterials(tx: Tx, enterpriseIds: readonly number[]) {
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
  }).from(candidates).innerJoin(collection, eq(collection.id, candidates.id)).innerJoin(queryAlias, eq(queryAlias.collectionId, collection.id)))
  const rows = (await tx.with(keys, candidates, latest).select({
    owner: latest.owner, id: latest.id, interface: latest.interface, queryKey: latest.queryKey,
    rdjb: latest.rdjb, titleCode: latest.titleCode, queriedAt: latest.queriedAt, status: latest.status,
  }).from(latest).where(eq(latest.rank, 1))).map(({ owner, ...material }) => ({ owner, collection: material as Collection }))
  const collectionIds = [...new Set(rows.map(row => row.collection.id))]
  if (!collectionIds.length) return new Map<number, { titleCode: string | null; material: Material }[]>()
  // Keep the selected IDs in one bound array for large observation histories.
  const selected = sql`${sql.param(collectionIds)}::bigint[]`
  // These lateral SQL projections retain JSON token order and first duplicate keys.
  // Drizzle 0.45.4 has no builders for JSON set-returning functions with ordinality,
  // bytea decoding or JSON token validation. Only selected fields leave PostgreSQL.
  const snapshot = sql`convert_from(${archive.bytes}, 'UTF8')::json`
  const current = tx.select({ matchBasis: assignment.matchBasis, verificationStatus: assignment.verificationStatus })
    .from(assignment).where(eq(assignment.observationId, observation.id)).orderBy(desc(assignment.revision)).limit(1).as('current_assignment')
  const cells = tx.select({
    selected: sql`json_agg(json_build_object('name',cell->>'name','storageClass',cell->>'storageClass','hex',cell->>'hex')
      ORDER BY ordinal) FILTER (WHERE cell->>'name'=ANY(${sql.param(refreshRelationFields)}::text[]))`.as('selected'),
    archiveBytes: sql`decode(max(cell->>'hex') FILTER
      (WHERE cell->>'name'='raw_fields' AND cell->>'storageClass'<>'null'),'hex')`.as('archive_bytes'),
  }).from(sql`json_array_elements(${snapshot}->'fields') WITH ORDINALITY entries(cell, ordinal)`).as('cells')
  const input = jsonProjectionInput(tx, archiveJsonText(sql`${cells.archiveBytes}`))
  const businessProjection = tx.select({ json: sql`coalesce(json_object_agg(key,value),'{}'::json)::text` })
    .from(sql`(${firstJsonFields(sql`${input.document}`, refreshSourceKeys)}) fields`)
  const sources = await tx.select({
    collectionId: observation.collectionId, match_basis: current.matchBasis, verification_status: current.verificationStatus,
    snapshot: sql<unknown>`json_build_object('encoding',${snapshot}->>'encoding','fields',coalesce(${cells.selected},'[]'::json))`,
    business: sql<string | null>`CASE WHEN ${input.raw} IS NULL THEN NULL
      WHEN ${input.document} IS NULL OR json_typeof(${input.document})='null' THEN '{'
      ELSE ${businessProjection} END`,
    quoted: input.quoted,
  }).from(observation).innerJoin(relationAlias, eq(relationAlias.observationId, observation.id))
    .innerJoin(observationRef, and(eq(observationRef.ownerId, observation.id), eq(observationRef.field, 'legacyRowSnapshot')))
    .innerJoin(archive, eq(archive.id, observationRef.archiveId)).innerJoinLateral(current, sql`true`)
    .crossJoinLateral(cells).crossJoinLateral(input)
    .where(sql`${observation.collectionId} = any(${selected})`)
  const relations = Map.groupBy(sources.map(row => ({
    collectionId: row.collectionId, material: relationMaterial(row.snapshot, row.match_basis, row.verification_status, row.business, row.quoted),
  })), row => row.collectionId)
  const metadataInput = jsonProjectionInput(tx, archiveJsonText(sql`${archive.bytes}`))
  const metadataPages = tx.select({ json: sql`coalesce(json_agg(CASE WHEN json_typeof(page)='null' THEN page
    ELSE json_build_object('rdjb',page->'rdjb','status',page->'status','declaredTotal',page->'declaredTotal') END
    ORDER BY ordinal),'[]'::json)` }).from(sql`json_array_elements(value) WITH ORDINALITY pages(page, ordinal)`)
  const metadataProjection = tx.select({ json: sql`coalesce(json_object_agg(key,
    CASE WHEN key='pages' THEN CASE WHEN json_typeof(value)='array' THEN ${metadataPages}
      ELSE 'null'::json END ELSE value END),'{}'::json)::text` })
    .from(sql`(${firstJsonFields(sql`${metadataInput.document}`, refreshMetadataKeys)}) fields`)
  const metadataRows = await tx.select({
    collectionId: collectionRef.ownerId,
    quoted: metadataInput.quoted,
    metadata: sql<string | null>`CASE WHEN ${archive.storageClass}='null' THEN NULL
      WHEN ${metadataInput.document} IS NULL THEN '{' WHEN json_typeof(${metadataInput.document})='null' THEN 'null'
      ELSE ${metadataProjection} END`,
  }).from(collectionRef).innerJoin(archive, eq(archive.id, collectionRef.archiveId))
    .crossJoinLateral(metadataInput)
    .where(and(sql`${collectionRef.ownerId} = any(${selected})`, eq(collectionRef.field, 'collectionEvidence')))
  const metadata = new Map(metadataRows.map(row => [row.collectionId,
    row.metadata === null ? null : restoreJsonEscapes(row.metadata, row.quoted)]))
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
      .innerJoin(table, eq(table.versionId, observation.versionId)).where(sql`${observation.collectionId} = any(${selected})`)
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

export async function readPostgresRefreshFingerprints(tx: Tx, enterpriseIds: readonly number[]) {
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
  const platform = await readPlatformMaterials(tx, enterpriseIds)
  return enterprises.map(({ id, enterprise }) => ({
    subject: { id, ...enterprise },
    fingerprints: new Map(CURRENT_TITLES.map(title => {
      const key = id + ':' + title
      const fingerprint = hashRefreshInputs({ enterprise, aliases: (aliasesByOwner.get(id) ?? []).map(row => row.material),
        formal: (formalByTitle.get(key) ?? []).map(row => row.material),
        evidence: (evidenceByTitle.get(key) ?? []).map(row => row.material),
        correspondences: (correspondenceByTitle.get(key) ?? []).map(row => row.material),
        observations: (platform.get(id) ?? []).filter(row => row.titleCode === null || row.titleCode === title).map(row => row.material),
      })
      return [title, fingerprint]
    })),
  }))
}
