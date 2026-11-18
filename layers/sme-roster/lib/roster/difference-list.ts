import { differencePublicColumns } from '../platform/difference-reference-target'
/** #132 differences-only read plan. No persisted or cross-request cache. */
import { eq, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../../../db/schema'
import { explainCurrentDifferencePage } from './current-difference'
import { getComparison } from '../comparison'
import { normalizeName } from '../domain'
import { TITLE_ORDER } from '../labels'
import { MAX_PAGE_SIZE } from '../query'
import type { RosterDifferenceFilter, RosterDifferencesResult } from './enterprise-roster'
import { readQueryAssessments } from '../../../../lib/roster/query-assessment'
import { targetCandidateTables } from '../../server/utils/candidate-target-sources'

type Db = BetterSQLite3Database<typeof s>
const keyOf = (r: { enterpriseId: number; titleCode: string; direction: string }) => JSON.stringify([r.enterpriseId, r.titleCode, r.direction])
const rank = (title: string) => { const i = TITLE_ORDER.indexOf(title); return i < 0 ? TITLE_ORDER.length : i }

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
    const current = new Map(heads.map(r => [keyOf(r), r]))
    const enterprises = new Map(db.select({ id: s.enterprise.id, name: s.enterprise.name, uscc: s.enterprise.usccNorm }).from(s.enterprise).all().map(e => [e.id, e]))
    const derived = getComparison(db).rows
    const derivedKeys = new Set(derived.map(keyOf))
    const coordinates = new Map([...derived, ...heads].map(r => [keyOf(r), { enterpriseId: r.enterpriseId, titleCode: r.titleCode, direction: r.direction }]))
    const needle = filter.q?.trim() ? normalizeName(filter.q) : null
    const usccNeedle = filter.q?.trim() ? filter.q.trim().toUpperCase() : null
    const aliases = new Map<number, string[]>()
    if (needle || usccNeedle) {
      for (const alias of db.select({ enterpriseId: s.enterpriseAlias.enterpriseId, name: s.enterpriseAlias.name }).from(s.enterpriseAlias).where(eq(s.enterpriseAlias.verificationStatus, 'confirmed')).all()) {
        const names = aliases.get(alias.enterpriseId) ?? []
        names.push(normalizeName(alias.name)); aliases.set(alias.enterpriseId, names)
      }
    }
    const rows = [...coordinates.values()].map(r => {
      const head = current.get(keyOf(r)), enterprise = enterprises.get(r.enterpriseId)
      return { ...r, name: enterprise?.name ?? '', uscc: enterprise?.uscc ?? null, explanationId: head?.id ?? null, status: head?.status ?? 'not_queried', reasonCode: head?.reasonCode ?? null, inCurrentDifference: derivedKeys.has(keyOf(r)) }
    }).filter(r =>
      (!filter.title?.length || filter.title.includes(r.titleCode)) &&
      (!filter.direction?.length || filter.direction.includes(r.direction)) &&
      (!filter.status?.length || filter.status.includes(r.status)) &&
      (!filter.reason?.length || r.reasonCode != null && filter.reason.includes(r.reasonCode)) &&
      (!(needle || usccNeedle) || needle != null && (normalizeName(r.name).includes(needle) || (aliases.get(r.enterpriseId) ?? []).some(a => a.includes(needle))) || usccNeedle != null && (r.uscc ?? '').toUpperCase().includes(usccNeedle)),
    ).sort((a, b) => rank(a.titleCode) - rank(b.titleCode) || a.direction.localeCompare(b.direction) || a.name.localeCompare(b.name) || a.enterpriseId - b.enterpriseId)
    const counts = Object.fromEntries(TITLE_ORDER.map(t => [t, { missing_in_miit: 0, extra_in_miit: 0 }])) as RosterDifferencesResult['counts']
    for (const r of rows) { counts[r.titleCode] ??= { missing_in_miit: 0, extra_in_miit: 0 }; counts[r.titleCode]![r.direction]++ }
    const page = Number.isFinite(filter.page) && filter.page! >= 1 ? Math.floor(filter.page!) : 1
    const pageSize = Math.min(Number.isFinite(filter.pageSize) && filter.pageSize! >= 1 ? Math.floor(filter.pageSize!) : 50, MAX_PAGE_SIZE)
    const pageRows = rows.slice((page - 1) * pageSize, page * pageSize)
    if (!pageRows.length) return { rows: [], counts, total: rows.length, page, pageSize }
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
    return { counts, total: rows.length, page, pageSize, rows: selected.map((r, i) => {
      const explanation = r.explanationId == null ? null : explanations.get(r.explanationId)!
      const query = explanation?.evidenceQueryId == null ? null : queries.get(explanation.evidenceQueryId)
      const movedIn = explanation && ([explanation.movedInCity, explanation.movedInTitleCode, explanation.movedInYear, explanation.movedInBatch].some(v => v != null) || explanation.reasonCode === 'moved_in')
        ? { city: explanation.movedInCity, titleCode: explanation.movedInTitleCode, year: explanation.movedInYear, batch: explanation.movedInBatch, complete: [explanation.movedInCity, explanation.movedInTitleCode, explanation.movedInYear, explanation.movedInBatch].every(v => v != null) } : null
      return { ...r, district: districts.get(r.enterpriseId) ?? null, reasonNote: explanation?.reasonNote ?? null, measureCode: explanation?.measureCode ?? null, measureNote: explanation?.measureNote ?? null, movedIn,
        ...(explanation?.factReferences?.length ? { factReferences: explanation.factReferences } : {}),
        verificationStatus: explanation?.verificationStatus ?? 'pending', recordedAt: explanation?.recordedAt ?? null,
        evidence: query ? { queryId: query.id, queriedAt: query.queriedAt, interface: query.interface, status: query.status, failureReason: query.failureReason, relationIds: relations.get(query.id) ?? [] } : null,
        ...assessments[i]!,
      }
    }) }
  })
}
