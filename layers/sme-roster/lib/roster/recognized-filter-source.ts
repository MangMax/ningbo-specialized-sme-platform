import type { RecognizedYearCondition } from '../../../../db/postgresql/recognized-source-scope'

export interface RecognizedFilterSourceRow {
  queryId: number
  titleCode: string | null
  rdjb: string
  rdjbKey: string | null
  conditionValidYear: RecognizedYearCondition
  conditionMaintenanceYear: RecognizedYearCondition
  rawValid: string | null
  maintenanceYearAbsent: boolean
  rawMaintenanceBatch: string | null
}
