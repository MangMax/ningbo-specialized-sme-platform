import type {
  LOG_INTEGRATIONS,
  LOG_LEVELS,
  LogCollection,
  LogCollectionRule,
  LogFieldControls,
  LogFieldControlsPatch,
  LogFilter,
  LogPolicy,
  LogPolicyPatch
} from '#core/lib/logging/contract'
import type { LOG_FIELD_PROFILES } from '#core/lib/logging/field-controls'

/** 目录项由后端常量导出；这里只取它的元素类型，不另造只含 supported 的窄类型。 */
export type IntegrationEntry = (typeof LOG_INTEGRATIONS)[number]
/** 字段目录同样只取服务端响应的元素类型，页面不进口本地常量当开关来源。 */
export type FieldProfile = (typeof LOG_FIELD_PROFILES)[number]
/**
 * 服务端实际响应：新后端带 collection/catalog/revision，旧后端只有 legacy
 * retention/maxBytes。后两项保持可选，旧界面仍能保留清理能力，且不会显示
 * 伪采集开关。
 */
export type PolicyView = LogPolicy & {
  collection?: LogCollection
  fieldControls?: LogFieldControls
  catalog?: {
    integrations: readonly IntegrationEntry[]
    profiles?: readonly FieldProfile[]
  }
  revision?: number
  storageBytes: number
  pruned: number
  cleared: number
  accounting: string
  status?: {
    dropped?: number
    /** 写请求发出后失去确认的记录数；旧后端不返回，按 0 读。 */
    writeUnknown?: number
    /** 合入已有汇总的额外查询尝试数，不是丢弃或存储计数。 */
    coalesced?: number
    unavailable?: boolean
    since?: string
    queuedEntries?: number
    inFlightEntries?: number
    lastError?: string | null
  }
}
export type RuleChange = {
  dimension: '来源采集' | '技术集成' | '业务埋点'
  key: string
  label: string
  from: LogCollectionRule
  to: LogCollectionRule
}
/** 页面只做展示分组；草稿、差异比较和 PATCH 仍是同一份 collection 规则。 */
export type CollectionRow = {
  key: string
  label: string
  rule: LogCollectionRule
  prefix: 'source' | 'integration'
}
/** 一个字段叶子相对已保存配置的真实变动；恢复默认也会以 false→true 出现在这里。 */
export type FieldChange = {
  profile: string
  profileLabel: string
  level: LevelKey
  levelLabel: string
  field: string
  fieldLabel: string
  from: boolean
  to: boolean
}
export type ConfigReview = {
  kind: 'config'
  retentionDays: number
  maxBytes: number
  retentionChanged: boolean
  capacityChanged: boolean
  sources: RuleChange[]
  integrations: RuleChange[]
  fields: FieldChange[]
}
export type Review =
  | ConfigReview
  | { kind: 'clear'; filter: LogFilter & { from: string; to: string } }
export type LevelKey = (typeof LOG_LEVELS)[number]
export const LEVEL_LABELS: Record<LevelKey, string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误'
}
/** 级别来自服务端目录；未知取值原样显示，不猜中文名。 */
export const levelLabel = (level: string) => LEVEL_LABELS[level as LevelKey] ?? level

/** 值没变就不再让人为一个没有差异的操作做确认（比较的是提交用的真实单位）。 */
export const bytesLabel = (value: number) => {
  const gib = value >= 1073741824
  const unit = gib ? 1073741824 : 1048576
  const size = Number((value / unit).toFixed(value % unit === 0 ? 0 : 1))
  return `${size} ${gib ? 'GiB' : 'MiB'}（${value} 字节）`
}
export const local = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
}
/** 危险确认里给本地时间；原始 UTC 值跟在括号里，避免看不见冻结的到底是哪一刻。 */
export const localRange = (iso: string) => {
  const formatted = local(iso)
  return Number.isNaN(Date.parse(iso)) ? iso : `${formatted}（${iso}）`
}
export const ruleLabel = (rule: LogCollectionRule) =>
  rule.enabled
    ? `开启 · 最低${LEVEL_LABELS[rule.minLevel]}`
    : `关闭 · 级别保留${LEVEL_LABELS[rule.minLevel]}`

function fieldPatch(changes: FieldChange[]): LogFieldControlsPatch | undefined {
  if (!changes.length) return undefined
  const patch: Record<string, Record<string, Record<string, boolean>>> = {}
  for (const change of changes) {
    const levels = (patch[change.profile] ??= {})
    const fields = (levels[change.level] ??= {})
    fields[change.field] = change.to
  }
  return patch as LogFieldControlsPatch
}

/** 只发送有差异的规则；每条规则仍带 enabled + minLevel 两个必填字段。 */
export function configPatch(target: ConfigReview): LogPolicyPatch {
  const patch: LogPolicyPatch = {
    retentionDays: target.retentionDays,
    maxBytes: target.maxBytes
  }
  const sources = Object.fromEntries(
    target.sources.map((change) => [
      change.key,
      { enabled: change.to.enabled, minLevel: change.to.minLevel }
    ])
  )
  const integrations = Object.fromEntries(
    target.integrations.map((change) => [
      change.key,
      { enabled: change.to.enabled, minLevel: change.to.minLevel }
    ])
  )
  if (Object.keys(sources).length || Object.keys(integrations).length) {
    patch.collection = {}
    if (Object.keys(sources).length) patch.collection.sources = sources
    if (Object.keys(integrations).length) patch.collection.integrations = integrations
  }
  const fieldControls = fieldPatch(target.fields)
  if (fieldControls) patch.fieldControls = fieldControls
  return patch
}
