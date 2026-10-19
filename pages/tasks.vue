<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { TASK_EXPORTS, TASK_TABS, TASK_STATES, type TaskExportTitle, type TaskList, type TaskSummary, type TaskTab } from '~~/lib/task-center'
import { isJobId, JOB_STATES, type JobState } from '~~/lib/job'
import { useTaskPolling } from '~/composables/useTaskPolling'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
useHead({ title: '后台任务' })
const route = useRoute(), router = useRouter()
const scalar = (raw: unknown) => typeof raw === 'string' ? raw : ''
const tab = computed<TaskTab>(() => TASK_TABS.includes(scalar(route.query.tab) as TaskTab) ? scalar(route.query.tab) as TaskTab : 'all')
const state = computed(() => JOB_STATES.includes(scalar(route.query.state) as JobState) ? scalar(route.query.state) : 'all')
const positive = (raw: unknown, fallback: number, max: number) => /^\d+$/.test(scalar(raw)) && Number(raw) > 0 ? Math.min(Number(raw), max) : fallback
const page = computed(() => positive(route.query.page, 1, 1000000)), pageSize = computed(() => positive(route.query.pageSize, 25, 200))
const job = computed(() => scalar(route.query.job))
const titleCode = computed(() => TASK_EXPORTS.some(t => t.titleCode === route.query.titleCode) ? scalar(route.query.titleCode) : 'all')
const tabLabels: Record<TaskTab, string> = { all: '全部任务', ocr: 'OCR', platform: '工信部平台', export: '导出' }
const draftToken = ref(''), token = ref(''), authorizationVersion = ref(0)
const params = computed(() => ({ tab: tab.value, state: state.value === 'all' ? undefined : state.value, titleCode: titleCode.value === 'all' ? undefined : titleCode.value, page: page.value, pageSize: pageSize.value }))
const key = computed(() => JSON.stringify([params.value, authorizationVersion.value]))
const { data, sourceKey, loading, failed, retryIn, refresh } = useTaskPolling(key, signal => $fetch<TaskList>('/api/task-center', { query: params.value, headers: token.value ? { authorization: `Bearer ${token.value}` } : undefined, signal }))
const stale = computed(() => sourceKey.value !== key.value)
const failureDescription = computed(() => {
  if (!data.value || !sourceKey.value) return '筛选已保留，将自动退避重试，也可立即重新加载。'
  const [source] = JSON.parse(sourceKey.value) as [{ tab: TaskTab; state?: JobState; titleCode?: string }]
  const sourceState = source.state ? TASK_STATES[source.state] : '全部状态'
  const targetState = state.value === 'all' ? '全部状态' : TASK_STATES[state.value as JobState]
  const titleLabel = (code?: string) => TASK_EXPORTS.find(t => t.titleCode === code)?.label ?? '全部称号'
  return `保留上次结果（${tabLabels[source.tab]} / ${sourceState} / ${titleLabel(source.titleCode)}，第 ${data.value.page} 页）；请求目标为${tabLabels[tab.value]} / ${targetState} / ${titleLabel(titleCode.value)}，第 ${page.value} 页。将在 ${retryIn.value / 1000} 秒后重试。`
})
function navigate(patch: Record<string, string | number | undefined>) { return router.push({ path: '/tasks', query: { ...route.query, ...patch } }) }
function setTab(value: string | number) { if (TASK_TABS.includes(value as TaskTab)) void navigate({ tab: String(value), titleCode: undefined, page: 1, job: undefined }) }
function authorize() { token.value = draftToken.value.trim(); draftToken.value = ''; authorizationVersion.value++ }
function clearAuthorization() { token.value = ''; draftToken.value = ''; authorizationVersion.value++ }
const exportRoutes = ref<Partial<Record<TaskExportTitle, boolean>>>({})
const discovering = ref(false), discoveryFailed = ref(false)
async function discoverExports() {
  discovering.value = true; discoveryFailed.value = false; exportRoutes.value = {}
  try {
    const capabilities = await $fetch<{ exports: { titleCode: string; path: string; ready: boolean }[] }>('/api/roster/exports/current/capabilities')
    exportRoutes.value = Object.fromEntries(TASK_EXPORTS.map(t => [t.titleCode, capabilities.exports.some(entry => entry.titleCode === t.titleCode && entry.path === t.path && entry.ready === true)]))
  } catch { discoveryFailed.value = true }
  finally { discovering.value = false }
}
// Only request identities are persisted, never credentials or task states. A
// lost 202 response can be recovered with the same key after navigation/reload.
type ExportRequest = { clientRequestId: string; jobId?: string }
const exportRequests = ref<Record<string, ExportRequest>>({})
const storageKey = 'task-center-export-requests-v1'
const submitting = ref(false), downloading = ref(false), exportNotice = ref('')
function rememberRequests() { sessionStorage.setItem(storageKey, JSON.stringify(exportRequests.value)) }
async function submitExport(title: TaskExportTitle, regenerateOf?: string) {
  if (submitting.value || !token.value || !data.value?.authorized || stale.value || !exportRoutes.value[title]) return
  const entry = TASK_EXPORTS.find(t => t.titleCode === title)!
  const requestKey = `${title}:${regenerateOf ?? 'initial'}`
  submitting.value = true; exportNotice.value = ''
  try {
    let intent = exportRequests.value[requestKey]
    if (!intent) {
      intent = { clientRequestId: crypto.randomUUID() }
      exportRequests.value[requestKey] = intent
    }
    rememberRequests() // Fail closed if the stable identity cannot be saved.
    const result = await $fetch.raw<{ jobId: string }>(entry.path, { method: 'POST', headers: { authorization: `Bearer ${token.value}` }, body: { clientRequestId: intent.clientRequestId, ...(regenerateOf ? { regenerateOf } : {}) }, retry: 0 })
    if (result.status !== 202 || !isJobId(result._data?.jobId)) throw new Error('Unexpected acceptance')
    intent.jobId = result._data.jobId
    if (regenerateOf) delete exportRequests.value[requestKey]
    rememberRequests()
    exportNotice.value = '导出已受理。可以离开页面，稍后从任务历史取回文件。'
    void navigate({ tab: 'export', state: undefined, titleCode: title, page: 1, job: intent.jobId })
    void refresh()
  } catch {
    exportNotice.value = '提交尚未确认。请核对授权、接口和容量后重提；本次请求标识已保留，不会因断线重复创建。'
  } finally { submitting.value = false }
}
const availabilityLabels = { available: '可下载', expired: '已过期，请重新生成', missing: '文件缺失，请重新生成' }
async function downloadExport(task: TaskSummary, refreshDetail: () => Promise<void>) {
  const artifact = task.export?.artifact
  if (downloading.value || !token.value || !task.export?.canDownload || !artifact || artifact.availability !== 'available' || artifact.id !== task.id || artifact.downloadUrl !== `/api/job-artifacts/${task.id}`) return
  downloading.value = true; exportNotice.value = ''
  try {
    const response = await fetch(artifact.downloadUrl, { headers: { authorization: `Bearer ${token.value}` }, cache: 'no-store' })
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || !response.headers.get('content-disposition')?.includes(`filename="${artifact.filename}"`)) throw new Error('Invalid artifact response')
    const bytes = await response.arrayBuffer()
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
    if (bytes.byteLength !== artifact.size || sha256 !== artifact.sha256) throw new Error('Artifact integrity mismatch')
    const url = URL.createObjectURL(new Blob([bytes], { type: response.headers.get('content-type')! }))
    const link = document.createElement('a'); link.href = url; link.download = artifact.filename; document.body.append(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    exportNotice.value = 'Excel 已校验并下载；有效期内可重复下载。'
  } catch { exportNotice.value = '下载未完成或文件校验失败。请核对授权和产物可用性；过期或缺失时重新生成。'; void refreshDetail(); void refresh() }
  finally { downloading.value = false }
}
onMounted(() => {
  window.addEventListener('pagehide', clearAuthorization)
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || '{}')
    for (const [key, value] of Object.entries(saved)) {
      const candidate = value as ExportRequest
      if (/^(little_giant|specialized_sme|innovative_sme):(initial|[0-9A-HJKMNP-TV-Z]{26})$/.test(key) && typeof candidate?.clientRequestId === 'string' && /^[a-f0-9-]{36}$/.test(candidate.clientRequestId)) exportRequests.value[key] = { clientRequestId: candidate.clientRequestId, ...(isJobId(candidate.jobId) ? { jobId: candidate.jobId } : {}) }
    }
  } catch { /* Submission requires a successful storage write before HTTP. */ }
  void discoverExports()
})
onBeforeUnmount(() => { clearAuthorization(); window.removeEventListener('pagehide', clearAuthorization) })
</script>
<template>
  <div class="flex min-w-0 flex-col gap-4">
    <PageHeader title="后台任务" description="查看 OCR、工信部平台和导出任务。离开页面后，后台任务继续运行。">
      <template #actions><Button variant="outline" :disabled="loading" @click="refresh">刷新列表</Button></template>
    </PageHeader>
    <Tabs :model-value="tab" @update:model-value="setTab">
      <TabsList class="h-auto w-full flex-wrap justify-start">
        <TabsTrigger v-for="name in TASK_TABS" :key="name" :value="name">{{ tabLabels[name] }}<span v-if="data && !stale" class="ml-1 tabular-nums">{{ data.counts[name] }}</span></TabsTrigger>
      </TabsList>
    </Tabs>
    <div class="flex flex-wrap items-center gap-3">
      <Label for="task-state">状态</Label>
      <Select :model-value="state" @update:model-value="navigate({ state: String($event), page: 1, job: undefined })">
        <SelectTrigger id="task-state" class="w-36" aria-label="任务状态"><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup><SelectItem value="all">全部状态</SelectItem><SelectItem v-for="s in JOB_STATES" :key="s" :value="s">{{ TASK_STATES[s] }}</SelectItem></SelectGroup></SelectContent>
      </Select>
      <NuxtLink v-if="tab === 'ocr'" to="/ocr" class="text-primary text-sm underline">识别校对入口</NuxtLink>
      <NuxtLink v-if="tab === 'platform'" to="/comparison" class="text-primary text-sm underline">比对与核查入口</NuxtLink>
      <template v-if="tab === 'all' || tab === 'export'">
        <Label for="export-title-filter">导出称号</Label>
        <Select :model-value="titleCode" @update:model-value="navigate({ titleCode: $event === 'all' ? undefined : String($event), page: 1, job: undefined })">
          <SelectTrigger id="export-title-filter" class="w-full sm:w-56" aria-label="导出称号"><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup><SelectItem value="all">全部称号</SelectItem><SelectItem v-for="entry in TASK_EXPORTS" :key="entry.titleCode" :value="entry.titleCode">{{ entry.label }}</SelectItem></SelectGroup></SelectContent>
        </Select>
      </template>
    </div>
    <section v-if="tab === 'export'" aria-label="提交名录导出" class="flex flex-col gap-3 rounded-md border p-4">
      <h2 class="font-semibold">当前有效名录 Excel</h2>
      <p class="text-muted-foreground text-sm">按执行时固定的数据快照生成，不发起平台采集。产物保留 7 天；重新生成请在原任务详情操作。</p>
      <div class="flex flex-wrap gap-3">
        <div v-for="entry in TASK_EXPORTS" :key="entry.titleCode" class="flex min-w-0 flex-col gap-2">
          <Button variant="outline" :disabled="submitting || !data?.authorized || stale || !exportRoutes[entry.titleCode]" @click="submitExport(entry.titleCode)">{{ exportRequests[`${entry.titleCode}:initial`]?.jobId ? '找回本次导出' : '提交导出' }} · {{ entry.label }}</Button>
          <span class="text-muted-foreground text-xs">{{ discovering ? '正在发现接口…' : discoveryFailed ? '接口能力未确认' : exportRoutes[entry.titleCode] ? '接口已上线' : '专用接口尚未上线' }}</span>
        </div>
      </div>
      <p v-if="!data?.authorized || stale" class="text-muted-foreground text-sm">提交与下载需要下方管理操作授权。</p>
      <Button v-if="discoveryFailed" variant="outline" class="self-start" :disabled="discovering" @click="discoverExports">重新发现导出能力</Button>
    </section>
    <p v-if="exportNotice" role="status" class="break-words text-sm">{{ exportNotice }}</p>
    <p class="text-muted-foreground text-xs">OCR 包含识别与 PDF 转图；工信部平台包含批量查询与核查。每个类型仅归一组；其他类型保留在全部任务中。</p>
    <details class="text-sm">
      <summary class="cursor-pointer">管理操作授权 · {{ data?.authorized && !stale ? '已授权' : '只读' }}</summary>
      <form class="mt-3 flex flex-wrap items-end gap-2" @submit.prevent="authorize">
        <div class="flex min-w-0 flex-col gap-2"><Label for="task-key">API 管理密钥</Label><Input id="task-key" v-model="draftToken" type="password" autocomplete="off" placeholder="由管理员提供" /></div>
        <Button type="submit" variant="outline">应用授权</Button><Button type="button" variant="ghost" @click="draftToken = ''; authorize()">清除授权</Button>
        <p class="text-muted-foreground w-full text-xs">仅用于本页请求，离页即清除；不保存到 URL 或浏览器存储。无密钥仍可查看任务。</p>
      </form>
    </details>
    <div class="data-table relative min-w-0 overflow-hidden rounded-md border">
      <TableLoadingStatus :loading="loading" kind="files" label="正在读取后台任务…" />
      <TableFailureState v-if="failed" title="任务列表加载失败" :compact="!!data" :pending="loading" :description="failureDescription" @retry="refresh" />
      <p v-if="stale && data && !failed" role="status" class="text-muted-foreground px-4 py-2 text-sm">正在切换筛选，暂时显示上次结果（第 {{ data.page }} 页）。</p>
      <div class="overflow-x-auto">
        <Table>
          <TableHeader><TableRow><TableHead>类型 / 任务编号</TableHead><TableHead>状态</TableHead><TableHead>阶段进度</TableHead><TableHead>创建时间</TableHead><TableHead>详情</TableHead></TableRow></TableHeader>
          <TableBody>
            <TableRow v-for="row in data?.rows ?? []" :key="row.id">
              <TableCell><div class="flex flex-col gap-1"><NuxtLink :to="{ path: '/tasks', query: { ...route.query, job: row.id } }" class="text-primary underline underline-offset-4 sm:hidden" :aria-label="`打开 ${row.label} ${row.id}`">{{ row.label }}</NuxtLink><span class="hidden sm:inline">{{ row.label }}</span><span class="text-muted-foreground break-all font-mono text-xs">{{ row.id }}</span><span v-if="row.error" class="text-destructive max-w-xs text-xs">{{ row.error }}</span></div></TableCell>
              <TableCell><div class="flex flex-col items-start gap-1"><Badge :variant="row.state === 'failed' ? 'destructive' : 'secondary'" class="whitespace-nowrap">{{ TASK_STATES[row.state] }}</Badge><span v-if="row.export?.artifact" class="text-muted-foreground text-xs">{{ availabilityLabels[row.export.artifact.availability] }}</span></div></TableCell>
              <TableCell><TaskProgress :progress="row.progress" /></TableCell>
              <TableCell class="text-muted-foreground text-xs">{{ row.createdAt }}</TableCell>
              <TableCell><Button variant="outline" size="sm" :aria-label="`查看 ${row.label} ${row.id}`" @click="navigate({ job: row.id })">查看</Button></TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <Empty v-if="!loading && !failed && !data?.rows.length"><EmptyHeader><EmptyTitle>暂无任务</EmptyTitle><EmptyDescription>当前分类和状态没有任务记录。</EmptyDescription></EmptyHeader></Empty>
      <div class="border-t p-3"><TablePagination :page="data?.page ?? page" :page-size="data?.pageSize ?? pageSize" :total="data?.total ?? 0" unit="个任务" :loading="loading || stale" @update:page="navigate({ page: $event })" @update:page-size="navigate({ pageSize: $event, page: 1 })" /></div>
    </div>
    <TaskDetail v-if="job" :key="`${job}:${authorizationVersion}`" :id="job" :token="token" @close="navigate({ job: undefined })" @changed="refresh">
      <template #default="{ task, current, refresh: refreshDetail }">
        <section v-if="task.export" aria-label="导出产物" class="flex min-w-0 flex-col gap-3">
          <dl class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt>生成时间</dt><dd class="break-all">{{ task.export.generatedAt ?? '尚未生成' }}</dd>
            <dt>快照边界</dt><dd class="break-all">{{ task.export.snapshotStartedAt ?? '尚未固定' }}</dd>
            <dt>规则版本</dt><dd class="break-all">{{ task.export.ruleVersion ?? '尚未记录' }}</dd>
            <template v-if="task.export.dataVersion"><dt>数据版本</dt><dd class="break-all font-mono text-xs">{{ task.export.dataVersion }}</dd></template>
            <template v-if="task.export.regenerateOf"><dt>重新生成自</dt><dd class="break-all"><NuxtLink :to="{ path: '/tasks', query: { tab: 'export', job: task.export.regenerateOf } }" class="text-primary underline">{{ task.export.regenerateOf }}</NuxtLink></dd></template>
          </dl>
          <p v-if="task.export.counts" class="text-sm">有效 {{ task.export.counts.eligible }} · 待确认 {{ task.export.counts.pending }} · 排除 {{ task.export.counts.excluded }}</p>
          <template v-if="task.export.artifact">
            <p class="break-all text-sm">{{ task.export.artifact.filename }} · {{ task.export.artifact.size }} 字节 · {{ availabilityLabels[task.export.artifact.availability] }}</p>
            <p class="text-muted-foreground break-all text-xs">保留至 {{ task.export.artifact.expiresAt }} · SHA-256 {{ task.export.artifact.sha256 }}</p>
          </template>
          <p v-else class="text-muted-foreground text-sm">尚无可下载的完整产物。失败或取消不会发布文件。</p>
          <div class="flex flex-wrap gap-2">
            <Button :disabled="!current || downloading || !token || !task.export.canDownload" @click="downloadExport(task, refreshDetail)">{{ downloading ? '校验下载中…' : '下载 Excel' }}</Button>
            <Button variant="outline" :disabled="!current || submitting || !token || !task.export.canRegenerate || !task.export.titleCode || !exportRoutes[task.export.titleCode]" @click="task.export.titleCode && submitExport(task.export.titleCode, task.id)">重新生成</Button>
          </div>
          <p v-if="exportNotice" role="status" class="break-words text-sm">{{ exportNotice }}</p>
        </section>
      </template>
    </TaskDetail>
  </div>
</template>
