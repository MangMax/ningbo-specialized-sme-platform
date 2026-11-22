import { type RelationEvidenceDisplay, sanitizeRelationDisplays } from './relation-evidence-projection'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { readTargetRelationDisplay, type RelationEvidenceDisplaySelection } from '../../lib/platform/target-relation-display'
import type { ReceiptRedactor } from './import-receipt-redaction'
export type { RelationEvidenceDisplaySelection } from '../../lib/platform/target-relation-display'
export function readTargetRelationEvidenceDisplay<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>, selections: readonly RelationEvidenceDisplaySelection[], redactor?: ReceiptRedactor,
): Readonly<{ purpose: 'platform_relation_evidence_display'; sources: ReadonlyMap<number, RelationEvidenceDisplay> }> {
  const display = readTargetRelationDisplay(db, selections)
  return { purpose: display.purpose, sources: sanitizeRelationDisplays(display.sources, redactor) }
}
export { type RelationEvidenceDisplay, sanitizeRelationDisplays } from './relation-evidence-projection'
