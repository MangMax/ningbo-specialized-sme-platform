<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { LOG_LEVELS } from '~~/lib/logging/contract'
import type {
  LOG_INTEGRATIONS,
  LogCollection,
  LogCollectionRule,
  LogFieldControls,
  LogFieldControlsPatch,
  LogFilter,
  LogPolicy,
  LogPolicyPatch
} from '~~/lib/logging/contract'
import type { LOG_FIELD_PROFILES } from '~~/lib/logging/field-controls'
import { isClientLogSource, sourceLabel } from './logPresentation'
import { iconForGroup, iconForIntegration, iconForSection, iconForSource } from './logIcons'
import LogFieldEditor from './LogFieldEditor.vue'
import LogModulePanel from './LogModulePanel.vue'
import {
  logBrowserHeaders,
  logErrorCode,
  logErrorMessage,
  useLogRead
} from '~/composables/useLogRead'
import TableFailureState from '@/components/TableFailureState.vue'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Table, TableBody, TableRow, TableCell } from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'

/** 目录项由后端常量导出；这里只取它的元素类型，不另造只含 supported 的窄类型。 */
type IntegrationEntry = (typeof LOG_INTEGRATIONS)[number]
/** 字段目录同样只取服务端响应的元素类型，页面不进口本地常量当开关来源。 */
type FieldProfile = (typeof LOG_FIELD_PROFILES)[number]
/**
 * 服务端实际响应：新后端带 collection/catalog/revision，旧后端只有 legacy
 * retention/maxBytes。后两项保持可选，旧界面仍能保留清理能力，且不会显示
 * 伪采集开关。
 */
type PolicyView = LogPolicy & {
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
    unavailable?: boolean
    since?: string
    queuedEntries?: number
    inFlightEntries?: number
    lastError?: string | null
  }
}
type RuleChange = {
  dimension: '来源采集' | '技术集成' | '业务埋点'
  key: string
  label: string
  from: LogCollectionRule
  to: LogCollectionRule
}
/** 页面只做展示分组；草稿、差异比较和 PATCH 仍是同一份 collection 规则。 */
type CollectionRow = {
  key: string
  label: string
  rule: LogCollectionRule
  prefix: 'source' | 'integration'
}
type IntegrationRow = CollectionRow & {
  category: IntegrationEntry['category']
  runtimes: IntegrationEntry['runtimes']
}
type RowGroup = {
  key: string
  testid: string
  title: string
  note?: string
  icon: string
  rows: CollectionRow[]
}
type CollectionSection = {
  key: string
  testid: string
  headingId: string
  title: string
  description: string
  icon: string
  groups: RowGroup[]
}
/** 一个字段叶子相对已保存配置的真实变动；恢复默认也会以 false→true 出现在这里。 */
type FieldChange = {
  profile: string
  profileLabel: string
  level: LevelKey
  levelLabel: string
  field: string
  fieldLabel: string
  from: boolean
  to: boolean
}
type ConfigReview = {
  kind: 'config'
  retentionDays: number
  maxBytes: number
  retentionChanged: boolean
  capacityChanged: boolean
  sources: RuleChange[]
  integrations: RuleChange[]
  fields: FieldChange[]
}
type Review =
  | ConfigReview
  | { kind: 'clear'; filter: LogFilter & { from: string; to: string } }

const props = defineProps<{ filter: LogFilter }>()
const emit = defineEmits<{ changed: [] }>()
const filterLabels: Record<string, string> = {
  from: '开始时间',
  to: '结束时间',
  level: '级别',
  source: '来源',
  outcome: '结果',
  operation: '操作',
  requestId: '请求标识',
  traceId: '链路标识',
  taskId: '任务标识',
  fileId: '文件编号',
  batchId: '批次标识',
  resourceId: '资源标识'
}
type LevelKey = (typeof LOG_LEVELS)[number]
const LEVEL_LABELS: Record<LevelKey, string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误'
}
/** 级别来自服务端目录；未知取值原样显示，不猜中文名。 */
const levelLabel = (level: string) => LEVEL_LABELS[level as LevelKey] ?? level
const { data, loading, error, refresh } = useLogRead(ref('policy'), () =>
  $fetch<PolicyView>('/api/logs/policy', { retry: 0, headers: logBrowserHeaders })
)
const days = ref(7),
  bytes = ref(536870912),
  initialized = ref(false)
const sourceDraft = ref<Record<string, LogCollectionRule>>({}),
  integrationDraft = ref<Record<string, LogCollectionRule>>({})
/** 字段草稿：profile → 级别 → 字段布尔。只在服务端目录存在时才有内容。 */
const fieldDraft = ref<LogFieldControls>({} as LogFieldControls)
/** 每个采集器面板独立开合；多个面板可同时打开。 */
const openPanels = ref<Record<string, boolean>>({})
const panelKey = (prefix: 'source' | 'integration', key: string) => `${prefix}:${key}`

function cloneRules(
  rules?: Partial<Record<string, LogCollectionRule>>
): Record<string, LogCollectionRule> {
  const out: Record<string, LogCollectionRule> = {}
  for (const [key, rule] of Object.entries(rules ?? {}))
    if (rule) out[key] = { enabled: rule.enabled, minLevel: rule.minLevel }
  return out
}
/** 草稿只在首次读取或保存成功后的真实响应上初始化；刷新/失败不覆盖用户编辑。 */
function initializeDrafts(policy: PolicyView) {
  days.value = policy.retentionDays
  bytes.value = policy.maxBytes
  sourceDraft.value = cloneRules(policy.collection?.sources)
  integrationDraft.value = cloneRules(policy.collection?.integrations)
  const profiles = policy.catalog?.profiles ?? []
  fieldDraft.value = cloneFieldControls(policy.fieldControls, profiles) as LogFieldControls
  // 首次读取默认展开 HTTP（如果它的采集器存在）；之后保留用户的开合状态。
  if (!Object.keys(openPanels.value).length) {
    const http = profiles.find((profile) => String(profile.key) === 'http')
    const collector = http ? collectorKeyForProfile(http) : undefined
    if (collector) openPanels.value[panelKey('integration', collector)] = true
  }
}
watch(data, (value) => {
  if (value && !initialized.value) {
    initializeDrafts(value)
    initialized.value = true
  }
})

const pending = ref(false),
  notice = ref(''),
  failure = ref('')
const review = ref<Review | null>(null)
// Keep the frozen contents while the shared Dialog plays its closing animation.
// Clearing the open state must not change a configuration review into a clear warning.
const dialogReview = computed<Review | null>((previous) => review.value ?? previous ?? null)
const busy = computed(() => pending.value || loading.value || !!error.value)
const validPolicy = computed(
  () =>
    Number.isInteger(days.value) &&
    days.value >= 1 &&
    days.value <= 365 &&
    Number.isInteger(bytes.value) &&
    bytes.value >= 1048576 &&
    bytes.value <= 4294967296
)
const clearAllowed = computed(
  () =>
    !!props.filter.from &&
    !!props.filter.to &&
    !Number.isNaN(Date.parse(props.filter.from)) &&
    !Number.isNaN(Date.parse(props.filter.to)) &&
    Date.parse(props.filter.from) <= Date.parse(props.filter.to)
)

/** 只有新旧后端都给出 collection + catalog 时才渲染采集规则，不从常量补一套伪目录。 */
const supportsCollection = computed(
  () => !!data.value?.collection && !!data.value?.catalog?.integrations.length
)
const sourceRows = computed<CollectionRow[]>(() =>
  Object.entries(sourceDraft.value).map(([key, rule]) => ({
    key,
    label: sourceLabel(key),
    rule,
    prefix: 'source' as const
  }))
)
const configuredIntegrations = computed(() =>
  (data.value?.catalog?.integrations ?? []).filter(
    (meta) =>
      meta.state === 'supported' &&
      meta.configurable &&
      !!integrationDraft.value[meta.key]
  )
)
const unwiredIntegrations = computed(() =>
  (data.value?.catalog?.integrations ?? []).filter(
    (meta) => !configuredIntegrations.value.some((supported) => supported.key === meta.key)
  )
)
const integrationRows = computed<IntegrationRow[]>(() =>
  configuredIntegrations.value.map((meta) => ({
    key: meta.key,
    label: meta.label,
    rule: integrationDraft.value[meta.key]!,
    prefix: 'integration' as const,
    category: meta.category,
    runtimes: meta.runtimes
  }))
)
/** runtimes 只用于页面分组，不是新的策略维度；旧目录缺失时按兼容组展示。 */
const runsOn = (row: IntegrationRow, runtime: 'node' | 'browser') =>
  (row.runtimes as readonly string[] | undefined)?.includes(runtime) === true
const technicalGroups = computed<RowGroup[]>(() => {
  const technical = integrationRows.value.filter((row) => row.category === 'technical')
  const groups: RowGroup[] = [
    {
      key: 'technical-node',
      testid: 'log-technical-node',
      title: '服务端',
      icon: iconForGroup('technical-node'),
      rows: technical.filter((row) => runsOn(row, 'node'))
    },
    {
      key: 'technical-browser',
      testid: 'log-technical-browser',
      title: '客户端',
      note: '客户端自报，不代表服务端执行事实。',
      icon: iconForGroup('technical-browser'),
      rows: technical.filter((row) => runsOn(row, 'browser'))
    },
    {
      key: 'technical-other',
      testid: 'log-technical-other',
      title: '未标注运行端',
      note: '旧目录没有运行端元数据，仅作兼容展示；不影响规则保存。',
      icon: iconForGroup('technical-other'),
      rows: integrationRows.value.filter(
        (row) => row.category !== 'technical' && row.category !== 'business'
      )
    }
  ]
  return groups.filter((group) => group.rows.length > 0)
})
const businessGroups = computed<RowGroup[]>(() => {
  const groups: RowGroup[] = [
    {
      key: 'business-shared',
      testid: 'log-business-shared',
      title: '跨端共享手动上报',
      note: '服务端与客户端共用这一条规则，并与来源条件同时成立。',
      icon: iconForGroup('business-shared'),
      rows: integrationRows.value.filter((row) => row.category === 'business')
    },
    {
      key: 'business-node',
      testid: 'log-business-node',
      title: '服务端来源',
      icon: iconForGroup('business-node'),
      rows: sourceRows.value.filter((row) => !isClientLogSource(row.key))
    },
    {
      key: 'business-browser',
      testid: 'log-business-browser',
      title: '客户端来源',
      note: '浏览器自报，上下文不可信。',
      icon: iconForGroup('business-browser'),
      rows: sourceRows.value.filter((row) => isClientLogSource(row.key))
    }
  ]
  return groups.filter((group) => group.rows.length > 0)
})
const collectionSections = computed<CollectionSection[]>(() => {
  const sections: CollectionSection[] = [
    {
      key: 'technical',
      testid: 'log-collection-integrations',
      headingId: 'log-technical-heading',
      title: '技术集成',
      description: '技术集成与来源须同时开启，最低级别取两者中更严格的一处。',
      icon: iconForSection('technical'),
      groups: technicalGroups.value
    },
    {
      key: 'business',
      testid: 'log-collection-sources',
      headingId: 'log-business-heading',
      title: '业务埋点',
      description: '来源维度独立生效，也可被技术集成条件收窄。',
      icon: iconForSection('business'),
      groups: businessGroups.value
    }
  ]
  return sections.filter((section) =>
    section.key === 'technical'
      ? section.groups.length > 0 || unwiredIntegrations.value.length > 0
      : section.groups.length > 0
  )
})


/** 字段目录只来自服务端响应；旧后端或不可读的字段规则不渲染入口，也不补默认。 */
const fieldProfiles = computed<readonly FieldProfile[]>(() => data.value?.catalog?.profiles ?? [])
const fieldValues = (controls: LogFieldControls | undefined, profile: string, level: string) =>
  (controls as unknown as Record<string, Record<string, Record<string, boolean>>> | undefined)?.[
    profile
  ]?.[level]
const supportsFieldControls = computed(() => {
  const profiles = fieldProfiles.value,
    controls = data.value?.fieldControls
  // 父级条件是真实的来源/集成规则；没有 collection 就无从判断“当前是否采集”，
  // 整个入口隐藏而不是渲染一组看起来可用的孤立开关。
  if (!profiles.length || !controls || !data.value?.collection) return false
  return profiles.every(
    (profile) =>
      profile.fields.length > 0 &&
      profile.levels.length > 0 &&
      profile.levels.every((level) => {
        const values = fieldValues(controls, profile.key, level)
        return (
          !!values && profile.fields.every((field) => typeof values[field.key] === 'boolean')
        )
      })
  )
})
/** 只按目录里真实存在的键重建，响应里多出的 profile/level/field 不进入草稿。 */
function cloneFieldControls(
  controls: LogFieldControls | undefined,
  profiles: readonly FieldProfile[]
): LogFieldControls {
  const out: Record<string, Record<string, Record<string, boolean>>> = {}
  for (const profile of profiles) {
    const levels: Record<string, Record<string, boolean>> = {}
    for (const level of profile.levels) {
      const values = fieldValues(controls, profile.key, level)
      const fields: Record<string, boolean> = {}
      for (const field of profile.fields) fields[field.key] = values?.[field.key] === true
      levels[level] = fields
    }
    out[profile.key] = levels
  }
  return out as unknown as LogFieldControls
}
/**
 * profile 与主采集器的展示映射。目录里没有“父级集成”字段，所以先看同名集成
 * （tus 等服务端 hook 就是这种），再补已知的独立采集器（HTTP 完成事件由
 * Nuxt / Nitro 集成产生）。未来目录新增 profile 时，两者都不匹配就不臆造父级。
 */
const PROFILE_COLLECTOR_INTEGRATIONS: Record<string, readonly string[]> = {
  http: ['nuxt-nitro']
}
function collectorKeyForProfile(profile: FieldProfile): string | undefined {
  const mapped = PROFILE_COLLECTOR_INTEGRATIONS[String(profile.key)]?.[0]
  if (mapped) return mapped
  return configuredIntegrations.value.some((meta) => meta.key === String(profile.key))
    ? String(profile.key)
    : undefined
}
function collectorLabelForProfile(profile: FieldProfile): string {
  const key = collectorKeyForProfile(profile)
  return (
    configuredIntegrations.value.find((meta) => meta.key === key)?.label ??
    key ??
    String(profile.key)
  )
}
/** 集成行承载哪个字段 profile；来源行不承载字段（字段跟随主采集器）。 */
function profileForIntegration(key: string): FieldProfile | undefined {
  return (
    fieldProfiles.value.find((profile) => String(profile.key) === key) ??
    fieldProfiles.value.find((profile) =>
      (PROFILE_COLLECTOR_INTEGRATIONS[String(profile.key)] ?? []).includes(key)
    )
  )
}
function profileForSource(key: string): FieldProfile | undefined {
  return fieldProfiles.value.find((profile) => String(profile.source) === key)
}
/** 只给采集器行返回 profile；来源行即使有同 source 的 profile 也不画字段开关。 */
function collectorProfileForRow(row: CollectionRow): FieldProfile | undefined {
  return row.prefix === 'integration' ? profileForIntegration(row.key) : undefined
}
function sourceProfileForRow(row: CollectionRow): FieldProfile | undefined {
  return row.prefix === 'source' ? profileForSource(row.key) : undefined
}
function profileForRow(row: CollectionRow): FieldProfile | undefined {
  return collectorProfileForRow(row) ?? sourceProfileForRow(row)
}
/** 模板里已用 v-if 判过；这里返回非空，避免在模板写非空断言。 */
function requireCollectorProfile(row: CollectionRow): FieldProfile {
  const profile = collectorProfileForRow(row)
  if (!profile) throw new Error('collector_profile_missing')
  return profile
}
function sourceCollectorLabel(row: CollectionRow): string {
  const profile = sourceProfileForRow(row)
  return profile ? collectorLabelForProfile(profile) : ''
}
function parentRulesFor(profile: FieldProfile | undefined) {
  if (!profile) return []
  const rules: { label: string; rule: LogCollectionRule }[] = []
  const source = sourceDraft.value[profile.source]
  if (source) rules.push({ label: sourceLabel(String(profile.source)) + '来源', rule: source })
  const candidates = [
    String(profile.key),
    ...(PROFILE_COLLECTOR_INTEGRATIONS[String(profile.key)] ?? [])
  ]
  for (const key of candidates) {
    const rule = integrationDraft.value[key]
    if (!rule) continue
    const label = configuredIntegrations.value.find((meta) => meta.key === key)?.label ?? key
    rules.push({ label: label + '集成', rule })
  }
  return rules
}
const offReasonsFor = (profile: FieldProfile | undefined) =>
  parentRulesFor(profile)
    .filter((entry) => !entry.rule.enabled)
    .map((entry) => entry.label + '已关闭')
/** 核对时按改动涉及的 profile 说明父级；不是只看当前正在编辑的那一类。 */
const reviewParentReasons = computed(() => {
  const keys = [...new Set(fieldChanges.value.map((change) => change.profile))]
  const reasons = keys.flatMap((key) =>
    offReasonsFor(fieldProfiles.value.find((profile) => profile.key === key))
  )
  return [...new Set(reasons)]
})
/** 父级规则同时生效，有效门槛取更严格的一处。 */
function parentMinLevelFor(profile: FieldProfile): LevelKey | undefined {
  const indexes = parentRulesFor(profile).map((entry) => LOG_LEVELS.indexOf(entry.rule.minLevel))
  if (!indexes.length) return undefined
  return LOG_LEVELS[Math.max(...indexes)]
}
function effectiveMinFor(profile: FieldProfile | undefined): LevelKey | undefined {
  return profile ? parentMinLevelFor(profile) : undefined
}
type FieldState = 'on' | 'off' | 'mixed'
/** 一份选择是否适用于全部事件级别；mixed 是已保存配置真实存在的不一致。 */
function fieldState(profile: FieldProfile, field: string): FieldState {
  let on = 0
  for (const level of profile.levels)
    if (fieldValues(fieldDraft.value, profile.key, level)?.[field] === true) on++
  return on === profile.levels.length ? 'on' : on === 0 ? 'off' : 'mixed'
}
function fieldCounts(profile: FieldProfile) {
  let on = 0,
    mixed = 0
  for (const field of profile.fields) {
    const state = fieldState(profile, field.key)
    if (state === 'on') on++
    else if (state === 'mixed') mixed++
  }
  return { on, mixed, total: profile.fields.length }
}
/** 相对服务端基线的真实差异；恢复 true 也在这里出现，不能只在“关闭项”里找。 */
const fieldChanges = computed<FieldChange[]>(() => {
  const baseline = data.value?.fieldControls
  if (!baseline || !supportsFieldControls.value) return []
  const changes: FieldChange[] = []
  for (const profile of fieldProfiles.value)
    for (const level of profile.levels)
      for (const field of profile.fields) {
        const from = fieldValues(baseline, profile.key, level)?.[field.key]
        const to = fieldValues(fieldDraft.value, profile.key, level)?.[field.key]
        if (typeof from !== 'boolean' || typeof to !== 'boolean' || from === to) continue
        changes.push({
          profile: profile.key,
          profileLabel: profile.label,
          level,
          levelLabel: levelLabel(level),
          field: field.key,
          fieldLabel: field.label,
          from,
          to
        })
      }
  return changes
})
const controlsFor = (profile: FieldProfile) =>
  (
    fieldDraft.value as unknown as Record<
      string,
      Record<string, Record<string, boolean>>
    >
  )[String(profile.key)]!
function profileDirty(profile: FieldProfile) {
  const baseline = data.value?.fieldControls
  if (!baseline) return false
  return profile.levels.some((level) =>
    profile.fields.some((field) => {
      const from = fieldValues(baseline, profile.key, level)?.[field.key]
      const to = fieldValues(fieldDraft.value, profile.key, level)?.[field.key]
      return typeof from === 'boolean' && from !== to
    })
  )
}
/** 规则差异 + 该采集器字段差异，用于面板“未保存”和顶部汇总。 */
function rowRuleChanged(row: CollectionRow) {
  const collection = data.value?.collection as
    | {
        sources?: Record<string, LogCollectionRule>
        integrations?: Record<string, LogCollectionRule>
      }
    | undefined
  const base =
    row.prefix === 'source'
      ? collection?.sources?.[row.key]
      : collection?.integrations?.[row.key]
  return !!base && !sameRule(base, row.rule)
}
function rowDirty(row: CollectionRow) {
  const profile = collectorProfileForRow(row)
  return rowRuleChanged(row) || (!!profile && supportsFieldControls.value && profileDirty(profile))
}
const dirtyModuleLabels = computed(() => {
  const labels = new Set<string>()
  for (const row of integrationRows.value) if (rowDirty(row)) labels.add(row.label)
  for (const row of sourceRows.value) if (rowRuleChanged(row)) labels.add(row.label)
  // 保留策略也是同一份全局草稿；只改天数/容量时同样要显示“未保存”。
  if (retentionChanged.value || capacityChanged.value) labels.add('保留策略')
  return [...labels]
})
function ruleSummary(rule: LogCollectionRule) {
  return rule.enabled
    ? '最低' + LEVEL_LABELS[rule.minLevel]
    : '关闭 · 级别保留' + LEVEL_LABELS[rule.minLevel]
}
/** 面板头的一行摘要：门槛、字段保留数、来源跟随/父级关闭。 */
function panelSummary(row: CollectionRow) {
  const parts = [ruleSummary(row.rule)]
  const profile = collectorProfileForRow(row)
  if (profile && supportsFieldControls.value) {
    const { on, total } = fieldCounts(profile)
    parts.push('详情 ' + on + '/' + total + ' 项')
    if (offReasonsFor(profile).length) parts.push('当前不采集')
  }
  const sourceProfile = sourceProfileForRow(row)
  if (sourceProfile) parts.push('字段跟随「' + collectorLabelForProfile(sourceProfile) + '」')
  if (!profile && !sourceProfile) parts.push('无独立详情字段')
  return parts.join(' · ')
}
type Counterpart = {
  prefix: 'source' | 'integration'
  key: string
  label: string
  role: '来源' | '采集器'
}
function counterpartForRow(row: CollectionRow): Counterpart | null {
  if (row.prefix === 'integration') {
    const profile = profileForIntegration(row.key)
    if (!profile) return null
    const sourceKey = String(profile.source)
    if (!sourceDraft.value[sourceKey]) return null
    return {
      prefix: 'source',
      key: sourceKey,
      label: sourceLabel(sourceKey),
      role: '来源'
    }
  }
  const profile = sourceProfileForRow(row)
  if (!profile) return null
  const collectorKey = collectorKeyForProfile(profile)
  const collector = integrationRows.value.find((candidate) => candidate.key === collectorKey)
  if (!collectorKey || !collector) return null
  return { prefix: 'integration', key: collectorKey, label: collector.label, role: '采集器' }
}
/** 跳到同时生效的另一侧；只开面板，不改任何数据。 */
function openCounterpart(prefix: 'source' | 'integration', key: string) {
  openPanels.value[panelKey(prefix, key)] = true
  void nextTick(() => {
    const target = document.querySelector(
      '[data-testid="log-module-' + prefix + '-' + key + '"]'
    ) as HTMLElement | null
    target?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  })
}
function openCounterpartForRow(row: CollectionRow) {
  const other = counterpartForRow(row)
  if (other) openCounterpart(other.prefix, other.key)
}
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
const sameRule = (a: LogCollectionRule, b: LogCollectionRule) =>
  a.enabled === b.enabled && a.minLevel === b.minLevel
const changedSources = computed<RuleChange[]>(() => {
  const base = data.value?.collection?.sources as
    | Record<string, LogCollectionRule>
    | undefined
  if (!base) return []
  return Object.entries(sourceDraft.value).flatMap(([key, rule]) => {
    const before = base[key]
    return before && !sameRule(before, rule)
      ? [
          {
            dimension: '来源采集' as const,
            key,
            label: sourceLabel(key),
            from: { ...before },
            to: { ...rule }
          }
        ]
      : []
  })
})
const changedIntegrations = computed<RuleChange[]>(() => {
  const base = data.value?.collection?.integrations as
    | Record<string, LogCollectionRule>
    | undefined
  if (!base) return []
  return integrationRows.value.flatMap(({ key, label, rule, category }) => {
    const before = base[key]
    return before && !sameRule(before, rule)
      ? [
          {
            dimension: (category === 'business' ? '业务埋点' : '技术集成') as RuleChange['dimension'],
            key,
            label,
            from: { ...before },
            to: { ...rule }
          }
        ]
      : []
  })
})
const retentionChanged = computed(
  () => !!data.value && Number(days.value) !== data.value.retentionDays
)
const capacityChanged = computed(
  () => !!data.value && Number(bytes.value) !== data.value.maxBytes
)
const hasChanges = computed(
  () =>
    retentionChanged.value ||
    capacityChanged.value ||
    changedSources.value.length > 0 ||
    changedIntegrations.value.length > 0 ||
    fieldChanges.value.length > 0
)

/** 值没变就不再让人为一个没有差异的操作做确认（比较的是提交用的真实单位）。 */
const bytesLabel = (value: number) => {
  const gib = value >= 1073741824
  const unit = gib ? 1073741824 : 1048576
  const size = Number((value / unit).toFixed(value % unit === 0 ? 0 : 1))
  return `${size} ${gib ? 'GiB' : 'MiB'}（${value} 字节）`
}
const local = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
}
/** 危险确认里给本地时间；原始 UTC 值跟在括号里，避免看不见冻结的到底是哪一刻。 */
const localRange = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : `${date.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')}（${iso}）`
}
const ruleLabel = (rule: LogCollectionRule) =>
  rule.enabled
    ? `开启 · 最低${LEVEL_LABELS[rule.minLevel]}`
    : `关闭 · 级别保留${LEVEL_LABELS[rule.minLevel]}`

/** 对话框关闭后把焦点还给触发它的核对按钮；取消/Escape 不把焦点丢给 body。 */
function restoreReviewFocus() {
  void nextTick(() => {
    const button = document.querySelector(
      '[data-testid="log-policy-review"]'
    ) as HTMLButtonElement | null
    button?.focus()
  })
}
function reviewConfig() {
  if (busy.value || !data.value || !validPolicy.value || !hasChanges.value) return
  review.value = {
    kind: 'config',
    retentionDays: Number(days.value),
    maxBytes: Number(bytes.value),
    retentionChanged: retentionChanged.value,
    capacityChanged: capacityChanged.value,
    sources: changedSources.value,
    integrations: changedIntegrations.value,
    fields: fieldChanges.value
  }
}
function reviewClear() {
  if (!clearAllowed.value || busy.value || !data.value) return
  const { cursor: _cursor, limit: _limit, ...filter } = props.filter
  review.value = { kind: 'clear', filter: { ...filter, from: filter.from!, to: filter.to! } }
}
/** 只发送有差异的规则；每条规则仍带 enabled + minLevel 两个必填字段。 */
function configPatch(target: ConfigReview): LogPolicyPatch {
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

let active = true
onBeforeUnmount(() => {
  active = false
})
async function confirm() {
  if (!review.value || pending.value) return
  const target = review.value
  pending.value = true
  notice.value = ''
  failure.value = ''
  try {
    if (target.kind === 'config') {
      const result = await $fetch<PolicyView>('/api/logs/policy', {
        method: 'PATCH',
        retry: 0,
        headers: logBrowserHeaders,
        body: configPatch(target)
      })
      if (active)
        notice.value =
          '日志配置已保存。'
      if (active) {
        // PATCH 成功响应就是真实生效值；先落到草稿，finally 再刷新概览与真实值。
        if (result) {
          initializeDrafts(result)
          initialized.value = true
        } else {
          initialized.value = false
        }
      }
    } else {
      const result = await $fetch<{ deleted: number; hasMore: boolean }>('/api/logs/clear', {
        method: 'POST',
        retry: 0,
        headers: logBrowserHeaders,
        body: { ...target.filter, confirm: true }
      })
      if (active) {
        notice.value = `已确认范围 ${target.filter.from} 至 ${target.filter.to}，筛选 ${JSON.stringify(target.filter)}。本次已清理 ${result.deleted} 条运行日志。${result.hasMore ? '范围内仍有日志；核对后可再次确认清理。' : '本次范围清理已完成。'}业务审计、回执和源文件不受影响。`
        emit('changed')
      }
    }
  } catch (cause) {
    if (active) failure.value = logErrorMessage(logErrorCode(cause))
  } finally {
    if (active) {
      pending.value = false
      review.value = null
      void refresh()
    }
  }
}
</script>
<template>
  <div class="flex min-w-0 flex-col gap-5">
    <!-- 范围在 tab 内容里说明一次；保留策略与清理各自带后果，不再重复免责声明。 -->
    <p class="text-muted-foreground text-[13px] leading-5" data-testid="log-settings-scope">
      只影响运行日志，不改动业务审计、回执与源文件。
    </p>
    <!-- 全局保存是唯一提交入口：这里只说明草稿归属，不提供第二个保存按钮。 -->
    <p
      v-if="data"
      data-testid="log-unsaved-summary"
      aria-live="polite"
      class="text-[13px] leading-5"
    >
      <template v-if="pending">正在提交，完成后会用真实响应回填。</template>
      <template v-else-if="dirtyModuleLabels.length"
        >未保存：{{ dirtyModuleLabels.join('、') }}。核对并确认后才会提交；刷新页面不会自动保存。</template
      >
      <template v-else>当前配置与已生效配置相同。</template>
    </p>
    <Skeleton v-if="loading && !data" class="h-24 w-full" aria-label="正在读取日志配置" />
    <TableFailureState
      v-if="error"
      title="日志配置读取失败"
      :description="`${logErrorMessage(error)} ${data ? '保留上次读取的配置；当前状态需重新加载确认。' : ''}`"
      :pending="loading"
      @retry="refresh"
    />
    <template v-if="data">
      <template v-if="supportsCollection">
        <section
          v-for="section in collectionSections"
          :key="section.key"
          :data-testid="section.testid"
          :aria-labelledby="section.headingId"
          class="flex min-w-0 flex-col gap-3"
        >
          <div class="bg-secondary flex min-w-0 items-start gap-2.5 rounded-md px-3 py-2.5">
            <span class="text-primary mt-0.5 inline-flex size-[18px] shrink-0 items-center justify-center">
              <Icon :name="section.icon" class="size-[18px]" aria-hidden="true" />
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <div class="flex min-w-0 items-center justify-between gap-2">
                <h2 :id="section.headingId" class="text-sm font-medium">{{ section.title }}</h2>
                <span class="text-muted-foreground shrink-0 text-[12px] leading-4 tabular-nums">
                  {{ section.groups.reduce((sum, group) => sum + group.rows.length, 0) }} 项
                </span>
              </div>
              <p v-if="section.description" class="text-muted-foreground text-[13px] leading-5">
                {{ section.description }}
              </p>
            </div>
          </div>
          <div
            v-for="group in section.groups"
            :key="group.key"
            :data-testid="group.testid"
            class="flex min-w-0 flex-col gap-1.5"
          >
            <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-1">
              <span class="text-muted-foreground inline-flex size-4 shrink-0 items-center justify-center">
                <Icon :name="group.icon" class="size-4" aria-hidden="true" />
              </span>
              <h3 class="text-muted-foreground text-[13px] leading-5 font-medium">{{ group.title }}</h3>
              <span v-if="group.note" class="text-muted-foreground text-[12px] leading-4">{{ group.note }}</span>
              <span class="text-muted-foreground ml-auto shrink-0 text-[12px] leading-4 tabular-nums">{{ group.rows.length }}</span>
            </div>
            <div class="flex min-w-0 flex-col gap-1.5">
              <LogModulePanel
                v-for="row in group.rows"
                :key="row.key"
                v-model:open="openPanels[panelKey(row.prefix, row.key)]"
                :testid="'log-module-' + row.prefix + '-' + row.key"
                :label="row.label"
                :icon="row.prefix === 'integration' ? iconForIntegration(row.key) : iconForSource(row.key)"
                :enabled="row.rule.enabled"
                :summary="panelSummary(row)"
                :dirty="rowDirty(row)"
                :primary="!!collectorProfileForRow(row)"
                :heading-level="4"
              >
                <div class="flex min-w-0 flex-col gap-3 px-1 pt-1">
                  <FieldGroup class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field
                      orientation="horizontal"
                      :data-disabled="busy"
                      class="min-w-0 items-center justify-between gap-3"
                    >
                      <FieldLabel
                        :for="'log-' + row.prefix + '-' + row.key + '-enabled'"
                        class="text-[13px] leading-5 font-normal"
                        >采集开关</FieldLabel
                      >
                      <Switch
                        :id="'log-' + row.prefix + '-' + row.key + '-enabled'"
                        v-model="row.rule.enabled"
                        :disabled="busy"
                      />
                    </Field>
                    <Field
                      orientation="horizontal"
                      :data-disabled="busy || !row.rule.enabled"
                      class="min-w-0 items-center justify-between gap-3"
                    >
                      <FieldLabel
                        :for="'log-' + row.prefix + '-' + row.key + '-min-level'"
                        class="text-[13px] leading-5 font-normal"
                        >采集门槛</FieldLabel
                      >
                      <Select v-model="row.rule.minLevel">
                        <SelectTrigger
                          :id="'log-' + row.prefix + '-' + row.key + '-min-level'"
                          size="sm"
                          class="bg-card w-32 shrink-0 shadow-none"
                          :aria-label="row.label + '的最低日志级别'"
                          :disabled="busy || !row.rule.enabled"
                        >
                          <SelectValue>{{ LEVEL_LABELS[row.rule.minLevel] }}</SelectValue>
                        </SelectTrigger>
                        <SelectContent><SelectGroup>
                          <SelectItem v-for="level in LOG_LEVELS" :key="level" :value="level">
                            {{ LEVEL_LABELS[level] }}（{{ level }}）
                          </SelectItem>
                        </SelectGroup></SelectContent>
                      </Select>
                    </Field>
                  </FieldGroup>
                  <p class="text-muted-foreground text-[12px] leading-4">
                    低于门槛的事件不写入；技术集成与来源须同时开启时，最低级别取更严格的一处。
                  </p>

                  <div
                    v-if="offReasonsFor(collectorProfileForRow(row)).length"
                    role="status"
                    class="flex min-w-0 flex-col gap-1"
                  >
                    <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5">
                      <Badge variant="quiet" class="font-normal">当前不采集</Badge>
                      <span class="text-muted-foreground">
                        {{ offReasonsFor(collectorProfileForRow(row)).join('、') }}；选择会保留，重新开启后按这里的设置记录。
                      </span>
                    </p>
                  </div>

                  <LogFieldEditor
                    v-if="collectorProfileForRow(row) && supportsFieldControls"
                    :profile="requireCollectorProfile(row)"
                    :controls="controlsFor(requireCollectorProfile(row))"
                    :disabled="busy"
                    :effective-min="effectiveMinFor(requireCollectorProfile(row))"
                  />
                  <p
                    v-else-if="collectorProfileForRow(row)"
                    class="text-muted-foreground text-[12px] leading-4"
                  >
                    字段目录来自服务端；当前响应不完整，暂不显示字段开关。
                  </p>
                  <p
                    v-else-if="sourceProfileForRow(row)"
                    class="text-muted-foreground text-[12px] leading-4"
                  >
                    此来源没有独立的详情字段：记录内容跟随「{{ sourceCollectorLabel(row) }}」，在那边配置一次。
                  </p>
                  <p v-else class="text-muted-foreground text-[12px] leading-4">
                    该模块没有独立的详情字段。
                  </p>

                  <div
                    v-if="counterpartForRow(row)"
                    class="flex min-w-0 flex-col gap-1 border-t pt-2.5"
                  >
                    <span class="text-[12px] leading-4 font-medium">同时生效</span>
                    <p class="text-muted-foreground text-[13px] leading-5">
                      与「{{ counterpartForRow(row)?.label }}」{{ counterpartForRow(row)?.role }}同时生效；当前有效门槛：<strong class="text-foreground">{{ LEVEL_LABELS[effectiveMinFor(profileForRow(row)) ?? 'debug'] }}</strong>。
                    </p>
                    <Button
                      variant="link"
                      size="sm"
                      class="h-auto justify-start p-0 text-[13px]"
                      @click="openCounterpartForRow(row)"
                    >
                      <Icon name="lucide:arrow-up-right" class="size-4" aria-hidden="true" />
                      打开「{{ counterpartForRow(row)?.label }}」
                    </Button>
                  </div>
                </div>
              </LogModulePanel>
            </div>
          </div>
          <DisclosurePanel
            v-if="section.key === 'technical' && unwiredIntegrations.length"
            data-testid="log-unwired-integrations"
            :title="'未接入的技术集成（' + unwiredIntegrations.length + '）'"
            description="未接入，不可配置"
            :heading-level="3"
            compact
          >
            <template #chevron>
              <span
                class="text-muted-foreground pointer-events-none inline-flex size-4 shrink-0 items-center justify-center"
                aria-hidden="true"
              >
                <Icon name="lucide:chevron-right" class="size-4" />
              </span>
            </template>
            <p class="text-muted-foreground text-[13px] leading-5">
              以下库尚未接入日志采集，列在这里只表示当前没有采集器，不能据此判断业务或部署已关闭。
            </p>
            <ul class="mt-2 flex flex-col gap-1.5 text-[13px]">
              <li
                v-for="row in unwiredIntegrations"
                :key="row.key"
                class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5"
              >
                <span class="text-muted-foreground inline-flex size-4 shrink-0 items-center justify-center">
                  <Icon :name="iconForIntegration(row.key)" class="size-4" aria-hidden="true" />
                </span>
                <span>{{ row.label }}</span>
                <span class="text-muted-foreground font-mono text-xs">{{ row.key }}</span>
                <span class="text-muted-foreground">未接入，不可配置</span>
              </li>
            </ul>
          </DisclosurePanel>
        </section>
      </template>
      <!-- 上一个区块存在时才画分隔线；旧后端没有采集规则时不留一条孤立横线。 -->
      <Separator v-if="supportsCollection" />
      <section aria-labelledby="log-retention-heading" class="flex min-w-0 flex-col gap-3">
        <div class="flex flex-col gap-1">
          <div class="flex min-w-0 items-center gap-2">
            <span class="text-muted-foreground inline-flex size-4 shrink-0 items-center justify-center">
              <Icon :name="iconForSection('retention')" class="size-4" aria-hidden="true" />
            </span>
            <h2 id="log-retention-heading" class="text-sm font-medium">保留策略</h2>
          </div>
          <p class="text-muted-foreground text-[13px] leading-5">
            取更严格者；缩短保留期或降低容量可能清理已有日志。
          </p>
        </div>
        <dl class="grid min-w-0 gap-x-6 gap-y-1 text-[13px] leading-5 sm:grid-cols-2">
          <div class="flex min-w-0 gap-2">
            <dt class="text-muted-foreground shrink-0">当前生效</dt>
            <dd class="min-w-0 break-words">
              {{ data.retentionDays }} 天 / {{ bytesLabel(data.maxBytes) }}
            </dd>
          </div>
          <div class="flex min-w-0 gap-2">
            <dt class="text-muted-foreground shrink-0">存储用量</dt>
            <dd class="min-w-0 break-words">{{ bytesLabel(data.storageBytes) }}</dd>
          </div>
          <div class="flex min-w-0 gap-2">
            <dt class="text-muted-foreground shrink-0">累计清理</dt>
            <dd class="min-w-0 break-words">
              策略裁剪 {{ data.pruned }} 条 / 手动清理 {{ data.cleared }} 条
            </dd>
          </div>
          <div class="flex min-w-0 gap-2">
            <dt class="text-muted-foreground shrink-0">进程状态</dt>
            <dd class="min-w-0 break-words">
              <span :class="data.status?.unavailable ? 'text-destructive' : ''">{{
                data.status?.unavailable ? '不可用' : '可用'
              }}</span
              >；已丢弃 {{ data.status?.dropped ?? 0 }} 条；排队
              {{ data.status?.queuedEntries ?? 0 }} 条；写入中
              {{ data.status?.inFlightEntries ?? 0 }} 条
            </dd>
          </div>
        </dl>
        <p class="text-muted-foreground text-[13px] leading-5">
          用量含日志库与附属文件，不含文件系统与容器输出；进程计数自
          {{ data.status?.since ? local(data.status.since) : '本次进程启动' }} 起。
        </p>
        <form data-testid="log-policy-form" @submit.prevent="reviewConfig">
          <FieldGroup class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <Field :data-disabled="busy">
              <FieldLabel for="log-retention-days">保留天数（1–365）</FieldLabel
              ><Input
                id="log-retention-days"
                v-model.number="days"
                type="number"
                min="1"
                max="365"
                required
                :disabled="busy"
              />
            </Field>
            <Field :data-disabled="busy">
              <FieldLabel for="log-max-bytes">容量字节（1 MiB–4 GiB）</FieldLabel
              ><Input
                id="log-max-bytes"
                v-model.number="bytes"
                type="number"
                min="1048576"
                max="4294967296"
                required
                :disabled="busy"
              />
            </Field>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2 sm:col-span-2">
              <Button
                type="submit"
                variant="outline"
                data-testid="log-policy-review"
                :disabled="busy || !validPolicy || !hasChanges"
                >核对日志配置修改</Button
              >
              <!-- 后果写在按钮旁边，不做单独一段通栏说明；没有变化时说明为什么不能核对。 -->
              <p class="text-muted-foreground text-[13px] leading-5">
                <template v-if="!hasChanges">当前配置与已生效配置相同，无需核对。</template>
                <template v-else
                  >核对范围包括采集规则、记录内容与保留策略；只提交有差异的项，其余保持不变。保留策略调整可能触发轮转。</template
                >
              </p>
            </div>
          </FieldGroup>
        </form>
      </section>
      <Separator />
      <section aria-labelledby="log-clear-heading" class="flex min-w-0 flex-col gap-2">
        <div class="flex flex-col gap-1">
          <h2 id="log-clear-heading" class="text-sm font-medium">范围清理</h2>
          <p class="text-muted-foreground text-[13px] leading-5">
            沿用运行日志中已应用的筛选，只删除运行日志。
          </p>
        </div>
        <div class="flex flex-col items-start gap-2">
          <Button
            variant="destructive"
            :disabled="busy || !clearAllowed"
            @click="reviewClear"
            >清理当前筛选范围</Button
          >
          <p class="text-muted-foreground text-[13px] leading-5">
            请先在筛选中应用明确的开始和结束时间。每次最多清理 1000 条；所有已应用的筛选同时生效。
            业务审计、回执、源文件和任务产物不受影响。
          </p>
        </div>
      </section>
    </template>
    <Alert v-if="notice || failure" :variant="failure ? 'destructive' : 'default'" role="status"
      ><AlertDescription>{{ failure || notice }}</AlertDescription></Alert
    >
    <Dialog
      :open="!!review"
      @update:open="
        (value) => {
          if (!value && !pending) {
            review = null
            restoreReviewFocus()
          }
        }
      "
    >
      <DialogContent
        class="max-h-[90dvh] overflow-y-auto"
        @interact-outside="pending && $event.preventDefault()"
        @escape-key-down="pending && $event.preventDefault()"
      >
        <DialogHeader
          ><DialogTitle>{{
            dialogReview?.kind === 'config' ? '核对日志配置修改' : '确认清理运行日志'
          }}</DialogTitle
          ><DialogDescription>{{
            dialogReview?.kind === 'config'
              ? '采集配置对后续批次生效；保留策略调整可能清理已有日志。'
              : '此操作可能永久删除运行日志。业务审计、回执、源文件和任务产物不在清理范围。'
          }}</DialogDescription></DialogHeader
        >
        <template v-if="dialogReview?.kind === 'config'">
          <div
            v-if="dialogReview.sources.length || dialogReview.integrations.length"
            class="flex flex-col gap-2"
          >
            <p class="text-sm">仅列出有差异的采集规则：</p>
            <Table class="data-table">
              <TableBody>
                <TableRow
                  v-for="change in [...dialogReview.sources, ...dialogReview.integrations]"
                  :key="`${change.dimension}-${change.key}`"
                >
                  <TableCell class="text-muted-foreground whitespace-normal">
                    {{ change.dimension }} · {{ change.label }}
                  </TableCell>
                  <TableCell class="whitespace-normal">{{ ruleLabel(change.from) }}</TableCell>
                  <TableCell class="whitespace-normal">{{ ruleLabel(change.to) }}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <p class="text-muted-foreground text-[13px] leading-5">
              其余项保持不变，不会被重置。
            </p>
          </div>
          <div v-if="dialogReview.fields.length" class="flex flex-col gap-2">
            <p class="text-sm">仅列出有差异的字段（与已保存配置比较）：</p>
            <Table class="data-table" data-testid="log-field-review-table">
              <TableBody>
                <TableRow
                  v-for="change in dialogReview.fields"
                  :key="`${change.profile}-${change.level}-${change.field}`"
                >
                  <TableCell class="text-muted-foreground whitespace-normal">
                    {{ change.profileLabel }} · {{ change.levelLabel }} · {{ change.fieldLabel }}
                  </TableCell>
                  <TableCell class="whitespace-normal">{{
                    change.from ? '保留' : '不记录'
                  }}</TableCell>
                  <TableCell class="whitespace-normal">{{
                    change.to ? '保留' : '不记录'
                  }}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <p class="text-muted-foreground text-[13px] leading-5">
              只影响之后写入；恢复为保留也会作为改动提交。
            </p>
            <p
              v-if="reviewParentReasons.length"
              class="text-muted-foreground text-[13px] leading-5"
              data-testid="log-field-review-parent"
            >
              当前不采集：{{ reviewParentReasons.join('、') }}。保存不会重新开启采集。
            </p>
          </div>
          <div
            v-if="dialogReview.retentionChanged || dialogReview.capacityChanged"
            class="flex flex-col gap-1 text-sm"
          >
            <p v-if="dialogReview.retentionChanged">
              保留天数：{{ data?.retentionDays }} 天 → {{ dialogReview.retentionDays }} 天
            </p>
            <p v-if="dialogReview.capacityChanged">
              容量：{{ data ? bytesLabel(data.maxBytes) : '' }} →
              {{ bytesLabel(dialogReview.maxBytes) }}
            </p>
          </div>
        </template>
        <template v-else-if="dialogReview?.kind === 'clear'"
          ><p class="text-sm">清理以下已固定范围，每次最多 1000 条：</p>
          <Table><TableBody><TableRow v-for="(value, key) in dialogReview.filter" :key="key">
            <TableCell class="text-muted-foreground">{{ filterLabels[key] ?? key }}</TableCell>
            <TableCell class="break-all">{{ key === 'from' || key === 'to' ? localRange(String(value)) : value }}</TableCell>
          </TableRow></TableBody></Table>
        </template>
        <DialogFooter
          ><Button variant="outline" :disabled="pending" @click="review = null">取消</Button
          ><Button
            :variant="dialogReview?.kind === 'clear' ? 'destructive' : 'default'"
            data-testid="log-policy-confirm"
            :disabled="pending"
            @click="confirm"
            >{{
              pending
                ? '正在提交…'
                : dialogReview?.kind === 'config'
                  ? '确认保存配置'
                  : '确认清理范围'
            }}</Button
          ></DialogFooter
        >
      </DialogContent>
    </Dialog>
  </div>
</template>
