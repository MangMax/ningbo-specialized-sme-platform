import { publicCorrespondence } from './record-correspondence-projection'
import type { CorrespondenceRead } from './record-correspondence'

/** Opt-in list projection; source IDs resolve through the existing point/source routes. */
export function summaries(rows: CorrespondenceRead[]) {
  return rows.map(publicCorrespondence)
}
