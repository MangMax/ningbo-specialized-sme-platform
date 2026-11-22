import type { OfficialEvidenceExecutor } from './official-evidence'
import { listEventOfficialEvidence, readLatestOfficialEvidence, readOfficialEvidenceHistory } from './official-evidence'
import { officialProjectionBudget, officialProjectionResponse, type EvidenceRead, type EventRead } from './official-evidence-read'
import { importReceiptRedactor } from './import-receipt-redaction-sqlite'

type Db = Parameters<typeof importReceiptRedactor>[0]

/** Only the new projection is budgeted/redacted; no legacy field is trimmed or rewritten. */
export function readPublicOfficialEvidence(db: Db, kind: 'evidence'|'event', args: EvidenceRead | EventRead) {
  const { maxBytes, budget: availableBytes } = officialProjectionBudget(args)
  const executor: OfficialEvidenceExecutor = db
  const budget = { maxBytes: availableBytes }
  let result:object, availability:string
  if(kind==='event') {
    const event=args as EventRead
    result=listEventOfficialEvidence(executor,event.eventId,{...budget,...(event.pageSize===undefined?{}:{pageSize:event.pageSize}),...(event.afterEvidenceId===undefined?{}:{afterEvidenceId:event.afterEvidenceId})})
    availability='captured_rows'
  } else {
    const evidence=args as EvidenceRead
    if(evidence.official==='history') {
      const history=readOfficialEvidenceHistory(executor,evidence.id,{...budget,...(evidence.pageSize===undefined?{}:{pageSize:evidence.pageSize}),...(evidence.beforeRevision===undefined?{}:{beforeRevision:evidence.beforeRevision})})
      result=history; availability=history.rows.length?'available':evidence.beforeRevision===undefined?'unknown_legacy':'empty_page'
    } else {
      const latest=readLatestOfficialEvidence(executor,evidence.id,budget)
      result=latest; availability=latest.row?'available':'unknown_legacy'
    }
  }
  return officialProjectionResponse(result, availability, maxBytes, importReceiptRedactor(db))
}
