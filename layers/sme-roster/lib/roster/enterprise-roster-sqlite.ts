import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
import { normalizeName } from '../domain'
import { getComparison, type ComparisonDirection } from '../comparison'
import { TITLE_ORDER } from '../labels'
import { createCurrentQualificationAssessmentReader } from './current-qualification'
import { explainCurrentDifferences } from './current-difference-sqlite'
import { canonicalEnterpriseId } from './enterprise-identity'
import { readEnterpriseSnapshot, enterpriseComparisonCoordinates } from './enterprise-read-snapshot'
import { readQueryAssessment, readQueryCoverage } from './query-assessment'
import { readPlatformBusinessDetails, readPlatformDetailFacts } from '../../server/utils/platform-business-detail-read'
import {
  differenceKey, projectEnterpriseDifferenceUniverse, projectRosterDetailHistory, projectRosterDetailRelations, projectRosterDetailTimeline,
  readDifferenceSnapshot, rosterPageOf, selectRosterDetailArchive, titleRank,
  type RosterDifferenceFilter, type RosterDifferencesResult, type RosterEnterpriseDetail,
} from './enterprise-roster'

type Db = BetterSQLite3Database<typeof schema>

export function getRosterEnterpriseDetail(db: Db, id: number, asOf = Date.now()): RosterEnterpriseDetail | null {
  return db.transaction(() => {
    const canonicalId = canonicalEnterpriseId(db, id)
    return canonicalId === null ? null : enterpriseDetail(db, canonicalId, asOf)
  })
}

function enterpriseDetail(db: Db, id: number, asOf: number): RosterEnterpriseDetail | null {
  const snap = readEnterpriseSnapshot(db, id)
  const enterprise = snap.enterprises.find(e => e.id === id)
  if (!enterprise) return null
  const archive = selectRosterDetailArchive(enterprise, snap)
  const { queries, relations } = archive
  // Both directions use the same coverage for a title. Its IDs came from this
  // enterprise's snapshot, so coverage need not rescan global query keys.
  const coverageByTitle = new Map<string, ReturnType<typeof readQueryCoverage>>()
  const coverageForTitle = (titleCode: Parameters<typeof readQueryAssessment>[1]['titleCode']) => {
    let coverage = coverageByTitle.get(titleCode)
    if (!coverage) {
      coverage = readQueryCoverage(db, {enterpriseId:id,titleCode,direction:'missing_in_miit'}, undefined, snap.ownQueryIds)
      coverageByTitle.set(titleCode, coverage)
    }
    return coverage
  }
  const assessmentFor = (scope: Parameters<typeof readQueryAssessment>[1]) =>
    readQueryAssessment(db, scope, undefined, coverageForTitle(scope.titleCode))

  const publishedScope = snap.evidence.map(v => ({ evidenceId: v.id, eventId: v.recordEventId }))
  const detailRead = createCurrentQualificationAssessmentReader((db as Db & { $client: import('better-sqlite3').Database }).$client)
    .readDetail(id, asOf, publishedScope, { ownQueryIds: snap.ownQueryIds, coverageForTitle })
  const { snapshot: qualificationAssessment, publishedPresentation } = detailRead
  const differenceRows = explainCurrentDifferences(db, projectEnterpriseDifferenceUniverse(snap, enterpriseComparisonCoordinates(db, id)), asOf, detailRead)
  const facts = readPlatformDetailFacts(db,queries,relations)
  return {
    businessTimeline: projectRosterDetailTimeline(id, snap, detailRead.platformFacts, queries, qualificationAssessment.asOf),
    qualificationAssessment,
    publishedPresentation,
    ...projectRosterDetailHistory(snap, id, differenceRows),
    differences: differenceRows
      .filter((r) => r.enterpriseId === id)
      .sort((a, b) => titleRank(a.titleCode) - titleRank(b.titleCode) || a.direction.localeCompare(b.direction))
      .map(r => ({ ...r, ...assessmentFor(r) })),
    titleAssessments: TITLE_ORDER.flatMap(titleCode => (['missing_in_miit', 'extra_in_miit'] as const).map(direction => {
      const scope = { enterpriseId: id, titleCode, direction }; return { ...scope, ...assessmentFor(scope) }
    })),
    platform: {
      queries,
      businessRecords: readPlatformBusinessDetails(db,id,queries,relations,facts),
      relations: projectRosterDetailRelations(archive,facts),
    },
  }
}

/**
 * 差异与解释。**按 `(企业 × 称号 × 方向)` 出当前解释**;两个方向都能筛。
 * `counts` 与筛选同口径、先于分页。
 */
export function listRosterDifferences(db: Db, filter: RosterDifferenceFilter = {}): RosterDifferencesResult {
  return db.transaction(() => rosterDifferences(db, filter))
}

function rosterDifferences(db: Db, filter: RosterDifferenceFilter): RosterDifferencesResult {
  const asOf = Date.now()
  const snap = readDifferenceSnapshot(db)
  const differenceRows = projectEnterpriseDifferenceUniverse(snap, getComparison(db).rows)

  // 别名:只带 `confirmed`(契约 §1.2),与总表的搜索口径同一处规则。
  const confirmedAliases = new Map<number, string[]>()
  for (const alias of snap.aliases) {
    if (alias.verificationStatus !== 'confirmed') continue
    const list = confirmedAliases.get(alias.enterpriseId) ?? []
    if (!list.includes(alias.name)) list.push(alias.name)
    confirmedAliases.set(alias.enterpriseId, list)
  }
  const needle = filter.q?.trim() ? normalizeName(filter.q) : null
  const usccNeedle = filter.q?.trim() ? filter.q.trim().toUpperCase() : null

  const rows = differenceRows
    .filter((row) => {
      if (filter.title?.length && !filter.title.includes(row.titleCode)) return false
      if (filter.direction?.length && !filter.direction.includes(row.direction)) return false
      if (filter.status?.length && !filter.status.includes(row.status)) return false
      if (filter.reason?.length && !(row.reasonCode != null && filter.reason.includes(row.reasonCode))) return false
      if (needle || usccNeedle) {
        const hit =
          (needle != null && normalizeName(row.name).includes(needle)) ||
          (needle != null &&
            (confirmedAliases.get(row.enterpriseId) ?? []).some((alias) =>
              normalizeName(alias).includes(needle),
            )) ||
          (usccNeedle != null && (row.uscc ?? '').toUpperCase().includes(usccNeedle))
        if (!hit) return false
      }
      return true
    })
    .sort(
      (a, b) =>
        titleRank(a.titleCode) - titleRank(b.titleCode) ||
        a.direction.localeCompare(b.direction) ||
        a.name.localeCompare(b.name) ||
        a.enterpriseId - b.enterpriseId,
    )

  const counts = Object.fromEntries(
    TITLE_ORDER.map((code) => [code, { missing_in_miit: 0, extra_in_miit: 0 }]),
  ) as Record<string, Record<ComparisonDirection, number>>
  for (const row of rows) {
    counts[row.titleCode] ??= { missing_in_miit: 0, extra_in_miit: 0 }
    counts[row.titleCode]![row.direction] += 1
  }

  const { page, pageSize } = rosterPageOf(filter)
  const selected = rows.slice((page - 1) * pageSize, page * pageSize)
  const hydrated = new Map(projectEnterpriseDifferenceUniverse(readDifferenceSnapshot(db, [...new Set(selected.map(r => r.enterpriseId))]), selected).map(r => [differenceKey(r.enterpriseId, r.titleCode, r.direction), r]))
  return {
    rows: explainCurrentDifferences(db, selected.map(row => ({ ...hydrated.get(differenceKey(row.enterpriseId, row.titleCode, row.direction))!, inCurrentDifference: row.inCurrentDifference, ...readQueryAssessment(db, row) })), asOf),
    counts,
    total: rows.length,
    page,
    pageSize,
  }
}
