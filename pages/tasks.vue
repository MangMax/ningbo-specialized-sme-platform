<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { TASK_EXPORTS, TASK_TABS, TASK_STATES, type TaskExportTitle, type TaskList, type TaskSummary, type TaskTab } from '~~/lib/task-center'
import { isJobId, JOB_STATES, type JobState } from '~~/lib/job'
import { useTaskPolling } from '~/composables/useTaskPolling'
import { useAdminAuthorization } from '~/composables/useAdminAuthorization'
import { useExportRequestLog } from '~/composables/useExportRequestLog'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
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

const auth = useAdminAuthorization()
const { draft, credential, version, phase, message, verify, isAuthorized, clear, checking, clearChecking } = auth
const keyInput = useTemplateRef<{ $el?: HTMLInputElement }>('keyInput')
// happy-dom does not give SFC template refs their instance `$el`; a browser always
// does, so fall back to the ref'd element when the parent cannot unwrap it.
const keyField = () => keyInput.value?.$el ?? (keyInput.value as unknown as HTMLInputElement | null) ?? null
const params = computed(() => ({ tab: tab.value, state: state.value === 'all' ? undefined : state.value, titleCode: titleCode.value === 'all' ? undefined : titleCode.value, page: page.value, pageSize: pageSize.value }))
const key = computed(() => JSON.stringify([params.value, version.value]))
// Answer is captured with the request so a late reply can be matched to the
// credential that produced it; a revoked key must not authorize anything.
type ListRead = { list: TaskList, credential: string, key: string }
const { data: read, sourceKey, loading, failed, retryIn, refresh, settle } = useTaskPolling<ListRead>(key, async (signal) => {
  // The answer is captured with the request: a late reply is matched to the
  // credential, filter and generation that produced it, never to "current".
  const requested = { credential: credential.value, params: params.value, key: key.value }
  try {
    const list = await $fetch<TaskList>('/api/task-center', { query: requested.params, headers: requested.credential ? { authorization: `Bearer ${requested.credential}` } : undefined, signal })
    return { list, credential: requested.credential, key: requested.key }
  } catch (cause) {
    throw cause
  }
})
/** The stored snapshot only counts as an answer about `askedFor` if it is that read's. */
function snapshotFor(askedFor: string): ListRead | null {
  return read.value && read.value.key === askedFor ? read.value : null
}
const data = computed(() => read.value?.list)
// Only a list payload renders rows; anything partial shows as empty instead of
// throwing mid-render.
const rows = computed(() => Array.isArray(data.value?.rows) ? data.value.rows : [])
const authorized = computed(() => isAuthorized(read.value && { credential: read.value.credential, authorized: read.value.list?.authorized === true }))
const stale = computed(() => sourceKey.value !== key.value)
// Template handlers must not hand Vue a promise result (Vue treats a resolved
// promise as "component unmounted").
function reload() { void refresh() }
const readOnlyReason = computed(() => {
  if (stale.value) return '正在按新筛选读取授权状态，读完即可操作。'
  if (!data.value) return '尚未读到列表，无法确认授权状态。'
  if (!authorized.value) return '管理操作（提交、下载、取消、重试）需要先完成管理操作授权。'
  return ''
})
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

const exportOpen = ref(false), authOpen = ref(false)
function regenerate(task: TaskSummary) {
  const code = task.export?.titleCode
  if (code) void submitExport(code, task.id)
}
// One explicit action runs at a time: a second Enter while the first check is
// still on the wire must not start a parallel verification (only `settle()` is
// generation-guarded, the verdict is not).
const authSubmitting = ref(false)
const authCancel = new AbortController()
function abortVerification() { clearChecking(); authCancel.abort('verification abandoned') }
/**
 * 等“带着这把候选密钥”的那次读取落定，并交出它的结果。
 *
 * `askedFor` 是**发起时**就算好的读取键（筛选 + 这次凭据的版本），之后任何 await
 * 都不会把它换成“当前”的键：晚到的答案只回答它自己那次请求。
 *
 * 只等“从现在起新开始的读取”不够：提交时若正好有一次轮询在途，密钥变化只是让轮询
 * 重排下一次读取，`settle()` 等到的仍是那次在途的旧读取 —— 它的载荷里没有候选密钥。
 * 所以第一次落定之后，继续等**本次键自己的**快照；它还不存在，就按同一筛选、同一
 * 候选密钥**只读**再取一次（GET 无副作用，也不写回列表），用它作答。
 */
async function waitForCredentialRead(askedFor: string, signal: AbortSignal) {
  // The read that carries this key may be the one already on the wire (re-armed by
  // the credential bump) or a fresh one; either way wait until it has settled and
  // its snapshot exists.
  for (let attempt = 0; attempt < 4 && !signal.aborted && !snapshotFor(askedFor); attempt++) { void settle(signal); await flushPendingRow() }
  await flushPendingRow()
  if (signal.aborted) return { ok: false, answer: null }
  let snapshot = snapshotFor(askedFor)
  // A newer filter/credential read already replaced the stored snapshot: it is not
  // this attempt's answer. Ask the same read-only endpoint once, for this filter
  // and this candidate, instead of passing off "whatever is current".
  if (!snapshot) {
    const [query] = JSON.parse(askedFor) as [typeof params.value, number]
    try {
      const list = await $fetch<TaskList>('/api/task-center', { query, headers: credential.value ? { authorization: `Bearer ${credential.value}` } : undefined, signal })
      snapshot = { list, credential: credential.value, key: askedFor }
    } catch { return { ok: false, answer: null } }
  }
  // Clearing authorization or leaving the page abandons the answer.
  if (signal.aborted) return { ok: false, answer: null }
  if (!snapshot) return { ok: false, answer: null }
  return { ok: true, answer: { credential: snapshot.credential, authorized: snapshot.list?.authorized === true } }
}
/** Resolves after Vue flushed pending DOM work (a macrotask boundary is enough). */
function flushPendingRow() {
  return new Promise<void>((resolve) => {
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => finish())
    const finish = () => { observer?.disconnect(); clearTimeout(timer); resolve() }
    const timer = setTimeout(finish, 0)
    observer?.observe(document.documentElement, { subtree: true, childList: true, attributes: true })
  })
}
// Opens the authorization form, brings it into view once and puts the cursor
// where the key is typed. Only a person asks for this; polling never does.
function requestAuthorization() {
  authOpen.value = true
  void nextTick(() => {
    const input = keyField()
    if (!input) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    input.focus({ preventScroll: true })
    input.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
  })
}
async function submitAuthorization() {
  if (authSubmitting.value || checking.value) return
  authSubmitting.value = true
  // Everything this attempt is judged by is taken **now**, before any request: the
  // candidate in the field, and the read key that will carry it (`verify` bumps the
  // credential version by one). Nothing after an await may relabel the attempt.
  const candidate = draft.value.trim()
  const askedFor = JSON.stringify([params.value, version.value + 1])
  try {
    await verify(candidate, () => waitForCredentialRead(askedFor, authCancel.signal), authCancel.signal)
    // The verdict lands once, and only a refusal moves the cursor: the key stays
    // where it was typed so it can be fixed in place. Success needs no focus
    // move — the badge and the single `role=status` line below say what changed.
    if (phase.value === 'rejected' || phase.value === 'unreachable') {
      await nextTick()
      const field = keyField()
      field?.focus({ preventScroll: true })
      // A field that is not on screen (closed/replaced form) cannot take the caret;
      // say the verdict out loud instead of leaving it to whatever is still focused.
      if (typeof document !== 'undefined' && field && document.activeElement !== field) announceAuth(field.closest('form'))
    }
  } finally { authSubmitting.value = false }
}
function clearAuthorization() { abortVerification(); clear() }
/** Make sure the one verdict line is a live region even when focus cannot move. */
function announceAuth(scope: Element | null) {
  const line = scope?.querySelector<HTMLElement>('[data-testid="task-auth-alert"], [data-testid="task-auth-unreachable"]')
  if (line) line.setAttribute('role', 'alert')
}

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

// Only request identities are persisted (see useExportRequestLog); a lost 202
// is recovered by retrying with the same clientRequestId.
const requestLog = useExportRequestLog()
const exportRequests = requestLog.entries
const submitting = ref(false), downloading = ref(false)
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
const exportDisabledReason = (code: TaskExportTitle) => {
  if (discovering.value) return '正在发现可用的导出接口。'
  if (discoveryFailed.value) return '导出接口能力未确认，请重新发现后再提交。'
  if (!exportRoutes.value[code]) return '该称号的专用导出接口尚未上线。'
  if (readOnlyReason.value) return readOnlyReason.value
  return ''
}
async function submitExport(code: TaskExportTitle, regenerateOf?: string) {
  if (submitting.value || !credential.value || stale.value || !authorized.value || !exportRoutes.value[code]) return
  const entry = TASK_EXPORTS.find(t => t.titleCode === code)!
  const requestKey = `${code}:${regenerateOf ?? 'initial'}`
  submitting.value = true; exportNotice.value = null
  let accepted: string | null = null
  try {
    let intent = exportRequests.value[requestKey]
    if (!intent) {
      intent = { clientRequestId: crypto.randomUUID() }
      requestLog.remember(requestKey, intent)
    } else {
      requestLog.remember(requestKey, intent) // Fail closed if identity cannot be stored.
    }
    const response = await $fetch.raw<{ jobId: string }>(entry.path, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.value}` },
      body: { clientRequestId: intent.clientRequestId, ...(regenerateOf ? { regenerateOf } : {}) },
      retry: 0,
    })
    if (response.status !== 202 || !isJobId(response._data?.jobId)) throw new Error('Unconfirmed acceptance')
    intent.jobId = response._data.jobId
    if (regenerateOf) requestLog.forget(requestKey)
    else requestLog.remember(requestKey, intent)
    accepted = intent.jobId
  } catch {
    announce('提交尚未确认（没有拿到 202 受理回执）。请求标识已保留，重提沿用同一标识，不会重复建任务。', '', 'alert')
  } finally { submitting.value = false }
  if (!accepted) return
  announce('导出已受理；可以离开，稍后从下方“已受理”条取回。', accepted)
  // #121 requires returning to work with the detail open; the standing bar keeps
  // that same request findable from every tab afterwards.
  void navigate({ tab: 'export', state: undefined, titleCode: code, page: 1, job: accepted })
  void refresh()
}
const availabilityLabels = { available: '可下载', expired: '已过期，请重新生成', missing: '文件缺失，请重新生成' }
async function downloadExport(task: TaskSummary, refreshDetail: () => void) {
  const artifact = task.export?.artifact
  if (downloading.value || !credential.value || !task.export?.canDownload || !artifact || artifact.availability !== 'available' || artifact.id !== task.id || artifact.downloadUrl !== `/api/job-artifacts/${task.id}`) return
  downloading.value = true; exportNotice.value = null
  try {
    const response = await fetch(artifact.downloadUrl, { headers: { authorization: `Bearer ${credential.value}` }, cache: 'no-store' })
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || !response.headers.get('content-disposition')?.includes(`filename="${artifact.filename}"`)) throw new Error('Invalid artifact response')
    const bytes = await response.arrayBuffer()
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
    if (bytes.byteLength !== artifact.size || sha256 !== artifact.sha256) throw new Error('Artifact integrity mismatch')
    const url = URL.createObjectURL(new Blob([bytes], { type: response.headers.get('content-type')! }))
    const link = document.createElement('a'); link.href = url; link.download = artifact.filename; document.body.append(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    announce('Excel 已校验并下载；有效期内可重复下载。', task.id)
  } catch {
    announce('下载未完成或文件校验失败。请核对授权和产物可用性；过期或缺失时请重新生成。', task.id, 'alert')
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
  if (task.export?.titleCode && !exportRoutes.value[task.export.titleCode]) return '该称号的专用导出接口尚未上线。'
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
async function closeDetail() {
  const id = lastOpenedRow.value || job.value
  await navigate({ job: undefined })
  await nextTick()
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
watch(job, (next) => { if (exportNotice.value && exportNotice.value.jobId && exportNotice.value.jobId !== next) exportNotice.value = null })
onMounted(() => {
  // Leaving the page clears the credential (required); the badge falls back to
  // 只读 and every disabled action then states "需要先完成管理操作授权".
  window.addEventListener('pagehide', clearAuthorization)
  void discoverExports()
})
// Unmounting ends the page, not the person's authorization intent: abort the
// in-flight verification but do not touch `auth` (a parent route may keep it).
onBeforeUnmount(() => { abortVerification(); window.removeEventListener('pagehide', clearAuthorization) })
</script>
<template>
  <div class="flex min-w-0 flex-col gap-4">
    <PageHeader title="后台任务" description="查看 OCR、工信部平台和导出任务。离开页面后，后台任务继续运行。">
      <template #actions>
        <Badge :variant="authorized ? 'secondary' : 'outline'" data-testid="auth-badge">{{ authorized ? '已授权' : '只读' }}</Badge>
        <Button size="sm" variant="outline" :disabled="loading" @click="reload">刷新列表</Button>
      </template>
    </PageHeader>
    <!-- 任务列表：分类、筛选、列表与分页同属一个 h2 区块 -->
    <section aria-labelledby="task-list-heading" class="flex min-w-0 flex-col gap-4">
      <h2 id="task-list-heading" class="sr-only">任务列表</h2>
      <Tabs :model-value="tab" @update:model-value="setTab">
        <TabsList class="h-auto w-full flex-wrap justify-start">
          <TabsTrigger v-for="name in TASK_TABS" :key="name" :value="name" :data-task-tab="name" class="min-h-11 sm:min-h-0">{{ tabLabels[name] }}<span v-if="data && !stale" class="ml-1 tabular-nums">{{ data.counts[name] }}</span></TabsTrigger>
        </TabsList>
      </Tabs>
      <!-- 每个 Label+Select 自成一组：窄屏折行时标签不会留在上一行、控件掉到下一行 -->
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div class="flex items-center gap-2">
          <Label for="task-state">状态</Label>
          <Select :model-value="state" @update:model-value="navigate({ state: String($event), page: 1, job: undefined })">
            <SelectTrigger id="task-state" class="w-36" aria-label="任务状态"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup><SelectItem value="all">全部状态</SelectItem><SelectItem v-for="s in JOB_STATES" :key="s" :value="s">{{ TASK_STATES[s] }}</SelectItem></SelectGroup></SelectContent>
          </Select>
        </div>
        <NuxtLink v-if="tab === 'ocr'" to="/ocr" class="text-primary text-sm underline">识别校对入口</NuxtLink>
        <NuxtLink v-if="tab === 'platform'" to="/comparison" class="text-primary text-sm underline">比对与核查入口</NuxtLink>
        <div v-if="tab === 'all' || tab === 'export'" class="flex min-w-0 items-center gap-2">
          <Label for="export-title-filter" class="shrink-0">导出称号</Label>
          <Select :model-value="titleCode" @update:model-value="navigate({ titleCode: $event === 'all' ? undefined : String($event), page: 1, job: undefined })">
            <SelectTrigger id="export-title-filter" class="w-full min-w-0 sm:w-56" aria-label="导出称号"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup><SelectItem value="all">全部称号</SelectItem><SelectItem v-for="entry in TASK_EXPORTS" :key="entry.titleCode" :value="entry.titleCode">{{ entry.label }}</SelectItem></SelectGroup></SelectContent>
          </Select>
        </div>
      </div>

      <!-- 本次导出：跨分类常驻，只说“请求”状态，与服务端任务状态分开 -->
      <Alert v-if="acceptedExports.length" data-testid="export-request-bar" aria-label="本次导出" class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <Badge variant="solid">已受理</Badge>
          <span class="text-sm">已受理的导出请求 · {{ acceptedExports.map(item => item.entry.label).join(' / ') }}</span>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button v-for="item in acceptedExports" :key="item.jobId" size="sm" variant="outline" @click="navigate({ job: item.jobId })">查看 · {{ item.entry.label }}</Button>
        </div>
      </Alert>
      <!-- 全页唯一的 live region：受理/下载结果只在这里说一次 -->
      <p v-if="exportNotice" :role="exportNotice.tone" :aria-live="exportNotice.tone === 'status' ? 'polite' : 'assertive'" data-testid="export-notice" class="text-sm break-words" :class="exportNotice.tone === 'alert' && 'text-destructive'">{{ exportNotice.text }}</p>

      <div class="data-table relative min-w-0 overflow-hidden rounded-md border">
        <TableLoadingStatus :loading="loading" kind="files" label="正在读取后台任务…" />
        <TableFailureState v-if="failed" title="任务列表加载失败" :compact="!!data" :pending="loading" :description="failureDescription" @retry="reload" />
        <p v-if="stale && data && !failed" role="status" class="text-muted-foreground px-4 py-2 text-sm">正在切换筛选，暂时显示上次结果（第 {{ data.page }} 页）。</p>
        <!-- 桌面：表格；窄屏：同一份数据的摘要，状态与操作不必横向滚动 -->
        <div class="hidden overflow-x-auto sm:block">
          <Table>
            <TableHeader><TableRow><TableHead>类型 / 任务编号</TableHead><TableHead>状态</TableHead><TableHead>阶段进度</TableHead><TableHead>创建时间</TableHead><TableHead>详情</TableHead></TableRow></TableHeader>
            <TableBody>
              <TableRow v-for="row in rows" :key="row.id" :data-task-row="row.id">
                <TableCell><div class="flex flex-col gap-1"><span>{{ row.label }}</span><span class="text-muted-foreground font-mono text-xs break-all">{{ row.id }}</span><span v-if="row.error" class="text-destructive max-w-xs text-xs">{{ row.error }}</span></div></TableCell>
                <TableCell><div class="flex flex-col items-start gap-1"><Badge :variant="row.state === 'failed' ? 'destructive' : 'secondary'" class="whitespace-nowrap">{{ TASK_STATES[row.state] ?? row.state }}</Badge><span v-if="row.export?.artifact" class="text-muted-foreground text-xs">{{ availabilityLabels[row.export.artifact.availability] }}</span></div></TableCell>
                <TableCell><TaskProgress v-if="row.progress?.stage" :progress="row.progress" /></TableCell>
                <TableCell class="text-muted-foreground text-xs"><time v-if="row.createdAt" :datetime="row.createdAt">{{ dated(row.createdAt) }}</time></TableCell>
                <TableCell><Button variant="outline" size="sm" data-row-action :aria-label="`查看 ${row.label} ${row.id}`" @click="openDetail(row.id)">查看</Button></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <ul v-if="rows.length" class="flex flex-col divide-y sm:hidden" aria-label="任务列表">
          <li v-for="row in rows" :key="row.id" :data-task-row="row.id" class="flex min-w-0 flex-col gap-2 p-3" data-testid="task-card">
            <div class="flex items-start justify-between gap-3">
              <div class="flex min-w-0 flex-col gap-1">
                <span class="font-medium break-words">{{ row.label }}</span>
                <span class="text-muted-foreground font-mono text-xs break-all">{{ row.id }}</span>
              </div>
              <Button variant="outline" size="sm" class="min-h-11 shrink-0" data-row-action :aria-label="`查看 ${row.label} ${row.id}`" @click="openDetail(row.id)">查看</Button>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Badge :variant="row.state === 'failed' ? 'destructive' : 'secondary'" class="whitespace-nowrap">{{ TASK_STATES[row.state] ?? row.state }}</Badge>
              <span v-if="row.export?.artifact" class="text-muted-foreground text-xs">{{ availabilityLabels[row.export.artifact.availability] }}</span>
              <TaskProgress v-if="row.progress?.stage" :progress="row.progress" inline />
              <time v-if="row.createdAt" :datetime="row.createdAt" class="text-muted-foreground text-xs">{{ dated(row.createdAt) }}</time>
            </div>
            <p v-if="row.error" class="text-destructive text-xs">{{ row.error }}</p>
          </li>
        </ul>
        <Empty v-if="!loading && !failed && !rows.length"><EmptyHeader><EmptyTitle>暂无任务</EmptyTitle><EmptyDescription>当前分类和状态没有任务记录。</EmptyDescription></EmptyHeader></Empty>
        <div class="border-t p-3"><TablePagination :page="data?.page ?? page" :page-size="data?.pageSize ?? pageSize" :total="data?.total ?? 0" unit="个任务" :loading="loading || stale" @update:page="navigate({ page: $event })" @update:page-size="navigate({ pageSize: $event, page: 1 })" /></div>
      </div>
    </section>

    <!-- 任务详情：卡片标题就是本区块的 h2；重新验证授权只换凭据，不重挂卡片 -->
    <section v-if="job" aria-labelledby="task-detail-title" class="flex min-w-0 flex-col">
      <TaskDetail :id="job" :token="credential" :authorization-reason="readOnlyReason" :dated="dated" @close="closeDetail" @changed="refresh" @request-authorization="requestAuthorization">
        <template #actions="{ task, current, refresh: refreshDetail }">
          <template v-if="task.export">
            <Button :disabled="!current || downloading || !credential || !task.export.canDownload" @click="downloadExport(task, refreshDetail)">{{ downloading ? '校验下载中…' : '下载 Excel' }}</Button>
            <Button variant="outline" :disabled="!current || submitting || !credential || !task.export.canRegenerate || !task.export.titleCode || !exportRoutes[task.export.titleCode]" @click="regenerate(task)">重新生成</Button>
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
        </TaskDetail>
      </section>

    <!-- 一次性说明与“开始新任务”的入口下沉到列表之后，且默认收起 -->
    <div class="flex flex-col gap-2">
      <p class="text-muted-foreground text-xs">OCR 包含识别与 PDF 转图；工信部平台包含批量查询与核查。每个类型仅归一组；其他类型保留在全部任务中。</p>
      <DisclosurePanel v-if="tab === 'export' || tab === 'all'" v-model:open="exportOpen">
        <template #trigger><span class="text-sm">发起新的名录导出</span><Badge v-if="!authorized" variant="outline">只读</Badge></template>
        <section aria-label="提交名录导出" class="flex flex-col gap-3">
          <p class="text-muted-foreground text-sm">按执行时固定的数据快照生成，不发起平台采集。产物保留 7 天；重新生成请在原任务详情操作。</p>
          <div class="flex flex-col gap-2">
            <div v-for="entry in TASK_EXPORTS" :key="entry.titleCode" data-testid="export-action" class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button variant="outline" class="min-h-11 sm:min-h-0" :disabled="submitting || !!exportDisabledReason(entry.titleCode)" :aria-describedby="`export-${entry.titleCode}-reason`" @click="submitExport(entry.titleCode)">{{ exportRequests[`${entry.titleCode}:initial`]?.jobId ? '找回本次导出' : '提交导出' }} · {{ entry.label }}</Button>
              <span :id="`export-${entry.titleCode}-reason`" class="text-muted-foreground text-xs">
                {{ exportDisabledReason(entry.titleCode) || '接口已上线' }}
                <Button v-if="readOnlyReason && exportRoutes[entry.titleCode]" variant="link" size="sm" class="h-auto px-1" data-testid="go-authorize" @click="requestAuthorization">进入授权</Button>
              </span>
            </div>
          </div>
          <Button v-if="discoveryFailed" variant="outline" class="self-start" :disabled="discovering" @click="discoverExports">重新发现导出能力</Button>
        </section>
      </DisclosurePanel>
      <DisclosurePanel v-model:open="authOpen">
        <template #trigger><span class="text-sm">管理操作授权</span><Badge :variant="authorized ? 'secondary' : 'outline'" data-testid="auth-badge-inline">{{ authorized ? '已授权' : '只读' }}</Badge></template>
        <form class="flex flex-col gap-3" @submit.prevent="submitAuthorization">
          <div class="flex flex-wrap items-end gap-2">
            <div class="flex min-w-0 flex-col gap-2">
              <Label for="task-key">API 管理密钥</Label>
              <Input id="task-key" ref="keyInput" v-model="draft" type="password" autocomplete="off" placeholder="由管理员提供" :aria-invalid="phase === 'rejected' || undefined" aria-describedby="task-key-help" />
            </div>
            <Button type="submit" variant="outline" class="min-h-11 sm:min-h-0" :disabled="checking" :aria-busy="checking || undefined">{{ checking ? '正在验证…' : '应用授权' }}</Button>
            <Button type="button" variant="ghost" class="min-h-11 sm:min-h-0" @click="clearAuthorization">清除授权</Button>
          </div>
          <!-- One line, one live region: the verdict of the last attempt only. -->
          <p v-if="checking" role="status" data-testid="task-auth-checking" class="text-muted-foreground text-sm">正在验证密钥…</p>
          <p v-else-if="phase === 'idle' && authorized" role="status" data-testid="task-auth-feedback" class="text-sm">已授权，可以提交、下载或取消任务。</p>
          <p v-else-if="message" :role="phase === 'rejected' ? 'alert' : 'status'" :data-testid="phase === 'rejected' ? 'task-auth-alert' : 'task-auth-unreachable'" class="text-sm" :class="phase === 'rejected' && 'text-destructive'">{{ message }}</p>
          <p id="task-key-help" class="text-muted-foreground text-xs">仅用于本页请求，离页即清除；不保存到 URL 或浏览器存储。无密钥仍可查看任务。</p>
        </form>
      </DisclosurePanel>
    </div>
  </div>
</template>
