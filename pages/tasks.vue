<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { TASK_TABS, TASK_STATES, type TaskList, type TaskTab } from '~~/lib/task-center'
import { JOB_STATES, type JobState } from '~~/lib/job'
import { useTaskPolling } from '~/composables/useTaskPolling'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
useHead({ title: '后台任务' })
const route = useRoute(), router = useRouter()
const scalar = (raw: unknown) => typeof raw === 'string' ? raw : ''
const tab = computed<TaskTab>(() => TASK_TABS.includes(scalar(route.query.tab) as TaskTab) ? scalar(route.query.tab) as TaskTab : 'all')
const state = computed(() => JOB_STATES.includes(scalar(route.query.state) as JobState) ? scalar(route.query.state) : 'all')
const positive = (raw: unknown, fallback: number, max: number) => /^\d+$/.test(scalar(raw)) && Number(raw) > 0 ? Math.min(Number(raw), max) : fallback
const page = computed(() => positive(route.query.page, 1, 1000000)), pageSize = computed(() => positive(route.query.pageSize, 25, 200))
const job = computed(() => scalar(route.query.job))
const tabLabels: Record<TaskTab, string> = { all: '全部任务', ocr: 'OCR', platform: '工信部平台', export: '导出' }
const draftToken = ref(''), token = ref(''), authorizationVersion = ref(0)
const params = computed(() => ({ tab: tab.value, state: state.value === 'all' ? undefined : state.value, page: page.value, pageSize: pageSize.value }))
const key = computed(() => JSON.stringify([params.value, authorizationVersion.value]))
const { data, sourceKey, loading, failed, retryIn, refresh } = useTaskPolling(key, signal => $fetch<TaskList>('/api/task-center', { query: params.value, headers: token.value ? { authorization: `Bearer ${token.value}` } : undefined, signal }))
const stale = computed(() => sourceKey.value !== key.value)
const failureDescription = computed(() => {
  if (!data.value || !sourceKey.value) return '筛选已保留，将自动退避重试，也可立即重新加载。'
  const [source] = JSON.parse(sourceKey.value) as [{ tab: TaskTab; state?: JobState }]
  const sourceState = source.state ? TASK_STATES[source.state] : '全部状态'
  const targetState = state.value === 'all' ? '全部状态' : TASK_STATES[state.value as JobState]
  return `保留上次结果（${tabLabels[source.tab]} / ${sourceState}，第 ${data.value.page} 页）；请求目标为${tabLabels[tab.value]} / ${targetState}第 ${page.value} 页。将在 ${retryIn.value / 1000} 秒后重试。`
})
function navigate(patch: Record<string, string | number | undefined>) { return router.push({ path: '/tasks', query: { ...route.query, ...patch } }) }
function setTab(value: string | number) { if (TASK_TABS.includes(value as TaskTab)) void navigate({ tab: String(value), page: 1, job: undefined }) }
function authorize() { token.value = draftToken.value.trim(); draftToken.value = ''; authorizationVersion.value++ }
function clearAuthorization() { token.value = ''; draftToken.value = '' }
onMounted(() => window.addEventListener('pagehide', clearAuthorization))
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
    </div>
    <Alert v-if="tab === 'export'"><AlertTitle>导出能力尚未就绪</AlertTitle><AlertDescription>当前尚未接入三称号导出任务；本页暂不提供提交或下载。</AlertDescription></Alert>
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
              <TableCell><Badge :variant="row.state === 'failed' ? 'destructive' : 'secondary'" class="whitespace-nowrap">{{ TASK_STATES[row.state] }}</Badge></TableCell>
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
    <TaskDetail v-if="job" :key="`${job}:${authorizationVersion}`" :id="job" :token="token" @close="navigate({ job: undefined })" @changed="refresh" />
  </div>
</template>
