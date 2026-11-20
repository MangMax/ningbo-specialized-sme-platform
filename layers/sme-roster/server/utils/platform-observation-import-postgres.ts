import { createHash } from 'node:crypto'
import { getTableName, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { platformApplyProjection, platformBusinessProjection, platformRecognizedProjection } from '../../../../db/schema'
import type { PlatformProjectionResult } from '../../lib/platform/business-record'
import { legacyFingerprintRaw } from '../../lib/platform/legacy-fingerprint-raw'
import { materializedText } from '../../lib/platform/apply-materialization'
import { canonicalPlatformJson, PLATFORM_PROJECTION_RULE, PLATFORM_RAW_HASH_RULE, planPlatformObservation } from '../../lib/platform/observation-plan'
import { writePostgresArchiveValue } from '../../lib/platform/postgres-archive-write'
import { ensurePostgresObservationContent } from '../../lib/platform/postgres-observation-write'
import { snapshotSchema } from '../../lib/platform/target-evidence-read'
import type { RosterImportPlatformQuery, RosterImportRelation } from '../../lib/roster-import-client'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { applyProjectionPreview, businessProjectionPreview, PlatformProjectionError, recognizedProjectionPreview } from './platform-business-record'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Source = RosterImportPlatformQuery['interface']
type ArchivedObservation = Pick<PlatformProjectionResult, 'recordId' | 'versionId'> & {
  id: number; collectionId: number; queryId: number | null; sequenceNo: number; source: Source; sourceRelationKey: string | null
  queryKey: string; rdjb: string; queriedAt: string; indexedAt: string | null; batchId: number | null
  identityState: PlatformProjectionResult['identityState'] | 'not_indexed'
  contentState: PlatformProjectionResult['contentState'] | 'not_indexed'
  keySource: PlatformProjectionResult['keySource'] | null
  projectionRuleVersion: string | null; inputFingerprint: string | null; scheme: string | null; basisId: number | null; pageValid: boolean
}
type Archive = { id: number; storageClass: 'null' | 'blob' | 'text'; bytes: Buffer | null; byteLength: number | null; sha256: string | null }
const projectionTables = {
  apply_list: platformApplyProjection, business_list: platformBusinessProjection, recognized_list: platformRecognizedProjection,
} as const
const previewKeys = {
  apply_list: ['titleRaw', 'declareKind', 'declarationYear', 'appliedAt', 'status', 'nameRaw', 'usccRaw', 'ruleVersion'],
  business_list: ['titleRaw', 'declareKind', 'businessYear', 'appliedAt', 'status', 'batch', 'awardBatchLabel', 'province', 'nameRaw', 'usccRaw', 'ruleVersion'],
  recognized_list: ['titleRaw', 'validityDateRaw', 'maintenanceYear', 'maintenanceBatch', 'district', 'awardNote', 'nameRaw', 'usccRaw', 'ruleVersion'],
} as const
const projectionNames = {
  apply_list: 'applyProjection', business_list: 'businessProjection', recognized_list: 'recognizedProjection',
} as const
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const decode = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)

function checkedArchive(archive: Archive | undefined, storage?: Archive['storageClass']) {
  if (!archive || (storage && archive.storageClass !== storage) || (archive.storageClass === 'null'
    ? archive.bytes !== null || archive.byteLength !== null || archive.sha256 !== null
    : !archive.bytes || archive.byteLength !== archive.bytes.length || archive.sha256 !== hash(archive.bytes))) {
    throw new PlatformProjectionError('projection_source_drift', 'Original archive bytes or owner differ')
  }
  return archive
}

function previewFields(plan: ReturnType<typeof planPlatformObservation>) {
  const apply = applyProjectionPreview(plan)
  const business = businessProjectionPreview(plan)
  const recognized = recognizedProjectionPreview(plan)
  return { ...(apply ? { applyProjection: apply } : {}), ...(business ? { businessProjection: business } : {}),
    ...(recognized ? { recognizedProjection: recognized } : {}) }
}

async function inspectObservation(tx: Tx, relationId: number, options: { expected?: string; allowMissingVersionProjection?: boolean }) {
  const { expected, allowMissingVersionProjection } = options
  const { rows: [row] } = await tx.execute<ArchivedObservation>(sql`
    SELECT o.id::float8 AS id,c.id::float8 AS "collectionId",q.old_id::float8 AS "queryId",o.sequence_no::float8 AS "sequenceNo",
      c.interface AS source,c.query_key AS "queryKey",c.rdjb,c.queried_at AS "queriedAt",o.source_relation_key AS "sourceRelationKey",
      o.identity_state AS "identityState",o.content_state AS "contentState",o.key_source AS "keySource",
      o.record_id::float8 AS "recordId",o.version_id::float8 AS "versionId",o.projection_rule_version AS "projectionRuleVersion",
      o.input_fingerprint AS "inputFingerprint",o.indexed_at AS "indexedAt",o.batch_id::float8 AS "batchId",
      b.scheme,b.input_archive_id::float8 AS "basisId",
      CASE WHEN o.page_id IS NULL THEN o.page_row_no IS NULL ELSE EXISTS (
        SELECT 1 FROM platform_collection_page p WHERE p.id=o.page_id AND p.collection_id=o.collection_id
          AND (o.page_row_no IS NULL OR (o.page_row_no > 0 AND o.sequence_no=p.sequence_start+o.page_row_no-1 AND o.sequence_no<=p.sequence_end))
      ) END AS "pageValid"
    FROM platform_legacy_relation_alias a JOIN platform_business_observation o ON o.id=a.observation_id
    JOIN platform_collection c ON c.id=o.collection_id
    LEFT JOIN platform_legacy_query_alias q ON q.collection_id=c.id
    LEFT JOIN platform_observation_fingerprint_basis b ON b.observation_id=o.id WHERE a.old_id=${relationId}`)
  if (!row) throw new PlatformProjectionError('projection_source_missing', 'Original relation ' + relationId + ' not found')
  const drift = (message: string): never => { throw new PlatformProjectionError('projection_source_drift', message) }
  const mapping = (message: string): never => { throw new PlatformProjectionError('projection_mapping_conflict', message) }
  if (row.queryId === null || !row.pageValid) drift('Original query alias or page coordinate differs')
  const indexed = row.identityState !== 'not_indexed'
  if (!indexed && (row.contentState !== 'not_indexed' ||
    [row.recordId, row.versionId, row.keySource, row.projectionRuleVersion, row.inputFingerprint, row.indexedAt, row.batchId, row.scheme].some(value => value !== null))) {
    mapping('Invalid paired not_indexed observation')
  }

  const { rows: archives } = await tx.execute<Archive & { field: string }>(sql`
    SELECT r.field,a.id::float8 AS id,a.storage_class AS "storageClass",a.bytes,a.byte_length::float8 AS "byteLength",a.sha256
    FROM platform_observation_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id
    WHERE r.owner_id=${row.id} AND r.sealed=1
    UNION ALL
    SELECT 'basis',a.id::float8,a.storage_class,a.bytes,a.byte_length::float8,a.sha256
    FROM platform_archive_value a WHERE a.id=${row.basisId}
      AND NOT EXISTS(SELECT 1 FROM platform_collection_archive_ref WHERE archive_id=a.id)
      AND NOT EXISTS(SELECT 1 FROM platform_observation_archive_ref WHERE archive_id=a.id)
      AND NOT EXISTS(SELECT 1 FROM platform_version_archive_ref WHERE archive_id=a.id)`)
  const originals = new Map(archives.map(archive => [archive.field, archive]))
  const raw = checkedArchive(originals.get('rawFields'))
  const sourceText = checkedArchive(originals.get('sourceText'))
  const snapshot = checkedArchive(originals.get('legacyRowSnapshot'), 'blob')
  const { rawFields, bytes } = (() => {
    try {
      const cells = snapshotSchema.parse(JSON.parse(decode(snapshot.bytes!))).fields
      const byName = new Map(cells.map(cell => [cell.name, cell]))
      if (byName.size !== cells.length) return drift('Duplicate original relation cell')
      const cell = (name: string) => byName.get(name) ?? drift('Missing original relation cell ' + name)
      for (const [name, coordinate] of [['id', relationId], ['query_id', row.queryId], ['sequence_no', row.sequenceNo]] as const) {
        if (cell(name).storageClass !== 'integer' || Buffer.from(cell(name).hex, 'hex').toString() !== String(coordinate)) {
          return drift('Original relation coordinate differs')
        }
      }
      const verifyCell = (name: string, storageClass: Archive['storageClass'], bytes: Buffer | null) => {
        if (cell(name).storageClass !== storageClass || (bytes?.toString('hex') ?? '') !== cell(name).hex.toLowerCase()) {
          drift('Original relation bytes differ')
        }
      }
      verifyCell('raw_fields', raw.storageClass, raw.bytes)
      const commandScheme = row.scheme === 'target-command-v1'
      if (commandScheme) {
        // The command archive keeps the exact input. The legacy cell snapshot models materialized text.
        const materialized = materializedText(sourceText.bytes?.toString('utf8'))
        verifyCell('source_text', materialized === null ? 'null' : 'text', materialized === null ? null : Buffer.from(materialized))
      } else {
        verifyCell('source_text', sourceText.storageClass, sourceText.bytes)
      }
      const key = cell('relation_key')
      const originalKey = key.storageClass === 'null' ? null : key.storageClass === 'text'
        ? decode(Buffer.from(key.hex, 'hex')) : drift('Invalid original key cell')
      if (originalKey !== (commandScheme ? materializedText(row.sourceRelationKey) : row.sourceRelationKey)) return drift('Original relation key differs')
      const legacy = legacyFingerprintRaw(raw)

      if (!indexed || row.scheme === 'legacy-indexed-v1' || row.scheme === 'legacy-bootstrap-v1') {
        const bytes = Buffer.from(canonicalPlatformJson({
          interface: row.source, relationKey: originalKey, queryId: row.queryId, sequenceNo: row.sequenceNo,
          queryKey: row.queryKey, rdjb: row.rdjb, queriedAt: row.queriedAt, ...legacy,
        }))
        if (indexed && !checkedArchive(originals.get('basis'), 'blob').bytes!.equals(bytes)) return drift('Original legacy fingerprint input differs')
        return { rawFields: legacy.rawFields, bytes }
      }
      if (row.scheme !== 'target-command-v1') return drift('Original fingerprint input was never captured')
      const bytes = checkedArchive(originals.get('basis'), 'blob').bytes!
      const command = JSON.parse(decode(bytes)) as { collectionId: number; position: { sequenceNo: number }; row: RosterImportRelation; batchId?: number }
      const commandKey = row.source === 'recognized_list' ? command.row.relationKey ?? null
        : materializedText(command.row.relationKey)
      if (!Buffer.from(canonicalPlatformJson(command)).equals(bytes) || command.collectionId !== row.collectionId ||
        command.position.sequenceNo !== row.sequenceNo || command.row.sequenceNo !== row.sequenceNo ||
        (command.batchId ?? null) !== row.batchId || (commandKey ?? null) !== row.sourceRelationKey ||
        canonicalPlatformJson(command.row.rawFields ?? null) !== canonicalPlatformJson(legacy.rawFields) ||
        (command.row.sourceText ?? null) !== (sourceText.bytes?.toString('utf8') ?? null)) {
        return drift('Original command fingerprint input differs')
      }
      return { rawFields: legacy.rawFields, bytes }
    } catch (error) {
      if (error instanceof PlatformProjectionError) throw error
      return drift('Invalid original relation or fingerprint bytes')
    }
  })()
  const inputFingerprint = hash(bytes)
  if (expected !== undefined && expected !== inputFingerprint) drift('Original relation ' + relationId + ' changed since preflight')
  if (indexed && (row.inputFingerprint !== inputFingerprint || row.projectionRuleVersion !== PLATFORM_PROJECTION_RULE || !row.indexedAt)) {
    drift('Original observation fingerprint or rule differs')
  }

  const plan = planPlatformObservation({ interface: row.source, relationKey: row.sourceRelationKey, rawFields })
  const fields = previewFields(plan)
  const typed = fields.applyProjection ?? fields.businessProjection ?? fields.recognizedProjection
  const table = projectionTables[row.source]
  const name = sql.identifier(getTableName(table))
  const { rows: [observed] } = await tx.execute<{ value: Record<string, unknown> }>(sql`
    SELECT ${postgresRosterRow(table, 'p')} AS value FROM ${name} p
    WHERE p.observation_id=${row.id} AND p.source_archive_id=${raw.id}`)
  if (!observed) throw new PlatformProjectionError('projection_missing', 'Original observation source-fidelity projection missing')

  let versionProjectionMissing = false
  if (indexed) {
    if (row.identityState !== plan.identityState || row.contentState !== plan.contentState || row.keySource !== plan.keySource) {
      mapping('Original indexed observation state differs')
    }
    if (plan.platformKey !== null) {
      const { rows: [record] } = await tx.execute(sql`
        SELECT 1 FROM platform_business_record WHERE id=${row.recordId} AND interface=${row.source}
          AND platform_key=${plan.platformKey} AND identity_rule_version=${PLATFORM_PROJECTION_RULE}`)
      if (!record) mapping('Original record owner differs')
    } else if (row.recordId !== null) mapping('Unexpected original record owner')

    if (plan.canonicalRawJson !== null && typed) {
      const { rows: [version] } = await tx.execute<Archive & { projection: Record<string, unknown> | null }>(sql`
        SELECT a.id::float8 AS id,a.storage_class AS "storageClass",a.bytes,a.byte_length::float8 AS "byteLength",a.sha256,
          CASE WHEN p.id IS NOT NULL THEN ${postgresRosterRow(table, 'p')} ELSE NULL END AS projection
        FROM platform_business_record_version v
        JOIN platform_version_archive_ref r ON r.owner_id=v.id AND r.archive_id=v.canonical_archive_id AND r.field='canonicalRawJson' AND r.sealed=1
        JOIN platform_archive_value a ON a.id=r.archive_id
        LEFT JOIN ${name} p ON p.version_id=v.id AND p.record_id=v.record_id
        WHERE v.id=${row.versionId} AND v.record_id=${row.recordId} AND v.hash_algorithm=${PLATFORM_RAW_HASH_RULE}
          AND v.content_hash=${plan.contentHash} AND v.canonical_raw_json=${plan.canonicalRawJson}`)
      if (!version || !checkedArchive(version, 'text').bytes!.equals(Buffer.from(plan.canonicalRawJson))) mapping('Original version owner or archive differs')
      const projection = version?.projection
      versionProjectionMissing = projection == null
      if (versionProjectionMissing && !allowMissingVersionProjection) {
        throw new PlatformProjectionError('projection_missing', 'Original version projection missing')
      }
      if (projection && Object.entries(typed).some(([key, value]) => projection[key] !== value)) mapping('Original version projection differs')
    } else if (row.versionId !== null) mapping('Unexpected original version owner')
  }

  const fingerprint = { relationId, identityState: plan.identityState, contentState: plan.contentState, keySource: plan.keySource,
    projectionRuleVersion: PLATFORM_PROJECTION_RULE, inputFingerprint }
  const historicalPreview = { ...fingerprint, ...fields }
  const observationPreview = { relationId, identityState: plan.identityState, contentState: plan.contentState, keySource: plan.keySource,
    [projectionNames[row.source]]: Object.fromEntries(previewKeys[row.source].map(key => [key, observed.value[key]])) }
  return { row, indexed, plan, fingerprint, bytes, historicalPreview, observationPreview, versionProjectionMissing }
}

export async function planPostgresHistoricalObservation(tx: Tx, relationId: number, expected?: string) {
  return (await inspectObservation(tx, relationId, { expected })).historicalPreview
}

export async function previewPostgresArchivedObservation(tx: Tx, relationId: number) {
  return (await inspectObservation(tx, relationId, { allowMissingVersionProjection: true })).observationPreview
}

type ImportMode = { kind: 'reference' | 'replay' } | { kind: 'historical'; batchId: number; expected: string }

export class ArchivedObservationWriteError extends PlatformProjectionError {
  constructor(readonly relationId: number, readonly kind: 'platform_observation' | 'platform_relation', error: PlatformProjectionError) {
    super(error.code, error.message)
  }
}

export async function writePostgresArchivedObservation(tx: Tx, relationId: number, mode: ImportMode): Promise<PlatformProjectionResult | null> {
  const sync = mode.kind !== 'reference'
  try {
    const { row, indexed, plan, fingerprint, bytes, versionProjectionMissing } = await inspectObservation(tx, relationId,
      mode.kind === 'historical' ? { expected: mode.expected } : { allowMissingVersionProjection: true })
    if (!indexed && !sync) return null

    const now = new Date().toISOString()
    const content = !indexed || (sync && versionProjectionMissing)
      ? await ensurePostgresObservationContent(tx, row.source, plan, now)
      : { recordId: row.recordId, versionId: row.versionId, recordCreated: false, versionCreated: false, projectionCreated: false }
    if (!indexed) {
      const archive = await writePostgresArchiveValue(tx, bytes, null)
      const batchId = mode.kind === 'historical' ? mode.batchId : null
      await tx.execute(sql`INSERT INTO platform_observation_fingerprint_basis(observation_id,scheme,input_archive_id)
        VALUES(${row.id},'legacy-bootstrap-v1',${archive.id})`)
      await tx.execute(sql`UPDATE platform_business_observation SET record_id=${content.recordId},version_id=${content.versionId},
        identity_state=${plan.identityState},content_state=${plan.contentState},key_source=${plan.keySource},
        projection_rule_version=${PLATFORM_PROJECTION_RULE},input_fingerprint=${fingerprint.inputFingerprint},indexed_at=${now},batch_id=${batchId}
        WHERE id=${row.id}`)
    }

    const { projectionCreated, ...values } = content
    const prefix = row.source === 'apply_list' ? 'apply' : row.source === 'business_list' ? 'business' : 'recognized'
    return { ...fingerprint, ...values, observationCreated: !indexed,
      ...(sync ? { syncRequested: true, ...(values.versionId === null ? {} :
        { [prefix + 'ProjectionCreated']: projectionCreated, [prefix + 'ProjectionReused']: !projectionCreated }) } : {}) }
  } catch (error) {
    const kind = mode.kind === 'historical' ? 'platform_observation' : 'platform_relation'
    if (error instanceof PlatformProjectionError) throw new ArchivedObservationWriteError(relationId, kind, error)
    if (error instanceof Error && ['projection_rule_conflict', 'platform_content_hash_conflict', 'platform_projection_conflict'].includes(error.message)) {
      throw new ArchivedObservationWriteError(relationId, kind, new PlatformProjectionError(error.message, error.message))
    }
    throw error
  }
}
