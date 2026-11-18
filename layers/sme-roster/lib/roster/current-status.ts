export const CURRENT_STATUS_LABELS = { effective: '有效企业', expired: '已到期', terminated: '已注销（吊销）', moved_out: '已迁出', unrecognized: '未认定' } as const
export type CurrentStatus = keyof typeof CURRENT_STATUS_LABELS
