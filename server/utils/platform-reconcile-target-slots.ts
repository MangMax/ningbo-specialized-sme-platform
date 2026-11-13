/** Explicit decision reader for completed capture targets. Ordinary guards stay closed. */
import type Database from 'better-sqlite3'
import { and, asc, eq, or } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { alias } from 'drizzle-orm/sqlite-core'
import { targetSchema as s, platformReconcileCapture as capture } from '../../lib/platform/target-schema'
import { sqliteConnection } from '../../lib/platform/target-connection'
import { requireH1cReady } from '../../lib/platform/h1c-catalog'
import { reconcileSlotWriteInstalled, selectedReconcileCollectionInput, selectedReconcileObservationInput } from '../../lib/platform/reconcile-slot-write'
import { RECONCILE_SLOT_RULE, slotLegacyRow, slotPayloadRow } from '../../lib/platform/reconcile-slot-capture'
import { platformNormalizationConflict } from '../../lib/platform/normalization'
import { targetReplaySource } from '../../lib/platform/collection-target-replay'
import { snapshotStoredReplayInput } from '../../lib/platform/reconcile-replay-input'
import type { StoredSlot, ReconcileRunOptions } from './platform-reconcile'

type Db = ReconcileRunOptions['db']
const slotCapture = alias(capture, 'slot_capture')
type CandidateOrder = { collection: Pick<typeof s.platformCollection.$inferSelect, 'queriedAt'>; id: number }
/** id is the public query alias. Physical collection IDs never break a tie. */
export function compareReconcileSlotCollections(a: CandidateOrder, b: CandidateOrder) {
  return b.collection.queriedAt.localeCompare(a.collection.queriedAt) || b.id - a.id
}
export interface ReconcileTargetSlotReader {
  assertConnection(db: Db): void
  read(db: Db, queryKey: string, cutoffIso: string): Map<string, StoredSlot>
}
const fields = ['province', 'status', 'batch', 'declareKind', 'appliedAt', 'awardBatchLabel', 'year'] as const
type Projection = typeof s.platformBusinessProjection.$inferSelect | typeof s.platformApplyProjection.$inferSelect
function comparison(source: Projection) {
  const tuples = {
    province: [source.provinceConflict, source.storedProvince, source.parsedProvince],
    status: [source.statusConflict, source.storedStatus, source.parsedStatus],
    batch: [source.batchConflict, source.storedBatch, source.parsedBatch],
    declareKind: [source.declareKindConflict, source.storedDeclareKind, source.parsedDeclareKind],
    appliedAt: [source.appliedAtConflict, source.storedAppliedAt, source.parsedAppliedAt],
    awardBatchLabel: [source.awardBatchLabelConflict, source.storedAwardBatchLabel, source.parsedAwardBatchLabel],
    year: [source.yearConflict, source.storedYear, source.parsedYear],
  } satisfies Record<typeof fields[number], [number | null, string | number | Buffer | null, string | number | null]>
  return {
    province: source.reconciledProvince, status: source.reconciledStatus, batch: source.reconciledBatch,
    declareKind: source.reconciledDeclareKind, appliedAt: source.reconciledAppliedAt,
    awardBatchLabel: source.reconciledAwardBatchLabel, year: source.reconciledYear,
    normalizationConflicts: fields.flatMap(field => {
      const [conflict, stored, raw] = tuples[field]
      return conflict && stored !== null && raw !== null ? [platformNormalizationConflict(field, stored, raw)] : []
    }),
  }
}

/** Creation does no I/O; every call verifies identity/readiness inside its snapshot. */
export function createReconcileTargetSlotReader(connection: Database.Database): ReconcileTargetSlotReader {
  function assertConnection(db: Db) {
    if (sqliteConnection(db) !== connection) throw new Error('Reconcile target reader connection mismatch')
    requireH1cReady(connection)
    if (!reconcileSlotWriteInstalled(connection)) throw new Error('Reconcile capture target NOTREADY')
  }
  return {
    assertConnection,
    read(db, queryKey, cutoffIso) {
      return db.transaction(tx => {
        assertConnection(tx)
        const target = drizzle(connection), c = s.platformCollection, a = s.platformLegacyQueryAlias
        const candidates = target.select({ collection: c, id: a.oldId, capture: slotCapture }).from(c)
          .innerJoin(a, eq(a.collectionId, c.id)).innerJoin(slotCapture, eq(slotCapture.id, c.id))
          .where(and(eq(c.queryKey, queryKey), or(
            and(eq(c.interface, 'business_list'), or(eq(c.rdjb, '1'), eq(c.rdjb, '2'), eq(c.rdjb, '3'))),
            and(eq(c.interface, 'apply_list'), eq(c.rdjb, '')),
          ))).all().sort(compareReconcileSlotCollections)
        const selected = new Map<string, typeof candidates[number]>()
        for (const row of candidates) {
          const key = `${row.collection.interface}|${row.collection.rdjb}`
          if (!selected.has(key)) selected.set(key, row)
        }
        const result = new Map<string, StoredSlot>()
        for (const [key, { collection: c, capture: state }] of selected) {
          if (c.status !== 'success' && c.status !== 'no_record' || c.queriedAt < cutoffIso) continue
          if (state.state === 'uncaptured') throw new Error('Reconcile capture target NOTREADY: selected slot uncaptured')
          if (state.rule !== RECONCILE_SLOT_RULE) throw new Error('Reconcile capture target NOTREADY: unsupported rule')
          if (state.state === 'miss') continue
          if (state.state === 'error') throw new SyntaxError((state.reason ?? '').replace(/^SyntaxError: /, ''))
          if (state.rawArchiveId === null || state.rowCount === null) throw new Error('Reconcile capture target NOTREADY: missing binding')
          const o = s.platformBusinessObservation, original = s.platformObservationAssignment
          const observations = target.select({ observation: o, original }).from(o)
            .innerJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
            .where(eq(o.collectionId, c.id)).orderBy(asc(o.sequenceNo)).all()
          if (observations.length !== state.rowCount) throw new Error('Reconcile selected observation count drift')
          if ((c.status === 'no_record') !== (observations.length === 0)) continue
          // All classification facts are source-owned and observation-local, even without a version.
          const facts = observations.map(({ observation, original }) => {
            const p = c.interface === 'business_list' ? s.platformBusinessProjection : s.platformApplyProjection
            const projection = target.select().from(p).where(eq(p.observationId, observation.id)).get()
            if (!projection) throw new Error('Missing reconcile observation source facts')
            return { observation, original, facts: comparison(projection) }
          })
          // Only now may selected original owners hydrate typed payloads and report pages.
          const originals = observations.map(({ observation }) => selectedReconcileObservationInput(connection, observation.id))
          const collection = selectedReconcileCollectionInput(connection, c.id, state.rawArchiveId)
          const payloadRows = originals.map(slotPayloadRow)
          const { source } = targetReplaySource(target, connection, c, 'after_assertions')
          result.set(key, {
            kind: 'stored',
            original: snapshotStoredReplayInput(c, source, observations.map(({ observation }) => observation.sequenceNo)),
            titleCode: c.titleCode,
            collection, raw: '', payloadRows, rawRows: originals.map(slotLegacyRow),
            evidence: {
              interface: c.interface, rdjb: c.rdjb, queriedAt: c.queriedAt, status: c.status,
              completeness: 'complete', failureReason: c.failureReason,
              relations: facts.map(({ observation, original, facts }, index) => ({
                interface: c.interface, rdjb: c.rdjb, sequenceNo: observation.sequenceNo,
                relationKey: observation.sourceRelationKey, nameRaw: original.nameRaw, usccRaw: original.usccRaw,
                ...facts, sourceKind: c.interface === 'business_list' ? 'platform_business' : 'platform_apply',
                rawFields: payloadRows[index]!,
              })),
            },
          })
        }
        return result
      })
    },
  }
}
