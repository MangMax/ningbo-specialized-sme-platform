export const differenceStatuses = [ 'not_queried', 'query_failed', 'no_record', 'confirmed_no_diff', 'confirmed_reason', 'needs_review', ] as const
export const differenceReasons = ['moved_out', 'deregistered', 'renamed', 'platform_stale', 'pending_review', 'moved_in', 'other' ] as const
export const differenceMeasures = [ 'keep_history', 'mark_platform_snapshot', 'follow_review', 'mark_moved_out', 'mark_deregistered', 'update_current_name', 'record_moved_in', 'manual_review', 'none', ] as const
