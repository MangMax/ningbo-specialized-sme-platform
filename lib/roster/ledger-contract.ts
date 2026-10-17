/** 企业列表筛选与排序的纯契约值，客户端与服务端读模型共用。 */
import { DIFFERENCE_REASONS, DIFFERENCE_REASON_ORDER, DIFFERENCE_STATUSES, DIFFERENCE_STATUS_ORDER, DIFF_STATUS_NONE_LABEL } from '../labels'

export const ROSTER_ENTERPRISE_SORTS = ['recognition', 'name', 'title'] as const
export type RosterEnterpriseSort = (typeof ROSTER_ENTERPRISE_SORTS)[number]
export const DEFAULT_ROSTER_ENTERPRISE_SORT: RosterEnterpriseSort = 'recognition'

/** 与企业列表差异列同源：状态、已展示原因及无差异。列表/导出接受同一组选项。 */
export const ROSTER_DIFFERENCE_FILTER_OPTIONS = [
  ...DIFFERENCE_STATUS_ORDER.map(value => ({value, label:DIFFERENCE_STATUSES[value]!})),
  ...DIFFERENCE_REASON_ORDER.map(value => ({value, label:DIFFERENCE_REASONS[value]!})),
  {value:'none',label:DIFF_STATUS_NONE_LABEL},
]
export const ROSTER_DIFFERENCE_FILTER_VALUES = ROSTER_DIFFERENCE_FILTER_OPTIONS.map(option => option.value)
export const rosterDifferenceFilterLabel = (value: string) => ROSTER_DIFFERENCE_FILTER_OPTIONS.find(option => option.value === value)?.label ?? value
