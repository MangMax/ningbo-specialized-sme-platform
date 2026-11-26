import type { EnterpriseLibraryFilters, EnterpriseLibrarySort, EnterpriseLibraryTableRow } from '../../lib/core/enterprise-library'

export type DirectoryRow = EnterpriseLibraryTableRow & {
  city: string | null
  industryDivisionCode: string | null
  removedReason: string | null
  revision: number
  mergedInto: number | null
}

export type DirectoryQuery = EnterpriseLibraryFilters & {
  sourceId?: number; includeRemoved?: boolean; page?: number; after?: number; limit: number
  sorts?: readonly EnterpriseLibrarySort[]
}
