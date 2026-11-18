import { readAnnualWriteScope } from '../../utils/annual-correspondence-read'
import { annualCorrespondenceSpec } from '../../utils/jobs/annual-correspondence'

export { differenceSnapshotSpec } from '../../utils/difference-snapshot'
export { batchSpec } from '../../utils/platform-batch-query'
export { reconcileSpec } from '../../utils/jobs/reconcile'
export { candidateDiscoverySpec } from '../../utils/jobs/candidate-discovery'
export { currentRosterExportSpec } from '../../utils/jobs/current-roster-export'

export const annualSpec = annualCorrespondenceSpec(readAnnualWriteScope)
