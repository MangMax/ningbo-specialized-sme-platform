import type { RosterPlatformQueryRow, RosterPlatformRelationRow } from '../../layers/sme-roster/lib/roster/enterprise-roster'
import type { PlatformFactField, PlatformObservationFact } from '../platform/observation-facts'

export type PlatformRecordQuery = RosterPlatformQueryRow
export type PlatformRecord = RosterPlatformRelationRow & { aliasNameRaw?: string | null }

/** 原始字段保留在数据层；界面说明使用业务名称。 */
export function platformNoteForDisplay(note: string | null | undefined): string | null {
  if (!note) return null
  return note
    .replace(/recognized_list|queryBusList/g, '已认定企业列表')
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
  if (/session|cookie|token|password|debug|stack|authorization|bearer|credential|secret/i.test(reason)) return '平台查询未完成，请稍后重试。'
  if (/限流|频繁|too many|rate.limit|\b429\b/i.test(reason)) return '平台查询过于频繁，请稍后重试。'
  if (/超时|timeout|timed out/i.test(reason)) return '平台响应超时，请稍后重试。'
  if (/ECONN|ENOTFOUND|network|fetch failed/i.test(reason)) return '暂时无法连接平台，请稍后重试。'
  if (/https?:|<[^>]+>|Error:|\bat \w+[.(]|HTTP \d/i.test(reason)) return '平台查询未完成，请稍后重试。'
  return platformNoteForDisplay(reason)?.replace(/平台接口/g, '平台服务') ?? null
}

/** Business labels preserve source meanings; unknown scalar fields keep their original keys. */
export const PLATFORM_BUSINESS_FIELDS: Record<string, string> = {
  id: '平台行标识', qymc: '企业名称', tyshxydm: '统一社会信用代码', rdjb: '平台称号原值',
  szq: '平台属地（原值/代码）', szsfmc: '平台省市', szsf: '省份代码', szs: '城市代码',
  rdxx: '平台认定信息', rdsj: '平台认定时间（原值）', rdrq: '平台认定日期（原值）',
  rddqrq: '有效期（原值）', whpcyear: '维护年份', whpc: '维护批次',
  year: '平台年份（原值）', sqsj: '申报时间', sblx: '申报类型', cszt: '办理状态',
  personuuid: '平台批次原值', sshy: '所属行业', jtxflymc: '细分领域', zdcpmc: '主导产品',
  qylx: '企业类型原值', sfty: '同意标记原值', zyzb: '主营占比原值',
}
/** Shared display rule for typed projection values and legacy raw/import columns. */
export function platformFieldValue(value: unknown): string {
  return (typeof value === 'string' && value !== '') || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '未提供'
}
export function recognizedField(raw: Record<string, unknown> | null | undefined, field: string): string {
  return platformFieldValue(raw?.[field])
}

/** One rule for "source-owned typed field wins only when this source models it"; otherwise
 * the legacy relation/raw column is used. A modeled null stays "未提供" (never backfilled). */
export function platformDetailValue(typed: PlatformObservationFact | null | undefined, field: PlatformFactField, legacy: unknown): string {
  return platformFieldValue(platformDetailRaw(typed, field, legacy))
}

export function platformDetailRaw(typed: PlatformObservationFact | null | undefined, field: PlatformFactField, legacy: unknown): unknown {
  return typed?.modeledFields.includes(field) ? (typed as unknown as Record<string, unknown>)[field] : legacy
}
export function platformBusinessFields(raw: Record<string, unknown> | null | undefined) {
  return Object.entries(raw ?? {}).filter(([key, value]) =>
    !/cookie|session|token|password|secret|auth|csrf|debug|stack|request|response|headers|envelope|^_/i.test(key)
    && (value == null || ['string', 'number', 'boolean'].includes(typeof value)))
    .map(([key]) => ({ key, label: PLATFORM_BUSINESS_FIELDS[key] ?? '平台原字段', value: recognizedField(raw, key) }))
}

/** Business presentation is an opt-in, verified whitelist of this observation's raw fields.
 * Do not fill gaps from another interface, observation, query conditions or collection time.
 * rdtime is displayed without assigning a business date meaning; related raw states are separate.
 */
const PRESENTATION_FIELDS: Record<string, string> = {
  qymc: '企业名称', tyshxydm: '统一社会信用代码', rdjb: '平台称号原值',
  sblx: '申报类型', sqsj: '申报时间', cszt: '办理状态',
  rdxx: '平台认定信息', rdsj: '平台认定时间（原值）', rdrq: '平台认定日期（原值）',
  rdtime: '平台记录时间（含义待核）', rddqrq: '有效期（原值）', whpcyear: '维护年份', whpc: '维护批次', year: '平台年份（原值）',
  szsfmc: '平台省市', szsmc: '平台城市', szqmc: '平台区县',
  sshy: '所属行业', jtxflymc: '细分领域', zdcpmc: '主导产品',
  qylx: '企业类型原值', sfty: '同意标记原值', zyzb: '主营占比原值',
}
export function platformPresentationFields(raw: Record<string, unknown> | null | undefined) {
  return Object.entries(PRESENTATION_FIELDS).flatMap(([key, label]) => {
    const value = raw?.[key]
    if (!(typeof value === 'string' && value.trim() !== '' || typeof value === 'number' || typeof value === 'boolean')) return []
    return [{ key, label, value: String(value) }]
  })
}

/** Bounded keys under investigation, never inferred personnel roles or cross-observation values. */
export function platformRelatedRawFields(raw: Record<string, unknown> | null | undefined) {
  return ['rdtime', 'rddqrq', 'sqsj', 'zsrxm', 'cz'].map(key => {
    if (!raw || !Object.hasOwn(raw, key)) return { key, state: 'missing' as const, value: '' }
    const value = raw[key]
    if (value === null) return { key, state: 'null' as const, value: 'null' }
    if (typeof value === 'string' && value.trim() === '') return { key, state: 'blank' as const, value: JSON.stringify(value) }
    return { key, state: 'value' as const, value: typeof value === 'string' ? value : JSON.stringify(value) ?? String(value) }
  })
}

export const PLATFORM_HISTORY_CONFLICTS: Record<string, string> = {
  identity_conflict: '企业身份冲突', title_conflict: '称号冲突',
  correspondence_decision_conflict: '对应决定冲突', platform_key_conflict: '平台编号冲突',
  platform_field_conflict: '原字段冲突',
}
export const PLATFORM_HISTORY_STATES: Record<string, string> = {
  not_indexed: '尚未建立业务映射', missing_key: '缺少平台业务编号',
  conflict: '平台编号冲突', unverifiable: '原文内容无法核实',
}
