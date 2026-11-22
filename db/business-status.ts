import { customType } from 'drizzle-orm/sqlite-core'

import { checkedBusinessStatus } from './business-status-contract'
export { checkedBusinessStatus, BUSINESS_STATUS_V1, BUSINESS_STATUS_V2, type BusinessStatusValue } from './business-status-contract'

export const businessStatusCell = customType<{ data: string | Buffer; driverData: unknown }>({
  dataType: () => 'text',
  fromDriver(value) {
    const checked = checkedBusinessStatus(value)
    if (checked === null) throw new Error('Unexpected null business status driver value')
    return checked
  },
  toDriver: value => value,
})

export const businessStatusChecks = {
  stored_status_kind_ck: `stored_status_kind IS NULL OR (stored_status_kind IN ('absent','null','text','number','boolean','array','object','invalid') AND (stored_status_kind NOT IN ('absent','null','array','object','invalid','boolean') OR stored_status IS NULL) AND typeof(stored_status) IN ('null','text')) OR (stored_status_kind = 'blob' AND typeof(stored_status) = 'blob')`,
  stored_status_ck: `typeof(stored_status) IN ('null','text') OR (typeof(stored_status) = 'blob' AND stored_status_kind IS 'blob')`,
  reconciled_status_ck: `typeof(reconciled_status) IN ('null','text','blob')`,
  status_reconcile_ck: `observation_id IS NULL OR (typeof(status_conflict) = 'integer' AND status_conflict = (stored_status IS NOT NULL AND parsed_status IS NOT NULL AND (typeof(stored_status) = 'blob' OR stored_status COLLATE BINARY <> parsed_status COLLATE BINARY)) AND reconciled_status IS (CASE WHEN status_conflict = 1 THEN NULL ELSE coalesce(stored_status,parsed_status) END))`,
} as const
