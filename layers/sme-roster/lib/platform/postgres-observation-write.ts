import { createHash } from 'node:crypto'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/postgresql/platform-tables'
import { platformArchiveValue, platformVersionArchiveRef } from '../../../../db/postgresql/platform-archive-tables'
import { BUSINESS_STATUS_V2 } from '../../../../db/business-status-contract'
import type { RosterImportRelation } from '../roster-import-client'
import type { PlatformProjectionResult } from './business-record'
import { PlatformProjectionError } from './projection-error'
import { normalizePlatformRelation } from './normalization'
import { allocatePostgresPlatformAlias, bindPostgresArchive, sealPostgresArchive, writePostgresArchiveValue } from './postgres-archive-write'
import { encodePlatformExactCell } from './postgres-platform-insert'
import type { writePostgresCollectionHeader } from './postgres-collection-write'
import { materializedText } from './apply-materialization'
import { parseApplyRecord, APPLY_PROJECTION_RULE } from './apply-record'
import { parseBusinessProcess, BUSINESS_PROJECTION_RULE } from './business-projection'
import { parseRecognizedRecord, parseRecognizedQualificationFields, parseRecognizedSourceFidelity, RECOGNIZED_PROJECTION_RULE } from './recognized-projection'
import { planPlatformObservation, canonicalPlatformJson, PLATFORM_PROJECTION_RULE, PLATFORM_RAW_HASH_RULE } from './observation-plan'
import { sourceFieldComparison, sourceValueKind } from './source-extraction'
import { relationEvidenceColumns } from './relation-evidence-fields'
import { slotFallbackColumns, type SlotRelation } from './reconcile-slot-capture'
import type { ApplyTargetInput } from './apply-target-writer'

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
  const table = projectionTables[source]
  const [stored] = await tx.select().from(table).where(eq(table.versionId, versionId)).orderBy(table.id).limit(1)
  const stable = source === 'apply_list' ? plan.applyRecord! : source === 'business_list' ? plan.businessProjection! : plan.recognizedProjection!
  if (stored) {
    if (stored.recordId !== recordId || stored.ruleVersion !== projectionRules[source] ||
      Object.entries(stable).some(([name,value]) => Reflect.get(stored,name) !== value)) throw new Error('platform_projection_conflict')
    return false
  }
  if (source === 'apply_list') {
    await tx.insert(schema.platformApplyProjection).values({ versionId,recordId,...plan.applyRecord!,ruleVersion:APPLY_PROJECTION_RULE,createdAt })
  } else if (source === 'business_list') {
    await tx.insert(schema.platformBusinessProjection).values({ versionId,recordId,...plan.businessProjection!,ruleVersion:BUSINESS_PROJECTION_RULE,createdAt })
  } else {
    const { sourceValidFlag,...qualification } = parseRecognizedQualificationFields(JSON.parse(plan.canonicalRawJson!))
    await tx.insert(schema.platformRecognizedProjection).values({ versionId,recordId,...plan.recognizedProjection!,
      ...plan.recognizedSourceFidelity!, sourceMaintenanceYearAbsent: Number(plan.recognizedSourceFidelity!.sourceMaintenanceYearAbsent),
      ...qualification,ruleVersion:RECOGNIZED_PROJECTION_RULE,createdAt,
      ...encodePlatformExactCell('sourceValidFlag',sourceValidFlag) })
  }
  return true
}

export async function ensurePostgresObservationContent(tx: Tx, source: Source, plan: Content, now: string) {
  const result: { recordId: number | null; versionId: number | null; recordCreated: boolean; versionCreated: boolean; projectionCreated: boolean } =
    { recordId:null,versionId:null,recordCreated:false,versionCreated:false,projectionCreated:false }
  if (!plan.platformKey) return result
  const recordTable = schema.platformBusinessRecord
  const [fresh] = await tx.insert(recordTable).values({
    interface: source, platformKey: plan.platformKey, identityRuleVersion: PLATFORM_PROJECTION_RULE, createdAt: now,
  }).onConflictDoNothing({ target: [recordTable.interface, recordTable.platformKey] }).returning({ id: recordTable.id })
  const known = fresh ? null : (await tx.select({ id: recordTable.id, rule: recordTable.identityRuleVersion })
    .from(recordTable).where(and(eq(recordTable.interface, source), eq(recordTable.platformKey, plan.platformKey))))[0]
  if (!fresh && known?.rule !== PLATFORM_PROJECTION_RULE) throw new Error('projection_rule_conflict')
  const recordId = fresh?.id ?? known!.id
  Object.assign(result,{recordId,recordCreated:!!fresh})
  if (!plan.canonicalRawJson || !plan.contentHash) return result
  const versionTable = schema.platformBusinessRecordVersion
  const [version] = await tx.select({
    id: versionTable.id, text: versionTable.canonicalRawJson, valid: isNotNull(platformArchiveValue.id),
  })
    .from(versionTable)
    .leftJoin(platformVersionArchiveRef, and(
      eq(platformVersionArchiveRef.ownerId, versionTable.id),
      eq(platformVersionArchiveRef.field, 'canonicalRawJson'),
      eq(platformVersionArchiveRef.sealed, 1),
    ))
    .leftJoin(platformArchiveValue, and(
      eq(platformArchiveValue.id, platformVersionArchiveRef.archiveId),
      eq(platformArchiveValue.id, versionTable.canonicalArchiveId),
      // Drizzle does not expose PostgreSQL's encoding conversion.
      eq(platformArchiveValue.bytes, sql`convert_to(${versionTable.canonicalRawJson}, 'UTF8')`),
    ))
    .where(and(eq(versionTable.recordId, recordId), eq(versionTable.hashAlgorithm, PLATFORM_RAW_HASH_RULE),
      eq(versionTable.contentHash, plan.contentHash)))
  if (version && (version.text !== plan.canonicalRawJson || !version.valid)) {
    throw new PlatformProjectionError('platform_content_hash_conflict', 'Stored canonical platform evidence disagrees with its content hash')
  }
  let versionId: number
  if (version) {
    versionId = version.id
  } else {
    const [inserted] = await tx.insert(versionTable).values({
      recordId, hashAlgorithm: PLATFORM_RAW_HASH_RULE, contentHash: plan.contentHash, canonicalRawJson: plan.canonicalRawJson, createdAt: now,
    }).returning({ id: versionTable.id })
    versionId = inserted!.id
    const archive = await writePostgresArchiveValue(tx,plan.canonicalRawJson,now)
    await bindPostgresArchive(tx,{ kind:'version',ownerId:versionId,field:'canonicalRawJson' },archive.id)
    await sealPostgresArchive(tx,{ kind:'version',ownerId:versionId })
    await tx.update(versionTable).set({ canonicalArchiveId: archive.id }).where(eq(versionTable.id, versionId))
  }
  const projectionCreated = await completeVersionProjection(tx,source,plan,recordId,versionId,now)
  return { ...result,versionId,versionCreated:!version,projectionCreated }
}

function persistedFields(row: RosterImportRelation, source: Source, createdAt: string) {
  const normalized = normalizePlatformRelation(source,row)
  const fields = Object.fromEntries(Object.entries(normalized).map(([key,value]) => [key,materializedText(value)]))
  const rawFields = row.rawFields ?? null
  return { ...fields,nameRaw:materializedText(row.nameRaw),usccRaw:materializedText(row.usccRaw),
    rawFields,titleRaw:materializedText(rawFields?.rdjb),
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
    ...encodePlatformExactCell('exactStatus',fields.status),
    ...encodePlatformExactCell('exactDeclareKind',fields.declareKind),
    ...encodePlatformExactCell('exactAppliedAt',fields.appliedAt),
    ...encodePlatformExactCell('exactTitleRaw',fields.titleRaw),
    ...encodePlatformExactCell('exactYear',fields.year),
  }
  if (source === 'apply_list') return tx.insert(schema.platformApplyProjection).values(
    { ...common,...(plan.applyRecord ?? parseApplyRecord(raw)),ruleVersion:APPLY_PROJECTION_RULE,sqlFactTitle:fields.titleRaw,
      exactStoredState:'captured',exactStoredRule:'apply-stored-cells-v1',exactStoredOrigin:'command_materialized',
      sqlFactTitleState:'captured',sqlFactTitleRule:'apply-legacy-sql-fact-title-v1',
      ...sourceFieldComparison('apply_list',{...fields,status:typeof fields.status === 'string' ? fields.status : null},raw,common.parseState), ...exact })
  if (source === 'business_list') {
    const comparison = sourceFieldComparison('business_list',fields,raw,common.parseState)
    const { storedStatus,reconciledStatus,...facts } = comparison
    return tx.insert(schema.platformBusinessProjection).values({ ...common,...(plan.businessProjection ?? parseBusinessProcess(raw)),ruleVersion:BUSINESS_PROJECTION_RULE,
        sqlFactTitle:fields.titleRaw,
        exactStoredState:'captured',exactStoredRule:'process-stored-cells-v1',exactStoredOrigin:'command_materialized',
        sqlFactTitleState:'captured',sqlFactTitleRule:'process-legacy-sql-fact-title-v1',...facts,
      ...exact,...encodePlatformExactCell('exactBatch',fields.batch),...encodePlatformExactCell('exactAwardBatchLabel',fields.awardBatchLabel),
        ...encodePlatformExactCell('exactProvince',fields.province),...encodePlatformExactCell('storedStatus',storedStatus),
        ...encodePlatformExactCell('reconciledStatus',reconciledStatus) })
  }
  const original = { province:fields.province,status:typeof fields.status === 'string' ? fields.status : null,
    batch:fields.batch,declareKind:fields.declareKind,appliedAt:fields.appliedAt,awardBatchLabel:fields.awardBatchLabel,year:fields.year }
  const { sourceValidFlag,...qualification } = parseRecognizedQualificationFields(raw)
  const fidelity = raw ? parseRecognizedSourceFidelity(raw) : null
  return tx.insert(schema.platformRecognizedProjection).values({ ...common,...(plan.recognizedProjection ?? parseRecognizedRecord(raw)),
      ...fidelity, sourceMaintenanceYearAbsent: fidelity ? Number(fidelity.sourceMaintenanceYearAbsent) : undefined,
      ...qualification,ruleVersion:RECOGNIZED_PROJECTION_RULE,
      exactTitleState:'captured',exactTitleOrigin:'commandInput',exactTitleArchiveId:fingerprint.id,exactTitleSha256:fingerprint.sha256,
      ...sourceFieldComparison('recognized_list',original,raw,common.parseState),
    ...encodePlatformExactCell('exactTitleRaw',fields.titleRaw),...encodePlatformExactCell('sourceValidFlag',sourceValidFlag) })
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
  const values = await ensurePostgresObservationContent(tx,source,content,now)
  const fingerprintInput = { collectionId:collection.collectionId,position,row,assignment,batchId }
  const inputFingerprint = stamp(fingerprintInput)
  // Drizzle cannot reserve an identity value before insert. The exact-owner checks require the observation's own ID at insert.
  const { rows: [next] } = await tx.execute<{ id: number }>(sql`
    SELECT nextval(pg_get_serial_sequence('platform_business_observation','id'))::float8 AS id`)
  const observationId = next!.id
  const actorValues = source === 'apply_list'
    ? { applyExactOwnerId:observationId,applyExactState:'captured' as const,applySqlFactTitleState:'captured' as const }
    : source === 'business_list'
      ? { processExactOwnerId:observationId,processExactState:'captured' as const,processSqlFactTitleState:'captured' as const } : {}
  await tx.insert(schema.platformBusinessObservation).values({
    id:observationId,collectionId:collection.collectionId,...position,...candidate,...witnessFields,...actorValues,
    sourceRelationKey:source === 'recognized_list' ? row.relationKey ?? null : fields.relationKey,recordId:values.recordId,
    versionId:values.versionId,identityState:content.identityState,contentState:content.contentState,keySource:content.keySource,
    projectionRuleVersion:PLATFORM_PROJECTION_RULE,inputFingerprint,indexedAt:now,batchId,...exact,
  })
  const fingerprintArchive = await writePostgresArchiveValue(tx,Buffer.from(canonicalPlatformJson(fingerprintInput)),null)
  await tx.insert(schema.platformObservationFingerprintBasis).values({
    observationId, scheme: 'target-command-v1', inputArchiveId: fingerprintArchive.id,
  })
  await tx.insert(schema.platformObservationAssignment).values({ ...assignment, actor: assignment.actor == null ? assignment.actor : JSON.stringify(assignment.actor), observationId, revision: 1 })
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
