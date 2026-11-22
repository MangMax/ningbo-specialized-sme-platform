import type { RelationEvidenceDisplay as TargetDisplay } from '../../lib/platform/target-relation-display'
import { safeCollectionEvidence, sanitizeEvidence } from './evidence-redaction'
import type { ReceiptRedactor } from './import-receipt-redaction'

export type RelationEvidenceDisplay = ReturnType<typeof sanitizeEvidence>

export function sanitizeRelationDisplays(sources: ReadonlyMap<number, TargetDisplay>, redactor?: ReceiptRedactor) {
  return new Map([...sources].map(([id, source]) => {
    const query = source?.query
    const value = source && query && typeof query === 'object' && 'collectionEvidence' in query
      ? { ...source, query: { ...query, collectionEvidence: safeCollectionEvidence(query.collectionEvidence) } } : source
    return [id, sanitizeEvidence(value, redactor?.knownRedactors)]
  }))
}
