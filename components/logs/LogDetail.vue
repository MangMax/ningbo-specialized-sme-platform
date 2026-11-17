<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { clientRequestReference } from '~~/lib/client-logging/request-reference'
import type { FieldCapturedLogEvent, LogEvent, LogOrigin, LogSummary } from '~~/lib/logging/contract'
import { LOG_FIELD_PROFILES } from '~~/lib/logging/field-controls'
import { detailFieldValue, detailProfile, fieldOmission } from '~~/lib/logging/detail-profile'
import { logBrowserHeaders, logErrorMessage, useLogRead } from '~/composables/useLogRead'
import {
  describeLogRow,
  FIELD_DISABLED_LABEL,
  FIELD_DISABLED_NOTE,
  formatCounts,
  operationLabel,
  outcomeLabel,
  queryAttemptTotal,
  resourceIdLabel,
  resourceTypeLabel,
  sourceLabel
} from './logPresentation'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableRow, TableCell } from '@/components/ui/table'
import TableFailureState from '@/components/TableFailureState.vue'
import { RouterLink } from 'vue-router'
const props = defineProps<{ id: string }>()
const key = computed(() => props.id)
const { data, sourceKey, loading, error, refresh } = useLogRead(key, (id, signal) =>
  $fetch<FieldCapturedLogEvent>(`/api/logs/${encodeURIComponent(id)}`, {
    headers: logBrowserHeaders,
    retry: 0,
    signal
  })
)
const current = computed(
  () => sourceKey.value === props.id && data.value?.id === props.id && !error.value
)
const notice = ref('')
/** 记录时间与列表同一种本地写法；时区写进标签，复制的事件仍保留原始 ISO。 */
const zoneOffset = -new Date().getTimezoneOffset()
const zoneLabel = `UTC${zoneOffset >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(zoneOffset) / 60)).padStart(2, '0')}:${String(Math.abs(zoneOffset) % 60).padStart(2, '0')}`
const localStamp = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
}
const fieldLabels: Record<string, string> = {
  id: '事件标识',
  timestamp: `记录时间（本地 ${zoneLabel}）`,
  level: '级别',
  source: '来源',
  operation: '操作',
  outcome: '结果',
  durationMs: '耗时（毫秒）',
  statusCode: 'HTTP 状态',
  httpMethod: 'HTTP 方法',
  httpRoute: '接口路由模板',
  errorCode: '安全失败码',
  counts: '处理数量',
  requestId: '请求标识',
  traceId: '链路标识',
  taskId: '任务标识',
  fileId: '文件编号',
  page: '页码',
  batchId: '批次标识',
  resourceType: '资源类型',
  resourceId: '资源标识',
  auditId: '审计引用',
  receiptId: '回执引用',
  parentEventId: '上级事件',
  untrustedRelatedRequestId: '关联请求（客户端声称，UNTRUSTED）',
  'mcp.transport': 'MCP 传输',
  'mcp.sessionMode': 'MCP 会话模式',
  'mcp.rpcMethod': 'JSON-RPC 方法',
  'mcp.tool': 'MCP 工具',
  'mcp.clientName': '客户端类别（自报）',
  'mcp.clientVersion': '客户端版本（自报）',
  'mcp.protocolVersionRequested': '协议版本（初始化请求声明）',
  'tus.uploadId': '上传标识',
  'tus.phase': '上传阶段',
  'tus.method': '上传方法',
  'tus.size': '声明总量（字节）',
  'tus.offset': '已接收（字节）',
  'origin.runtime': '运行环境',
  'origin.integration': '接入模块',
  'origin.capture': '采集方式',
  'origin.execution': '执行位置'
}
/** 标签由固定枚举键约束；新增取值会在这里报类型错，而不是静默漏翻。 */
const ORIGIN_RUNTIME_LABELS: Record<LogOrigin['runtime'], string> = {
  node: 'Node',
  browser: '浏览器'
}
const ORIGIN_INTEGRATION_LABELS: Record<LogOrigin['integration'], string> = {
  'nuxt-nitro': 'Nuxt / Nitro 请求',
  'mcp-toolkit': 'MCP Toolkit 模块上下文',
  tus: 'tus 服务端回调',
  application: '应用手动埋点',
  browser: '浏览器原生异常',
  vue: 'Vue 异常',
  'tus-client': 'tus 客户端',
  drizzle: 'Drizzle 数据库',
  embedpdf: 'EmbedPDF',
  'pinia-colada': 'Colada 查询',
  'vue-router': 'Vue Router'
}
const ORIGIN_CAPTURE_LABELS: Record<LogOrigin['capture'], string> = {
  framework: '框架采集',
  hook: '生命周期钩子',
  manual: '手动埋点'
}
const ORIGIN_EXECUTION_LABELS: Record<NonNullable<LogOrigin['execution']>, string> = {
  request: '请求处理',
  background: '后台',
  worker: '工作进程',
  page: '页面'
}
const MCP_CLIENT_LABELS: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  vscode: 'Visual Studio Code',
  cline: 'Cline',
  continue: 'Continue',
  inspector: 'MCP Inspector',
  other: '其他/未知'
}
const TUS_PHASE_LABELS: Record<string, string> = {
  created: '已创建',
  completed: '已完成',
  'request-failed': '请求失败'
}
watch(key, () => {
  notice.value = ''
})
function copyMcp(value: FieldCapturedLogEvent['mcp']): Record<string, unknown> | undefined {
  if (!value) return undefined
  const out: Record<string, unknown> = {}
  for (const key of ['transport', 'sessionMode', 'rpcMethod', 'tool', 'protocolVersionRequested'] as const)
    if (value[key] !== undefined) out[key] = value[key]
  if (value.client) {
    const client: Record<string, unknown> = {}
    for (const key of ['name', 'version', 'trust', 'capturedAt'] as const)
      if (value.client[key] !== undefined) client[key] = value.client[key]
    out.client = client
  }
  return out
}
/**
 * 输出侧的 TUS 上下文会从“input 必填 uploadId”变为“output 可选 uploadId、phase 必填”。
 * 这里按键白名单读取，不假设 uploadId 一定存在，也不把投影过的事件再交给
 * safeLogEvent（那会删掉整个 tus 并重新生成 id/time）。
 */
const TUS_COPY_KEYS = ['uploadId', 'phase', 'method', 'size', 'offset'] as const
function copyTus(value: FieldCapturedLogEvent['tus']): Record<string, unknown> | undefined {
  if (!value) return undefined
  const source = value as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of TUS_COPY_KEYS) if (source[key] !== undefined) out[key] = source[key]
  return Object.keys(out).length ? out : undefined
}
/**
 * 字段省略标记按白名单重建：字段键来自后端已实现的 profile 表（HTTP 四字段，
 * 未来 TUS 的 tus.* 键由同一张表加入），revision 必须是有限非负整数。
 * 任意多出的键、伪造的 profile 或非数字 revision 都不会跟着复制走；
 * id/timestamp 仍取原事件，不用 safeLogEvent 重新生成。
 * 这张表只用于校验**服务端已给的事实**，不参与页面是否显示字段入口的判断。
 */
const FIELD_KEYS_BY_PROFILE: Record<string, readonly string[]> = Object.fromEntries(
  LOG_FIELD_PROFILES.map((profile) => [
    String(profile.key),
    profile.fields.map((field) => String(field.key))
  ])
)
function copyCapture(
  value: FieldCapturedLogEvent['fieldCapture'],
  event: FieldCapturedLogEvent
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const profile = value.profile
  const keys = typeof profile === 'string' ? FIELD_KEYS_BY_PROFILE[profile] : undefined
  if (!keys) return undefined
  const revision = value.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
    return undefined
  if (!Array.isArray(value.disabled)) return undefined
  // 只有真正不在事件里的字段才能被标记为“当时未启用”；有值却说没采集是自相矛盾。
  // 用同一个取值器判断存在性，TUS 的 tus.* 键不会被误当成顶层缺失。
  const disabled = keys.filter(
    (key) => value.disabled.includes(key as never) && detailFieldValue(event, key) === undefined
  )
  if (!disabled.length) return undefined
  return { profile, revision, disabled }
}
/** 只复制固定枚举字段；未来响应里多出的 origin 键不跟着离开页面。 */
function copyOrigin(value: FieldCapturedLogEvent['origin']): Record<string, unknown> | undefined {
  if (!value) return undefined
  const out: Record<string, unknown> = {
    runtime: value.runtime,
    integration: value.integration,
    capture: value.capture
  }
  if (value.execution !== undefined) out.execution = value.execution
  return out
}
// Copy only the foundation's event projection, even if a future response adds fields.
const safe = computed<Record<string, unknown> | null>(() => {
  if (!current.value || !data.value) return null
  const fields = [
    'id',
    'timestamp',
    'level',
    'source',
    'operation',
    'outcome',
    'durationMs',
    'statusCode',
    'httpMethod',
    'httpRoute',
    'errorCode',
    'counts',
    'requestId',
    'traceId',
    'taskId',
    'fileId',
    'page',
    'batchId',
    'resourceType',
    'resourceId',
    'auditId',
    'receiptId',
    'parentEventId'
  ] as const
  const event: Record<string, unknown> = Object.fromEntries(
    fields.filter((k) => data.value![k] !== undefined).map((k) => [k, data.value![k]])
  )
  const mcp = copyMcp(data.value.mcp)
  if (mcp) event.mcp = mcp
  const tus = copyTus(data.value.tus)
  if (tus) event.tus = tus
  const origin = copyOrigin(data.value.origin)
  if (origin) event.origin = origin
  const capture = copyCapture(data.value.fieldCapture, data.value)
  if (capture) event.fieldCapture = capture
  const reference =
    data.value.source === 'client'
      ? clientRequestReference(data.value.untrustedRelatedRequestId)
      : undefined
  if (reference) event.untrustedRelatedRequestId = reference
  return event
})
/** 只有确认的 Drizzle 查询汇总才把计数读成“查询尝试”；其余来源仍是处理数量。 */
const queryAttempts = computed(() => (data.value ? queryAttemptTotal(data.value) : undefined))
const displayValue = (name: string, value: unknown): string => {
  if (name === 'timestamp') return localStamp(String(value))
  if (name === 'counts')
    return (
      formatCounts(value as LogEvent['counts'], data.value?.operation, queryAttempts.value !== undefined) ||
      JSON.stringify(value)
    )
  if (name === 'outcome') return `${outcomeLabel(String(value))}（${String(value)}）`
  if (name === 'source') return `${sourceLabel(String(value))}（${String(value)}）`
  if (name === 'resourceType') {
    const label = resourceTypeLabel(String(value))
    return label === String(value) ? label : `${label}（${String(value)}）`
  }
  if (name === 'resourceId' && data.value?.resourceType === 'database_connection')
    return resourceIdLabel(data.value.resourceType, String(value))
  if (name === 'operation') {
    const label = operationLabel(String(value))
    return label ? `${label}（${String(value)}）` : String(value)
  }
  if (name === 'mcp.sessionMode') return value === 'stateless' ? '无会话（stateless）' : String(value)
  if (name === 'mcp.clientName')
    return `${MCP_CLIENT_LABELS[String(value)] ?? '其他/未知'}（${String(value)}，自报）`
  if (name === 'mcp.clientVersion') return `${String(value)}（自报）`
  if (name === 'mcp.protocolVersionRequested') return `${String(value)}（客户端声明）`
  if (name === 'tus.phase') return `${TUS_PHASE_LABELS[String(value)] ?? String(value)}（${String(value)}）`
  if (name === 'tus.size' || name === 'tus.offset') return `${String(value)} 字节`
  if (name === 'origin.runtime') {
    const runtime = String(value) as LogOrigin['runtime']
    const label = ORIGIN_RUNTIME_LABELS[runtime] ?? runtime
    return runtime === 'browser' ? `${label}（${runtime}，客户端自报）` : `${label}（${runtime}）`
  }
  if (name === 'origin.integration') {
    const integration = String(value) as LogOrigin['integration']
    return `${ORIGIN_INTEGRATION_LABELS[integration] ?? integration}（${integration}）`
  }
  if (name === 'origin.capture') {
    const capture = String(value) as LogOrigin['capture']
    return `${ORIGIN_CAPTURE_LABELS[capture] ?? capture}（${capture}）`
  }
  if (name === 'origin.execution') {
    const execution = String(value) as NonNullable<LogOrigin['execution']>
    return `${ORIGIN_EXECUTION_LABELS[execution] ?? execution}（${execution}）`
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}
const groups = computed(() => {
  const event = safe.value
  if (!current.value || !event || !data.value) return []
  // 目标列只能使用安全投影里已校验的客户端引用；原始响应里的 untrusted 值一律不渲染。
  const validatedReference =
    data.value.source === 'client' && typeof event.untrustedRelatedRequestId === 'string'
      ? event.untrustedRelatedRequestId
      : undefined
  const target = describeLogRow({
    ...data.value,
    untrustedRelatedRequestId: validatedReference
  } as LogSummary).target
  return detailProfile(data.value).map((section) => ({
    title: section.title,
    showTarget: section.showTarget === true,
    note: section.note,
    disabledNote: section.disabledFields?.length ? FIELD_DISABLED_NOTE : undefined,
    targetText: target.text,
    targetMissing: target.missing,
    targetUntrusted: target.untrusted,
    rows: section.fields.map((name) => {
      const value =
        name === 'untrustedRelatedRequestId'
          ? validatedReference
          : detailFieldValue(data.value!, name)
      const omission = fieldOmission(data.value!, name)
      return {
        name,
        label: name === 'counts' && queryAttempts.value !== undefined
          ? '查询尝试次数'
          : (fieldLabels[name] ?? name),
        present: value !== undefined,
        disabled: value === undefined && omission === 'disabled',
        text: value === undefined ? '' : displayValue(name, value)
      }
    })
  }))
})
async function copy() {
  const id = props.id,
    text = JSON.stringify(safe.value, null, 2)
  if (!current.value || !safe.value) return
  try {
    await navigator.clipboard.writeText(text)
    if (props.id === id) notice.value = '已复制脱敏事件。'
  } catch {
    if (props.id === id) notice.value = '复制失败，请重试或在详情中选择所需字段。'
  }
}
</script>
<template>
  <div class="flex min-w-0 flex-col gap-4">
    <Skeleton v-if="loading" class="h-32 w-full" aria-label="正在读取日志详情" />
    <TableFailureState
      v-if="error"
      title="日志详情读取失败"
      :description="logErrorMessage(error)"
      :pending="loading"
      @retry="refresh"
    />
    <template v-if="current && safe">
      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" :disabled="loading" @click="copy">复制脱敏事件</Button
          ><Button v-if="data?.taskId" as-child variant="outline"
            ><RouterLink :to="{ path: '/tasks', query: { job: data.taskId } }"
              >查看关联任务</RouterLink
            ></Button
          >
        </div>
        <!-- 复制结果贴着触发它的按钮，不在详情底部另起一段。 -->
        <p v-if="notice" role="status" class="text-muted-foreground text-table">{{ notice }}</p>
      </div>
      <Alert v-if="data?.source === 'client'"><AlertDescription>
        客户端上报的上下文不可信，不代表服务端业务执行事实。
      </AlertDescription></Alert>
      <section v-for="group in groups" :key="group.title" class="flex min-w-0 flex-col gap-2">
        <h3 class="text-muted-foreground text-table leading-5 font-medium">{{ group.title }}</h3>
        <Table class="data-table table-fixed">
          <TableBody>
            <TableRow v-if="group.showTarget">
              <TableCell class="text-muted-foreground w-[168px] align-top whitespace-normal"
                >目标</TableCell
              >
              <TableCell
                class="break-all whitespace-normal"
                :class="group.targetMissing ? 'text-muted-foreground' : ''"
              >
                {{ group.targetText }}
                <span v-if="group.targetUntrusted" class="text-muted-foreground"
                  >· UNTRUSTED</span
                >
              </TableCell>
            </TableRow>
            <TableRow v-if="group.note || group.disabledNote">
              <TableCell class="text-muted-foreground w-[168px] align-top whitespace-normal"
                >说明</TableCell
              >
              <TableCell class="text-muted-foreground whitespace-normal text-table">
                <p v-if="group.note">{{ group.note }}</p>
                <p
                  v-if="group.disabledNote"
                  data-testid="log-detail-disabled-note"
                  class="mt-1 first:mt-0"
                  >{{ group.disabledNote }}</p
                >
              </TableCell>
            </TableRow>
            <TableRow v-for="row in group.rows" :key="row.name">
              <TableCell class="text-muted-foreground w-[168px] align-top whitespace-normal">{{
                row.label
              }}</TableCell>
              <!-- 「当时未启用采集」只说配置事实；没有 capture 的历史记录仍是「未记录」。 -->
              <TableCell
                class="break-all whitespace-normal font-mono text-xs"
                :class="row.present ? '' : 'text-muted-foreground font-sans text-table'"
                :data-omission="row.present ? 'present' : row.disabled ? 'disabled' : 'absent'"
              >
                {{ row.present ? row.text : row.disabled ? FIELD_DISABLED_LABEL : '未记录' }}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </section>
      <!-- 汇总说明贴着详情底部，不新增 section；只在确认的查询汇总上出现。 -->
      <p
        v-if="queryAttempts !== undefined"
        data-testid="log-query-attempt-note"
        class="text-muted-foreground text-table leading-5"
      >
        排队期间查询尝试汇总，时间为首次尝试；不表示执行成功。
      </p>
    </template>
  </div>
</template>
