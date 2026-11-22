import { and, eq, exists, inArray, isNotNull, isNull, min, ne, or } from 'drizzle-orm'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { TITLE_ORDER } from '../../lib/labels'
import { isPageCapable } from '../../lib/roster/evidence-page'
import { matchesRecognitionQuery } from '../../lib/roster/first-recognition'
import { compareRecognitionCoordinates, summarizeRecognitionAwards, recognitionPageOf, type RosterRecognitionFilter, type RosterRecognitionRow, type RosterRecognitionsResult } from '../../lib/roster/recognition-projection'

export function readPostgresRecognitions(db: NodePgDatabase, filter: RosterRecognitionFilter): Promise<RosterRecognitionsResult> {
  const { page, pageSize } = recognitionPageOf(filter)
  return db.transaction(async tx => {
    const evidenceForEvent = tx.select({ id: recordEvidence.id }).from(recordEvidence)
      .where(eq(recordEvidence.recordEventId, recordEvent.id))
    const awards = await tx.select({
      enterpriseId: enterprise.id, name: enterprise.name, titleCode: record.titleCode, source: record.source,
      id: recordEvent.id, eventType: recordEvent.eventType, year: recordEvent.year, decidedYear: recordEvent.decidedYear,
      reviewOutcome: recordEvent.reviewOutcome, hasEvidence: exists(evidenceForEvent).mapWith(Boolean),
    }).from(record).innerJoin(recordEvent, eq(recordEvent.recordId, record.id))
      .innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
      .where(and(eq(recordEvent.eventType, 'award'), filter.title?.length ? inArray(record.titleCode, filter.title) : undefined))
      .orderBy(enterprise.id, record.titleCode, recordEvent.id)
    const query = { title: filter.title, firstYear: filter.year, firstStatus: filter.status }
    const summaries = [...summarizeRecognitionAwards(awards)].filter(summary => matchesRecognitionQuery(summary, query))
    const titles: Record<string, number> = Object.fromEntries(TITLE_ORDER.map(code => [code, 0]))
    for (const { titleCode } of summaries) titles[titleCode] = (titles[titleCode] ?? 0) + 1
    const counts = { titlePairs: summaries.length, enterprises: new Set(summaries.map(summary => summary.enterpriseId)).size, titles }
    summaries.sort(compareRecognitionCoordinates)
    const selected = summaries.slice((page - 1) * pageSize, page * pageSize)
    if (!selected.length) return { rows: [], counts, page, pageSize }

    const ids = [...new Set(selected.map(summary => summary.enterpriseId))]
    const fallback = tx.select({ district: record.district }).from(record)
      .where(and(eq(record.enterpriseId, enterprise.id), ne(record.district, '')))
      .orderBy(record.id).limit(1).as('fallback')
    const identities = await tx.select({
      id: enterprise.id, uscc: enterprise.usccNorm, district: enterprise.district, fallback: fallback.district,
    }).from(enterprise).leftJoinLateral(fallback, or(isNull(enterprise.district), eq(enterprise.district, ''))).where(inArray(enterprise.id, ids))
    const byEnterprise = new Map(identities.map(row => [row.id, row]))
    const firstIds = selected.flatMap(summary => summary.firstEventId == null ? [] : [summary.firstEventId])
    const byEvent = new Map<number, RosterRecognitionRow['evidence']>()
    if (firstIds.length) {
      const evidence = await tx.select({ id: recordEvidence.recordEventId, sourceFile: recordEvidence.sourceFile,
        attachment: recordEvidence.attachment, listNo: recordEvidence.listNo, page: recordEvidence.page,
      }).from(recordEvidence).where(inArray(recordEvidence.recordEventId, firstIds)).orderBy(recordEvidence.id)
      for (const { id, sourceFile, attachment, listNo, page } of evidence) {
        const pointers = byEvent.get(id) ?? []
        pointers.push({ sourceFile, attachment, listNo, page: isPageCapable(sourceFile) ? page : null })
        byEvent.set(id, pointers)
      }
    }
    return { counts, page, pageSize, rows: selected.map(summary => {
      const identity = byEnterprise.get(summary.enterpriseId)!
      return {
        ...summary, uscc: identity.uscc, district: identity.district || identity.fallback,
        evidence: summary.firstEventId === null ? [] : byEvent.get(summary.firstEventId) ?? [],
      }
    }) }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function readPostgresLedgerYears(db: NodePgDatabase) {
  return db.transaction(async tx => {
    const eventYears = await tx.selectDistinct({ year: recordEvent.year }).from(recordEvent)
      .innerJoin(record, eq(record.id, recordEvent.recordId)).innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
      .where(isNotNull(recordEvent.year)).orderBy(recordEvent.year)
    const awards = tx.select({ owner: record.enterpriseId, title: record.titleCode, year: recordEvent.decidedYear })
      .from(recordEvent).innerJoin(record, eq(record.id, recordEvent.recordId))
      .where(and(eq(recordEvent.eventType, 'award'), isNotNull(recordEvent.decidedYear)))
      .unionAll(tx.select({ owner: record.enterpriseId, title: record.titleCode, year: recordEvent.year })
        .from(recordEvent).innerJoin(record, eq(record.id, recordEvent.recordId))
        .where(and(eq(recordEvent.eventType, 'award'), isNull(recordEvent.decidedYear), isNotNull(recordEvent.year))))
      .as('award_years')
    const firstYears = await tx.selectDistinct({ year: min(awards.year) }).from(awards)
      .innerJoin(enterprise, eq(enterprise.id, awards.owner)).groupBy(awards.owner, awards.title)
      .orderBy(min(awards.year))
    return {
      eventYears: eventYears.flatMap(row => row.year ?? []),
      firstRecognitionYears: firstYears.flatMap(row => row.year ?? []),
    }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
