import { and, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { differencePublicColumns } from '../platform/difference-reference-target'
import { readCorrespondenceTargetQueries, readCorrespondenceTargetSources, correspondenceQueryRelationIds } from '../../server/utils/record-correspondence-target-sources'
import { currentEnterpriseIdentity } from './enterprise-identity'
import { readEnterpriseHistories } from './enterprise-read-snapshot'
import { selectEnterpriseCoordinates, removedEnterpriseIds } from './enterprise-list-selection'
import { projectRosterEnterprisePage, rosterPageOf, type Snapshot, type RosterEnterpriseRow, type RosterEnterpriseFilter, type RosterCounts, type RosterEnterprisesResult } from './enterprise-roster-projection'

export * from './enterprise-roster-projection'
export { readPublicPublishedNames } from './official-published-presentation-sqlite'

type Db = BetterSQLite3Database<typeof schema>

/** Differences need coordinates and evidence pointers, never archive bodies. */
export function readDifferenceSnapshot(db: Db, ids?: number[]): Snapshot {
  const d = schema.differenceReason
  // Global counts/sort use only narrow current-coordinate metadata. Large notes,
  // actors and evidence are hydrated for the selected page only.
  const differences = db.select({ ...differencePublicColumns(db),
    ...(ids == null ? { reasonNote: sql<null>`null`, measureNote: sql<null>`null`, movedInCity: sql<null>`null`, movedInTitleCode: sql<null>`null`, movedInYear: sql<null>`null`, movedInBatch: sql<null>`null`, basis: sql<null>`null`, actor: sql<null>`null`, requestHash: sql<null>`null`, idempotencyKey: sql<null>`null` } : {}),
  }).from(d).where(and(ids == null ? undefined : inArray(d.enterpriseId, ids), sql`not exists (select 1 from difference_reason newer where newer.enterprise_id=${d.enterpriseId} and newer.title_code=${d.titleCode} and newer.direction=${d.direction} and (newer.recorded_at>${d.recordedAt} or (newer.recorded_at=${d.recordedAt} and newer.id>${d.id})))`)).all()
  const queryIds = [...new Set(differences.flatMap(d => d.evidenceQueryId == null ? [] : [d.evidenceQueryId]))]
  return {
    enterprises: db.select().from(schema.enterprise).where(and(currentEnterpriseIdentity(db), ids == null ? undefined : inArray(schema.enterprise.id, ids))).all(),
    records: db.select().from(schema.record).where(ids == null ? undefined : inArray(schema.record.enterpriseId, ids)).all(),
    aliases: ids == null ? db.select().from(schema.enterpriseAlias).all() : [], differences,
    queries: ids == null ? [] : [...readCorrespondenceTargetQueries(db, queryIds, { rawResponse: false }).values()].map(({ query, collection }) => ({
      id: query.id, interface: collection.interface, queryKey: collection.queryKey, rdjb: collection.rdjb, titleCode: collection.titleCode,
      queriedAt: collection.queriedAt, lastCollectedAt: collection.lastCollectedAt, status: collection.status,
      failureReason: collection.failureReason, createdAt: collection.createdAt, rawResponse: null, collectionEvidence: null,
    })),
    relations: ids == null ? [] : readCorrespondenceTargetSources(db, queryIds.flatMap(queryId => correspondenceQueryRelationIds(db, queryId))).map(row => ({ ...row.relation, rawFields: null, sourceText: null })),
    events: [], evidence: [], exportRows: [], exportBatches: [], recordsByEnterprise: new Map(), eventsByRecord: new Map(),
  }
}

/**
 * 总表:一行 = 一家企业。筛选作用于企业;`counts` 与筛选**同口径**、且**先于分页**。
 */
export function listRosterEnterprises(db: Db, filter: RosterEnterpriseFilter = {}): RosterEnterprisesResult {
  const { rows, counts } = db.transaction(() => selectRosterEnterprises(db, filter, true))
  const { page, pageSize } = rosterPageOf(filter)
  return {
    rows,
    counts,
    page,
    pageSize,
  }
}

/**
 * 不分页地取**全部**匹配企业(导出用)。口径与 `listRosterEnterprises` 共用同一处实现 ——
 * 「筛选与导出同一口径」不是靠对齐两段代码,而是它们本来就是同一段。
 */
export function allRosterEnterprises(
  db: Db,
  filter: Omit<RosterEnterpriseFilter, 'page' | 'pageSize'> = {},
): { rows: RosterEnterpriseRow[]; counts: RosterCounts } {
  return db.transaction(() => selectRosterEnterprises(db, filter))
}

function selectRosterEnterprises(
  db: Db,
  filter: RosterEnterpriseFilter,
  paginate = false,
): { rows: RosterEnterpriseRow[]; counts: RosterCounts } {
  const { page, pageSize } = rosterPageOf(filter)
  const { candidates, counts } = selectEnterpriseCoordinates(db, filter, paginate ? page * pageSize : undefined)
  const selected = paginate ? candidates.slice((page - 1) * pageSize, page * pageSize) : candidates
  const ids = selected.map(row => row.id)
  const history = readEnterpriseHistories(db, ids)
  const snap: Snapshot = { ...history, enterprises: db.select().from(schema.enterprise).where(inArray(schema.enterprise.id, ids)).all(),
    exportRows: [], exportBatches: [], queries: [], relations: [] }
  const removed = filter.rosterState ? new Set<number>() : removedEnterpriseIds(db, ids.filter(id => {
    const records = snap.recordsByEnterprise.get(id) ?? []
    return records.length > 0 && !records.some(record => record.source === 'jxj')
  }))
  return { counts, rows: projectRosterEnterprisePage(snap, selected, removed) }
}
