/** Enterprise history membership is structured. Archives attach only after selection.
 * Qualification, coverage and business grouping continue to consume original facts.
 */
import { and, eq, getTableColumns, inArray, max, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../db/schema'
import { targetSchema as t } from '../platform/target-schema'
import { identityUsccSql } from './enterprise-read-snapshot'
import { normalizeUscc } from '../domain'
import { resolveSelectedLegacyProvenance } from '../platform/target-legacy-provenance'
import { assertTargetDisplayBudget } from '../platform/target-query-budget'
import { readTargetCollectionDisplay } from '../platform/target-query-display'
import { readTargetRelationDisplay } from '../platform/target-relation-display'
import { cellExpression, snapshotSchema } from '../platform/target-evidence-read'

type Db = BetterSQLite3Database<typeof s>
const chunks = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / 300) }, (_, i) => items.slice(i * 300, i * 300 + 300))

export function readEnterpriseTargetPlatformHistory(db: Db, enterprise: typeof s.enterprise.$inferSelect, evidenceIds: number[]) {
  const c = t.platformCollection, qa = t.platformLegacyQueryAlias, o = t.platformBusinessObservation
  const ra = t.platformLegacyRelationAlias, a = t.platformObservationAssignment
  const newer = alias(a, 'enterprise_history_newer')
  const current = and(eq(a.observationId, o.id), eq(a.revision, db.select({ n: max(newer.revision) }).from(newer).where(eq(newer.observationId, o.id))))
  const uscc = normalizeUscc(enterprise.usccNorm) || null
  const owned = db.select({ collectionId: o.collectionId }).from(o).innerJoin(a, current).where(eq(a.enterpriseId, enterprise.id))
  // Match the schema0 normalized key branch, including its exact lowercase name: key.
  const selected = db.select({ collection: c, id: qa.oldId }).from(c).innerJoin(qa, eq(qa.collectionId, c.id)).where(or(
    eq(c.queryKey, `name:${enterprise.nameNorm}`),
    uscc === null ? undefined : sql`${uscc.includes(':') ? sql`1` : sql`instr(${c.queryKey},':')=0`} and ${identityUsccSql(sql`${c.queryKey}`)}=${uscc}`,
    inArray(c.id, owned),
  )).all()
  const ownQueryIds = selected.map(row => row.id)
  const ownSet = new Set(ownQueryIds)
  const explanationOwners = chunks([...new Set(evidenceIds.filter(id => !ownSet.has(id)))]).flatMap(ids =>
    db.select({ collection: c, id: qa.oldId }).from(c).innerJoin(qa, eq(qa.collectionId, c.id)).where(inArray(qa.oldId, ids)).all())
  const allOwners = [...selected, ...explanationOwners]
  const recognized = selected.filter(row => row.collection.interface === 'recognized_list').map(row => row.collection.id)
  const displayed = or(eq(a.enterpriseId, enterprise.id), sql`${o.collectionId} in (select value from json_each(${JSON.stringify(recognized)}))`)!
  // Keep every explanation row ID, but hydrate only rows the enterprise actually displays.
  const owners = chunks(allOwners.map(row => row.collection.id)).flatMap(ids =>
    db.select({ relationId: ra.oldId, queryId: qa.oldId, observationId: o.id, sequenceNo: o.sequenceNo,
      relationKey: o.sourceRelationKey, enterpriseId: a.enterpriseId, matchBasis: a.matchBasis,
      verificationStatus: a.verificationStatus, displayed: sql<number>`case when ${displayed} then 1 else 0 end` })
      .from(o).innerJoin(ra, eq(ra.observationId, o.id)).innerJoin(qa, eq(qa.collectionId, o.collectionId)).innerJoin(a, current)
      .where(and(inArray(o.collectionId, ids), or(displayed, sql`${qa.oldId} in (select value from json_each(${JSON.stringify(evidenceIds)}))`))).all())
  const legacy = resolveSelectedLegacyProvenance(db, selected)
  assertTargetDisplayBudget(db, selected, legacy)
  const displays = readTargetRelationDisplay(db, owners.filter(row => row.displayed).map(row => ({ relationId: row.relationId, queryId: row.queryId })),
    { fullCollectionEvidence: true, legacy, budgetChecked: true }).sources
  const queryDisplays = new Map(chunks(selected).flatMap(rows => [...readTargetCollectionDisplay(db, rows, false, legacy)]))
  const queries: (typeof s.platformQuery.$inferSelect)[] = allOwners.map(({ collection: q, id }) => ({
    id, interface: q.interface, queryKey: q.queryKey, rdjb: q.rdjb, titleCode: q.titleCode,
    queriedAt: q.queriedAt, lastCollectedAt: q.lastCollectedAt, status: q.status,
    failureReason: q.failureReason, createdAt: q.createdAt, rawResponse: null,
    collectionEvidence: queryDisplays.get(q.id)?.collectionEvidence ?? null,
  }))
  // Retain original stored fields for the existing normalization/business grouping.
  // Shared display above authenticates the selected snapshots and original source archives.
  // These cells never participate in membership, counts or ordering.
  const ar = t.platformObservationArchiveRef, av = t.platformArchiveValue
  const snapshots = new Map(chunks(owners.filter(row => row.displayed).map(row => row.observationId)).flatMap(ids =>
    db.select({ id: ar.ownerId, bytes: av.bytes }).from(ar).innerJoin(av, eq(av.id, ar.archiveId))
      .where(and(inArray(ar.ownerId, ids), eq(ar.field, 'legacyRowSnapshot'))).all()).map(row => {
    if (!row.bytes) throw new Error('Missing selected enterprise relation snapshot')
    return [row.id, snapshotSchema.parse(JSON.parse(row.bytes.toString('utf8'))).fields] as const
  }))
  const columns = getTableColumns(s.platformRelation)
  const relations = owners.map(owner => {
    if (!owner.displayed) return {
      id: owner.relationId, queryId: owner.queryId, sequenceNo: owner.sequenceNo, relationKey: owner.relationKey,
      enterpriseId: owner.enterpriseId, matchBasis: owner.matchBasis, verificationStatus: owner.verificationStatus,
      sourceText: null, rawFields: null, nameRaw: null, usccRaw: null, aliasNameRaw: null,
      titleRaw: null, province: null, status: null, batch: null, declareKind: null, appliedAt: null,
      awardBatchLabel: null, year: null, createdAt: '',
    } satisfies typeof s.platformRelation.$inferSelect
    const cells = snapshots.get(owner.observationId)!
    return db.select({
      id: sql<number>`${owner.relationId}`, queryId: sql<number>`${owner.queryId}`,
      sequenceNo: sql<number>`${owner.sequenceNo}`, relationKey: sql<string | null>`${owner.relationKey}`,
      enterpriseId: sql<number | null>`${owner.enterpriseId}`, matchBasis: sql`${owner.matchBasis}`.mapWith(columns.matchBasis),
      verificationStatus: sql`${owner.verificationStatus}`.mapWith(columns.verificationStatus),
      ...originalColumns(cells, columns),
    }).from(o).where(eq(o.id, owner.observationId)).get()!
  })
  return { queries, relations, ownQueryIds,
    legacyById: new Map(selected.flatMap(row => {
      const value = queryDisplays.get(row.collection.id)?.legacyProvenance
      return value ? [[row.id, value] as const] : []
    })),
    positionsById: new Map([...displays].map(([id, row]) => [id, { sourceRdjb: row?.sourceRdjb, sourcePage: row?.sourcePage }])),
  }
}

function originalColumns(cells: ReturnType<typeof snapshotSchema.parse>['fields'], columns: ReturnType<typeof getTableColumns<typeof s.platformRelation>>) {
  function cell<K extends keyof typeof columns>(key: K) {
    const column = columns[key], found = cells.find(cell => cell.name === column.name)
    if (!found) throw new Error(`Missing original enterprise relation cell: ${column.name}`)
    return cellExpression(found).mapWith(column)
  }
  return { rawFields: cell('rawFields'), sourceText: cell('sourceText'), usccRaw: cell('usccRaw'), nameRaw: cell('nameRaw'),
    aliasNameRaw: cell('aliasNameRaw'), titleRaw: cell('titleRaw'), province: cell('province'), status: cell('status'),
    batch: cell('batch'), declareKind: cell('declareKind'), appliedAt: cell('appliedAt'),
    awardBatchLabel: cell('awardBatchLabel'), year: cell('year'), createdAt: cell('createdAt') }
}
