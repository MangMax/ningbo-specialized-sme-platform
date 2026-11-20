import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { ReceiptRedactor } from '../../server/utils/import-receipt-redaction'
import { readPostgresOfficialEvidencePages } from '../../server/utils/official-evidence-postgres'
import type { PublishedPresentation } from './correspondence-view'
import {
  officialPublishedError, officialPublishedPresentationSteps, projectOfficialPublishedNames,
  type OfficialPublishedScope,
} from './official-published-presentation'

export async function readPostgresOfficialPublishedPresentation(db: NodePgDatabase, scope: readonly OfficialPublishedScope[], redact: ReceiptRedactor) {
  const steps = officialPublishedPresentationSteps(scope, () => redact)
  let step = steps.next()
  while (!step.done) step = steps.next(await readPostgresOfficialEvidencePages(db, step.value))
  return step.value
}

export async function readPostgresPublishedNames(db: NodePgDatabase, scope: readonly OfficialPublishedScope[], redact: ReceiptRedactor, copies = scope, envelopeCount = 1): Promise<PublishedPresentation> {
  try {
    const facts = await readPostgresOfficialPublishedPresentation(db, scope, redact)
    return projectOfficialPublishedNames([...facts.values()], copies, envelopeCount)
  } catch (error) {
    return { availability: 'unavailable' as const, error: officialPublishedError(error).code, facts: [] }
  }
}
