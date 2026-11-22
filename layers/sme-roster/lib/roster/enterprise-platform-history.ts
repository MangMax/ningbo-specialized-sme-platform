import type { PlatformStoredQuery, PlatformStoredRelation } from '../platform/read'
import { sourceRelationFields } from '../platform/source-snapshot-fields'
import { checkedBusinessStatus } from '../../../../db/business-status'
/** Enterprise history membership is structured. Archives attach only after selection.
 * Qualification, coverage and business grouping continue to consume original facts.
 */
import { and, eq, inArray, max, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../../../db/schema'
import { targetSchema as t } from '../platform/target-schema'
import { identityUsccSql } from './enterprise-read-snapshot'
import { normalizeUscc } from '../domain'
import { resolveSelectedLegacyProvenance } from '../platform/target-legacy-provenance'
import { assertTargetDisplayBudget } from '../platform/target-query-budget'
import { readTargetCollectionDisplay } from '../platform/target-query-display'
import { readTargetRelationDisplay } from '../platform/target-relation-display'
import { cellExpression } from '../platform/target-evidence-read'
import { snapshotSchema } from '../platform/evidence-snapshot-model'

type Db = BetterSQLite3Database<typeof s>
const chunks = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / 300) }, (_, i) => items.slice(i * 300, i * 300 + 300))

export function readEnterpriseTargetPlatformHistory(db: Db, enterprise: typeof s.enterprise.$inferSelect, evidenceIds: number[]) {
  const c = t.platformCollection, qa = t.platformLegacyQueryAlias, o = t.platformBusinessObservation
  const ra = t.platformLegacyRelationAlias, a = t.platformObservationAssignment
  const newer = alias(a, 'enterprise_history_newer')
  const current = and(eq(a.observationId, o.id), eq(a.revision, db.select({ n: max(newer.revision) }).from(newer).where(eq(newer.observationId, o.id))))
  const uscc = normalizeUscc(enterprise.usccNorm) || null
  const owned = db.select({ collectionId: o.collectionId }).from(o).innerJoin(a, current).where(eq(a.enterpriseId, enterprise.id))
  // Match normalized USCC and the exact lowercase name: key.
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
  const queries: PlatformStoredQuery[] = allOwners.map(({ collection: q, id }) => ({
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
  const relations = owners.map(owner => {
    if (!owner.displayed) return {
      id: owner.relationId, queryId: owner.queryId, sequenceNo: owner.sequenceNo, relationKey: owner.relationKey,
      enterpriseId: owner.enterpriseId, matchBasis: owner.matchBasis, verificationStatus: owner.verificationStatus,
      sourceText: null, rawFields: null, nameRaw: null, usccRaw: null, aliasNameRaw: null,
      titleRaw: null, province: null, status: null, batch: null, declareKind: null, appliedAt: null,
      awardBatchLabel: null, year: null, createdAt: '',
    } satisfies PlatformStoredRelation
    const cells = snapshots.get(owner.observationId)!
    return db.select({
      id: sql<number>`${owner.relationId}`, queryId: sql<number>`${owner.queryId}`,
      sequenceNo: sql<number>`${owner.sequenceNo}`, relationKey: sql<string | null>`${owner.relationKey}`,
      enterpriseId: sql<number | null>`${owner.enterpriseId}`, matchBasis: sql<typeof owner.matchBasis>`${owner.matchBasis}`,
      verificationStatus: sql<typeof owner.verificationStatus>`${owner.verificationStatus}`,
      ...originalColumns(cells, allOwners.find(row=>row.id===owner.queryId)?.collection.interface === 'business_list'),
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

function originalColumns(cells: ReturnType<typeof snapshotSchema.parse>['fields'], business: boolean) {
  function cell(key: keyof typeof sourceRelationFields) {
    const descriptor = sourceRelationFields[key], found = cells.find(cell => cell.name === descriptor.name)
    if (!found) throw new Error(`Missing original enterprise relation cell: ${descriptor.name}`)
    return cellExpression(found)
  }
  const text = (key: keyof typeof sourceRelationFields) => cell(key).mapWith(String)
  return { rawFields: cell('rawFields').mapWith((value: string) => JSON.parse(value)), sourceText: text('sourceText'), usccRaw: text('usccRaw'), nameRaw: text('nameRaw'),
    aliasNameRaw: text('aliasNameRaw'), titleRaw: text('titleRaw'), province: text('province'), status: business ? cell('status').mapWith(checkedBusinessStatus) : text('status'),
    batch: text('batch'), declareKind: text('declareKind'), appliedAt: text('appliedAt'),
    awardBatchLabel: text('awardBatchLabel'), year: cell('year').mapWith(Number), createdAt: text('createdAt') }
}
