import { createHash } from 'node:crypto'
import { getTableName, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { BUSINESS_STATUS_V2 } from '../../../../db/business-status'
import type { RosterImportRelation } from '../roster-import-client'
import type { PlatformProjectionResult } from './business-record'
import { normalizePlatformRelation } from './normalization'
import { allocatePostgresPlatformAlias, bindPostgresArchive, sealPostgresArchive, writePostgresArchiveValue } from './postgres-archive-write'
import { encodePlatformExactCell, insertPostgresPlatformRow, postgresPlatformInsert } from './postgres-platform-insert'
import type { writePostgresCollectionHeader } from './postgres-collection-write'
import { materializedText } from './apply-materialization'
import { storedApplyProjection } from './apply-stored-schema'
import { storedProcessProjection } from './process-stored-schema'
import { storedRecognizedProjection } from './recognized-stored-schema'
import { parseApplyRecord, APPLY_PROJECTION_RULE } from './apply-record'
import { parseBusinessProcess, BUSINESS_PROJECTION_RULE } from './business-projection'
import { parseRecognizedRecord, parseRecognizedQualificationFields, parseRecognizedSourceFidelity, RECOGNIZED_PROJECTION_RULE } from './recognized-projection'
import { planPlatformObservation, canonicalPlatformJson, PLATFORM_PROJECTION_RULE, PLATFORM_RAW_HASH_RULE } from './observation-plan'
import { sourceFieldComparison, sourceValueKind } from './source-extraction'
import { relationEvidenceColumns } from './relation-evidence-snapshot'
import { slotFallbackColumns, type SlotRelation } from './reconcile-slot-capture'
import type { ApplyTargetInput } from './apply-target-writer'
import { readPostgresRosterRowsById } from '../roster/postgres-rows'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Source = 'apply_list' | 'business_list' | 'recognized_list'
type Content = ReturnType<typeof planPlatformObservation>
type Collection = Awaited<ReturnType<typeof writePostgresCollectionHeader>>
type Assignment = ApplyTargetInput['assignment']
const projectionTables = { apply_list: schema.platformApplyProjection, business_list: schema.platformBusinessProjection,
  recognized_list: schema.platformRecognizedProjection } as const
const projectionRules = { apply_list: APPLY_PROJECTION_RULE, business_list: BUSINESS_PROJECTION_RULE, recognized_list: RECOGNIZED_PROJECTION_RULE } as const
const stamp = (data: unknown) => createHash('sha256').update(canonicalPlatformJson(data)).digest('hex')

async function completeVersionProjection(tx: Tx, source: Source, plan: Content, recordId: number, versionId: number, createdAt: string) {
  const stored = (await readPostgresRosterRowsById(tx, projectionTables[source],
    sql`FROM ${sql.identifier(getTableName(projectionTables[source]))} p WHERE version_id=${versionId}`))[0]
  const stable = source === 'apply_list' ? plan.applyRecord! : source === 'business_list' ? plan.businessProjection! : plan.recognizedProjection!
  if (stored) {
    if (stored.recordId !== recordId || stored.ruleVersion !== projectionRules[source] ||
      Object.entries(stable).some(([name,value]) => Reflect.get(stored,name) !== value)) throw new Error('platform_projection_conflict')
    return false
  }
  if (source === 'apply_list') {
    await tx.execute(postgresPlatformInsert(schema.platformApplyProjection,{ versionId,recordId,...plan.applyRecord!,ruleVersion:APPLY_PROJECTION_RULE,createdAt }))
  } else if (source === 'business_list') {
    await tx.execute(postgresPlatformInsert(schema.platformBusinessProjection,{ versionId,recordId,...plan.businessProjection!,ruleVersion:BUSINESS_PROJECTION_RULE,createdAt }))
  } else {
    const { sourceValidFlag,...qualification } = parseRecognizedQualificationFields(JSON.parse(plan.canonicalRawJson!))
    await tx.execute(postgresPlatformInsert(schema.platformRecognizedProjection,{ versionId,recordId,...plan.recognizedProjection!,
      ...plan.recognizedSourceFidelity!,...qualification,ruleVersion:RECOGNIZED_PROJECTION_RULE,createdAt },
      encodePlatformExactCell('source_valid_flag',sourceValidFlag)))
  }
  return true
}

async function ensureContent(tx: Tx, source: Source, plan: Content, now: string) {
  const result: { recordId: number | null; versionId: number | null; recordCreated: boolean; versionCreated: boolean; projectionCreated: boolean } =
    { recordId:null,versionId:null,recordCreated:false,versionCreated:false,projectionCreated:false }
  if (!plan.platformKey) return result
  const records = await tx.execute<{ id: number }>(sql`
    INSERT INTO platform_business_record(interface,platform_key,identity_rule_version,created_at)
    VALUES(${source},${plan.platformKey},${PLATFORM_PROJECTION_RULE},${now})
    ON CONFLICT(interface,platform_key) DO NOTHING RETURNING id::float8 AS id`)
  const fresh = records.rows[0]
  const known = fresh ? null : (await tx.execute<{ id: number; rule: string }>(sql`SELECT id::float8 AS id,identity_rule_version AS rule
    FROM platform_business_record WHERE interface=${source} AND platform_key=${plan.platformKey}`)).rows[0]
  if (!fresh && known?.rule !== PLATFORM_PROJECTION_RULE) throw new Error('projection_rule_conflict')
  const recordId = fresh?.id ?? known!.id
  Object.assign(result,{recordId,recordCreated:!!fresh})
  if (!plan.canonicalRawJson || !plan.contentHash) return result
  const version = (await tx.execute<{ id: number; text: string; valid: boolean }>(sql`
    SELECT v.id::float8 AS id,v.canonical_raw_json AS text,EXISTS(SELECT 1 FROM platform_version_archive_ref r
      JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=v.id AND r.field='canonicalRawJson' AND r.sealed=1
        AND r.archive_id=v.canonical_archive_id AND a.bytes=convert_to(v.canonical_raw_json,'UTF8')) AS valid
    FROM platform_business_record_version v WHERE record_id=${recordId} AND hash_algorithm=${PLATFORM_RAW_HASH_RULE} AND content_hash=${plan.contentHash}`)).rows[0]
  if (version && (!version.valid || version.text !== plan.canonicalRawJson)) throw new Error('platform_content_hash_conflict')
  const versionId = version?.id ?? await insertPostgresPlatformRow(tx,schema.platformBusinessRecordVersion,
    { recordId,hashAlgorithm:PLATFORM_RAW_HASH_RULE,contentHash:plan.contentHash,canonicalRawJson:plan.canonicalRawJson,createdAt:now })
  if (!version) {
    const archive = await writePostgresArchiveValue(tx,plan.canonicalRawJson,now)
    await bindPostgresArchive(tx,{ kind:'version',ownerId:versionId,field:'canonicalRawJson' },archive.id)
    await sealPostgresArchive(tx,{ kind:'version',ownerId:versionId })
    await tx.execute(sql`UPDATE platform_business_record_version SET canonical_archive_id=${archive.id} WHERE id=${versionId}`)
  }
  const projectionCreated = await completeVersionProjection(tx,source,plan,recordId,versionId,now)
  return { ...result,versionId,versionCreated:!version,projectionCreated }
}

function persistedFields(row: RosterImportRelation, source: Source, createdAt: string) {
  const normalized = normalizePlatformRelation(source,row)
  const fields = Object.fromEntries(Object.entries(normalized).map(([key,value]) => [key,materializedText(value)]))
  const rawFields = row.rawFields ?? null
  return { ...fields,rawFields,titleRaw:materializedText(rawFields?.rdjb),
    year: typeof normalized.year === 'number' && Number.isFinite(normalized.year) ? Math.trunc(normalized.year) : null, createdAt } as unknown as
      Omit<SlotRelation,'id'> & { titleRaw: string | null; createdAt: string }
}

function writeObservationProjection(tx: Tx, source: Source, observationId: number, plan: Content,
  raw: Record<string,unknown> | null, fields: ReturnType<typeof persistedFields>, archive: { id: number; sha256: string | null }, fingerprint: { id: number; sha256: string | null }) {
  const title = raw?.rdjb
  const common = { observationId,createdAt:fields.createdAt,basis:raw === null ? 'unavailable' as const : 'observation_reconciliation' as const,
    parseState:raw === null ? 'absent' as const : 'valid' as const,sourceArchiveId:archive.id,
    sourceTitleKind:sourceValueKind(title),sourceTitleText:typeof title === 'string' ? title : null,
    sourceTitleNumberText:typeof title === 'number' ? String(title) : null, sourceTitleBoolean:typeof title === 'boolean' ? Number(title) : null,
    sourceTitleRuleVersion:source === 'business_list' ? BUSINESS_STATUS_V2 : 't05b-source-projections-v1' }
  const exact = {
    ...encodePlatformExactCell('exact_status',fields.status),
    ...encodePlatformExactCell('exact_declare_kind',fields.declareKind),
    ...encodePlatformExactCell('exact_applied_at',fields.appliedAt),
    ...encodePlatformExactCell('exact_title_raw',fields.titleRaw),
    ...encodePlatformExactCell('exact_year',fields.year),
  }
  if (source === 'apply_list') return tx.execute(postgresPlatformInsert(storedApplyProjection,
    { ...common,...(plan.applyRecord ?? parseApplyRecord(raw)),ruleVersion:APPLY_PROJECTION_RULE,sqlFactTitle:fields.titleRaw,
      exactStoredState:'captured',exactStoredRule:'apply-stored-cells-v1',exactStoredOrigin:'command_materialized',
      sqlFactTitleState:'captured',sqlFactTitleRule:'apply-legacy-sql-fact-title-v1',
      ...sourceFieldComparison('apply_list',{...fields,status:typeof fields.status === 'string' ? fields.status : null},raw,common.parseState) },exact))
  if (source === 'business_list') {
    const comparison = sourceFieldComparison('business_list',fields,raw,common.parseState)
    const { storedStatus,reconciledStatus,...facts } = comparison
    return tx.execute(postgresPlatformInsert(storedProcessProjection,
      { ...common,...(plan.businessProjection ?? parseBusinessProcess(raw)),ruleVersion:BUSINESS_PROJECTION_RULE,
        sqlFactTitle:fields.titleRaw,
        exactStoredState:'captured',exactStoredRule:'process-stored-cells-v1',exactStoredOrigin:'command_materialized',
        sqlFactTitleState:'captured',sqlFactTitleRule:'process-legacy-sql-fact-title-v1',...facts },
      { ...exact,...encodePlatformExactCell('exact_batch',fields.batch),...encodePlatformExactCell('exact_award_batch_label',fields.awardBatchLabel),
        ...encodePlatformExactCell('exact_province',fields.province),...encodePlatformExactCell('stored_status',storedStatus),
        ...encodePlatformExactCell('reconciled_status',reconciledStatus) }))
  }
  const original = { province:fields.province,status:typeof fields.status === 'string' ? fields.status : null,
    batch:fields.batch,declareKind:fields.declareKind,appliedAt:fields.appliedAt,awardBatchLabel:fields.awardBatchLabel,year:fields.year }
  const { sourceValidFlag,...qualification } = parseRecognizedQualificationFields(raw)
  return tx.execute(postgresPlatformInsert(storedRecognizedProjection,
    { ...common,...(plan.recognizedProjection ?? parseRecognizedRecord(raw)),...(raw ? parseRecognizedSourceFidelity(raw) : {}),
      ...qualification,ruleVersion:RECOGNIZED_PROJECTION_RULE,
      exactTitleState:'captured',exactTitleOrigin:'commandInput',exactTitleArchiveId:fingerprint.id,exactTitleSha256:fingerprint.sha256,
      ...sourceFieldComparison('recognized_list',original,raw,common.parseState) },
    { ...encodePlatformExactCell('exact_title_raw',fields.titleRaw),...encodePlatformExactCell('source_valid_flag',sourceValidFlag) }))
}

export async function writePostgresObservation(tx: Tx, collection: Collection, row: RosterImportRelation, assignment: Assignment, batchId: number) {
  const source = collection.query.interface
  const { position,candidate,witnessFields,exact } = collection.placement(row.sequenceNo)
  const content = planPlatformObservation({ interface:source,relationKey:row.relationKey,rawFields:row.rawFields })
  const now = new Date().toISOString()
  const fields = persistedFields(row,source,now)
  if (source !== 'recognized_list' && ((assignment.nameRaw ?? null) !== fields.nameRaw || (assignment.usccRaw ?? null) !== fields.usccRaw)) {
    throw new Error('Source materialization does not match the original assignment')
  }
  const values = await ensureContent(tx,source,content,now)
  const fingerprintInput = { collectionId:collection.collectionId,position,row,assignment,batchId }
  const inputFingerprint = stamp(fingerprintInput)
  const { rows: [next] } = await tx.execute<{ id: number }>(sql`
    SELECT nextval(pg_get_serial_sequence('platform_business_observation','id'))::float8 AS id`)
  const observationId = next!.id
  const actorValues = source === 'apply_list'
    ? { applyExactOwnerId:observationId,applyExactState:'captured' as const,applySqlFactTitleState:'captured' as const }
    : source === 'business_list'
      ? { processExactOwnerId:observationId,processExactState:'captured' as const,processSqlFactTitleState:'captured' as const } : {}
  await tx.execute(postgresPlatformInsert(schema.platformBusinessObservation,{
    id:observationId,collectionId:collection.collectionId,...position,...candidate,...witnessFields,...actorValues,
    sourceRelationKey:source === 'recognized_list' ? row.relationKey ?? null : fields.relationKey,recordId:values.recordId,
    versionId:values.versionId,identityState:content.identityState,contentState:content.contentState,keySource:content.keySource,
    projectionRuleVersion:PLATFORM_PROJECTION_RULE,inputFingerprint,indexedAt:now,batchId,
  },exact))
  const fingerprintArchive = await writePostgresArchiveValue(tx,Buffer.from(canonicalPlatformJson(fingerprintInput)),null)
  await tx.execute(sql`INSERT INTO platform_observation_fingerprint_basis(observation_id,scheme,input_archive_id)
    VALUES(${observationId},'target-command-v1',${fingerprintArchive.id})`)
  await tx.execute(postgresPlatformInsert(schema.platformObservationAssignment,{...assignment,observationId,revision:1}))
  const relationId = await allocatePostgresPlatformAlias(tx,'relation',observationId)
  const raw = row.rawFields ?? null
  const rawText = raw === null ? null : JSON.stringify(raw)
  const data = { ...fields,id:relationId,queryId:collection.queryAlias,sequenceNo:row.sequenceNo,enterpriseId:assignment.enterpriseId ?? null,
    rawFields:rawText,matchBasis:assignment.matchBasis,verificationStatus:assignment.verificationStatus }
  const cells = relationEvidenceColumns.map(([key,name]) => {
    const value = Reflect.get(data,key) as string | number | null | undefined
    return { name,storageClass:value == null ? 'null' : typeof value === 'number' ? 'integer' : 'text',
      hex:value == null ? '' : Buffer.from(String(value)).toString('hex').toUpperCase() }
  })
  const snapshot = Buffer.from(JSON.stringify({ encoding:'t05a-sqlite-cells-v1',fields:cells }))
  const rawArchive = await writePostgresArchiveValue(tx,rawText,now)
  for (const [field,value] of [['sourceText',row.sourceText ?? null],['legacyRowSnapshot',snapshot]] as const) {
    const archived = await writePostgresArchiveValue(tx,value,now)
    await bindPostgresArchive(tx,{kind:'observation',ownerId:observationId,field},archived.id)
  }
  await bindPostgresArchive(tx,{kind:'observation',ownerId:observationId,field:'rawFields'},rawArchive.id)
  await sealPostgresArchive(tx,{kind:'observation',ownerId:observationId})
  await writeObservationProjection(tx,source,observationId,content,raw,fields,rawArchive,fingerprintArchive)
  const prefix = source === 'apply_list' ? 'apply' : source === 'business_list' ? 'business' : 'recognized'
  const projection: PlatformProjectionResult = { relationId,recordId:values.recordId,versionId:values.versionId,identityState:content.identityState,
    contentState:content.contentState,keySource:content.keySource,projectionRuleVersion:PLATFORM_PROJECTION_RULE,inputFingerprint,
    syncRequested:true,observationCreated:true,recordCreated:values.recordCreated,versionCreated:values.versionCreated,
    ...(values.versionId === null ? {} : { [prefix+'ProjectionCreated']:values.projectionCreated,[prefix+'ProjectionReused']:!values.projectionCreated }) }
  const slot: SlotRelation = { ...fields,id:relationId,sequenceNo:row.sequenceNo,rawFields:raw }
  const slotInput = { id:relationId,sequenceNo:row.sequenceNo,rawFields:{ storageClass:rawText === null ? 'null' : 'text',
    byteLength:rawText === null ? null : Buffer.byteLength(rawText),sha256:rawArchive.sha256 },
    fallbackCells:slotFallbackColumns.map(name => cells.find(cell => cell.name === name)!) }
  const evidence = { id:relationId,enterpriseId:assignment.enterpriseId ?? null,sequenceNo:row.sequenceNo,
    material:[data.relationKey,data.usccRaw,data.nameRaw,Reflect.get(data,'aliasNameRaw') ?? null,data.province,data.status,
      data.batch,data.declareKind,data.appliedAt,data.awardBatchLabel,data.year,assignment.verificationStatus,
      raw?.rddqrq ?? null,raw?.whpcyear ?? null,raw?.whpc ?? null,raw?.szq ?? null] }
  return { projection,slot,slotInput,evidence }
}
