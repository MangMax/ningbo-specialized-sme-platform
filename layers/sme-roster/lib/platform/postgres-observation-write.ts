import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/postgresql/platform-tables'
import { encodePlatformSourceCell, type PlatformSourceValues } from '../../../../db/postgresql/platform-source-values'
import type { RosterImportRelation } from '../roster-import-client'
import type { PlatformProjectionResult } from './business-record'
import { normalizePlatformRelation } from './normalization'
import type { writePostgresCollectionHeader } from './postgres-collection-write'
import { materializedText } from './apply-materialization'
import { APPLY_PROJECTION_RULE } from './apply-record'
import { BUSINESS_PROJECTION_RULE } from './business-projection'
import { parseRecognizedQualificationFields, parseRecognizedSourceFidelity, RECOGNIZED_PROJECTION_RULE } from './recognized-projection'
import { planPlatformObservation, canonicalPlatformJson, PLATFORM_PROJECTION_RULE, PLATFORM_RAW_HASH_RULE } from './observation-plan'
import { capturePostgresObservationFacts } from './postgres-platform-facts'
import type { PlatformStoredRelation } from './read'
import type { ApplyTargetInput } from './apply-target-writer'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Source = 'apply_list' | 'business_list' | 'recognized_list'
type Content = ReturnType<typeof planPlatformObservation>
type Collection = Awaited<ReturnType<typeof writePostgresCollectionHeader>>
type Assignment = ApplyTargetInput['assignment']
type BusinessFields = NonNullable<(typeof schema.platformBusinessRecordVersion.$inferSelect)['businessFields']>
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
      sourceValidFlag: encodePlatformSourceCell(sourceValidFlag) })
  }
  return true
}

async function ensurePostgresObservationContent(tx: Tx, source: Source, plan: Content, now: string, businessFields: BusinessFields) {
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
  const [version] = await tx.select({ id: versionTable.id }).from(versionTable)
    .where(and(eq(versionTable.recordId, recordId), eq(versionTable.hashAlgorithm, PLATFORM_RAW_HASH_RULE),
      eq(versionTable.contentHash, plan.contentHash)))
  const [inserted] = version ? [] : await tx.insert(versionTable).values({
    recordId, hashAlgorithm: PLATFORM_RAW_HASH_RULE, contentHash: plan.contentHash, createdAt: now, businessFields,
  }).returning({ id: versionTable.id })
  const versionId = (version ?? inserted)!.id
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
      Pick<PlatformStoredRelation, 'relationKey' | 'nameRaw' | 'usccRaw' | 'province' | 'status' | 'batch' |
        'declareKind' | 'appliedAt' | 'awardBatchLabel' | 'year' | 'rawFields' | 'titleRaw' | 'createdAt'>
}

function observationSourceValues(
  source: Source,
  fields: ReturnType<typeof persistedFields>,
  plan: Content,
  versionId: number | null,
): PlatformSourceValues {
  const observed: Record<keyof PlatformSourceValues, string | number | Buffer | null> = {
    titleRaw: fields.titleRaw,
    status: fields.status,
    declareKind: fields.declareKind,
    appliedAt: fields.appliedAt,
    year: fields.year,
    batch: fields.batch,
    awardBatchLabel: fields.awardBatchLabel,
    province: fields.province,
  }
  const versionValues: PlatformSourceValues = versionId === null ? {}
    : source === 'apply_list' ? { ...plan.applyRecord, year: plan.applyRecord?.declarationYear }
      : source === 'business_list' ? { ...plan.businessProjection, year: plan.businessProjection?.businessYear }
        : { titleRaw: plan.recognizedProjection?.titleRaw }
  const result: PlatformSourceValues = {}
  for (const key of Object.keys(observed) as (keyof PlatformSourceValues)[]) {
    const value = observed[key] ?? null
    if (value === (versionValues[key] ?? null)) continue
    result[key] = encodePlatformSourceCell(value)
  }
  return result
}

export async function writePostgresObservation(tx: Tx, collection: Collection, row: RosterImportRelation, assignment: Assignment, batchId: number) {
  const source = collection.query.interface
  const { position,candidateScopeMask,recognizedPosition } = collection.placement(row.sequenceNo)
  const content = planPlatformObservation({ interface:source,relationKey:row.relationKey,rawFields:row.rawFields })
  const now = new Date().toISOString()
  const fields = persistedFields(row,source,now)
  if (source !== 'recognized_list' && ((assignment.nameRaw ?? null) !== fields.nameRaw || (assignment.usccRaw ?? null) !== fields.usccRaw)) {
    throw new Error('Source materialization does not match the original assignment')
  }
  const raw = row.rawFields ?? null
  const businessFields: BusinessFields = Object.fromEntries(Object.entries(raw ?? {}).flatMap(([key, value]) =>
    !key.includes('\0') && ((typeof value === 'string' && value.length > 0 && !value.includes('\0')) ||
      typeof value === 'number' || typeof value === 'boolean') ? [[key, value]] : []))
  const values = await ensurePostgresObservationContent(tx,source,content,now,businessFields)
  const fingerprintInput = { collectionId:collection.collectionId,position,row,assignment,batchId }
  const inputFingerprint = stamp(fingerprintInput)
  const rawText = raw === null ? null : JSON.stringify(raw)
  const [observation] = await tx.insert(schema.platformBusinessObservation).values({
    collectionId:collection.collectionId, recognizedPosition, candidateScopeMask,
    sourceCreatedAt: now, sourceValues: observationSourceValues(source, fields, content, values.versionId), ...position,
    businessFields: values.versionId === null ? businessFields : null,
    ...capturePostgresObservationFacts(row.sourceText ?? null, rawText),
    sourceRelationKey:source === 'recognized_list' ? row.relationKey ?? null : fields.relationKey,recordId:values.recordId,
    versionId:values.versionId,identityState:content.identityState,contentState:content.contentState,keySource:content.keySource,
    projectionRuleVersion:PLATFORM_PROJECTION_RULE,inputFingerprint,indexedAt:now,batchId,
  }).returning({ id: schema.platformBusinessObservation.id, publicId: schema.platformBusinessObservation.publicId })
  await tx.insert(schema.platformObservationAssignment).values({ ...assignment, actor: assignment.actor == null ? assignment.actor : JSON.stringify(assignment.actor), observationId: observation!.id, revision: 1 })
  const relationId = observation!.publicId
  const data = { ...fields,id:relationId,queryId:collection.queryId,sequenceNo:row.sequenceNo,enterpriseId:assignment.enterpriseId ?? null,
    rawFields:rawText,matchBasis:assignment.matchBasis,verificationStatus:assignment.verificationStatus }
  const prefix = source === 'apply_list' ? 'apply' : source === 'business_list' ? 'business' : 'recognized'
  const projection: PlatformProjectionResult = { relationId,recordId:values.recordId,versionId:values.versionId,identityState:content.identityState,
    contentState:content.contentState,keySource:content.keySource,projectionRuleVersion:PLATFORM_PROJECTION_RULE,inputFingerprint,
    syncRequested:true,observationCreated:true,recordCreated:values.recordCreated,versionCreated:values.versionCreated,
    ...(values.versionId === null ? {} : { [prefix+'ProjectionCreated']:values.projectionCreated,[prefix+'ProjectionReused']:!values.projectionCreated }) }
  const evidence = { id:relationId,enterpriseId:assignment.enterpriseId ?? null,sequenceNo:row.sequenceNo,
    material:[data.relationKey,data.usccRaw,data.nameRaw,Reflect.get(data,'aliasNameRaw') ?? null,data.province,data.status,
      data.batch,data.declareKind,data.appliedAt,data.awardBatchLabel,data.year,assignment.verificationStatus,
      raw?.rddqrq ?? null,raw?.whpcyear ?? null,raw?.whpc ?? null,raw?.szq ?? null] }
  return { projection,evidence }
}
