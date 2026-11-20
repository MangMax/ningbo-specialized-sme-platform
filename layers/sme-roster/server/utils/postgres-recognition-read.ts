import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { TITLE_ORDER } from '../../lib/labels'
import { isPageCapable } from '../../lib/roster/evidence-page'
import { matchesRecognitionQuery } from '../../lib/roster/first-recognition'
import { compareRecognitionCoordinates, summarizeRecognitionAwards } from '../../lib/roster/recognition-read'
import { recognitionPageOf, type RosterRecognitionFilter, type RosterRecognitionRow, type RosterRecognitionsResult } from '../../lib/roster/recognitions'

type Award = {
  enterpriseId: string
  name: string
  titleCode: string
  source: string
  id: string
  eventType: string
  year: string | null
  decidedYear: string | null
  reviewOutcome: string | null
  hasEvidence: boolean
}
type Identity = { id: string; uscc: string | null; district: string | null }
type Pointer = {
  recordEventId: string
  sourceFile: string
  attachment: string | null
  listNo: string | null
  page: string | null
}

export function usePostgresRecognitionDb() {
  if (process.env.NUXT_POSTGRES_ROSTER_READ !== '1') return
  const db = usePostgresDirectoryDb()
  if (!db) throw new Error('PostgreSQL roster reads require NUXT_POSTGRES_DIRECTORY_URL')
  return db
}

function nullableNumber(value: string | null) {
  return value === null ? null : Number(value)
}

export function readPostgresRecognitions(db: NodePgDatabase, filter: RosterRecognitionFilter): Promise<RosterRecognitionsResult> {
  const { page, pageSize } = recognitionPageOf(filter)
  return db.transaction(async tx => {
    const titlesFilter = filter.title?.length
      ? sql`AND r.title_code IN (${sql.join(filter.title.map(title => sql`${title}`), sql`, `)})`
      : sql``
    const { rows } = await tx.execute<Award>(sql`
      SELECT e.id AS "enterpriseId", e.name, r.title_code AS "titleCode", r.source,
        v.id, v.event_type AS "eventType", v.year, v.decided_year AS "decidedYear", v.review_outcome AS "reviewOutcome",
        EXISTS (SELECT 1 FROM record_evidence ev WHERE ev.record_event_id = v.id) AS "hasEvidence"
      FROM record r JOIN record_event v ON v.record_id = r.id JOIN enterprise e ON e.id = r.enterprise_id
      WHERE v.event_type = 'award' ${titlesFilter}
      ORDER BY e.id, r.title_code, v.id`)
    const awards = rows.map(row => ({
      ...row, enterpriseId: Number(row.enterpriseId), id: Number(row.id),
      year: nullableNumber(row.year), decidedYear: nullableNumber(row.decidedYear),
    }))
    const query = { title: filter.title, firstYear: filter.year, firstStatus: filter.status }
    const summaries = [...summarizeRecognitionAwards(awards)].filter(summary => matchesRecognitionQuery(summary, query))
    const titles: Record<string, number> = Object.fromEntries(TITLE_ORDER.map(code => [code, 0]))
    for (const { titleCode } of summaries) titles[titleCode] = (titles[titleCode] ?? 0) + 1
    const counts = { titlePairs: summaries.length, enterprises: new Set(summaries.map(summary => summary.enterpriseId)).size, titles }
    summaries.sort(compareRecognitionCoordinates)
    const selected = summaries.slice((page - 1) * pageSize, page * pageSize)
    if (!selected.length) return { rows: [], counts, page, pageSize }

    const ids = [...new Set(selected.map(summary => summary.enterpriseId))]
    const identities = await tx.execute<Identity>(sql`
      SELECT e.id, e.uscc_norm AS uscc, coalesce(nullif(e.district, ''), (
        SELECT district FROM record r WHERE r.enterprise_id = e.id AND r.district IS NOT NULL AND r.district <> ''
        ORDER BY r.id LIMIT 1
      )) AS district
      FROM enterprise e WHERE e.id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`)
    const byEnterprise = new Map(identities.rows.map(row => [Number(row.id), row]))
    const firstIds = selected.flatMap(summary => summary.firstEventId == null ? [] : [summary.firstEventId])
    const byEvent = new Map<number, RosterRecognitionRow['evidence']>()
    if (firstIds.length) {
      const evidence = await tx.execute<Pointer>(sql`
        SELECT record_event_id AS "recordEventId", source_file AS "sourceFile", attachment, list_no AS "listNo", page
        FROM record_evidence WHERE record_event_id IN (${sql.join(firstIds.map(id => sql`${id}`), sql`, `)}) ORDER BY id`)
      for (const { recordEventId, sourceFile, attachment, listNo, page } of evidence.rows) {
        const id = Number(recordEventId)
        const pointers = byEvent.get(id) ?? []
        pointers.push({ sourceFile, attachment, listNo: nullableNumber(listNo), page: isPageCapable(sourceFile) ? nullableNumber(page) : null })
        byEvent.set(id, pointers)
      }
    }
    return { counts, page, pageSize, rows: selected.map(summary => {
      const identity = byEnterprise.get(summary.enterpriseId)!
      return {
        ...summary, uscc: identity.uscc, district: identity.district,
        evidence: summary.firstEventId === null ? [] : byEvent.get(summary.firstEventId) ?? [],
      }
    }) }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function readPostgresLedgerYears(db: NodePgDatabase) {
  const { rows } = await db.execute<{ year: string; kind: 'event' | 'first' }>(sql`
    WITH roster_events AS (
      SELECT r.enterprise_id, r.title_code, v.event_type, v.year, v.decided_year
      FROM record r JOIN enterprise e ON e.id = r.enterprise_id JOIN record_event v ON v.record_id = r.id
    )
    SELECT DISTINCT year, 'event' AS kind FROM roster_events WHERE year IS NOT NULL
    UNION
    SELECT min(coalesce(decided_year, year)), 'first' FROM roster_events
    WHERE event_type = 'award' AND coalesce(decided_year, year) IS NOT NULL
    GROUP BY enterprise_id, title_code
    ORDER BY year`)
  return {
    eventYears: rows.filter(row => row.kind === 'event').map(row => Number(row.year)),
    firstRecognitionYears: rows.filter(row => row.kind === 'first').map(row => Number(row.year)),
  }
}
