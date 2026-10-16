<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed, ref } from 'vue'
import {
  ArrowRightLeft,
  CheckCheck,
  FileDiff,
  GitMerge,
  ListChecks,
  ShieldAlert,
  TriangleAlert,
  Upload,
} from '@lucide/vue'
import {
  ANNUAL_ITEM_CLASS_LABELS,
  ANNUAL_ROSTER_BUCKETS,
  IMPORT_BATCH_STATUSES,
  IMPORT_SOURCE_KINDS,
  TITLES,
} from '~~/lib/labels'
import type {
  AnnualIncrementBundle,
  AnnualPreviewEntry,
  AnnualPreviewResponse,
  AnnualRosterRow,
} from '~~/lib/roster/annual-increment'
import type { RosterImportRequest } from '~~/lib/roster-import-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

/**
 * **年度增量**(RL-07):把今年这一批来源文件先算成一张可复核的清单,再决定要不要应用。
 *
 * ── 这一页回答两个问题 ────────────────────────────────────────────────
 * 1. **会发生什么**(还没写库):逐项分类(新增 / 更新 / 归并 / 无变化 / 冲突 / 重名候选),
 *    以及**总表增减** —— 谁将移出当前总表、谁因公布历史留下、谁因接口失败只能算待核;
 * 2. **发生了什么**(提交之后):每一项来源文件的批次号、摘要与逐项错误,失败的可按
 *    同一条幂等键重试(失败批次一行没落,重试不会写第二遍)。
 *
 * ── 三条硬口径(都在页面上写出来,不靠读者猜)────────────────────────────
 * - 预览**一行都不写**:同一个键连按两次预览,库里任何数字都不会变;
 * - 已提交的键**如实报零**(同键再提交一行都不会写),要补出处指针走 `/replay`;
 * - **接口失败 ≠ 无记录**:重查失败的企业不列入「将移出」,而是进「不得据此删除(待核)」。
 *
 * ── 凭证 ──────────────────────────────────────────────────────────────
 * 预览不鉴权(它是读面);**应用**调 `/api/roster/import/commit`,需要 `NUXT_API_TOKEN`。
 * token 只存在这个页面**内存里**、只随请求头发出,**不落 storage、不进日志、不回显**。
 */
// `$fetch` 上的这层 cast 是既有的必要写法（见 `pages/ocr.vue` 的说明）：一个页面里多次
// `$fetch(...)` 会让 `vue-tsc` 在路由联合类型上爆栈（TS2321）。
const apiGet = $fetch as unknown as <T>(url: string, opts?: { query?: Record<string, unknown> }) => Promise<T>
const apiPost = $fetch as unknown as <T>(
  url: string,
  opts: { method: 'POST'; body: unknown; headers?: Record<string, string> },
) => Promise<T>

// ---- 载荷 ----------------------------------------------------------------

const payloadText = ref('')
const parseError = ref<string | null>(null)
const fileName = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const preview = ref<AnnualPreviewResponse | null>(null)
const previewError = ref<string | null>(null)
const previewing = ref(false)

// 页面标题（RL-17 起的全仓形状):一眼看出是哪一个标签页。
useHead({
  title: computed(() =>
    preview.value
      ? `年度增量 · ${preview.value.entries.length} 项来源 · 名录台账`
      : '年度增量 · 名录台账',
  ),
})


/** 把文本框里的 JSON 解析成载荷包;两种写法都收(包 / 单条 §8.1 请求)。 */
function parseBundle(): AnnualIncrementBundle | null {
  parseError.value = null
  const text = payloadText.value.trim()
  if (!text) {
    parseError.value = '先把本批来源文件的载荷粘进来(或选一个 .json 文件)。'
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    parseError.value = `JSON 解析失败:${error instanceof Error ? error.message : String(error)}`
    return null
  }
  const entries = (parsed as AnnualIncrementBundle | null)?.entries
  if (!Array.isArray(entries)) {
    parseError.value = '载荷包缺少 entries 数组(或直接给一条 §8.1 请求)。'
    return null
  }
  return parsed as AnnualIncrementBundle
}

async function runPreview() {
  const bundle = parseBundle()
  if (!bundle) return
  previewing.value = true
  previewError.value = null
  try {
    preview.value = await apiPost<AnnualPreviewResponse>('/api/roster/import/annual/preview', {
      method: 'POST',
      body: bundle,
    })
  } catch (error) {
    preview.value = null
    previewError.value = describeError(error)
  } finally {
    previewing.value = false
  }
}

async function onPickFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  fileName.value = file.name
  payloadText.value = await file.text()
  preview.value = null
  input.value = ''
}

/** 只取服务器给的那一句 `message`(失败信封的形状全站一致)。 */
function describeError(error: unknown): string {
  const data = (error as { data?: { message?: string } }).data
  return data?.message ?? (error instanceof Error ? error.message : String(error))
}

// ---- 应用 ----------------------------------------------------------------

const token = ref('')
const applying = ref(false)
const applyError = ref<string | null>(null)
const applyResults = ref<
  Array<{
    index: number
    sourceIdentity: string
    batchId: number
    status: string
    summary: Record<string, number> | null
    error: string | null
    items: Array<{ ok: boolean; kind: string; ref: string; error?: { code: string; message: string } }>
  }>
>([])
const applyDialogOpen = ref(false)

/** 逐项提交(每一项来源文件一条 §8.1 请求)。**串行**:一项失败不掩盖前一项的结果。 */
async function apply() {
  const bundle = parseBundle()
  if (!bundle) return
  if (!token.value.trim()) {
    applyError.value = '需要 NUXT_API_TOKEN 才能应用(预览不需要)。'
    return
  }
  applying.value = true
  applyError.value = null
  applyResults.value = []
  try {
    for (const [index, entry] of bundle.entries.entries()) {
      const response = await apiPost<{
        batchId: number
        status: string
        summary: Record<string, number> | null
        items: []
        error: string | null
      }>('/api/roster/import/commit', {
        method: 'POST',
        body: entry as RosterImportRequest,
        headers: { 'x-api-token': token.value.trim() },
      })
      applyResults.value.push({
        index,
        sourceIdentity: entry.sourceIdentity,
        batchId: response.batchId,
        status: response.status,
        summary: response.summary,
        error: response.error,
        items: response.items ?? [],
      })
    }
    await batchesQuery.refetch()
  } catch (error) {
    applyError.value = describeError(error)
  } finally {
    applying.value = false
    applyDialogOpen.value = false
  }
}

// ---- 批次流水(可追溯)------------------------------------------------------

const batchesQuery = useQuery({
  key: () => ['import-batches'],
  query: () => apiGet<{ batches: ImportBatchRow[] }>('/api/roster/import/batches', { query: { limit: 20 } }),
})

interface ImportBatchRow {
  batchId: number
  idempotencyKey: string
  status: string
  sourceKind: string
  sourceIdentity: string
  summary: Record<string, number> | null
  error: string | null
  committedAt: string | null
}

const batches = computed<ImportBatchRow[]>(() => batchesQuery.data.value?.batches ?? [])
const failedBatches = computed(() => batches.value.filter((batch) => batch.status === 'failed'))

// ---- 展示口径 -------------------------------------------------------------

const CLASS_VARIANT: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline' | 'quiet' | 'solid' | 'tier-1'
> = {
  add: 'solid',
  update: 'secondary',
  merge: 'tier-1',
  unchanged: 'quiet',
  conflict: 'destructive',
  candidate: 'outline',
}

const label = (map: Record<string, string>, code: string) => map[code] ?? code
const classLabel = (code: string) => label(ANNUAL_ITEM_CLASS_LABELS, code)
const itemRows = computed(
  () =>
    preview.value?.entries.flatMap((entry) =>
      entry.items.map((item) => ({ ...item, sourceIdentity: entry.sourceIdentity, batchStatus: entry.batchStatus })),
    ) ?? [],
)
const conflictedItems = computed(() => itemRows.value.filter((item) => !item.ok))
const buckets = computed(() => {
  const roster = preview.value?.roster
  return [
    { key: 'removed' as const, rows: roster?.removed ?? [], tone: 'solid' as const },
    { key: 'blocked' as const, rows: roster?.blocked ?? [], tone: 'destructive' as const },
    { key: 'keptByAnnouncement' as const, rows: roster?.keptByAnnouncement ?? [], tone: 'quiet' as const },
  ]
})
const entryOf = (index: number): AnnualPreviewEntry | undefined => preview.value?.entries[index]
const TH_CLASS = 'bg-muted text-muted-foreground sticky top-0 z-10 h-9 text-xs font-medium'
const snapshotText = (row: AnnualRosterRow) =>
  row.snapshot ? `${row.snapshot.year} 年 · ${label(TITLES, row.snapshot.titleCode)}` : '—'
/** 「这一批会发生什么」的六个格子：顺序固定，数字来自预览的计数。 */
const countCells = computed(() => [
  { label: '新增', value: preview.value?.totals.add ?? 0, hint: '新写出来的记录' },
  { label: '更新', value: preview.value?.totals.update ?? 0, hint: '复用既有计划项（含归并项）' },
  { label: '归并', value: preview.value?.totals.merge ?? 0, hint: '并身份、删企业行' },
  { label: '无变化', value: preview.value?.totals.unchanged ?? 0, hint: '命中既有记录坐标' },
  { label: '待核实', value: preview.value?.totals.review ?? 0, hint: '无统代 / 查询失败 / 待核' },
  { label: '冲突', value: preview.value?.totals.conflicts ?? 0, hint: '有冲突则整批不落' },
])
</script>

<template>
  <div class="flex flex-col gap-5">
    <PageHeader title="年度增量" description="把今年这一批来源文件先算成一张可复核的清单，再决定要不要应用。">
      <template #description>
        一年只有最新公布文件和最新三张平台导出表。这一页先算出<strong class="text-foreground font-medium">会发生什么</strong>，
        再一次性应用：新增 / 更新 / 归并 / 冲突逐项可对，
        <strong class="text-foreground font-medium">将移出当前总表</strong>、
        <strong class="text-foreground font-medium">因公布历史而保留</strong>、
        <strong class="text-foreground font-medium">因接口失败只能算待核</strong>三栏分开列。
      </template>
    </PageHeader>

    <!-- 1. 载荷 --------------------------------------------------------- -->
    <Card class="rise-in" style="--rise-index: 0">
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base">
          <FileDiff class="size-4" />
          本批来源文件
        </CardTitle>
        <CardDescription>
          载荷包 = <code class="font-mono text-xs">{ year?, entries: [ …§8.1 请求… ] }</code>。
          每项来源文件各带自己的幂等键（同一来源重复导入不会写第二遍）。
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-3">
        <Textarea
          v-model="payloadText"
          data-testid="annual-payload"
          class="h-40 font-mono text-xs"
          spellcheck="false"
          placeholder='{"year": 2026, "entries": [ { "idempotencyKey": "jxj/2026/192号", "sourceKind": "announcement", "sourceIdentity": "jxj/announcement/2026/甬经信中小〔2026〕192号.pdf", "payload": { "announcement": { … } } } ]}'
          @input="preview = null"
        />
        <div class="flex flex-wrap items-center gap-2">
          <Button :disabled="previewing" @click="runPreview">
            <ListChecks class="size-4" />
            {{ previewing ? '计算中…' : '运行预览' }}
          </Button>
          <input ref="fileInput" type="file" accept=".json,application/json" class="hidden" @change="onPickFile" />
          <Button variant="outline" @click="fileInput?.click()">
            <Upload class="size-4" />
            选择 .json 文件
          </Button>
          <span v-if="fileName" class="text-muted-foreground text-xs">已载入 {{ fileName }}</span>
          <span class="text-muted-foreground ml-auto text-xs">运行预览<strong class="text-foreground font-medium">不写库</strong> —— 库里的数字一个都不会变。</span>
        </div>
        <Alert v-if="parseError" variant="destructive">
          <TriangleAlert />
          <AlertTitle>载荷读不了</AlertTitle>
          <AlertDescription>{{ parseError }}</AlertDescription>
        </Alert>
        <Alert v-if="previewError" variant="destructive">
          <TriangleAlert />
          <AlertTitle>预览失败</AlertTitle>
          <AlertDescription>{{ previewError }}</AlertDescription>
        </Alert>
      </CardContent>
    </Card>

    <!-- 2. 预览 --------------------------------------------------------- -->
    <template v-if="preview">
      <Card class="rise-in gap-0 py-0" style="--rise-index: 1">
        <CardHeader class="gap-1">
          <CardTitle class="text-base">这一批会发生什么</CardTitle>
          <CardDescription>
            {{ preview.entries.length }} 项来源文件 · 计数口径与统一写入 API 的预检同源同数。
            <span v-if="preview.applyable" class="text-foreground">可以应用。</span>
            <span v-else class="text-destructive">{{ preview.blockedReason }}</span>
          </CardDescription>
        </CardHeader>
        <CardContent class="grid grid-cols-2 gap-4 p-5 pt-0 sm:grid-cols-3 lg:grid-cols-6">
          <div v-for="cell in countCells" :key="cell.label" class="flex flex-col gap-1" data-count-cell="1">
            <span class="text-muted-foreground text-xs">{{ cell.label }}</span>
            <span
              class="text-2xl leading-none font-semibold tracking-tight tabular-nums"
              :class="cell.label === '冲突' && cell.value > 0 ? 'text-destructive' : ''"
              >{{ cell.value }}</span
            >
            <span class="text-muted-foreground text-[11px]">{{ cell.hint }}</span>
          </div>
        </CardContent>
      </Card>

      <!-- 总表增减 -->
      <div class="grid gap-4 lg:grid-cols-3">
        <Card
          v-for="bucket in buckets"
          :key="bucket.key"
          class="rise-in min-w-0 gap-0 py-0"
          :style="{ '--rise-index': 2 }"
          :data-bucket="bucket.key"
        >
          <CardHeader class="gap-1 pb-3">
            <CardTitle class="flex items-center gap-2 text-sm">
              <Badge :variant="bucket.tone">{{ bucket.rows.length }}</Badge>
              {{ ANNUAL_ROSTER_BUCKETS[bucket.key].label }}
            </CardTitle>
            <CardDescription class="text-xs">{{ ANNUAL_ROSTER_BUCKETS[bucket.key].hint }}</CardDescription>
          </CardHeader>
          <CardContent class="p-0">
            <p v-if="!bucket.rows.length" class="text-muted-foreground px-5 pb-5 text-xs">这一栏是空的。</p>
            <div v-else class="max-h-72 min-w-0 overflow-auto border-t">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead :class="TH_CLASS">企业</TableHead>
                    <TableHead :class="TH_CLASS">上次出现的快照</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="row in bucket.rows" :key="row.enterpriseId" class="[&>td]:py-1.5">
                    <TableCell class="min-w-0">
                      <NuxtLink :to="`/enterprises/${row.enterpriseId}`" class="font-medium hover:underline">
                        {{ row.name }}
                      </NuxtLink>
                      <span class="text-muted-foreground block font-mono text-[11px]">{{ row.uscc ?? '无统代' }}</span>
                    </TableCell>
                    <TableCell class="text-muted-foreground text-xs whitespace-nowrap">{{ snapshotText(row) }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <!-- 重查失败:移出照样发生,但原因必须留待重查 —— 这句话必须在**应用之前**说清。 -->
      <Alert v-if="preview.roster.counts.blocked > 0" data-testid="annual-blocked-warning">
        <TriangleAlert />
        <AlertTitle>{{ preview.roster.counts.blocked }} 家企业的接口重查失败了</AlertTitle>
        <AlertDescription>
          它们同样会被这张最新快照移出当前总表（成员资格只看公布记录与最新快照），
          但<strong class="text-foreground font-medium">原因不会被写下来</strong>：失败 ≠ 无记录，不得据此记成「已迁出 / 已注销 / 无记录」。
          要留下原因，先把这几家重查一遍再来。
        </AlertDescription>
      </Alert>

      <!-- 逐项明细 -->
      <Card class="rise-in gap-0 overflow-hidden py-0" style="--rise-index: 3">
        <CardHeader class="gap-1">
          <CardTitle class="text-base">逐项明细</CardTitle>
          <CardDescription>
            共 {{ itemRows.length }} 项计划 · 冲突 {{ conflictedItems.length }} 项。
            <span class="text-foreground">归并是唯一会删企业行的动作</span>；「无变化」= 命中既有记录坐标（载荷里若有库里还没有的事件，会作为追加写进去，既有事件一律不动）。
          </CardDescription>
        </CardHeader>
        <CardContent class="p-0">
          <p v-if="!itemRows.length" class="text-muted-foreground px-5 pb-5 text-xs">
            这一批没有任何计划项（比如三项都已提交过 ⇒ 同键再提交一行都不会写）。
          </p>
          <div v-else class="max-h-[32rem] min-w-0 overflow-auto border-t">
            <Table class="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead :class="TH_CLASS" class="w-24">分类</TableHead>
                  <TableHead :class="TH_CLASS" class="w-32">类型</TableHead>
                  <TableHead :class="TH_CLASS" class="w-64">企业</TableHead>
                  <TableHead :class="TH_CLASS" class="w-28">称号</TableHead>
                  <TableHead :class="TH_CLASS" class="w-40">引用</TableHead>
                  <TableHead :class="TH_CLASS">说明 / 错误</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="(item, index) in itemRows" :key="`${item.entryIndex}-${item.ref}-${index}`" class="[&>td]:py-1.5">
                  <TableCell>
                    <Badge :variant="CLASS_VARIANT[item.class] ?? 'quiet'">{{ classLabel(item.class) }}</Badge>
                  </TableCell>
                  <TableCell class="text-muted-foreground font-mono text-xs">{{ item.kind }}</TableCell>
                  <TableCell class="text-sm">
                    <span v-if="item.enterpriseName">{{ item.enterpriseName }}</span>
                    <span v-else class="text-muted-foreground">—</span>
                    <Badge v-if="item.review" variant="dashed" class="ml-1">待核</Badge>
                  </TableCell>
                  <TableCell class="text-muted-foreground text-xs">{{ item.titleCode ? label(TITLES, item.titleCode) : '—' }}</TableCell>
                  <TableCell class="text-muted-foreground font-mono text-[11px]">{{ item.ref }}</TableCell>
                  <TableCell class="text-xs">
                    <span v-if="item.error" class="text-destructive">
                      {{ item.error.code }}：{{ item.error.message }}
                    </span>
                    <span v-else class="text-muted-foreground">{{ entryOf(item.entryIndex)?.sourceIdentity }}</span>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <!-- 应用 -->
      <Card class="rise-in" style="--rise-index: 4">
        <CardHeader>
          <CardTitle class="flex items-center gap-2 text-base">
            <ShieldAlert class="size-4" />
            应用
          </CardTitle>
          <CardDescription>
            应用走既有的 <code class="font-mono text-xs">POST /api/roster/import/commit</code>：单批事务、
            失败整批不落业务数据、同一幂等键重放不产生第二遍效果。需要 <code class="font-mono text-xs">NUXT_API_TOKEN</code>
            （只存本页内存，不落浏览器存储、不进日志）。
          </CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-3">
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex w-full max-w-sm flex-col gap-1.5">
              <Label for="annual-token">API token</Label>
              <Input id="annual-token" v-model="token" type="password" autocomplete="off" placeholder="X-API-Token" />
            </div>
            <Dialog v-model:open="applyDialogOpen">
              <DialogTrigger as-child>
                <Button :disabled="!preview.applyable || applying">
                  <CheckCheck class="size-4" />
                  确认应用（{{ preview.entries.length }} 项）
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>确认应用这一批年度增量？</DialogTitle>
                  <DialogDescription>
                    将写入 {{ preview.totals.add }} 项新增、{{ preview.totals.update }} 项更新、
                    归并 {{ preview.totals.merge }} 行；总表里
                    {{ preview.roster.counts.removed + preview.roster.counts.blocked }} 家将移出当前总表
                    <template v-if="preview.roster.counts.blocked">
                      （其中 {{ preview.roster.counts.blocked }} 家的重查失败了：它们照样会移出，但原因不会被写下来）
                    </template>。
                    写入是单批事务：有任何一项不合法则整批不落任何业务数据。
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose as-child>
                    <Button variant="outline">再想想</Button>
                  </DialogClose>
                  <Button :disabled="applying" @click="apply">{{ applying ? '应用中…' : '确认应用' }}</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
          <Alert v-if="applyError" variant="destructive">
            <TriangleAlert />
            <AlertTitle>应用失败</AlertTitle>
            <AlertDescription>{{ applyError }}</AlertDescription>
          </Alert>
          <div v-if="applyResults.length" class="flex flex-col gap-2" data-testid="annual-apply-results">
            <div v-for="result in applyResults" :key="result.batchId" class="flex flex-col gap-1 rounded-md border px-3 py-2">
              <div class="flex flex-wrap items-center gap-2 text-xs">
                <Badge :variant="result.status === 'committed' ? 'secondary' : 'destructive'">
                  {{ label(IMPORT_BATCH_STATUSES, result.status) }}
                </Badge>
                <span class="font-mono">#{{ result.batchId }}</span>
                <span class="min-w-0 truncate">{{ result.sourceIdentity }}</span>
                <span v-if="result.summary" class="text-muted-foreground tabular-nums">
                  写入 {{ result.summary.written }} · 跳过 {{ result.summary.skipped }} · 失败 {{ result.summary.failed }} ·
                  收敛出处 {{ result.summary.evidenceRepointed }}
                </span>
                <span v-if="result.error" class="text-destructive">{{ result.error }}</span>
              </div>
              <!-- 失败项逐条列出来(可追溯 / 可重试):只列不通过的,通过的在摘要里数过了。 -->
              <ul v-if="result.items.some((item) => !item.ok)" class="flex flex-col gap-0.5 text-[11px]">
                <li v-for="item in result.items.filter((row) => !row.ok)" :key="item.ref" class="text-destructive font-mono">
                  {{ item.ref }} · {{ item.error?.code }}：{{ item.error?.message }}
                </li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </template>

    <!-- 3. 批次流水(可追溯 / 可重试)------------------------------------- -->
    <Card class="rise-in gap-0 overflow-hidden py-0" style="--rise-index: 5">
      <CardHeader class="gap-1">
        <CardTitle class="flex items-center gap-2 text-base">
          <GitMerge class="size-4" />
          批次流水
        </CardTitle>
        <CardDescription>
          最近 20 条导入批次（幂等键 / 来源 / 状态 / 摘要）。失败批次的逐项错误就在下面 ——
          失败批次<strong class="text-foreground font-medium">一行业务数据都没落</strong>，按同一条幂等键 + 修好的载荷重试即可，不会写第二遍。
        </CardDescription>
      </CardHeader>
      <CardContent class="p-0">
        <div v-if="batchesQuery.isLoading.value && !batches.length" class="flex flex-col gap-2 p-5">
          <Skeleton class="h-5 w-72" />
          <Skeleton class="h-5 w-96" />
        </div>
        <p v-else-if="!batches.length" class="text-muted-foreground px-5 pb-5 text-xs">还没有任何导入批次。</p>
        <div v-else class="min-w-0 overflow-auto border-t">
          <Table class="min-w-[880px]">
            <TableHeader>
              <TableRow>
                <TableHead :class="TH_CLASS" class="w-16">批次</TableHead>
                <TableHead :class="TH_CLASS" class="w-24">状态</TableHead>
                <TableHead :class="TH_CLASS" class="w-28">来源类别</TableHead>
                <TableHead :class="TH_CLASS">来源身份 / 幂等键</TableHead>
                <TableHead :class="TH_CLASS" class="w-56">摘要</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="batch in batches" :key="batch.batchId" class="[&>td]:py-1.5">
                <TableCell class="text-muted-foreground tabular-nums">#{{ batch.batchId }}</TableCell>
                <TableCell>
                  <Badge :variant="batch.status === 'committed' ? 'secondary' : batch.status === 'failed' ? 'destructive' : 'quiet'">
                    {{ label(IMPORT_BATCH_STATUSES, batch.status) }}
                  </Badge>
                </TableCell>
                <TableCell class="text-xs">{{ label(IMPORT_SOURCE_KINDS, batch.sourceKind) }}</TableCell>
                <TableCell class="min-w-0">
                  <span class="block truncate text-xs">{{ batch.sourceIdentity }}</span>
                  <span class="text-muted-foreground block truncate font-mono text-[11px]">{{ batch.idempotencyKey }}</span>
                  <span v-if="batch.error" class="text-destructive block text-[11px]">{{ batch.error }}</span>
                </TableCell>
                <TableCell class="text-muted-foreground text-xs tabular-nums">
                  <template v-if="batch.summary">
                    写入 {{ batch.summary.written }} · 跳过 {{ batch.summary.skipped }} · 失败 {{ batch.summary.failed }} ·
                    收敛出处 {{ batch.summary.evidenceRepointed }}
                  </template>
                  <template v-else>未提交（预检批）</template>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <p v-if="failedBatches.length" class="text-destructive flex items-center gap-1.5 px-5 py-3 text-xs">
          <ArrowRightLeft class="size-3.5" />
          有 {{ failedBatches.length }} 条失败批次可重试。
        </p>
      </CardContent>
    </Card>
  </div>
</template>
