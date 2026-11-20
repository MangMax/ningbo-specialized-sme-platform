/** First-recognition I/O is deliberately independent of enterprise profiles.
 * Scan only award scalars, retain sortable pair coordinates, then hydrate the
 * selected page. Platform archives and unselected evidence bodies are never read. */
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { Database } from 'better-sqlite3'
import * as schema from '../../../../db/schema'
import { TITLE_ORDER } from '../labels'
import { isPageCapable } from './evidence-page'
import { computeFirstAward } from './lifecycle'
import { matchesRecognitionQuery, summarizeFirstRecognition, type RecognitionEvent } from './first-recognition'
import type { RosterRecognitionFilter, RosterRecognitionRow, RosterRecognitionsResult } from './recognitions'

type Db = BetterSQLite3Database<typeof schema>
interface Coordinate { enterpriseId: number; name: string; titleCode: string }
type AwardRow = Coordinate & RecognitionEvent & { hasEvidence: boolean }

function rank(code: string) {
  const index = TITLE_ORDER.indexOf(code)
  return index < 0 ? TITLE_ORDER.length : index
}

export function compareRecognitionCoordinates(a: Coordinate, b: Coordinate) {
  return rank(a.titleCode) - rank(b.titleCode) || a.name.localeCompare(b.name) || a.enterpriseId - b.enterpriseId
}

export function* summarizeRecognitionAwards(rows: Iterable<AwardRow>) {
  let coordinate: Coordinate | undefined
  let events: AwardRow[] = []
  const finish = () => {
    const lifecycle = computeFirstAward(events)
    const hasEvidence = events.some(event => event.id === lifecycle.firstRecognitionEventId && event.hasEvidence)
    return { ...coordinate!, ...summarizeFirstRecognition({ titleCode: coordinate!.titleCode, lifecycle, events, hasEvidence })! }
  }
  for (const row of rows) {
    if (coordinate?.enterpriseId !== row.enterpriseId || coordinate?.titleCode !== row.titleCode) {
      if (coordinate) yield finish()
      coordinate = { enterpriseId: row.enterpriseId, name: row.name, titleCode: row.titleCode }
      events = []
    }
    events.push(row)
  }
  if (coordinate) yield finish()
}

/** At most one enterprise/title history is materialized at a time. Review,
 * maintenance and nurture cannot affect first recognition, so only award events
 * are needed by the shared first-award calculation and status predicates. */
function* summaries(db: Db, titles?: string[], selected?: Coordinate[]) {
  const r = schema.record, v = schema.recordEvent, e = schema.enterprise
  const query = db.select({
    enterpriseId: e.id, name: e.name, titleCode: r.titleCode, source: r.source,
    id: v.id, eventType: v.eventType, year: v.year, decidedYear: v.decidedYear,
    reviewOutcome: v.reviewOutcome,
    hasEvidence: sql<number>`exists(select 1 from record_evidence ev where ev.record_event_id=${v.id})`,
  }).from(r).innerJoin(v, eq(v.recordId, r.id)).innerJoin(e, eq(e.id, r.enterpriseId))
    .where(and(eq(v.eventType, 'award'), titles?.length ? inArray(r.titleCode, titles) : undefined,
      selected ? or(...selected.map(c => and(eq(r.enterpriseId, c.enterpriseId), eq(r.titleCode, c.titleCode)))) : undefined))
    .orderBy(asc(e.id), asc(r.titleCode), asc(v.id)).toSQL()
  // The SQLite driver exposes a cursor; Drizzle's synchronous select builder
  // only exposes materializing all/get/values operations.
  const rows = (db as Db & { $client: Database }).$client.prepare(query.sql).raw().iterate(...query.params) as
    Iterable<[number, string, string, string, number, string, number | null, number | null, string | null, number]>

  function* awards() {
    for (const [enterpriseId, name, titleCode, source, id, eventType, year, decidedYear, reviewOutcome, hasEvidence] of rows) {
      yield { enterpriseId, name, titleCode, source, id, eventType, year, decidedYear, reviewOutcome, hasEvidence: Boolean(hasEvidence) }
    }
  }
  yield* summarizeRecognitionAwards(awards())
}

export function readRecognitionPage(db: Db, filter: RosterRecognitionFilter, page: number, pageSize: number): RosterRecognitionsResult {
  // Keep only three light scalars per matching pair for the existing JS locale
  // ordering. Counts are accumulated before pagination, without full profiles.
  const coordinates: Coordinate[] = []
  const enterpriseIds = new Set<number>()
  const titles: Record<string, number> = Object.fromEntries(TITLE_ORDER.map(code => [code, 0]))
  const query = { title: filter.title, firstYear: filter.year, firstStatus: filter.status }
  for (const summary of summaries(db, filter.title)) {
    if (!matchesRecognitionQuery(summary, query)) continue
    coordinates.push({ enterpriseId: summary.enterpriseId, name: summary.name, titleCode: summary.titleCode })
    enterpriseIds.add(summary.enterpriseId)
    titles[summary.titleCode] = (titles[summary.titleCode] ?? 0) + 1
  }
  coordinates.sort(compareRecognitionCoordinates)
  const selected = coordinates.slice((page - 1) * pageSize, page * pageSize)
  const counts = { titlePairs: coordinates.length, enterprises: enterpriseIds.size, titles }
  if (!selected.length) return { rows: [], counts, page, pageSize }

  const pageSummaries = [...summaries(db, undefined, selected)]
  const byPair = new Map(pageSummaries.map(s => [`${s.enterpriseId}/${s.titleCode}`, s]))
  const ids = [...new Set(selected.map(c => c.enterpriseId))]
  const e = schema.enterprise
  const identities = new Map(db.select({ id: e.id, uscc: e.usccNorm,
    // Same truthy enterprise district / earliest record district fallback as the
    // enterprise view, across all titles and sources, including records without events.
    // Keep the outer identifier explicit: Drizzle unqualifies interpolated
    // columns in single-table projections, which would bind `id` to inner r.id.
    district: sql<string | null>`coalesce(nullif(${e.district},''),(select district from record r where r.enterprise_id=enterprise.id and r.district is not null and r.district!='' order by r.id limit 1))`,
  }).from(e).where(inArray(e.id, ids)).all().map(row => [row.id, row]))
  const firstIds = pageSummaries.flatMap(s => s.firstEventId == null ? [] : [s.firstEventId])
  const evidence = firstIds.length ? db.select({ recordEventId: schema.recordEvidence.recordEventId,
    sourceFile: schema.recordEvidence.sourceFile, attachment: schema.recordEvidence.attachment,
    listNo: schema.recordEvidence.listNo, page: schema.recordEvidence.page,
  }).from(schema.recordEvidence).where(inArray(schema.recordEvidence.recordEventId, firstIds))
    .orderBy(asc(schema.recordEvidence.id)).all() : []
  const byEvent = new Map<number, RosterRecognitionRow['evidence']>()
  for (const { recordEventId, ...pointer } of evidence) {
    const list = byEvent.get(recordEventId) ?? []
    list.push({ ...pointer, page: isPageCapable(pointer.sourceFile) ? pointer.page : null })
    byEvent.set(recordEventId, list)
  }
  return { rows: selected.map(c => {
    const summary = byPair.get(`${c.enterpriseId}/${c.titleCode}`)!
    const identity = identities.get(c.enterpriseId)!
    return { ...summary, uscc: identity.uscc, district: identity.district,
      evidence: summary.firstEventId == null ? [] : byEvent.get(summary.firstEventId) ?? [] }
  }), counts, page, pageSize }
}
