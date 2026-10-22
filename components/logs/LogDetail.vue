<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { LogEvent } from '~~/lib/logging/contract'
import { logBrowserHeaders, logErrorMessage, useLogRead } from '~/composables/useLogRead'
import { Button } from '@/components/ui/button'
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
  return Object.fromEntries(
    fields.filter((k) => data.value![k] !== undefined).map((k) => [k, data.value![k]])
  )
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
    <p v-if="loading" role="status">正在读取日志详情…</p>
    <TableFailureState
      v-if="error"
      title="日志详情读取失败"
      :description="logErrorMessage(error)"
      :pending="loading"
      @retry="refresh"
    />
    <template v-if="current && safe">
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" :disabled="loading" @click="copy">复制脱敏事件</Button
        ><Button v-if="data?.taskId" as-child variant="outline"
          ><RouterLink :to="{ path: '/tasks', query: { job: data.taskId } }"
            >查看关联任务</RouterLink
          ></Button
        >
      </div>
      <p v-if="data?.source === 'client'" class="text-muted-foreground text-sm">
        客户端上报的上下文不可信，不代表服务端业务执行事实。
      </p>
      <dl class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm">
        <template v-for="(value, name) in safe" :key="name"
          ><dt class="text-muted-foreground">{{ name }}</dt>
          <dd class="break-all font-mono text-xs">
            {{ typeof value === 'object' ? JSON.stringify(value) : value }}
          </dd></template
        >
      </dl>
    </template>
    <p v-if="notice" role="status" class="text-sm">{{ notice }}</p>
  </div>
</template>
