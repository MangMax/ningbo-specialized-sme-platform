<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { LOG_LEVELS } from '~~/lib/logging/contract'
import type {
  LOG_INTEGRATIONS,
  LogCollection,
  LogCollectionRule,
  LogFilter,
  LogPolicy,
  LogPolicyPatch
} from '~~/lib/logging/contract'
import { sourceLabel } from './logPresentation'
import {
  logBrowserHeaders,
  logErrorCode,
  logErrorMessage,
  useLogRead
} from '~/composables/useLogRead'
import TableFailureState from '@/components/TableFailureState.vue'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
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
/**
 * 服务端实际响应：新后端带 collection/catalog/revision，旧后端只有 legacy
 * retention/maxBytes。后两项保持可选，旧界面仍能保留清理能力，且不会显示
 * 伪采集开关。
 */
type PolicyView = LogPolicy & {
  collection?: LogCollection
  catalog?: { integrations: readonly IntegrationEntry[] }
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
  dimension: '来源采集' | '技术集成'
  key: string
  label: string
  from: LogCollectionRule
  to: LogCollectionRule
}
type ConfigReview = {
  kind: 'config'
  retentionDays: number
  maxBytes: number
  retentionChanged: boolean
  capacityChanged: boolean
  sources: RuleChange[]
  integrations: RuleChange[]
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
const LEVEL_LABELS: Record<(typeof LOG_LEVELS)[number], string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误'
}
const { data, loading, error, refresh } = useLogRead(ref('policy'), () =>
  $fetch<PolicyView>('/api/logs/policy', { retry: 0, headers: logBrowserHeaders })
)
const days = ref(7),
  bytes = ref(536870912),
  initialized = ref(false)
const sourceDraft = ref<Record<string, LogCollectionRule>>({}),
  integrationDraft = ref<Record<string, LogCollectionRule>>({})

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
const sourceRows = computed(() =>
  Object.entries(sourceDraft.value).map(([key, rule]) => ({
    key,
    label: sourceLabel(key),
    rule
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
const integrationRows = computed(() =>
  configuredIntegrations.value.map((meta) => ({
    ...meta,
    rule: integrationDraft.value[meta.key]!
  }))
)

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
  return integrationRows.value.flatMap(({ key, label, rule }) => {
    const before = base[key]
    return before && !sameRule(before, rule)
      ? [
          {
            dimension: '技术集成' as const,
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
    changedIntegrations.value.length > 0
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

function reviewConfig() {
  if (busy.value || !data.value || !validPolicy.value || !hasChanges.value) return
  review.value = {
    kind: 'config',
    retentionDays: Number(days.value),
    maxBytes: Number(bytes.value),
    retentionChanged: retentionChanged.value,
    capacityChanged: capacityChanged.value,
    sources: changedSources.value,
    integrations: changedIntegrations.value
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
          '日志配置已保存。更改对后续日志批次和待处理队列生效；采集开关与级别不删除已有记录，保留策略调整可能触发轮转。'
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
    <!-- 范围只说一次：这些配置只作用于运行日志。 -->
    <p class="text-muted-foreground text-[13px] leading-5">
      仅管理运行日志，不修改业务审计、导入回执、源文件或任务产物。
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
          data-testid="log-collection-sources"
          aria-labelledby="log-sources-heading"
          class="flex min-w-0 flex-col gap-3"
        >
          <div class="flex flex-col gap-1">
            <h2 id="log-sources-heading" class="text-sm font-medium">来源采集</h2>
            <p class="text-muted-foreground text-[13px] leading-5">
              任一来源关闭后停止采集；技术集成与来源必须同时开启。最低级别取两处更严格者。
              采集规则不删除已有记录，保存只影响后续批次与待处理队列。
            </p>
          </div>
          <FieldGroup class="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
            <Field
              v-for="row in sourceRows"
              :key="row.key"
              orientation="horizontal"
              :data-disabled="busy"
              class="min-w-0 items-center justify-between gap-3"
            >
              <div class="flex min-w-0 items-center gap-2.5">
                <Switch
                  :id="`log-source-${row.key}-enabled`"
                  v-model="row.rule.enabled"
                  :disabled="busy"
                />
                <FieldLabel
                  :for="`log-source-${row.key}-enabled`"
                  class="min-w-0 text-[13px] leading-5 font-normal"
                >
                  <span class="truncate">{{ row.label }}</span>
                </FieldLabel>
              </div>
              <Select v-model="row.rule.minLevel">
                <SelectTrigger
                  size="sm"
                  class="bg-card w-32 shrink-0 shadow-none"
                  :aria-label="`${row.label}的最低日志级别`"
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
        </section>
        <Separator />
        <section
          v-if="integrationRows.length || unwiredIntegrations.length"
          data-testid="log-collection-integrations"
          aria-labelledby="log-integrations-heading"
          class="flex min-w-0 flex-col gap-3"
        >
          <div class="flex flex-col gap-1">
            <h2 id="log-integrations-heading" class="text-sm font-medium">技术集成</h2>
            <p class="text-muted-foreground text-[13px] leading-5">
              这里只列出当前实际接入日志采集的模块。与来源条件同时成立才采集，最低级别取两者更严格者。
              安装某个库不等于它已经在采集运行日志。
            </p>
          </div>
          <FieldGroup class="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
            <Field
              v-for="row in integrationRows"
              :key="row.key"
              orientation="horizontal"
              :data-disabled="busy"
              class="min-w-0 items-center justify-between gap-3"
            >
              <div class="flex min-w-0 items-center gap-2.5">
                <Switch
                  :id="`log-integration-${row.key}-enabled`"
                  v-model="row.rule.enabled"
                  :disabled="busy"
                />
                <FieldLabel
                  :for="`log-integration-${row.key}-enabled`"
                  class="min-w-0 text-[13px] leading-5 font-normal"
                >
                  <span class="truncate">{{ row.label }}</span>
                </FieldLabel>
              </div>
              <Select v-model="row.rule.minLevel">
                <SelectTrigger
                  size="sm"
                  class="bg-card w-32 shrink-0 shadow-none"
                  :aria-label="`${row.label}的最低日志级别`"
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
          <!-- 未接入单独折叠，不摆一排禁用开关：禁用开关会被误读成“部署已关闭”。 -->
          <DisclosurePanel
            v-if="unwiredIntegrations.length"
            data-testid="log-unwired-integrations"
            :title="`未接入的技术集成（${unwiredIntegrations.length}）`"
            description="未接入，不可配置"
            :heading-level="3"
            compact
          >
            <p class="text-muted-foreground text-[13px] leading-5">
              以下库尚未接入日志采集，列在这里只表示当前没有采集器，不能据此判断业务或部署已关闭。
            </p>
            <ul class="mt-2 flex flex-col gap-1.5 text-[13px]">
              <li
                v-for="row in unwiredIntegrations"
                :key="row.key"
                class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
              >
                <span>{{ row.label }}</span>
                <span class="text-muted-foreground font-mono text-xs">{{ row.key }}</span>
                <span class="text-muted-foreground">未接入，不可配置</span>
              </li>
            </ul>
          </DisclosurePanel>
        </section>
        <Separator />
      </template>
      <section aria-labelledby="log-retention-heading" class="flex min-w-0 flex-col gap-3">
        <div class="flex flex-col gap-1">
          <h2 id="log-retention-heading" class="text-sm font-medium">保留策略</h2>
          <p class="text-muted-foreground text-[13px] leading-5">
            保留期与容量取更严格者；缩短保留期或降低容量可能清理已有运行日志。
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
          用量含日志库与附属文件，不含文件系统开销、容器输出或进程内存；进程计数从
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
                  >只提交有差异的规则，其余规则保持不变；采集规则不删除已有记录，保留策略调整可能触发轮转。</template
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
            清理范围沿用运行日志中已应用的筛选；修改筛选后可返回本页核对。此操作只删除运行日志。
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
          if (!value && !pending) review = null
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
              ? '保存后影响后续日志批次和待处理队列的采集；采集规则不删除已有记录，保留策略调整可能触发轮转。'
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
              其余规则保持不变，不会随本次保存重置。
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
