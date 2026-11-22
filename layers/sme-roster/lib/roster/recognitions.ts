import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { asc, eq } from 'drizzle-orm'
import * as schema from '../../../../db/schema'
import { readRecognitionPage } from './recognition-read'
import { recognitionPageOf, type RosterRecognitionFilter, type RosterRecognitionsResult } from './recognition-projection'
import { computeTitleLifecycle, type LifecycleEvent } from './lifecycle'

type Db = BetterSQLite3Database<typeof schema>

export { recognitionPageOf, type RosterRecognitionFilter, type RosterRecognitionRow, type RosterRecognitionsResult } from './recognition-projection'

/**
 * 首次认定清单。`counts` 与筛选**同口径**、且**先于分页**。
 *
 * 企业身份(名称 / 统代 / 属地)取自 `enterprise` 行 —— 与 §7.1 同源,不另做一次匹配。
 */
export function listRosterRecognitions(
  db: Db,
  filter: RosterRecognitionFilter = {},
): RosterRecognitionsResult {
  const { page, pageSize } = recognitionPageOf(filter)
  return db.transaction(() => readRecognitionPage(db, filter, page, pageSize))
}

export function readLedgerYears(db: Db): { eventYears: number[]; firstRecognitionYears: number[] } {
  const eventYears = new Set<number>()
  const firstRecognitionYears = new Set<number>()
  const rows = db.select({
    enterpriseId: schema.record.enterpriseId,
    titleCode: schema.record.titleCode,
    id: schema.recordEvent.id,
    eventType: schema.recordEvent.eventType,
    year: schema.recordEvent.year,
    decidedYear: schema.recordEvent.decidedYear,
    reviewOutcome: schema.recordEvent.reviewOutcome,
  }).from(schema.record)
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .innerJoin(schema.recordEvent, eq(schema.recordEvent.recordId, schema.record.id))
    .orderBy(asc(schema.record.enterpriseId), asc(schema.record.titleCode), asc(schema.recordEvent.id))
    .all()
  let key: string | null = null
  let events: LifecycleEvent[] = []
  const finish = () => {
    const year = computeTitleLifecycle(events).firstRecognitionYear
    if (year != null) firstRecognitionYears.add(year)
  }
  for (const row of rows) {
    if (row.year != null) eventYears.add(row.year)
    const next = `${row.enterpriseId}/${row.titleCode}`
    if (key !== next) {
      if (key != null) finish()
      events = []
      key = next
    }
    events.push(row)
  }
  if (key != null) finish()

  return {
    eventYears: [...eventYears].sort((a, b) => a - b),
    firstRecognitionYears: [...firstRecognitionYears].sort((a, b) => a - b),
  }
}
