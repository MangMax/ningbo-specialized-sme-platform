import type { platformRecognizedProjection } from '../../../../db/postgresql/platform-tables'
import { legacyRowTitle, withArchiveProcessFacts, type PlatformObservationFact } from '../../lib/platform/observation-facts'
import type { PlatformObservationComparison } from '../../lib/platform/postgres-observation-facts'

const modeledFields = [
  'validityDateRaw', 'maintenanceYear', 'maintenanceBatch', 'district', 'awardNote', 'titleRaw', 'nameRaw', 'usccRaw',
] as const

type Version = Pick<typeof platformRecognizedProjection.$inferSelect,
  'versionId' | 'ruleVersion' | 'titleRaw' | 'nameRaw' | 'usccRaw' | 'validityDateRaw'
  | 'maintenanceYear' | 'maintenanceBatch' | 'district' | 'awardNote'>

export function projectRecognizedObservationFact(row: {
  relationId: number
  source: PlatformObservationComparison
  version: Version | null
  originalName: string | null
  originalUscc: string | null
}): PlatformObservationFact {
  const { source, version } = row
  const typed = version?.versionId != null
  const { normalized, normalizationConflicts } = source
  const title = legacyRowTitle({ rdjb: source.sourceTitle })
  return withArchiveProcessFacts({
    relationId: row.relationId, interface: 'recognized_list',
    projectionVersionId: typed ? version.versionId : null,
    projectionRuleVersion: typed ? version.ruleVersion : null,
    modeledFields: typed ? modeledFields : [],
    ...normalized,
    status: typeof normalized.status === 'string' ? normalized.status : null,
    titleRaw: typed ? version.titleRaw ?? title : title,
    nameRaw: typed ? version.nameRaw : row.originalName,
    usccRaw: typed ? version.usccRaw : row.originalUscc,
    validityDateRaw: typed ? version.validityDateRaw : null,
    maintenanceYear: typed ? version.maintenanceYear : null,
    maintenanceBatch: typed ? version.maintenanceBatch : null,
    district: typed ? version.district : null,
    awardNote: typed ? version.awardNote : null,
    normalizationConflicts,
  }, normalized)
}
