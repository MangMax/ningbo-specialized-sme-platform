/** Only the business observation's stored/reconciled status has this domain.
 * Content/parser status and the other two sources remain TEXT. */
export type BusinessStatusValue = string | Buffer | null
export function checkedBusinessStatus(value: unknown): BusinessStatusValue {
  if (value === null || typeof value === 'string' || Buffer.isBuffer(value)) return value
  throw new Error('Invalid business stored status cell')
}

export const BUSINESS_STATUS_V1 = 't05b-source-projections-v1'
export const BUSINESS_STATUS_V2 = 't05b-source-projections-v2-status-blob'
