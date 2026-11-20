<script setup lang="ts">
import { clientRequestReference } from '#core/lib/client-logging/request-reference'
import { computed, ref, watch } from 'vue'
import TaskListPanel from '#core/app/components/tasks/TaskListPanel.vue'
import RosterCandidateTaskCreate from '#sme-roster/app/components/tasks/CandidateTaskCreate.vue'
import { TASK_EXPORTS, type TaskExportTitle } from '../../lib/sme-roster/task-exports'
import { TASK_STATES, type TaskList, type TaskSummary } from '#core/lib/task-center'
import { getTaskGroups, resolveTaskFilters, getTaskTabs } from '#core/lib/task-catalog'
import { JOB_STATES, type JobState } from '#core/lib/job'
import { useTaskPolling } from '#core/app/composables/useTaskPolling'
import { useRosterCurrentExport, rosterTaskBrowserHeaders } from '#sme-roster/app/composables/useRosterCurrentExport'
import { Button } from '#core/app/components/ui/button'
import FilterChip from '#core/app/components/FilterChip.vue'
import { ENTERPRISE_LIST_TITLE } from '#sme-roster/lib/labels'
import { ROSTER_LEDGER_PATH } from '#sme-roster/lib/sme-roster/routes'
import { Label } from '#core/app/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '#core/app/components/ui/tabs'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { Badge } from '#core/app/components/ui/badge'
import { Alert } from '#core/app/components/ui/alert'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '#core/app/components/ui/sheet'
useHead({ title: '后台任务' })
const taskTabs = getTaskTabs()
const route = useRoute(), router = useRouter()
const scalar = (raw: unknown) => typeof raw === 'string' ? raw : ''
const filters = computed(() => resolveTaskFilters(route.query.tab, route.query.group))
const tab = computed(() => filters.value.tab.id)
const group = computed(() => filters.value.group?.id)
const groups = computed(() => getTaskGroups(tab.value))
const showsRosterTools = computed(() => tab.value === 'sme-roster' && (!group.value || group.value === 'platform'))
const showsExportFilter = computed(() => tab.value === 'all' || tab.value === 'sme-roster' && (!group.value || group.value === 'export'))
const state = computed(() => JOB_STATES.includes(scalar(route.query.state) as JobState) ? scalar(route.query.state) : 'all')
const positive = (raw: unknown, fallback: number, max: number) => /^\d+$/.test(scalar(raw)) && Number(raw) > 0 ? Math.min(Number(raw), max) : fallback
const page = computed(() => positive(route.query.page, 1, 1000000)), pageSize = computed(() => positive(route.query.pageSize, 25, 200))
const job = computed(() => scalar(route.query.job))
const titleCode = computed(() => showsExportFilter.value && TASK_EXPORTS.some(t => t.titleCode === route.query.titleCode) ? scalar(route.query.titleCode) : 'all')
const selectedExportTitle = computed(() => TASK_EXPORTS.find(entry => entry.titleCode === titleCode.value)?.label)
const selectedState = computed(() => state.value === 'all' ? undefined : TASK_STATES[state.value as JobState])

const browserHeaders = rosterTaskBrowserHeaders
const params = computed(() => ({ tab: tab.value, group: group.value, state: state.value === 'all' ? undefined : state.value, titleCode: titleCode.value === 'all' ? undefined : titleCode.value, page: page.value, pageSize: pageSize.value }))
const key = computed(() => JSON.stringify([params.value]))
const { data, sourceKey, loading, failed, retryIn, refresh } = useTaskPolling<TaskList>(key, signal =>
  $fetch<TaskList>('/api/task-center', { query: params.value, headers: browserHeaders, signal }))
// Only a list payload renders rows; anything partial shows as empty instead of
// throwing mid-render.
const rows = computed(() => Array.isArray(data.value?.rows) ? data.value.rows : [])
const stale = computed(() => sourceKey.value !== key.value)
// The template handler starts a read; it does not wait for it.
function reload() { void refresh() }
const readOnlyReason = computed(() => {
  if (stale.value) return '正在读取当前筛选，读完即可操作。'
  if (!data.value) return '正在读取任务列表。'
  return ''
})
const failureDescription = computed(() => {
  if (!data.value || !sourceKey.value) return '筛选已保留，将自动退避重试，也可立即重新加载。'
  const [source] = JSON.parse(sourceKey.value) as [{ tab: string; group?: string; state?: JobState; titleCode?: string }]
  const sourceState = source.state ? TASK_STATES[source.state] : '全部状态'
  const targetState = state.value === 'all' ? '全部状态' : TASK_STATES[state.value as JobState]
  const titleLabel = (code?: string) => TASK_EXPORTS.find(t => t.titleCode === code)?.label ?? '全部称号'
  const filterLabel = ({ tab, group }: ReturnType<typeof resolveTaskFilters>) => group ? `${tab.label} / ${group.label}` : tab.label
  return `保留上次结果（${filterLabel(resolveTaskFilters(source.tab, source.group))} / ${sourceState} / ${titleLabel(source.titleCode)}，第 ${data.value.page} 页）；请求目标为${filterLabel(filters.value)} / ${targetState} / ${titleLabel(titleCode.value)}，第 ${page.value} 页。将在 ${retryIn.value / 1000} 秒后重试。`
})
function navigate(patch: Record<string, string | number | undefined>) { return router.push({ path: '/tasks', query: { ...route.query, ...patch } }) }
function setTab(value: string | number) {
  if (taskTabs.some(tab => tab.id === value)) void navigate({ tab: String(value), group: undefined, titleCode: undefined, page: 1, job: undefined })
}

function regenerate(task: TaskSummary) {
  const code = task.export?.titleCode as TaskExportTitle | null | undefined
  if (code) void submitExport(code, task.id)
}
const { exportRequests, submitting, disabledReason: exportDisabledReason, submitExport: requestExport, discovering, discoveryFailed, discoverExports } = useRosterCurrentExport(readOnlyReason)
const { $clientErrors } = useNuxtApp()
const downloading = ref(false)
// `exportNotice` is the page's **only** live region: whether an export request
// was accepted, and the outcome of a download. The detail card never repeats it,
// so a 202 is announced once. A notice belongs to one task; switching tasks drops it.
type ExportNotice = { text: string, tone: 'status' | 'alert', jobId: string }
const exportNotice = ref<ExportNotice | null>(null)
const announce = (text: string, jobId = '', tone: ExportNotice['tone'] = 'status') => { exportNotice.value = { text, tone, jobId } }
// The export bar states the *request* (accepted / unconfirmed), never the task:
// task state lives on the server and is shown per row and in the detail.
const acceptedExports = computed(() => TASK_EXPORTS
  .map(entry => ({ entry, request: exportRequests.value[`${entry.titleCode}:initial`] }))
  .filter((item): item is { entry: typeof item.entry, request: { clientRequestId: string, jobId: string } } => !!item.request?.jobId)
  .map(item => ({ entry: item.entry, jobId: item.request.jobId })))
async function submitExport(code: TaskExportTitle, regenerateOf: string) {
  exportNotice.value = null
  const result = await requestExport(code, regenerateOf)
  if (!result) return
  if ('error' in result) { announce(result.error, '', 'alert'); return }
  announce('导出已受理；可以离开，稍后从后台任务取回。', result.jobId)
  void navigate({ tab: 'sme-roster', group: 'export', state: undefined, titleCode: code, page: 1, job: result.jobId })
  void refresh()
}
const availabilityLabels = { available: '可下载', expired: '已过期，请重新生成', missing: '文件缺失，请重新生成' }
async function downloadExport(task: TaskSummary, refreshDetail: () => void) {
  const artifact = task.export?.artifact
  if (downloading.value || !task.export?.canDownload || !artifact || artifact.availability !== 'available' || artifact.id !== task.id || artifact.downloadUrl !== `/api/job-artifacts/${task.id}`) return
  let relatedRequestId: string | undefined
  downloading.value = true; exportNotice.value = null
  try {
    const response = await fetch(artifact.downloadUrl, { headers: browserHeaders, cache: 'no-store' })
    relatedRequestId = clientRequestReference(response.headers.get('x-request-id'))
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || !response.headers.get('content-disposition')?.includes(`filename="${artifact.filename}"`)) throw new Error('Invalid artifact response')
    const bytes = await response.arrayBuffer()
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
    if (bytes.byteLength !== artifact.size || sha256 !== artifact.sha256) throw new Error('Artifact integrity mismatch')
    const url = URL.createObjectURL(new Blob([bytes], { type: response.headers.get('content-type')! }))
    const link = document.createElement('a'); link.href = url; link.download = artifact.filename; document.body.append(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    announce('Excel 已校验并下载；有效期内可重复下载。', task.id)
  } catch {
    $clientErrors?.reportInteractionFailure('task_artifact_download', relatedRequestId)
    announce('下载未完成或文件校验失败。请刷新任务并核对产物可用性；过期或缺失时请重新生成。', task.id, 'alert')
    refreshDetail(); void refresh()
  } finally { downloading.value = false }
}
// Every disabled action names its reason beside itself; disabled buttons receive
// neither pointer nor focus events, so a tooltip could never explain them.
const downloadReason = (task: TaskSummary) => {
  const artifact = task.export?.artifact
  if (!artifact) return '尚无完整产物；失败或取消不会发布文件，可重新生成新的导出。'
  if (artifact.availability !== 'available') return availabilityLabels[artifact.availability]
  if (readOnlyReason.value) return readOnlyReason.value
  if (!task.export?.canDownload) return '服务端当前未开放该产物的下载。'
  return ''
}
const regenerateReason = (task: TaskSummary) => {
  if (task.export?.titleCode && exportDisabledReason(task.export.titleCode as TaskExportTitle)) return exportDisabledReason(task.export.titleCode as TaskExportTitle)
  if (readOnlyReason.value) return readOnlyReason.value
  if (!task.export?.canRegenerate) return task.state === 'queued' || task.state === 'running' ? '任务仍在执行，结束后才能重新生成。' : '当前状态不支持重新生成。'
  return ''
}
/** Dates for people; the machine value stays on `<time :datetime>`. */
const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' })
const dated = (iso: string | null | undefined) => iso && !Number.isNaN(Date.parse(iso)) ? dateFormat.format(new Date(iso)).replace(/\//g, '-') : (iso ?? '')

// Closing a detail returns to the row that opened it, with focus there again;
// `block: 'nearest'` leaves the list alone when that row is already visible.
const lastOpenedRow = ref('')
function openDetail(id: string) { lastOpenedRow.value = id; void navigate({ job: id }) }
/** Connected *and* rendered: the desktop `<tr>` and the narrow-screen `<li>` carry
 *  the same `data-task-row`, but one of them is `display:none` at any width and a
 *  hidden button cannot take focus. */
const isShown = (element: Element | null | undefined): element is Element => !!element && element.isConnected && element.getClientRects().length > 0
const firstShown = <T extends Element>(selector: string) => Array.from(document.querySelectorAll<T>(selector)).find(isShown)
const closingRow = ref('')
async function closeDetail() {
  closingRow.value = lastOpenedRow.value || job.value
  await navigate({ job: undefined })
}
function restoreListFocus(event: Event) {
  event.preventDefault()
  const id = closingRow.value || lastOpenedRow.value
  const rows = Array.from(document.querySelectorAll<HTMLElement>(`[data-task-row="${id}"]`)).filter(isShown)
  if (rows.length) {
    rows[0]!.scrollIntoView({ block: 'nearest' })
    const target = rows.map(row => row.querySelector<HTMLElement>('[data-row-action]')).find(isShown)
    if (target) { target.focus({ preventScroll: true }); return }
  }
  // The row may not be on this page at all: a task opened from the standing bar
  // or a deep link can belong to another filter. Land on the current view's own
  // anchor instead of dropping the caret on <body>.
  firstShown<HTMLElement>('[data-slot="tabs-trigger"][data-state="active"]')?.focus({ preventScroll: true })
}
// A notice about one task must not follow the reader to the next one.
watch(job, (next, previous) => { if (previous && !next) closingRow.value = previous; if (exportNotice.value && exportNotice.value.jobId && exportNotice.value.jobId !== next) exportNotice.value = null })
</script>
<template>
  <div class="workspace-list flex min-w-0 flex-col gap-4">
    <PageHeader title="后台任务" />
    <!-- 任务列表：分类、筛选、列表与分页同属一个 h2 区块 -->
    <section aria-labelledby="task-list-heading" class="workspace-list workspace-list-body flex min-w-0 flex-col gap-4">
      <h2 id="task-list-heading" class="sr-only">任务列表</h2>
      <RosterCandidateTaskCreate v-if="showsRosterTools && data?.authorized && !stale" @created="id => { void navigate({job:id,tab:'sme-roster',group:'platform',page:1}); void refresh() }" />
      <!-- 本次导出：跨分类常驻，只说“请求”状态，与服务端任务状态分开。
           这是一条常驻状态，不是错误：它用 role=region（不是 Alert 默认的
           role=alert），受理结果只由下面的 export-notice 播报一次。 -->
      <Alert v-if="acceptedExports.length" role="region" data-testid="export-request-bar" aria-label="本次导出" class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <Badge variant="solid">已受理</Badge>
          <span class="text-sm">已受理的导出请求 · {{ acceptedExports.map(item => item.entry.label).join(' / ') }}</span>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button v-for="item in acceptedExports" :key="item.jobId" size="sm" variant="outline" class="min-h-11 sm:min-h-0" @click="navigate({ job: item.jobId })">查看 · {{ item.entry.label }}</Button>
        </div>
      </Alert>
      <!-- 全页唯一的 live region：受理/下载结果只在这里说一次 -->
      <p v-if="exportNotice && !job" :role="exportNotice.tone" :aria-live="exportNotice.tone === 'status' ? 'polite' : 'assertive'" data-testid="export-notice" class="text-sm break-words" :class="exportNotice.tone === 'alert' && 'text-destructive'">{{ exportNotice.text }}</p>

      <TaskListPanel
        :rows="rows" :data="data" :page="page" :page-size="pageSize"
        :loading="loading" :failed="failed" :stale="stale" :failure-description="failureDescription" :dated="dated"
        @reload="reload" @open-detail="openDetail" @page="navigate({ page: $event })" @page-size="navigate({ pageSize: $event, page: 1 })"
      >
        <template #toolbar>
          <Tabs :model-value="tab" @update:model-value="setTab">
            <TabsList aria-label="任务模块" class="h-auto w-full flex-wrap justify-start">
              <TabsTrigger v-for="entry in taskTabs" :key="entry.id" :value="entry.id" :data-task-tab="entry.id" class="h-auto min-h-11 sm:min-h-8">{{ entry.label }}<span v-if="data && !stale" class="ml-1 tabular-nums">{{ data.counts[entry.id] }}</span></TabsTrigger>
            </TabsList>
          </Tabs>
          <!-- 每个 Label+Select 自成一组：窄屏折行时标签不会留在上一行、控件掉到下一行 -->
          <div data-testid="task-filters" class="flex flex-wrap items-center gap-2">
            <div v-if="groups.length" class="flex items-center gap-2">
              <Label for="task-group" class="sr-only">分组</Label>
              <Select :model-value="group ?? 'all'" @update:model-value="navigate({ group: $event === 'all' ? undefined : String($event), titleCode: undefined, page: 1, job: undefined })">
                <SelectTrigger id="task-group" size="sm" class="bg-card w-36 shadow-none" aria-label="任务分组"><SelectValue /></SelectTrigger>
                <SelectContent class="shadow-none">
                  <SelectItem value="all">全部分组</SelectItem>
                  <SelectItem v-for="entry in groups" :key="entry.id" :value="entry.id">{{ entry.label }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="flex items-center gap-2">
              <Label for="task-state" class="sr-only">状态</Label>
              <Select :model-value="state" @update:model-value="navigate({ state: String($event), page: 1, job: undefined })">
                <SelectTrigger id="task-state" size="sm" class="bg-card data-[active=true]:border-primary/45 data-[active=true]:bg-accent data-[active=true]:text-accent-foreground w-32 shadow-none active:scale-[0.98] transition-transform duration-150 ease-snap motion-reduce:transition-none motion-reduce:active:scale-100" :data-active="state !== 'all'" aria-label="任务状态"><SelectValue /></SelectTrigger>
                <SelectContent class="shadow-none"><SelectGroup><SelectItem value="all">全部状态</SelectItem><SelectItem v-for="s in JOB_STATES" :key="s" :value="s">{{ TASK_STATES[s] }}</SelectItem></SelectGroup></SelectContent>
              </Select>
            </div>
            <Button v-if="tab === 'core'" as-child variant="outline" size="sm" class="bg-card shadow-none"><NuxtLink to="/ocr">识别校对入口</NuxtLink></Button>
            <Button v-if="showsRosterTools" as-child variant="outline" size="sm" class="bg-card shadow-none"><NuxtLink :to="ROSTER_LEDGER_PATH">{{ ENTERPRISE_LIST_TITLE }}</NuxtLink></Button>
            <div v-if="showsExportFilter" class="flex min-w-0 items-center gap-2">
              <Label for="export-title-filter" class="sr-only">导出称号</Label>
              <Select :model-value="titleCode" @update:model-value="navigate({ titleCode: $event === 'all' ? undefined : String($event), page: 1, job: undefined })">
                <SelectTrigger id="export-title-filter" size="sm" class="bg-card data-[active=true]:border-primary/45 data-[active=true]:bg-accent data-[active=true]:text-accent-foreground w-48 shadow-none active:scale-[0.98] transition-transform duration-150 ease-snap motion-reduce:transition-none motion-reduce:active:scale-100" :data-active="titleCode !== 'all'" aria-label="导出称号"><SelectValue /></SelectTrigger>
                <SelectContent class="shadow-none"><SelectGroup><SelectItem value="all">全部称号</SelectItem><SelectItem v-for="entry in TASK_EXPORTS" :key="entry.titleCode" :value="entry.titleCode">{{ entry.label }}</SelectItem></SelectGroup></SelectContent>
              </Select>
            </div>
            <Button size="sm" variant="outline" class="ml-auto" :disabled="loading" @click="reload">刷新列表</Button>
          </div>
          <div v-if="filters.group || selectedState || selectedExportTitle" class="flex flex-wrap items-center gap-1.5" role="group" aria-label="已应用筛选">
            <FilterChip v-if="filters.group" :label="`分组 · ${filters.group.label}`" @remove="navigate({ group: undefined, titleCode: undefined, page: 1, job: undefined })" />
            <FilterChip v-if="selectedState" :label="`状态 · ${selectedState}`" @remove="navigate({ state: undefined, page: 1, job: undefined })" />
            <FilterChip v-if="selectedExportTitle" :label="`称号 · ${selectedExportTitle}`" @remove="navigate({ titleCode: undefined, page: 1, job: undefined })" />
          </div>
        </template>
        <template #status="{ row }">
          <span v-if="row.export?.artifact" class="text-muted-foreground text-xs">{{ availabilityLabels[row.export.artifact.availability] }}</span>
        </template>
      </TaskListPanel>
    </section>

    <Sheet :open="!!job" @update:open="value => { if (!value) void closeDetail() }">
      <SheetContent floating-size="standard" class="min-w-0 gap-0" @close-auto-focus="restoreListFocus">
        <SheetHeader class="shrink-0 border-b px-6 py-5 pr-12">
          <SheetTitle>任务详情</SheetTitle>
          <SheetDescription>关闭详情后，任务继续运行。</SheetDescription>
        </SheetHeader>
        <div class="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]" data-testid="task-detail-scroll">
        <p v-if="exportNotice" :role="exportNotice.tone" :aria-live="exportNotice.tone === 'status' ? 'polite' : 'assertive'" data-testid="export-notice" class="mb-4 text-sm break-words" :class="exportNotice.tone === 'alert' && 'text-destructive'">{{ exportNotice.text }}</p>
        <RosterTaskDetail v-if="job" :id="job" :dated="dated" @close="closeDetail" @changed="refresh">
        <template #actions="{ task, current, refresh: refreshDetail }">
          <template v-if="task.export">
            <Button :disabled="!current || downloading || !task.export.canDownload" @click="downloadExport(task, refreshDetail)">{{ downloading ? '校验下载中…' : '下载 Excel' }}</Button>
            <Button variant="outline" :disabled="!current || submitting || !task.export.canRegenerate || !task.export.titleCode || !!exportDisabledReason(task.export.titleCode as TaskExportTitle)" @click="regenerate(task)">重新生成</Button>
            <Button v-if="discoveryFailed" variant="outline" :disabled="discovering" @click="discoverExports">重新发现导出能力</Button>
          </template>
        </template>
        <template #content="{ task, exportSummary }">
          <!-- 产物说明与它的禁用原因同属详情卡，不另起标题层级。 -->
          <div v-if="exportSummary" data-testid="export-artifact" class="flex min-w-0 flex-col gap-2">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
              <span class="text-foreground font-medium">{{ exportSummary.artifact ? availabilityLabels[exportSummary.artifact.availability] : '尚无可下载的完整产物' }}</span>
              <span v-if="exportSummary.artifact" class="text-muted-foreground break-all">{{ exportSummary.artifact.filename }} · 保留至 {{ dated(exportSummary.artifact.expiresAt) }}</span>
            </div>
            <!-- Disabled actions explain themselves here, next to the controls. -->
            <div class="flex flex-col gap-1" data-testid="export-actions">
              <p v-if="downloadReason(task)" class="text-muted-foreground text-sm">下载 Excel：{{ downloadReason(task) }}</p>
              <p v-if="regenerateReason(task)" class="text-muted-foreground text-sm">重新生成：{{ regenerateReason(task) }}</p>
            </div>
          </div>
        </template>
        </RosterTaskDetail>
        </div>
      </SheetContent>
    </Sheet>

  </div>
</template>
