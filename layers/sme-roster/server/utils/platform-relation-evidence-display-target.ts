/** Sanitized correspondence presentation over the shared target display owner. */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { readTargetRelationDisplay, type RelationEvidenceDisplaySelection } from '../../lib/platform/target-relation-display'
import { safeCollectionEvidence, sanitizeEvidence } from '../../../../server/utils/record-correspondence-read'
import type { ReceiptRedactor } from '../../../../server/utils/import-receipt-redaction'
export type { RelationEvidenceDisplaySelection } from '../../lib/platform/target-relation-display'
export type RelationEvidenceDisplay = ReturnType<typeof sanitizeEvidence>
export function readTargetRelationEvidenceDisplay<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>, selections: readonly RelationEvidenceDisplaySelection[], redactor?: ReceiptRedactor,
): Readonly<{ purpose: 'platform_relation_evidence_display'; sources: ReadonlyMap<number, RelationEvidenceDisplay> }> {
  const display = readTargetRelationDisplay(db, selections)
  return { purpose: display.purpose, sources: new Map([...display.sources].map(([id, source]) => {
    const query = source?.query
    const value = source && query && typeof query === 'object' && 'collectionEvidence' in query
      ? { ...source, query: { ...query, collectionEvidence: safeCollectionEvidence(query.collectionEvidence) } } : source
    return [id, sanitizeEvidence(value, redactor?.knownRedactors)]
  })) }
}
