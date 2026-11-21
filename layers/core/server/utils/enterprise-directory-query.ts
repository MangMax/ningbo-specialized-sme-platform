import type { EnterpriseLibraryFilters, EnterpriseLibrarySort, EnterpriseLibrarySortField, EnterpriseLibraryTableRow } from '../../lib/core/enterprise-library'

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

const directoryText = {
  district: "coalesce(dr.name,nullif(e.district,''),d.district_code)",
  township: 'coalesce(tr.name,d.township_code)',
  industry: 'coalesce(ind.name,d.industry_code)',
} as const

export const directorySource = `FROM enterprise e LEFT JOIN enterprise_directory d ON d.enterprise_id=e.id
    LEFT JOIN enterprise_merge m ON m.from_enterprise_id=e.id
    LEFT JOIN enterprise_region dr ON dr.code=d.district_code
    LEFT JOIN enterprise_region tr ON tr.code=d.township_code
    LEFT JOIN enterprise_industry ind ON ind.code=d.industry_code
    LEFT JOIN enterprise_industry ig ON ig.code=ind.parent_code
    LEFT JOIN enterprise_address ra ON ra.enterprise_id=e.id AND ra.kind='registered'
    LEFT JOIN enterprise_address oa ON oa.enterprise_id=e.id AND oa.kind='operating'`
export const directoryColumns = `e.id,e.name,e.uscc_norm AS uscc,e.city,e.district,
        d.district_code AS "districtCode",d.township_code AS "townshipCode",d.industry_code AS "industryCode",
        ig.parent_code AS "industryDivisionCode",d.removed_reason AS "removedReason",coalesce(d.revision,1) AS revision,
        m.into_enterprise_id AS "mergedInto",${directoryText.district} AS "districtName",${directoryText.township} AS "townshipName",
        ${directoryText.industry} AS "industryName",ra.address AS "registeredAddress",oa.address AS "operatingAddress"`

export const directoryOrder = {
  name: 'e.name_norm',
  uscc: "nullif(e.uscc_norm,'')",
  ...directoryText,
  registeredAddress: 'ra.address',
  operatingAddress: 'oa.address',
} satisfies Record<EnterpriseLibrarySortField, string>

export const enterpriseSourcesSelection = `SELECT s.id,s.module,s.business_table AS "businessTable",s.version_key AS "versionKey",
    c.name AS channel,t.name AS "listType",s.acquired_on AS "acquiredOn",s.series,s.file_id AS "fileId",s.sha256,
    f.rel_path AS "filePath"
    FROM enterprise_source_link l JOIN enterprise_source s ON s.id=l.source_id
    JOIN enterprise_source_channel c ON c.code=s.channel_code JOIN enterprise_source_list_type t ON t.code=s.list_type_code
    LEFT JOIN stored_file f ON f.id=s.file_id AND f.sha256=s.sha256 AND f.removed_at IS NULL`
