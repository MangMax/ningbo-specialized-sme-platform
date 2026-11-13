import { ensureProcessStoredReady } from './process-stored-catalog'
import { verifyWitnessCollection,verifyWitnessObservation } from './recognized-witness-write'
import { verifyCandidateObservation } from './candidate-scope-write'
import Database from 'better-sqlite3'
import { verifyFingerprint, FingerprintVerificationError } from './fingerprint-verifier'
import { bootstrapFingerprint } from './fingerprint-bootstrap'
import { requireCaptureForeignKeys } from './fingerprint-capture'
import { isDeepStrictEqual } from 'node:util'
import { planPlatformObservation, platformObservationPayload, PLATFORM_PROJECTION_RULE, PLATFORM_RAW_HASH_RULE } from './observation-plan'
import { PlatformProjectionError } from './projection-error'
import { ensureApplyTargetContent } from './apply-target-writer'
import { ensureProcessTargetContent } from './process-target-writer'
import { ensureRecognizedTargetContent } from './recognized-target-writer'
/** Explicit 71607 collection replay. Typed coordinates choose owners; archives only verify originals. */
import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import { normalizeUscc } from '../domain'
import type { RosterImportItemResult, RosterImportPlatformQuery, RosterImportRelation } from '../roster-import-client'
import { platformQueriesInputSchema } from '../../server/utils/roster-import-platform-schema'
import { FINGERPRINT_BASIS_VERSION } from '../../db/schema-phase'
import { targetSchema as s } from './target-schema'
import { replayOptionalString as optionalString, platformQuerySourceConflict, stagedPlatformQuerySource, type PlatformQueryReplaySource } from './query-replay'
import { queryEvidenceError } from './query-evidence'
import { normalizePlatformRelation } from './normalization'
import { writeNewCollectionTarget, type NewCollectionTargetCommand } from './collection-target-command'

/** Drizzle exposes $client on the database and the same client on a nested session.
 * C's native snapshot/savepoint seams must use that exact connection. */
function replayConnection(db: object): Database.Database {
  const direct: unknown = Reflect.get(db,'$client')
  if(direct instanceof Database) return direct
  const session: unknown = Reflect.get(db,'session')
  const nested: unknown = session && typeof session === 'object' ? Reflect.get(session,'client') : null
  if(nested instanceof Database) return nested
  throw new Error('Replay requires its original SQLite connection')
}
function fingerprintFailure(error: unknown): never {
  if(error instanceof FingerprintVerificationError) reject(error.kind,error.ref,error.code,error.message,error.field)
  throw error
}
function certify(sqlite: Database.Database, owner: Parameters<typeof verifyFingerprint>[1]) {
  try { return verifyFingerprint(sqlite,owner) } catch(error) { fingerprintFailure(error) }
}

function certifyReplay(sqlite: Database.Database, owner: Parameters<typeof verifyFingerprint>[1], source: string) {
  try { return verifyFingerprint(sqlite,owner,{allowMissingVersionProjection:true}) }
  catch(error) {
    if(error instanceof FingerprintVerificationError) {
      if(/version projection conflict|Legacy version projection drift/.test(error.message)) reject(error.kind,error.ref,source==='apply_list'?'apply_projection_conflict':source==='business_list'?'business_projection_conflict':'recognized_projection_conflict',error.message,error.field)
    }
    fingerprintFailure(error)
  }
}

export class CollectionReplayError extends Error {
  constructor(public readonly result: RosterImportItemResult) { super(result.error?.code ?? 'collection_replay_conflict') }
}
function reject(kind: string, ref: string, code: string, message: string, field?: string): never {
  throw new CollectionReplayError({ ok: false, kind, ref, error: { code, message, ...(field ? { field } : {}) } })
}

/** Validate shape without replacing immutable own keys with a schema-produced clone. */
function originalQuery(text: string): RosterImportPlatformQuery {
  const value: unknown = JSON.parse(text)
  platformQueriesInputSchema.parse([value])
  return value as RosterImportPlatformQuery
}

function archive<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, owner: { kind: 'collection'; id: number; field: typeof s.platformCollectionArchiveRef.$inferSelect.field } | { kind: 'observation'; id: number; field: typeof s.platformObservationArchiveRef.$inferSelect.field }, preserveTextBom=false): string | null {
  const r = owner.kind === 'collection' ? s.platformCollectionArchiveRef : s.platformObservationArchiveRef
  const a = s.platformArchiveValue
  const found = db.select({ value: a, sealed: r.sealed }).from(r).innerJoin(a, eq(a.id, r.archiveId)).where(and(eq(r.ownerId, owner.id), eq(r.field, owner.field))).get()
  if (!found || found.sealed !== 1) throw new Error('Missing sealed original archive')
  const v = found.value
  if (v.storageClass === 'null') {
    if (v.bytes !== null || v.byteLength !== null || v.sha256 !== null) throw new Error('Original archive drift')
    return null
  }
  if (!v.bytes || v.bytes.length !== v.byteLength || createHash('sha256').update(v.bytes).digest('hex') !== v.sha256) throw new Error('Original archive drift')
  return new TextDecoder('utf-8', { fatal: true,ignoreBOM:preserveTextBom }).decode(v.bytes)
}

function parseOriginalRaw(text: string | null): unknown {
  try { return text === null ? null : JSON.parse(text) } catch { return null }
}

const cells = z.object({ encoding: z.literal('t05a-sqlite-cells-v1'), fields: z.array(z.object({ name: z.string(), storageClass: z.string(), hex: z.string(), real64be: z.string().optional() })) })
/** Immutable legacy payload evidence only. Never used to choose members or their current owner. */
function legacyOriginal(text: string, sequenceNo: number, processCanonical=false): RosterImportRelation {
  const snapshot = cells.parse(JSON.parse(text))
  const read = (name: string) => {
    const c = snapshot.fields.find(c => c.name === name)
    if (!c) throw new Error('Original source cell missing')
    return c.storageClass === 'null' ? null : Buffer.from(c.hex, 'hex').toString('utf8')
  }
  // 71610 process assertions use the existing fingerprint's canonical decoder.
  // The independent SQL title is certified separately against BOM-preserving bytes.
  const rawCell=snapshot.fields.find(c=>c.name==='raw_fields')
  const raw = processCanonical&&rawCell?.storageClass==='text'
    ?new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(rawCell.hex,'hex')):read('raw_fields')
  const row = { sequenceNo, relationKey: read('relation_key'), nameRaw: read('name_raw'), usccRaw: read('uscc_raw'), aliasNameRaw: read('alias_name_raw'), sourceText: read('source_text'), province: read('province'), status: read('status'), batch: read('batch'), declareKind: read('declare_kind'), appliedAt: read('applied_at'), awardBatchLabel: read('award_batch_label'), year: read('year') === null ? null : Number(read('year')), rawFields: parseOriginalRaw(raw) }
  platformQueriesInputSchema.parse([{ interface: 'apply_list', queryKey: 'validation', queriedAt: 'validation', relations: [row] }])
  return row as RosterImportRelation
}

export function targetReplaySource<S extends Record<string, unknown>>(tx: BetterSQLite3Database<S>, sqlite: Database.Database, collection: typeof s.platformCollection.$inferSelect) {
    if(collection.interface==='recognized_list')verifyWitnessCollection(sqlite,collection.id)
    const alias = tx.select().from(s.platformLegacyQueryAlias).where(eq(s.platformLegacyQueryAlias.collectionId,collection.id)).get()
    if (!alias) throw new Error('Missing collection alias')
    const ref = `query:${alias.oldId}`
    const evidenceText = archive(tx,{kind:'collection',id:collection.id,field:'collectionEvidence'})
    const evidence: unknown = evidenceText === null ? null : JSON.parse(evidenceText)
    const rawResponse = archive(tx,{kind:'collection',id:collection.id,field:'rawResponse'})
    const observations = tx.select().from(s.platformBusinessObservation).where(eq(s.platformBusinessObservation.collectionId,collection.id)).all()
    const requestRef = tx.select().from(s.platformCollectionArchiveRef).where(and(eq(s.platformCollectionArchiveRef.ownerId,collection.id),eq(s.platformCollectionArchiveRef.field,'request'))).get()
    const request = requestRef ? archive(tx,{kind:'collection',id:collection.id,field:'request'}) : null
    const commandOriginal = request === null ? null : originalQuery(request)
    const source: PlatformQueryReplaySource = {
      ref, metadata: {titleCode:collection.titleCode,status:collection.status,failureReason:collection.failureReason,rawResponse,collectionEvidence:evidence as RosterImportPlatformQuery['collectionEvidence'] ?? null},
      relationCount:observations.length,
      relationAt: sequenceNo => {
        const o = observations.find(o => o.sequenceNo === sequenceNo)
        if (!o) return undefined
        const a = tx.select().from(s.platformLegacyRelationAlias).where(eq(s.platformLegacyRelationAlias.observationId,o.id)).get()
        if (!a) throw new Error('Missing observation alias')
        const rawText = archive(tx,{kind:'observation',id:o.id,field:'rawFields'})
        const sourceText = archive(tx,{kind:'observation',id:o.id,field:'sourceText'},collection.interface==='business_list'&&[71610,71611,71612,71613].includes(Number(sqlite.pragma('user_version',{simple:true}))))
        const rawFields: unknown = parseOriginalRaw(rawText)
        const values = commandOriginal?.relations?.find(row => row.sequenceNo === o.sequenceNo) ?? legacyOriginal(archive(tx,{kind:'observation',id:o.id,field:'legacyRowSnapshot'})!,o.sequenceNo,collection.interface==='business_list'&&[71610,71611,71612,71613].includes(Number(sqlite.pragma('user_version',{simple:true}))))
        if ((values.sourceText ?? null) !== sourceText) throw new PlatformProjectionError('projection_source_drift','Original source text differs')
        // Original command bytes remain authenticated separately from the stored key.
        const originalKey = commandOriginal && collection.interface==='business_list' && [71610,71611,71612,71613].includes(Number(sqlite.pragma('user_version',{simple:true}))) ? optionalString(values.relationKey) : values.relationKey
        if (platformObservationPayload({interface:collection.interface,relationKey:originalKey,rawFields:values.rawFields}) !== platformObservationPayload({interface:collection.interface,relationKey:o.sourceRelationKey,rawFields})) throw new PlatformProjectionError('projection_source_drift','Original observation archive differs')
        // The typed row owns original position/key; archive data only supplies payload assertions.
        return { id:a.oldId,ref:`relation:${a.oldId}`,values:{...values,relationKey:o.sourceRelationKey,rawFields:rawFields as RosterImportRelation['rawFields']},
          assertOriginal: claimed => {
            if (o.identityState === 'not_indexed') {
              try { bootstrapFingerprint(sqlite,{observationId:o.id,collectionId:collection.id,relationAlias:a.oldId},'reference') } catch(error) { fingerprintFailure(error) }
            } else {
              const table=collection.interface==='apply_list'?s.platformApplyProjection:collection.interface==='business_list'?s.platformBusinessProjection:s.platformRecognizedProjection
              if(!tx.select({id:table.id}).from(table).where(eq(table.observationId,o.id)).get()) reject('platform_relation',`relation:${a.oldId}`,'projection_missing','Original observation source-fidelity owner is missing','relations')
              certifyReplay(sqlite, {observationId:o.id,collectionId:collection.id,relationAlias:a.oldId},collection.interface)
            }
            // New #721 input retains the original typed key; public insertion would
            // apply optionalString. Migrated rows already contain the actual old key.
            const replayKey = commandOriginal ? optionalString(o.sourceRelationKey) : o.sourceRelationKey
            if (platformObservationPayload({interface:collection.interface,relationKey:replayKey,rawFields}) !== platformObservationPayload({interface:collection.interface,...claimed})) throw new PlatformProjectionError('observation_payload_conflict',`Collection row ${a.oldId} has a different key/raw payload`)
          },
        }
      },
    }
    return {source,alias,ref,observations}
}

/** New coordinates require complete #721 input; references do not consume assignments/createdAt. */
export type CollectionTargetCommand = NewCollectionTargetCommand
export function writeCollectionTarget<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, input: CollectionTargetCommand) {
  requireCaptureForeignKeys(db)
  const sqlite = replayConnection(db)
  return db.transaction(tx => {
    if (tx.get<{ user_version: number }>(sql`PRAGMA user_version`)?.user_version !== FINGERPRINT_BASIS_VERSION && tx.get<{ user_version: number }>(sql`PRAGMA user_version`)?.user_version !== 71608 && tx.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version !== 71609 && tx.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version !==71610 && tx.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version!==71611 && tx.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version!==71612 && tx.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version!==71613) throw new Error('Explicit 71607 target required')
    ensureProcessStoredReady(sqlite)
    const q = originalQuery(input.queryText)
    if(tx.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version===71608 && q.interface!=='apply_list')throw new Error('71608 command supports apply_list only')
    if (!isDeepStrictEqual(q.collectionEvidence ?? null,input.evidenceText === null ? null : JSON.parse(input.evidenceText))) throw new Error('Evidence bytes do not match command')
    const queryKey = optionalString(q.queryKey), queriedAt = optionalString(q.queriedAt)
    if (!queryKey) reject('platform_query','query:0','query_key_required','平台查询缺少 queryKey','queryKey')
    if (!queriedAt) reject('platform_query','query:0','queried_at_required','平台查询缺少 queriedAt（查询时点）','queriedAt')
    const c = s.platformCollection
    const plannedCollection = tx.select().from(c).where(and(eq(c.interface,q.interface),eq(c.queryKey,queryKey),eq(c.rdjb,optionalString(q.rdjb) ?? ''),eq(c.queriedAt,queriedAt))).get()
    const planned = plannedCollection ? targetReplaySource(tx,sqlite,plannedCollection) : undefined
    const evidenceError = queryEvidenceError(q,planned?.source,{
      byId: id => tx.select().from(s.enterprise).where(eq(s.enterprise.id,id)).get(),
      byUscc: raw => { const uscc = normalizeUscc(raw); return uscc ? tx.select().from(s.enterprise).where(eq(s.enterprise.usccNorm,uscc)).get() : null },
    })
    if (evidenceError) reject('platform_query','query:0','collection_evidence_invalid',evidenceError,'collectionEvidence')
    for (const [index,row] of (q.relations ?? []).entries()) {
      if (normalizePlatformRelation(q.interface,row).normalizationConflicts.length) reject('platform_relation',`query:0/r${index}`,'platform_field_conflict',`标准字段与原档冲突：${normalizePlatformRelation(q.interface,row).normalizationConflicts.map(c=>c.field).join(', ')}`,'relations')
    }
    if (!planned && q.reuseExisting) reject('platform_query','query:0','query_reuse_missing','No original collection exists at these coordinates','reuseExisting')
    const plannedSource = planned?.source ?? stagedPlatformQuerySource(q,'query:0')
    const plannedConflict = platformQuerySourceConflict(q,plannedSource)
    if (plannedConflict) throw new CollectionReplayError(plannedConflict)
    // The existing public transaction uses original key/time, not the normalized
    // planning coordinate. Both comparisons precede any content materialization.
    const originalCollection = q.queryKey === queryKey && q.queriedAt === queriedAt ? plannedCollection
      : tx.select().from(c).where(and(eq(c.interface,q.interface),eq(c.queryKey,q.queryKey),eq(c.rdjb,optionalString(q.rdjb) ?? ''),eq(c.queriedAt,q.queriedAt))).get()
    // Explicit references may use the existing normalized source, never create one.
    const collection = originalCollection ?? (q.reuseExisting === true ? plannedCollection : undefined)
    if (!collection) {
      if (q.reuseExisting) reject('platform_query','query:0','query_reuse_missing','No original collection exists at these coordinates','reuseExisting')
      return {...writeNewCollectionTarget(tx,input),reused:false}
    }
    const actual = plannedCollection?.id === collection.id && planned ? planned : targetReplaySource(tx,sqlite,collection)
    const {source,alias,ref,observations} = actual
    if (actual !== planned) {
      const conflict = platformQuerySourceConflict(q,source)
      if (conflict) throw new CollectionReplayError(conflict)
    }
    const canonicalProjection: Record<string, unknown>[] = []
    const reused = (q.relations ?? []).map(row => {
      const o = observations.find(o => o.sequenceNo === row.sequenceNo)!
      verifyCandidateObservation(tx, o.id)
      if(collection.interface==='recognized_list')verifyWitnessObservation(sqlite,o.id)
      const a = tx.select().from(s.platformLegacyRelationAlias).where(eq(s.platformLegacyRelationAlias.observationId,o.id)).get()!
      let recordId=o.recordId, versionId=o.versionId
      let completion: Record<string, unknown> = {}
      // Explicit references never bootstrap. An ordinary command must assert original raw.
      if (q.reuseExisting !== true && row.rawFields && typeof row.rawFields === 'object') {
        const table = q.interface === 'apply_list' ? s.platformApplyProjection : q.interface === 'business_list' ? s.platformBusinessProjection : s.platformRecognizedProjection
        const observedSource = tx.select({id:table.id}).from(table).where(eq(table.observationId,o.id)).get()
        if (!observedSource) reject('platform_relation',`relation:${a.oldId}`,'projection_missing','Original observation source-fidelity owner is missing; restore or revalidate T05b instead of deriving historical capture from raw/latest version','relations')
        const original = source.relationAt(row.sequenceNo)!.values
        const plan = planPlatformObservation({interface:q.interface,relationKey:o.sourceRelationKey,rawFields:original.rawFields})
        const recordBefore = plan.platformKey === null ? null : tx.select().from(s.platformBusinessRecord).where(and(eq(s.platformBusinessRecord.interface,q.interface),eq(s.platformBusinessRecord.platformKey,plan.platformKey))).get()
        const versionBefore = !recordBefore || !plan.contentHash ? null : tx.select().from(s.platformBusinessRecordVersion).where(and(eq(s.platformBusinessRecordVersion.recordId,recordBefore.id),eq(s.platformBusinessRecordVersion.hashAlgorithm,PLATFORM_RAW_HASH_RULE),eq(s.platformBusinessRecordVersion.contentHash,plan.contentHash))).get()
        const projectionBefore = versionBefore == null ? null : tx.select().from(table).where(eq(table.versionId,versionBefore.id)).get()
        const content = (() => {
          try { return q.interface === 'apply_list' ? ensureApplyTargetContent(tx,plan,true) : q.interface === 'business_list' ? ensureProcessTargetContent(tx,plan,true) : ensureRecognizedTargetContent(tx,plan,true) }
          catch (error) {
            if (error instanceof Error && ['apply_projection_conflict','business_projection_conflict','recognized_projection_conflict','platform_content_hash_conflict','projection_rule_conflict'].includes(error.message)) reject('platform_relation',`relation:${a.oldId}`,error.message,error.message,'relations')
            throw error
          }
        })()
        if (o.identityState !== 'not_indexed' && (recordId !== content.recordId || versionId !== content.versionId)) reject('platform_relation',`relation:${a.oldId}`,'projection_mapping_conflict','Stored projection does not match original observation','relations')
        recordId=content.recordId;versionId=content.versionId
        const prefix = q.interface === 'apply_list' ? 'apply' : q.interface === 'business_list' ? 'business' : 'recognized'
        completion = {syncRequested:true,observationCreated:o.identityState === 'not_indexed',recordCreated:content.recordId !== null && !recordBefore,versionCreated:content.versionId !== null && !versionBefore,...(content.versionId === null ? {} : {[`${prefix}ProjectionCreated`]:!projectionBefore,[`${prefix}ProjectionReused`]:!!projectionBefore})}

        if (o.identityState === 'not_indexed') {
          try { bootstrapFingerprint(sqlite,{observationId:o.id,collectionId:collection.id,relationAlias:a.oldId},'ordinary') }
          catch(error) { fingerprintFailure(error) }
        }
        certify(sqlite,{observationId:o.id,collectionId:collection.id,relationAlias:a.oldId})
      }
      const current = tx.select().from(s.platformBusinessObservation).where(eq(s.platformBusinessObservation.id,o.id)).get()!
      if (current.identityState !== 'not_indexed') canonicalProjection.push({relationId:a.oldId,recordId,versionId,identityState:current.identityState,contentState:current.contentState,keySource:current.keySource,projectionRuleVersion:current.projectionRuleVersion,inputFingerprint:current.inputFingerprint,recordCreated:false,versionCreated:false,observationCreated:false,...completion})
      return { observationId:o.id,recordId,versionId,relationAlias:a.oldId,reused:true }
    })
    return { collectionId:collection.id,queryAlias:alias.oldId,observations:reused,reused:true,
      item: {ok:true,kind:'platform_query',ref,detail:{relations:[],skipped:new Set((q.relations ?? []).map(r=>r.sequenceNo)).size,canonicalProjection,rowsWritten:0,reuseExisting:true}} satisfies RosterImportItemResult,
    }
  })
}
