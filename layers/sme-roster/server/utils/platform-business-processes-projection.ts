import type { platformBusinessProjection } from '../../../../db/postgresql/platform-tables'
import { withArchiveProcessFacts, type PlatformObservationFact } from '../../lib/platform/observation-facts'
import type { PlatformObservationComparison } from '../../lib/platform/postgres-observation-facts'

const modeledFields = [
  'declareKind', 'year', 'appliedAt', 'status', 'batch', 'awardBatchLabel', 'province', 'nameRaw', 'usccRaw',
] as const

type Version = Pick<typeof platformBusinessProjection.$inferSelect,
  'versionId' | 'ruleVersion' | 'nameRaw' | 'usccRaw' | 'declareKind' | 'businessYear'
  | 'appliedAt' | 'status' | 'batch' | 'awardBatchLabel' | 'province'>

export function projectBusinessProcessObservationFact(row: {
  relationId: number
  source: PlatformObservationComparison
  version: Version | null
  originalName: string | null
  originalUscc: string | null
}): PlatformObservationFact {
  const { source, version } = row
  const typed = version?.versionId != null
  const { normalized, normalizationConflicts, sqlFactTitle } = source
  return withArchiveProcessFacts({
    relationId: row.relationId, interface: 'business_list',
    projectionVersionId: typed ? version.versionId : null,
    projectionRuleVersion: typed ? version.ruleVersion : null,
    modeledFields: typed ? modeledFields : [],
    nameRaw: typed ? version.nameRaw : row.originalName,
    usccRaw: typed ? version.usccRaw : row.originalUscc,
    titleRaw: sqlFactTitle,
    declareKind: typed ? version.declareKind : normalized.declareKind,
    year: typed ? version.businessYear : normalized.year,
    appliedAt: typed ? version.appliedAt : normalized.appliedAt,
    status: typed ? version.status : normalized.status,
    batch: typed ? version.batch : normalized.batch,
    awardBatchLabel: typed ? version.awardBatchLabel : normalized.awardBatchLabel,
    province: typed ? version.province : normalized.province,
    validityDateRaw: null, maintenanceYear: null, maintenanceBatch: null, district: null, awardNote: null,
    normalizationConflicts,
  }, normalized)
}
