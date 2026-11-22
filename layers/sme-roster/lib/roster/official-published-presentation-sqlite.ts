import type { ReceiptRuntimeContext } from '../../server/utils/receipt-runtime-context'
import type { PublishedPresentation } from './correspondence-view'
import { listEventsOfficialEvidencePages } from '../../server/utils/official-evidence'
import type { ReceiptRedactor } from '../../server/utils/import-receipt-redaction'
import { importReceiptRedactor } from '../../server/utils/import-receipt-redaction-sqlite'
import { officialPublishedError, OfficialPublishedPresentationError, officialPublishedPresentationSteps, projectOfficialPublishedNames, type OfficialPublishedFact, type OfficialPublishedScope } from './official-published-presentation'

export function readOfficialPublishedPresentation(db: Parameters<typeof importReceiptRedactor>[0], scope: readonly OfficialPublishedScope[], redactor?: ReceiptRedactor, receiptRuntime?: ReceiptRuntimeContext): ReadonlyMap<number, OfficialPublishedFact> {
  try {
    const steps = officialPublishedPresentationSteps(scope, () => redactor ?? importReceiptRedactor(db, {}, receiptRuntime))
    let step = steps.next()
    while (!step.done) step = steps.next(listEventsOfficialEvidencePages(db, step.value, { pageSize: 50, maxBytes: 65536 }))
    return step.value
  } catch (error) { throw officialPublishedError(error) }
}

export function readPublicPublishedNames(db: Parameters<typeof readOfficialPublishedPresentation>[0], scope: readonly OfficialPublishedScope[], copies: readonly OfficialPublishedScope[] = scope, envelopeCount = 1, textCopies = 1, redactor?: ReceiptRedactor): PublishedPresentation {
  try {
    const facts = readOfficialPublishedPresentation(db, scope, redactor)
    return projectOfficialPublishedNames([...facts.values()], copies, envelopeCount, textCopies)
  } catch (error) {
    return { availability: 'unavailable', error: error instanceof OfficialPublishedPresentationError ? error.code : 'read_failed', facts: [] }
  }
}
