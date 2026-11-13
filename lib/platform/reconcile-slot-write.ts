/** Selected-original authentication and new-write capture; never a business selector. */
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { and, asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import { targetSchema as s, platformReconcileCapture as c } from './target-schema'
import { migrationFinished } from './migration-readiness'
import { captureReconcileSlot, RECONCILE_SLOT_COMPLETION, slotFallbackColumns, type SlotInput, type SlotRelation } from './reconcile-slot-capture'
import { sourceFieldComparison } from './source-extraction'

const columns = ['reconcile_slot_state','reconcile_slot_rule','reconcile_slot_raw_archive_id','reconcile_slot_row_count','reconcile_slot_input_sha256','reconcile_slot_reason']
const barriers = ['reconcile_slot_insert','reconcile_slot_binding','reconcile_slot_immutable','reconcile_slot_delete','reconcile_slot_observation_insert','reconcile_slot_observation_update','reconcile_slot_observation_delete']
/** Old nonvariant writers remain available. A partially installed variant never does. */
export function reconcileSlotWriteInstalled(t: Database.Database) {
  const names = t.prepare('SELECT name FROM pragma_table_info(?)').all('platform_collection') as { name: string }[]
  const present = columns.filter(name => names.some(c => c.name === name))
  const completed = migrationFinished(t, RECONCILE_SLOT_COMPLETION)
  if (!present.length && !completed && !t.prepare("SELECT 1 FROM sqlite_schema WHERE name LIKE 'reconcile_slot_%' LIMIT 1").get()) return false
  const fk = t.pragma('foreign_key_list(platform_collection)') as { from: string; table: string; to: string; on_delete: string }[]
  if (t.pragma('user_version', { simple: true }) !== 71613 || present.length !== columns.length || !completed
    || !fk.some(f => f.from === 'reconcile_slot_raw_archive_id' && f.table === 'platform_archive_value' && f.to === 'id' && f.on_delete === 'RESTRICT')
    || barriers.some(name => !t.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name=?").get(name))) {
    throw new Error('Reconcile capture target NOTREADY')
  }
  return true
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function archive(t: Database.Database, kind: 'collection'|'observation', id: number, field: string) {
  const db = drizzle(t), r = kind === 'collection' ? s.platformCollectionArchiveRef : s.platformObservationArchiveRef
  const found = db.select({ value: s.platformArchiveValue, sealed: r.sealed }).from(r)
    .innerJoin(s.platformArchiveValue, eq(s.platformArchiveValue.id, r.archiveId))
    .where(and(eq(r.ownerId, id), eq(r.field, field as typeof r.$inferSelect.field))).get()
  if (!found || found.sealed !== 1) throw new Error('Missing sealed reconcile original input')
  const a = found.value
  if (a.storageClass === 'null' ? a.bytes !== null || a.byteLength !== null || a.sha256 !== null
    : !Buffer.isBuffer(a.bytes) || a.bytes.length !== a.byteLength || hash(a.bytes) !== a.sha256) throw new Error('Reconcile original archive drift')
  return a
}
const snapshotShape = z.object({
  encoding: z.literal('t05a-sqlite-cells-v1'),
  fields: z.array(z.object({ name: z.string(), storageClass: z.enum(['null','text','integer','real','blob']), hex: z.string().regex(/^(?:[0-9a-fA-F]{2})*$/), real64be: z.string().optional() })),
})
function observationOriginal(t: Database.Database, id: number) {
  const snapshot = archive(t, 'observation', id, 'legacyRowSnapshot')
  if (snapshot.storageClass !== 'blob' || !snapshot.bytes) throw new Error('Missing reconcile original cells')
  const { fields } = snapshotShape.parse(JSON.parse(snapshot.bytes.toString('utf8')))
  if (new Set(fields.map(f => f.name)).size !== fields.length) throw new Error('Duplicate reconcile original cell')
  const cell = (name: string) => {
    const found = fields.find(f => f.name === name)
    if (!found) throw new Error('Missing reconcile original cell: ' + name)
    return found
  }
  const value = (name: string) => {
    const c = cell(name), bytes = Buffer.from(c.hex, 'hex')
    switch (c.storageClass) {
      case 'null': return null
      case 'blob': return bytes
      case 'text': return bytes.toString('utf8')
      case 'integer': {
        const n = Number(bytes.toString('utf8'))
        if (!Number.isSafeInteger(n)) throw new Error('Unrepresentable reconcile integer')
        return n
      }
      case 'real': {
        if (!c.real64be || !/^[0-9a-fA-F]{16}$/.test(c.real64be)) throw new Error('Missing reconcile REAL bits')
        return Buffer.from(c.real64be, 'hex').readDoubleBE()
      }
    }
  }
  const text = (name: string): string|null => {
    const v = value(name)
    if (v !== null && typeof v !== 'string') throw new Error('Invalid reconcile TEXT cell: ' + name)
    return typeof v === 'string' ? v : null
  }
  const integer = (name: string) => {
    const v = value(name)
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Error('Invalid reconcile integer cell: ' + name)
    return v
  }
  const raw = archive(t, 'observation', id, 'rawFields')
  if (raw.storageClass !== cell('raw_fields').storageClass || (raw.bytes?.toString('hex') ?? '').toUpperCase() !== cell('raw_fields').hex.toUpperCase()) throw new Error('Reconcile raw/cell drift')
  let decoded: { rawFields: SlotRelation['rawFields'] } | { error: string }
  try {
    // The old ORM's JSON boundary, including its errors and JS primitive behavior.
    decoded = { rawFields: raw.storageClass === 'null' ? null : JSON.parse(raw.bytes!.toString('utf8')) }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    decoded = { error: error.name + ': ' + error.message }
  }
  const yearValue = value('year'), statusValue = value('status')
  if (yearValue !== null && typeof yearValue !== 'number') throw new Error('Invalid reconcile year cell')
  if (statusValue !== null && typeof statusValue !== 'string' && !Buffer.isBuffer(statusValue)) throw new Error('Invalid reconcile status cell')
  const year = typeof yearValue === 'number' ? yearValue : null
  const status = typeof statusValue === 'string' || Buffer.isBuffer(statusValue) ? statusValue : null
  const row = { id: integer('id'), sequenceNo: integer('sequence_no'), relationKey: text('relation_key'), nameRaw: text('name_raw'), usccRaw: text('uscc_raw'),
    province: text('province'), status, batch: text('batch'), declareKind: text('declare_kind'), appliedAt: text('applied_at'), awardBatchLabel: text('award_batch_label'), year }
  return { row, decoded, queryId: integer('query_id'), raw,
    fallbackCells: slotFallbackColumns.map(name => { const { storageClass, hex } = cell(name); return { name, storageClass, hex } }) }
}
/** The seven stored values come from the same sealed old-insert materialization as capture. */
export function reconcileStoredObservation(t: Database.Database, id: number) {
  return observationOriginal(t, id).row
}
export function reconcileStoredApplyObservation(t: Database.Database, id: number) {
  const row = reconcileStoredObservation(t, id), status = row.status
  if (status !== null && typeof status !== 'string') throw new Error('Non-business stored status must be TEXT')
  return { ...row, status: typeof status === 'string' ? status : null }
}
/** Independent source calls cannot extend even a captured miss's original row set. */
export function requireReconcileObservationWrite(t: Database.Database, collectionId: number, existing: boolean) {
  if (!reconcileSlotWriteInstalled(t)) return
  const row = drizzle(t).select().from(c).where(eq(c.id, collectionId)).get()
  if (!row) throw new Error('Missing reconcile collection')
  if (row.rule !== null) {
    if (!existing) throw new Error('Immutable reconcile captured row set')
    verifyReconcileSlot(t, collectionId)
  }
}
function expectedCapture(t: Database.Database, collectionId: number, projections: boolean) {
  const db = drizzle(t), collection = db.select().from(s.platformCollection).where(eq(s.platformCollection.id, collectionId)).get()
  const alias = db.select().from(s.platformLegacyQueryAlias).where(eq(s.platformLegacyQueryAlias.collectionId, collectionId)).get()
  if (!collection || !alias) throw new Error('Missing reconcile collection/alias')
  const raw = archive(t, 'collection', collectionId, 'rawResponse')
  const query = { ...collection, id: alias.oldId }
  const observations = db.select().from(s.platformBusinessObservation).where(eq(s.platformBusinessObservation.collectionId, collectionId)).orderBy(asc(s.platformBusinessObservation.sequenceNo)).all()
  const originals = observations.map(o => {
    const original = observationOriginal(t, o.id)
    const a = db.select().from(s.platformLegacyRelationAlias).where(eq(s.platformLegacyRelationAlias.observationId, o.id)).get()
    if (!a || a.oldId !== original.row.id || alias.oldId !== original.queryId || o.sequenceNo !== original.row.sequenceNo || o.sourceRelationKey !== original.row.relationKey) throw new Error('Reconcile original observation mapping drift')
    if (projections && collection.interface !== 'recognized_list' && !('error' in original.decoded)) {
      const p = collection.interface === 'business_list' ? s.platformBusinessProjection : s.platformApplyProjection
      const actual = db.select().from(p).where(eq(p.observationId, o.id)).get()
      const rawFields = original.decoded.rawFields
      const parsed = rawFields && typeof rawFields === 'object' && !Array.isArray(rawFields) ? rawFields : null
      const facts = sourceFieldComparison(collection.interface, original.row, parsed, original.raw.storageClass === 'null' ? 'absent' : parsed ? 'valid' : 'invalid')
      if (!actual || Object.entries(facts).some(([key, value]) => !isDeepStrictEqual(Reflect.get(actual, key), value))) throw new Error('Reconcile per-observation materialization drift')
    }
    return original
  })
  const input: SlotInput = { query,
    rawResponse: { storageClass: raw.storageClass, byteLength: raw.byteLength, sha256: raw.sha256 },
    relations: originals.map(o => ({ id: o.row.id, sequenceNo: o.row.sequenceNo, rawFields: { storageClass: o.raw.storageClass, byteLength: o.raw.byteLength, sha256: o.raw.sha256 }, fallbackCells: o.fallbackCells })),
  }
  const rows: SlotRelation[] = []
  let decoded: Parameters<typeof captureReconcileSlot>[3] = { rows }
  for (const o of originals) {
    if ('error' in o.decoded) { decoded = o.decoded; break }
    rows.push({ ...o.row, rawFields: o.decoded.rawFields })
  }
  return captureReconcileSlot(input, raw.id, raw.bytes === null ? null : raw.bytes.toString('utf8'), decoded)
}
export function captureNewReconcileSlot(t: Database.Database, collectionId: number) {
  if (!reconcileSlotWriteInstalled(t)) return
  const db = drizzle(t), prior = db.select().from(c).where(eq(c.id, collectionId)).get()
  if (!prior || prior.state !== 'uncaptured' || prior.rule !== null || prior.reason !== null) throw new Error('Reconcile capture already finalized')
  db.update(c).set(expectedCapture(t, collectionId, true)).where(eq(c.id, collectionId)).run()
}
/** Read-only authentication: no upgrading misses, partial collections, aliases or archives. */
export function verifyReconcileSlot(t: Database.Database, collectionId: number) {
  if (!reconcileSlotWriteInstalled(t)) return
  const db = drizzle(t), stored = db.select({ state: c.state, rule: c.rule, rawArchiveId: c.rawArchiveId, rowCount: c.rowCount, inputSha256: c.inputSha256, reason: c.reason }).from(c).where(eq(c.id, collectionId)).get()
  if (!stored || stored.state === 'uncaptured' && stored.reason !== 'not_legacy_slot') throw new Error('Reconcile original capture unavailable')
  if (!isDeepStrictEqual(stored, expectedCapture(t, collectionId, true))) throw new Error('Reconcile original capture drift')
}
