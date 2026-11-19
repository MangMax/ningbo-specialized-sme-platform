/** Offline-only frozen stage dependency from ab503081dae3e24680afc9b07395a7e3ff21fc9f. */
/** Recognition-directory stored-cell owner. Evidence parsing is upgrade/replay only. */
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { targetSchema as s } from '../target-schema'
import { recognizedStoredProjection as p } from './recognized-stored-schema'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { rowSnapshot } from '../../layers/sme-roster/lib/platform/sqlite-row-cells'
import { captureSqlFactTitle } from '../../layers/sme-roster/lib/platform/apply-stored-cells'
export { RECOGNIZED_STORED_RULE, recognizedStoredInstalled } from '../recognized-stored-catalog'
import { recognizedStoredInstalled } from '../recognized-stored-catalog'
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const cellSchema = z.object({ name: z.string(), storageClass: z.enum(['text','blob','integer','real','null']), hex: z.string().regex(/^(?:[a-fA-F0-9]{2})*$/), real64be: z.string().optional() })
export type TitleCell = z.infer<typeof cellSchema>
const archiveSchema = z.object({ id: z.number().int().positive().safe(), storage_class: z.enum(['blob','text']), bytes: z.instanceof(Buffer), byte_length: z.number(), sha256: z.string() })
export function recognizedTitleEvidence(t: Database.Database, id: number) {
  const db=drizzle(t,{schema:s})
  const basis=db.select().from(s.platformObservationFingerprintBasis).where(eq(s.platformObservationFingerprintBasis.observationId,id)).get()
  const command=basis?.scheme==='target-command-v1'
  const value=command && basis?.inputArchiveId != null ? db.select().from(s.platformArchiveValue).where(eq(s.platformArchiveValue.id,basis.inputArchiveId)).get()
    : command ? undefined : db.select({value:s.platformArchiveValue}).from(s.platformObservationArchiveRef).innerJoin(s.platformArchiveValue,eq(s.platformArchiveValue.id,s.platformObservationArchiveRef.archiveId)).where(and(eq(s.platformObservationArchiveRef.ownerId,id),eq(s.platformObservationArchiveRef.field,'legacyRowSnapshot'),eq(s.platformObservationArchiveRef.sealed,1))).get()?.value
  if (!value) return null
  const a = archiveSchema.parse({id:value.id,storage_class:value.storageClass,bytes:value.bytes,byte_length:value.byteLength,sha256:value.sha256})
  if (a.bytes.length !== a.byte_length || hash(a.bytes) !== a.sha256) throw new Error('recognized_stored_archive_conflict')
  const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(a.bytes))
  let cell: TitleCell
  if (command) {
    const input = z.object({ collectionId:z.number(),position:z.object({sequenceNo:z.number()}), row: z.object({ rawFields: z.record(z.string(),z.unknown()).nullable().optional() }) }).parse(json)
    const owner=z.object({collection_id:z.number(),sequence_no:z.number(),input_fingerprint:z.string()}).parse(db.select({collection_id:s.platformBusinessObservation.collectionId,sequence_no:s.platformBusinessObservation.sequenceNo,input_fingerprint:s.platformBusinessObservation.inputFingerprint}).from(s.platformBusinessObservation).where(eq(s.platformBusinessObservation.id,id)).get())
    if(owner.collection_id!==input.collectionId||owner.sequence_no!==input.position.sequenceNo||owner.input_fingerprint!==a.sha256)throw new Error('recognized_stored_command_binding_conflict')
    const raw = input.row.rawFields == null ? null : JSON.stringify(input.row.rawFields)
    // Exactly the old insert trigger's string-only/JS trim grammar, never display parsing.
    const title = captureSqlFactTitle(t, raw)
    cell = { name:'title_raw', storageClass:title === null ? 'null':'text', hex:title === null ? '':Buffer.from(title).toString('hex') }
  } else {
    const snapshot = z.object({ encoding:z.literal('t05a-sqlite-cells-v1'), fields:z.array(cellSchema) }).parse(json)
    const found = snapshot.fields.find(c => c.name === 'title_raw')
    if (!found) return null
    cell = found
    const owner = z.object({ old_id:z.number(), query_id:z.number(), sequence_no:z.number() }).parse(db.select({old_id:s.platformLegacyRelationAlias.oldId,query_id:s.platformLegacyQueryAlias.oldId,sequence_no:s.platformBusinessObservation.sequenceNo}).from(s.platformBusinessObservation).innerJoin(s.platformLegacyRelationAlias,eq(s.platformLegacyRelationAlias.observationId,s.platformBusinessObservation.id)).innerJoin(s.platformLegacyQueryAlias,eq(s.platformLegacyQueryAlias.collectionId,s.platformBusinessObservation.collectionId)).where(eq(s.platformBusinessObservation.id,id)).get())
    for (const [name, n] of [['id',owner.old_id],['query_id',owner.query_id],['sequence_no',owner.sequence_no]] as const) {
      const c = snapshot.fields.find(c => c.name === name)
      if (!c || c.storageClass !== 'integer' || Buffer.from(c.hex,'hex').toString() !== String(n)) throw new Error('recognized_stored_coordinate_conflict')
    }
  }
  return { cell, exactTitleState:'captured' as const, exactTitleOrigin:command ? 'commandInput' as const:'legacyRowSnapshot' as const, exactTitleArchiveId:a.id, exactTitleSha256:a.sha256 }
}
/** Byte restoration is offline infrastructure; BLOB affinity retains original SQLite type. */
export function titleCellExpression(c: TitleCell): string {
  if (c.storageClass === 'null') return 'NULL'
  if (c.storageClass === 'blob') return `X'${c.hex}'`
  if (c.storageClass === 'text') return `CAST(X'${c.hex}' AS TEXT)`
  if (c.storageClass === 'integer') return `CAST(X'${c.hex}' AS INTEGER)`
  if (!c.real64be || !/^[a-fA-F0-9]{16}$/.test(c.real64be)) throw new Error('recognized_stored_real_bits')
  const n = Buffer.from(c.real64be,'hex').readDoubleBE()
  if (!Number.isFinite(n)) throw new Error('recognized_stored_real_nonfinite')
  return `CAST('${n}' AS REAL)`
}
export function verifyRecognizedStored(t: Database.Database, id: number) {
  if (!recognizedStoredInstalled(t)) return
  const row=drizzle(t).select().from(p).where(eq(p.observationId,id)).get()
  if (!row || row.exactTitleState !== 'captured') throw new Error('recognized_stored_uncaptured')
  const evidence = recognizedTitleEvidence(t,id)
  if (!evidence || row.exactTitleOrigin !== evidence.exactTitleOrigin || row.exactTitleArchiveId !== evidence.exactTitleArchiveId || row.exactTitleSha256 !== evidence.exactTitleSha256) throw new Error('recognized_stored_binding_conflict')
  const actual = rowSnapshot(t,'platform_recognized_projection','observation_id',id,['exact_title_raw'])[0]!
  if (actual.storageClass !== evidence.cell.storageClass || actual.hex.toUpperCase() !== evidence.cell.hex.toUpperCase() || actual.real64be !== evidence.cell.real64be) throw new Error('recognized_stored_cell_conflict')
}
