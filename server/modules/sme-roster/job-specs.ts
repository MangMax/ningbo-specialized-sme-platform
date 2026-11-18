import { readAnnualWriteScope } from '../../utils/annual-correspondence-read'
import { annualCorrespondenceSpec } from '../../utils/jobs/annual-correspondence'

export { differenceSnapshotSpec } from '../../utils/difference-snapshot'
export { batchSpec } from '../../../layers/sme-roster/server/utils/platform-batch-query'
export { reconcileSpec } from '../../../layers/sme-roster/server/utils/jobs/reconcile'
export { candidateDiscoverySpec } from '../../utils/jobs/candidate-discovery'
export { currentRosterExportSpec } from '../../../layers/sme-roster/server/utils/jobs/current-roster-export'

export const annualSpec = annualCorrespondenceSpec(readAnnualWriteScope)
