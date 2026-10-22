<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { clientRequestReference } from '~~/lib/client-logging/request-reference'
import type { LogEvent } from '~~/lib/logging/contract'
import { logBrowserHeaders, logErrorMessage, useLogRead } from '~/composables/useLogRead'
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
  id: '事件标识', timestamp: `记录时间（本地 ${zoneLabel}）`, level: '级别', source: '来源', operation: '操作',
  outcome: '结果', durationMs: '耗时（毫秒）', statusCode: 'HTTP 状态', errorCode: '错误代码',
  counts: '处理数量', requestId: '请求标识', traceId: '链路标识', taskId: '任务标识',
  fileId: '文件编号', page: '页码', batchId: '批次标识', resourceType: '资源类型',
  resourceId: '资源标识', auditId: '审计引用', receiptId: '回执引用', parentEventId: '上级事件',
  untrustedRelatedRequestId: '关联请求（客户端声称，UNTRUSTED）',
}
watch(key, () => {
  notice.value = ''
})
// Copy only the foundation's event projection, even if a future response adds fields.
const safe = computed(() => {
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
  const reference = data.value.source === 'client' ? clientRequestReference(data.value.untrustedRelatedRequestId) : undefined
  if (reference) event.untrustedRelatedRequestId = reference
  return event
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
      <Table class="data-table table-fixed">
        <TableBody><TableRow v-for="(value, name) in safe" :key="name">
          <TableCell class="text-muted-foreground w-[168px] align-top whitespace-normal">{{ fieldLabels[name] ?? name }}</TableCell>
          <TableCell class="break-all whitespace-normal font-mono text-xs">
            {{ typeof value === 'object' ? JSON.stringify(value) : name === 'timestamp' ? localStamp(String(value)) : value }}
          </TableCell>
        </TableRow></TableBody>
      </Table>
    </template>
  </div>
</template>
