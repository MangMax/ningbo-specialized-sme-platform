/** 企业列表排序参数。此文件只包含纯契约值，客户端与服务端读模型都可以安全引用。 */
export const ROSTER_ENTERPRISE_SORTS = ['recognition', 'name', 'title'] as const
export type RosterEnterpriseSort = (typeof ROSTER_ENTERPRISE_SORTS)[number]
export const DEFAULT_ROSTER_ENTERPRISE_SORT: RosterEnterpriseSort = 'recognition'
