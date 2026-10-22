<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { clientRequestReference } from '~~/lib/client-logging/request-reference'
import type { LogEvent, LogSummary } from '~~/lib/logging/contract'
import { logBrowserHeaders, logErrorMessage, useLogRead } from '~/composables/useLogRead'
import {
  describeLogRow,
  formatCounts,
  operationLabel,
  outcomeLabel,
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
  $fetch<LogEvent>(`/api/logs/${encodeURIComponent(id)}`, {
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
  untrustedRelatedRequestId: '关联请求（客户端声称，UNTRUSTED）'
}
/** 详情按「基本信息 / 目标与对象 / 结果与计数 / 关联标识」分组；缺失显示未记录。 */
const groupDefs: { title: string; keys: readonly string[] }[] = [
  { title: '基本信息', keys: ['id', 'timestamp', 'source', 'level', 'operation'] },
  { title: '目标与对象', keys: ['httpMethod', 'httpRoute', 'fileId', 'page', 'batchId', 'resourceType', 'resourceId'] },
  { title: '结果与计数', keys: ['outcome', 'durationMs', 'statusCode', 'errorCode', 'counts'] },
  {
    title: '关联标识',
    keys: ['requestId', 'traceId', 'taskId', 'auditId', 'receiptId', 'parentEventId', 'untrustedRelatedRequestId']
  }
]
watch(key, () => {
  notice.value = ''
})
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
  const event = Object.fromEntries(
    fields.filter((k) => data.value![k] !== undefined).map((k) => [k, data.value![k]])
  )
  const reference =
    data.value.source === 'client'
      ? clientRequestReference(data.value.untrustedRelatedRequestId)
      : undefined
  if (reference) event.untrustedRelatedRequestId = reference
  return event
})
const displayValue = (name: string, value: unknown): string => {
  if (name === 'timestamp') return localStamp(String(value))
  if (name === 'counts')
    return formatCounts(value as LogEvent['counts'], data.value?.operation) || JSON.stringify(value)
  if (name === 'outcome') return `${outcomeLabel(String(value))}（${String(value)}）`
  if (name === 'source') return `${sourceLabel(String(value))}（${String(value)}）`
  if (name === 'operation') {
    const label = operationLabel(String(value))
    return label ? `${label}（${String(value)}）` : String(value)
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
  return groupDefs.map((group) => ({
    title: group.title,
    showTarget: group.title === '目标与对象',
    targetText: target.text,
    targetMissing: target.missing,
    targetUntrusted: target.untrusted,
    rows: group.keys.map((name) => {
      const value = event[name]
      return {
        name,
        label: fieldLabels[name] ?? name,
        present: value !== undefined,
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
        <p v-if="notice" role="status" class="text-muted-foreground text-[13px]">{{ notice }}</p>
      </div>
      <Alert v-if="data?.source === 'client'"><AlertDescription>
        客户端上报的上下文不可信，不代表服务端业务执行事实。
      </AlertDescription></Alert>
      <section v-for="group in groups" :key="group.title" class="flex min-w-0 flex-col gap-2">
        <h3 class="text-muted-foreground text-[13px] leading-5 font-medium">{{ group.title }}</h3>
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
            <TableRow v-for="row in group.rows" :key="row.name">
              <TableCell class="text-muted-foreground w-[168px] align-top whitespace-normal">{{
                row.label
              }}</TableCell>
              <TableCell
                class="break-all whitespace-normal font-mono text-xs"
                :class="row.present ? '' : 'text-muted-foreground font-sans text-[13px]'"
              >
                {{ row.present ? row.text : '未记录' }}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </section>
    </template>
  </div>
</template>
