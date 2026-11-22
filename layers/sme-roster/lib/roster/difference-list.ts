import { differencePublicColumns } from '../platform/difference-reference-target'
/** #132 differences-only read plan. No persisted or cross-request cache. */
import { eq, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../../../db/schema'
import { explainCurrentDifferencePage } from './current-difference-sqlite'
import { getComparison } from '../comparison'
import { normalizeName } from '../domain'
import type { RosterDifferenceFilter, RosterDifferencesResult } from './enterprise-roster'
import { readQueryAssessments } from './query-assessment'
import { targetCandidateTables } from '../../server/utils/candidate-target-sources'

import { selectRosterDifferencePage, projectRosterDifferenceList } from './difference-list-projection'

type Db = BetterSQLite3Database<typeof s>

/** Preserve the REST universe (comparison coordinates UNION current explanations),
 * JS locale ordering, and pre-pagination counts. Only the selected heads/evidence
 * are hydrated. MCP intentionally retains its smaller stored-explanations view.
 */
export function listRosterDifferences(db: Db, filter: RosterDifferenceFilter = {}): RosterDifferencesResult {
  return db.transaction(() => {
    const asOf = Date.now()
    const { q, r: relation } = targetCandidateTables(db)
    const d = s.differenceReason
    const heads = db.select({ id: d.id, enterpriseId: d.enterpriseId, titleCode: d.titleCode, direction: d.direction, status: d.status, reasonCode: d.reasonCode }).from(d)
      .where(sql`not exists (select 1 from difference_reason n where n.enterprise_id=${d.enterpriseId} and n.title_code=${d.titleCode} and n.direction=${d.direction} and (n.recorded_at>${d.recordedAt} or (n.recorded_at=${d.recordedAt} and n.id>${d.id})))`).all()
    const enterprises = new Map(db.select({ id: s.enterprise.id, name: s.enterprise.name, uscc: s.enterprise.usccNorm }).from(s.enterprise).all().map(e => [e.id, e]))
    const aliases = new Map<number, string[]>()
    if (filter.q?.trim()) for (const alias of db.select({ enterpriseId: s.enterpriseAlias.enterpriseId, name: s.enterpriseAlias.name })
      .from(s.enterpriseAlias).where(eq(s.enterpriseAlias.verificationStatus, 'confirmed')).all()) {
      const names = aliases.get(alias.enterpriseId) ?? []
      names.push(normalizeName(alias.name))
      aliases.set(alias.enterpriseId, names)
    }
    const page = selectRosterDifferencePage(filter, getComparison(db).rows, heads, enterprises, aliases)
    const pageRows = page.rows
    if (!pageRows.length) return { ...page, rows: [] }
    const qualificationPage = explainCurrentDifferencePage(db, pageRows, asOf)
    const selected = qualificationPage.rows
    const selectedIds = selected.flatMap(r => r.explanationId == null ? [] : [r.explanationId])
    const explanations = new Map(db.select(differencePublicColumns(db)).from(d).where(inArray(d.id, selectedIds)).all().map(r => [r.id, r]))
    const enterpriseIds = [...new Set(selected.map(r => r.enterpriseId))]
    const districts = new Map(db.all<{ id: number; district: string | null }>(sql`select e.id,coalesce(e.district,
      (select district from record r where r.enterprise_id=e.id and r.district is not null and r.district!='' order by r.id limit 1)) district
      from enterprise e where e.id in (${sql.join(enterpriseIds.map(id => sql`${id}`), sql`,`)})`).map(r => [r.id, r.district]))
    const queryIds = [...new Set([...explanations.values()].flatMap(r => r.evidenceQueryId == null ? [] : [r.evidenceQueryId]))]
    const queries = new Map(db.select({ id: q.id, queriedAt: q.queriedAt, interface: q.interface, status: q.status, failureReason: q.failureReason }).from(q).where(inArray(sql<number>`${q.id}`, queryIds)).all().map(q => [q.id, q]))
    const relations = new Map<number, number[]>()
    for (const r of db.select({ id: relation.id, queryId: relation.queryId }).from(relation).where(inArray(sql<number>`${relation.queryId}`, queryIds)).all()) {
      const ids = relations.get(r.queryId) ?? []; ids.push(r.id); relations.set(r.queryId, ids)
    }
    const assessments = readQueryAssessments(db, selected, qualificationPage.coverages)
    return projectRosterDifferenceList(page, selected, explanations, districts, queries, relations, assessments)
  })
}
