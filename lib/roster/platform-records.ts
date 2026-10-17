import type { RosterPlatformQueryRow, RosterPlatformRelationRow } from './enterprise-roster'

export type PlatformRecordQuery = RosterPlatformQueryRow
export type PlatformRecord = RosterPlatformRelationRow & { aliasNameRaw?: string | null }

/** 原始字段保留在数据层；界面说明使用业务名称。 */
export function platformNoteForDisplay(note: string | null | undefined): string | null {
  if (!note) return null
  return note
    .replace(/business_list|businessList/g, '称号查询记录')
    .replace(/apply_list|applyList/g, '申报办理记录')
    .replace(/rdjb\s*=\s*1/g, '创新型中小企业')
    .replace(/rdjb\s*=\s*2/g, '专精特新中小企业')
    .replace(/rdjb\s*=\s*3/g, '专精特新“小巨人”')
    .replace(/tyshxydm/g, '统一社会信用代码')
}

/** 查询未完成时，给出用户能采取行动的原因，不暴露请求参数或错误堆栈。 */
export function platformFailureForDisplay(reason: string | null | undefined): string | null {
  if (!reason) return null
  if (/\b403\b|permission denied|forbidden/i.test(reason)) return '平台拒绝了本次查询，请检查登录状态或访问权限。'
  if (/登录.{0,6}(失效|过期)|(session|login).{0,12}expired/i.test(reason)) return '平台登录已失效，请重新登录后查询。'
  if (/unauthori[sz]ed|\b401\b/i.test(reason)) return '平台需要登录验证，请登录后查询。'
  if (/session|cookie/i.test(reason)) return '平台查询未完成，请稍后重试。'
  if (/限流|频繁|too many|rate.limit|\b429\b/i.test(reason)) return '平台查询过于频繁，请稍后重试。'
  if (/超时|timeout|timed out/i.test(reason)) return '平台响应超时，请稍后重试。'
  if (/ECONN|ENOTFOUND|network|fetch failed/i.test(reason)) return '暂时无法连接平台，请稍后重试。'
  if (/https?:|<[^>]+>|Error:|\bat \w+[.(]|HTTP \d/i.test(reason)) return '平台查询未完成，请稍后重试。'
  return platformNoteForDisplay(reason)?.replace(/平台接口/g, '平台服务') ?? null
}
