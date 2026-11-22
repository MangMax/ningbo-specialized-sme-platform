import type { platformApplyProjection } from '../../../../db/postgresql/platform-tables'
import { withArchiveProcessFacts, type PlatformObservationFact } from '../../lib/platform/observation-facts'
import type { PlatformObservationComparison } from '../../lib/platform/postgres-observation-facts'

const modeledFields = ['declareKind', 'year', 'appliedAt', 'status', 'nameRaw', 'usccRaw'] as const

type Version = Pick<typeof platformApplyProjection.$inferSelect,
  'versionId' | 'ruleVersion' | 'nameRaw' | 'usccRaw' | 'declareKind' | 'declarationYear' | 'appliedAt' | 'status'>

export function projectDeclarationObservationFact(row: {
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
    relationId: row.relationId, interface: 'apply_list',
    projectionVersionId: typed ? version.versionId : null,
    projectionRuleVersion: typed ? version.ruleVersion : null,
    modeledFields: typed ? modeledFields : [],
    titleRaw: sqlFactTitle,
    nameRaw: typed ? version.nameRaw : row.originalName,
    usccRaw: typed ? version.usccRaw : row.originalUscc,
    declareKind: typed ? version.declareKind : normalized.declareKind,
    year: typed ? version.declarationYear : normalized.year,
    appliedAt: typed ? version.appliedAt : normalized.appliedAt,
    status: typed ? version.status : typeof normalized.status === 'string' ? normalized.status : null,
    batch: normalized.batch, awardBatchLabel: normalized.awardBatchLabel, province: normalized.province,
    validityDateRaw: null, maintenanceYear: null, maintenanceBatch: null, district: null, awardNote: null,
    normalizationConflicts,
  }, normalized)
}
