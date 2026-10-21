<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { TaskExportTitle } from '~~/lib/task-center'
import { useCurrentRosterExport, taskBrowserHeaders } from '~/composables/useCurrentRosterExport'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { TITLES } from '~~/lib/labels'
import { CURRENT_TITLES } from '~~/lib/roster/current-titles'

const props = defineProps<{ titleCode: TaskExportTitle }>()
const router = useRouter()
let active = true, contextVersion = 0
// Invalidate a pending navigation even if the user leaves and returns before
// acceptance. Filter-only changes do not change the full-title export context.
// Match the page's effective title, including the default URL before filters
// materialize titleCode. Read the route directly so prop rendering cannot hide
// a title-away-and-back transition.
const routeTitle = computed(() => CURRENT_TITLES.find(code => code === router.currentRoute.value.query.titleCode) ?? 'little_giant')
watch([() => props.titleCode, () => router.currentRoute.value.path, routeTitle], () => { contextVersion++ }, { flush: 'sync' })
onBeforeUnmount(() => { active = false })
const authorization = ref<'loading' | 'allowed' | 'readonly' | 'failed'>('loading')
const readOnlyReason = computed(() => authorization.value === 'allowed' ? '' : authorization.value === 'loading' ? '正在读取任务操作能力。' : authorization.value === 'failed' ? '任务操作能力未确认，请重试。' : '当前部署未开放页面任务操作，仅可查看。')
const { exportRequests, submitting, discovering, discoveryFailed, disabledReason, discoverExports, submitExport } = useCurrentRosterExport(readOnlyReason)
const error = ref('')
const accepted = computed(() => exportRequests.value[`${props.titleCode}:initial`]?.jobId)
const taskLocation = (job: string, code = props.titleCode) => ({ path: '/tasks', query: { tab: 'export', titleCode: code, page: '1', job } })
async function discoverAuthorization() {
  authorization.value = 'loading'
  try {
    const result = await $fetch<{ authorized: boolean }>('/api/task-center', { query: { tab: 'export', pageSize: 1 }, headers: taskBrowserHeaders })
    authorization.value = result.authorized === true ? 'allowed' : 'readonly'
  } catch { authorization.value = 'failed' }
}
async function submit() {
  const code = props.titleCode
  const version = contextVersion
  error.value = ''
  const result = await submitExport(code)
  if (!result || !active || version !== contextVersion) return
  if ('error' in result) { error.value = result.error; return }
  await router.push(taskLocation(result.jobId, code))
}
function retryCapabilities() { void discoverExports(); void discoverAuthorization() }
onMounted(() => { void discoverAuthorization() })
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <Button size="sm" variant="outline" :disabled="submitting || !!disabledReason(titleCode)" :aria-label="`导出当前称号名单：${TITLES[titleCode]}`" :aria-describedby="disabledReason(titleCode) ? 'current-export-reason' : undefined" @click="submit">{{ submitting ? '正在提交…' : '导出当前称号名单' }}</Button>
    <Button v-if="accepted" as-child size="sm" variant="ghost"><NuxtLink :to="taskLocation(accepted)">查看本次导出</NuxtLink></Button>
    <Button v-if="discoveryFailed || authorization === 'failed'" size="sm" variant="outline" :disabled="discovering || authorization === 'loading'" @click="retryCapabilities">重新发现导出能力</Button>
    <p v-if="disabledReason(titleCode)" id="current-export-reason" class="text-muted-foreground text-[13px] leading-5">{{ disabledReason(titleCode) }}</p>
    <Alert v-if="error" variant="destructive" role="alert">{{ error }}</Alert>
  </div>
</template>
