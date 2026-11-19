<script setup lang="ts">
import { FileDown } from '@lucide/vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import { Button } from '#core/app/components/ui/button'
import { useTaskPolling } from '#core/app/composables/useTaskPolling'
import { isJobId, type JobState } from '#core/lib/job'
import { TASK_STATES } from '#core/lib/task-center'
import { describeFetchError } from '#core/lib/file-content-status'
import { LEAD_LIST_EXPORT } from '../../lib/export-contract'

const props = defineProps<{ versionId: number; disabled: boolean }>()
const route = useRoute()
const router = useRouter()
const id = computed(() => isJobId(route.query.exportJob) ? route.query.exportJob : '')
const headers = { 'x-task-center-browser': '1' }
type Job = { id: string; state: JobState; kind: string; params: { versionId: number }; error: string | null }
const { data, failed, loading, refresh } = useTaskPolling<Job>(id, signal => $fetch<Job>(`/api/jobs/${id.value}`, { signal, retry: 0 }))
const task = computed(() => data.value?.id === id.value && data.value.kind === LEAD_LIST_EXPORT && data.value.params.versionId === props.versionId ? data.value : undefined)
const mismatch = computed(() => data.value?.id === id.value && !task.value)
const busy = ref(false), downloading = ref(false), error = ref('')
let alive = true
onBeforeUnmount(() => { alive = false })
let request: { versionId: number; clientRequestId: string } | undefined

async function submit() {
  if (busy.value || props.disabled) return
  busy.value = true
  error.value = ''
  if (request?.versionId !== props.versionId) request = { versionId: props.versionId, clientRequestId: crypto.randomUUID() }
  const pending = request
  const initialVersion = route.query.version
  try {
    const result = await $fetch<{ jobId: string }>('/api/lead-lists/exports', { method: 'POST', headers, body: pending, retry: 0 })
    if (!isJobId(result.jobId)) throw Error('任务受理尚未确认，请重试。')
    request = undefined
    if (alive && route.query.version === initialVersion) {
      await router.replace({ query: { ...route.query, version: String(pending.versionId), exportJob: result.jobId } })
    }
  } catch (cause) {
    error.value = describeFetchError(cause)
  } finally { busy.value = false }
}
async function download() {
  if (!task.value || task.value.state !== 'done' || downloading.value) return
  const { id: taskId, params } = task.value
  downloading.value = true
  error.value = ''
  try {
    const blob = await $fetch<Blob>(`/api/lead-lists/exports/${taskId}/download`, { headers, responseType: 'blob', retry: 0 })
    const href = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = `lead-list-${params.versionId}.csv`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(href), 1000)
  } catch (cause) {
    error.value = describeFetchError(cause)
  } finally { downloading.value = false }
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" :disabled="disabled || busy || task?.state === 'queued' || task?.state === 'running'" @click="submit">
        <FileDown aria-hidden="true" />{{ busy ? '正在提交…' : '导出名单版本' }}
      </Button>
      <template v-if="task">
        <Button v-if="task.state === 'done'" size="sm" :disabled="downloading" @click="download">{{ downloading ? '正在下载…' : '下载 CSV' }}</Button>
        <Button as-child variant="ghost" size="sm"><NuxtLink :to="{ path: '/tasks', query: { tab: 'lead-lists', job: task.id } }">查看任务</NuxtLink></Button>
        <span role="status" class="text-muted-foreground text-sm">{{ TASK_STATES[task.state] }}</span>
      </template>
      <span v-else-if="id && loading" role="status" class="text-muted-foreground text-sm">正在读取导出进度…</span>
      <span v-else-if="mismatch" role="status" class="text-muted-foreground text-sm">此导出任务属于其他名单版本。</span>
    </div>
    <TableFailureState v-if="failed" title="导出任务读取失败" compact :pending="loading" @retry="refresh" />
    <p v-if="error" role="alert" class="text-destructive text-sm">{{ error }}</p>
  </div>
</template>
