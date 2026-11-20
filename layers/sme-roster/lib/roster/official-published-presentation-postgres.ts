import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { ReceiptRedactor } from '../../server/utils/import-receipt-redaction'
import { readPostgresOfficialEvidencePages } from '../../server/utils/official-evidence-postgres'
import type { OfficialEvidencePageResult } from '../../server/utils/official-evidence'
import type { PublishedPresentation } from './correspondence-view'
import {
  officialPublishedError, officialPublishedPresentationSteps, projectOfficialPublishedNames,
  type OfficialPublishedScope,
} from './official-published-presentation'

export function createPostgresPublishedPresentationReader(db: NodePgDatabase, redact: ReceiptRedactor, eventIds: readonly number[] = []) {
  const firstPages = new Map<number, OfficialEvidencePageResult>()
  let prefetched = false
  return async (scope: readonly OfficialPublishedScope[]) => {
    const steps = officialPublishedPresentationSteps(scope, () => redact)
    let step = steps.next()
    if (!step.done && !prefetched) {
      for (let offset = 0; offset < eventIds.length; offset += 40) {
        const pages = await readPostgresOfficialEvidencePages(db, eventIds.slice(offset, offset + 40).map(eventId => ({ eventId })))
        for (const page of pages) firstPages.set(page.eventId, page)
      }
      prefetched = true
    }
    while (!step.done) {
      const pending = step.value.filter(request => request.afterEvidenceId !== undefined || !firstPages.has(request.eventId))
      const pages = pending.length ? await readPostgresOfficialEvidencePages(db, pending) : []
      let index = 0
      step = steps.next(step.value.map(request => (request.afterEvidenceId === undefined ? firstPages.get(request.eventId) : undefined) ?? pages[index++]!))
    }
    return step.value
  }
}

export function readPostgresOfficialPublishedPresentation(db: NodePgDatabase, scope: readonly OfficialPublishedScope[], redact: ReceiptRedactor) {
  return createPostgresPublishedPresentationReader(db, redact)(scope)
}

export async function readPostgresPublishedNames(db: NodePgDatabase, scope: readonly OfficialPublishedScope[], redact: ReceiptRedactor, copies = scope, envelopeCount = 1): Promise<PublishedPresentation> {
  try {
    const facts = await readPostgresOfficialPublishedPresentation(db, scope, redact)
    return projectOfficialPublishedNames([...facts.values()], copies, envelopeCount)
  } catch (error) {
    return { availability: 'unavailable' as const, error: officialPublishedError(error).code, facts: [] }
  }
}
