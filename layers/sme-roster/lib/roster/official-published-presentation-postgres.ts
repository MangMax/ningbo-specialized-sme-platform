import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { ReceiptRedactor } from '../../server/utils/import-receipt-redaction'
import { readPostgresOfficialEvidencePages } from '../../server/utils/official-evidence-postgres'
import {
  officialPublishedError, officialPublishedPresentationSteps, projectOfficialPublishedNames,
  type OfficialPublishedScope,
} from './official-published-presentation'

export async function readPostgresPublishedNames(db: NodePgDatabase, scope: readonly OfficialPublishedScope[], redact: ReceiptRedactor) {
  try {
    const steps = officialPublishedPresentationSteps(scope, () => redact)
    let step = steps.next()
    while (!step.done) step = steps.next(await readPostgresOfficialEvidencePages(db, step.value))
    return projectOfficialPublishedNames([...step.value.values()], scope)
  } catch (error) {
    return { availability: 'unavailable' as const, error: officialPublishedError(error).code, facts: [] }
  }
}
