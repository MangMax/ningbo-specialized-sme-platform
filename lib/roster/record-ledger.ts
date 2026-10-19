import type { CorrespondenceDetail } from './correspondence-view'

/**
 * 企业详情「记录台账」的纯展示口径。
 *
 * 台账的主角是**每条认定 / 复核记录**，出处只是挂在它下面的一层。
 * 这些函数只回答「这条 edge 算不算这条事件的出处」「这条当前参考记录怎么标」，
 * 不改任何判定：已确认 / 候选 / 已拒绝 / 已解除仍然原样来自后端。
 */

export type EventEdge = Pick<CorrespondenceDetail, 'type' | 'status' | 'requiresRevalidation'>

/** 历史事件的直接出处只认这两种对应类型；later_process 与导出背景都不是本事件出处。 */
export function isEventSourceEdge(edge: Pick<CorrespondenceDetail, 'type'>): boolean {
  return edge.type === 'event_process' || edge.type === 'event_recognized'
}

/** 当前导出快照背景：只能作为「当前参考」，不能冒充历史认定证据。 */
export function isCurrentContextEdge(edge: Pick<CorrespondenceDetail, 'type'>): boolean {
  return edge.type === 'event_export_context' || edge.type === 'process_export_context'
}

/** 已确认且不需要重新核验的对应，才是这条事件当前的接口出处。 */
export function isConfirmedSourceEdge(edge: EventEdge): boolean {
  return isEventSourceEdge(edge) && edge.status === 'confirmed' && !edge.requiresRevalidation
}

export function isCandidateEdge(edge: Pick<CorrespondenceDetail, 'status'>): boolean {
  return edge.status === 'candidate'
}

/** 已拒绝 / 已解除：只进可选的匹配历史，不算出处。 */
export function isHistoricalNonSourceEdge(edge: Pick<CorrespondenceDetail, 'status'>): boolean {
  return edge.status === 'rejected' || edge.status === 'unlinked'
}

export interface EventSourceGroups<T extends EventEdge & Pick<CorrespondenceDetail, 'status'>> {
  /** 本事件已确认的接口出处。 */
  sources: T[]
  /** 候选：必须与已确认分开显示，且不计数为出处。 */
  candidates: T[]
  /** 当前导出快照：只作当前参考。 */
  currentContext: T[]
  /** 已确认但出处变更、需重新核验：不能按当前已确认出处计。 */
  revalidation: T[]
  /** 已拒绝 / 已解除：可查的匹配历史。 */
  history: T[]
}

/** 把一条事件上的 edge 分成「出处 / 候选 / 当前参考 / 匹配历史」四组。 */
export function groupEventEdges<T extends EventEdge & Pick<CorrespondenceDetail, 'status'>>(edges: T[]): EventSourceGroups<T> {
  return {
    sources: edges.filter(isConfirmedSourceEdge),
    candidates: edges.filter(edge => (isEventSourceEdge(edge) || isCurrentContextEdge(edge)) && isCandidateEdge(edge)),
    currentContext: edges.filter(edge => isCurrentContextEdge(edge) && edge.status === 'confirmed' && !edge.requiresRevalidation),
    revalidation: edges.filter(edge => (isEventSourceEdge(edge) || isCurrentContextEdge(edge)) && edge.status === 'confirmed' && edge.requiresRevalidation),
    history: edges.filter(edge => (isEventSourceEdge(edge) || isCurrentContextEdge(edge)) && isHistoricalNonSourceEdge(edge)),
  }
}

/** 记录行右侧的一句话状态；不比较字段，只陈述目前已登记的事实。 */
export function eventSourceState(groups: { sources: readonly unknown[]; candidates: readonly unknown[]; revalidation?: readonly unknown[] }, hasOfficialFile: boolean): string {
  if (groups.sources.length && hasOfficialFile) return '公布文件与接口已登记对应'
  if (groups.sources.length) return '仅有接口对应'
  if (groups.candidates.length) return '候选待确认'
  if (groups.revalidation?.length) return '对应待重新核验'
  if (hasOfficialFile) return '仅有公布文件'
  return '尚无已登记出处'
}

/** 日期 / 时间统一成人能读的写法：纯日期保持原样，时刻去掉 ISO 的 T、毫秒和 Z。 */
export function humanRecordTime(value: string | null | undefined): string {
  if (!value) return '时间未记录'
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}
