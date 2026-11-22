import { createHash } from 'node:crypto'
import { and, eq, getTableColumns, gt, isNull, lte, notExists, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  platformApplyProjection, platformBusinessObservation, platformBusinessProjection, platformBusinessRecord, platformBusinessRecordVersion,
  platformCollection, platformCollectionPage, platformLegacyQueryAlias, platformLegacyRelationAlias,
  platformObservationFingerprintBasis, platformRecognizedProjection,
} from '../../../../db/postgresql/platform-tables'
import {
  platformArchiveValue, platformCollectionArchiveRef, platformObservationArchiveRef, platformVersionArchiveRef,
} from '../../../../db/postgresql/platform-archive-tables'
import type { PlatformProjectionResult } from '../../lib/platform/business-record'
import { legacyFingerprintRaw } from '../../lib/platform/legacy-fingerprint-raw'
import { materializedText } from '../../lib/platform/apply-materialization'
import { canonicalPlatformJson, PLATFORM_PROJECTION_RULE, PLATFORM_RAW_HASH_RULE, planPlatformObservation } from '../../lib/platform/observation-plan'
import { ensurePostgresObservationContent } from '../../lib/platform/postgres-observation-write'
import { snapshotSchema } from '../../lib/platform/evidence-snapshot-model'
import { postgresObservationSnapshot } from '../../lib/platform/postgres-observation-snapshot'
import type { RosterImportPlatformQuery, RosterImportRelation } from '../../lib/roster-import-client'
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
type ObservationArchive = Archive & { snapshotBytes: Buffer | null }
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
  const o = platformBusinessObservation
  const c = platformCollection
  const q = platformLegacyQueryAlias
  const b = platformObservationFingerprintBasis
  const p = platformCollectionPage
  const a = platformLegacyRelationAlias
  // Drizzle has no CASE or bigint arithmetic builder for the archived page coordinate.
  const [row] = await tx.select({
    id: o.id, collectionId: c.id, queryId: q.oldId, sequenceNo: o.sequenceNo, source: c.interface,
    queryKey: c.queryKey, rdjb: c.rdjb, queriedAt: c.queriedAt, sourceRelationKey: o.sourceRelationKey,
    identityState: o.identityState, contentState: o.contentState, keySource: o.keySource, recordId: o.recordId,
    versionId: o.versionId, projectionRuleVersion: o.projectionRuleVersion, inputFingerprint: o.inputFingerprint,
    indexedAt: o.indexedAt, batchId: o.batchId, scheme: b.scheme, basisId: b.inputArchiveId,
    pageValid: sql<boolean>`case when ${isNull(o.pageId)} then ${isNull(o.pageRowNo)} else ${p.id} is not null end`,
  }).from(a).innerJoin(o, eq(o.id, a.observationId)).innerJoin(c, eq(c.id, o.collectionId))
    .leftJoin(q, eq(q.collectionId, c.id)).leftJoin(b, eq(b.observationId, o.id))
    .leftJoin(p, and(eq(p.id, o.pageId), eq(p.collectionId, o.collectionId), or(isNull(o.pageRowNo),
      and(gt(o.pageRowNo, 0), eq(o.sequenceNo, sql`${p.sequenceStart} + ${o.pageRowNo} - 1`),
        lte(o.sequenceNo, p.sequenceEnd)))))
    .where(eq(a.oldId, relationId)) as ArchivedObservation[]
  if (!row) throw new PlatformProjectionError('projection_source_missing', 'Original relation ' + relationId + ' not found')
  const drift = (message: string): never => { throw new PlatformProjectionError('projection_source_drift', message) }
  const mapping = (message: string): never => { throw new PlatformProjectionError('projection_mapping_conflict', message) }
  if (row.queryId === null || !row.pageValid) drift('Original query alias or page coordinate differs')
  const indexed = row.identityState !== 'not_indexed'
  if (!indexed && (row.contentState !== 'not_indexed' ||
    [row.recordId, row.versionId, row.keySource, row.projectionRuleVersion, row.inputFingerprint, row.indexedAt, row.batchId, row.scheme].some(value => value !== null))) {
    mapping('Invalid paired not_indexed observation')
  }

  const value = platformArchiveValue
  const archived = { id: value.id, storageClass: value.storageClass, bytes: value.bytes, byteLength: value.byteLength, sha256: value.sha256 }
  const refs = platformObservationArchiveRef
  const unreferenced = [platformCollectionArchiveRef, platformObservationArchiveRef, platformVersionArchiveRef]
    .map(ref => notExists(tx.select({ id: ref.archiveId }).from(ref).where(eq(ref.archiveId, value.id))))
  const ownerArchives = tx.select({ field: refs.field, ...archived,
    snapshotBytes: sql<Buffer | null>`CASE WHEN ${refs.field} = 'legacyRowSnapshot'
      THEN ${postgresObservationSnapshot(refs.ownerId, value.bytes)} END`,
  }).from(refs)
    .innerJoin(value, eq(value.id, refs.archiveId)).where(and(eq(refs.ownerId, row.id), eq(refs.sealed, 1)))
  const archives = await (row.scheme !== 'target-command-v1' || row.basisId === null ? ownerArchives : ownerArchives.unionAll(
    tx.select({ field: sql<string>`'basis'::text`.as('field'), ...archived, snapshotBytes: sql<null>`NULL::bytea` }).from(value)
      .where(and(eq(value.id, BigInt(row.basisId)), ...unreferenced)),
  ))
  const originals = new Map(archives.map(archive => [archive.field, { ...archive, id: Number(archive.id) } as ObservationArchive]))
  const raw = checkedArchive(originals.get('rawFields'))
  const sourceText = checkedArchive(originals.get('sourceText'))
  checkedArchive(originals.get('legacyRowSnapshot'), 'blob')
  const { rawFields, bytes, legacyStatusBlob } = (() => {
    try {
      const cells = snapshotSchema.parse(JSON.parse(decode(originals.get('legacyRowSnapshot')!.snapshotBytes!))).fields
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
        return { rawFields: legacy.rawFields, bytes,
          legacyStatusBlob: !indexed && row.source === 'business_list' && cell('status').storageClass === 'blob' }
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
      return { rawFields: legacy.rawFields, bytes, legacyStatusBlob: false }
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
  const [observed] = await tx.select().from(table)
    .where(and(eq(table.observationId, row.id), eq(table.sourceArchiveId, raw.id)))
  if (!observed) throw new PlatformProjectionError('projection_missing', 'Original observation source-fidelity projection missing')

  let versionProjectionMissing = false
  if (indexed) {
    if (row.identityState !== plan.identityState || row.contentState !== plan.contentState || row.keySource !== plan.keySource) {
      mapping('Original indexed observation state differs')
    }
    if (plan.platformKey !== null) {
      const r = platformBusinessRecord
      const [record] = row.recordId === null ? [] : await tx.select({ id: r.id }).from(r)
        .where(and(eq(r.id, row.recordId), eq(r.interface, row.source), eq(r.platformKey, plan.platformKey),
          eq(r.identityRuleVersion, PLATFORM_PROJECTION_RULE)))
      if (!record) mapping('Original record owner differs')
    } else if (row.recordId !== null) mapping('Unexpected original record owner')

    if (plan.canonicalRawJson !== null && typed) {
      const v = platformBusinessRecordVersion
      const r = platformVersionArchiveRef
      const [version] = row.versionId === null || row.recordId === null || plan.contentHash === null ? []
        : await tx.select({ ...archived, projection: getTableColumns(table) }).from(v)
          .innerJoin(r, and(eq(r.ownerId, v.id), eq(r.archiveId, v.canonicalArchiveId), eq(r.field, 'canonicalRawJson'), eq(r.sealed, 1)))
          .innerJoin(value, eq(value.id, r.archiveId))
          .leftJoin(table, and(eq(table.versionId, v.id), eq(table.recordId, v.recordId)))
          .where(and(eq(v.id, row.versionId), eq(v.recordId, row.recordId), eq(v.hashAlgorithm, PLATFORM_RAW_HASH_RULE),
            eq(v.contentHash, plan.contentHash)))
      if (!version || !checkedArchive({ ...version, id: Number(version.id) } as Archive, 'text').bytes!.equals(Buffer.from(plan.canonicalRawJson))) {
        mapping('Original version owner or archive differs')
      }
      const projection = version?.projection
      versionProjectionMissing = projection == null
      if (versionProjectionMissing && !allowMissingVersionProjection) {
        throw new PlatformProjectionError('projection_missing', 'Original version projection missing')
      }
      if (projection && Object.entries(typed).some(([key, value]) => Reflect.get(projection, key) !== value)) mapping('Original version projection differs')
    } else if (row.versionId !== null) mapping('Unexpected original version owner')
  }

  const fingerprint = { relationId, identityState: plan.identityState, contentState: plan.contentState, keySource: plan.keySource,
    projectionRuleVersion: PLATFORM_PROJECTION_RULE, inputFingerprint }
  const historicalPreview = { ...fingerprint, ...fields }
  const observationPreview = { relationId, identityState: plan.identityState, contentState: plan.contentState, keySource: plan.keySource,
    [projectionNames[row.source]]: Object.fromEntries(previewKeys[row.source].map(key => [key, Reflect.get(observed, key)])) }
  return { row, indexed, plan, fingerprint, historicalPreview, observationPreview, versionProjectionMissing, legacyStatusBlob }
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
    const { row, indexed, plan, fingerprint, versionProjectionMissing, legacyStatusBlob } = await inspectObservation(tx, relationId,
      mode.kind === 'historical' ? { expected: mode.expected } : { allowMissingVersionProjection: true })
    if (!indexed && !sync) return null
    if (legacyStatusBlob) throw new PlatformProjectionError('projection_source_drift', 'Legacy text class conflict')

    const now = new Date().toISOString()
    const content = !indexed || (sync && versionProjectionMissing)
      ? await ensurePostgresObservationContent(tx, row.source, plan, now)
      : { recordId: row.recordId, versionId: row.versionId, recordCreated: false, versionCreated: false, projectionCreated: false }
    if (!indexed) {
      const batchId = mode.kind === 'historical' ? mode.batchId : null
      await tx.insert(platformObservationFingerprintBasis).values({
        observationId: row.id, scheme: 'legacy-bootstrap-v1',
      })
      await tx.update(platformBusinessObservation).set({
        recordId: content.recordId, versionId: content.versionId, identityState: plan.identityState,
        contentState: plan.contentState, keySource: plan.keySource, projectionRuleVersion: PLATFORM_PROJECTION_RULE,
        inputFingerprint: fingerprint.inputFingerprint, indexedAt: now, batchId,
      }).where(eq(platformBusinessObservation.id, row.id))
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
