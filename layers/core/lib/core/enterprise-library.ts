export interface EnterpriseLibraryRow {
  id: number
  name: string
  uscc: string | null
  district: string | null
  districtCode: string | null
  townshipCode: string | null
  industryCode: string | null
}

export interface EnterpriseLibraryDetails extends EnterpriseLibraryRow {
  revision: number
  registeredAddress: string | null
  operatingAddress: string | null
}

export const enterpriseLibrarySortFields = [
  'name', 'uscc', 'district', 'township', 'industry', 'registeredAddress', 'operatingAddress',
] as const

export type EnterpriseLibrarySortField = typeof enterpriseLibrarySortFields[number]
export type EnterpriseLibrarySort = { field: EnterpriseLibrarySortField; direction: 'asc' | 'desc' }

export interface EnterpriseLibraryFilters {
  name?: string
  uscc?: string
  districtCode?: string
  townshipCode?: string
  industryDivisionCode?: string
  industryCode?: string
  registeredAddress?: string
  operatingAddress?: string
}

export interface EnterpriseLibraryTableRow extends EnterpriseLibraryRow {
  districtName: string | null
  townshipName: string | null
  industryName: string | null
  registeredAddress: string | null
  operatingAddress: string | null
}

export interface EnterpriseLibraryResult {
  rows: EnterpriseLibraryTableRow[]
  page: number
  total: number
}

export interface EnterpriseLibrarySource {
  id: number
  channel: string
  listType: string
  acquiredOn: string | null
  series: string
  filePath: string | null
}

export const enterpriseLibraryColumnLabels = {
  name: '企业名称',
  uscc: '统一社会信用代码',
  district: '区县',
  township: '乡镇（街道）',
  industry: '行业',
  registeredAddress: '注册地址',
  operatingAddress: '经营地址',
} as const satisfies Record<EnterpriseLibrarySortField, string>
