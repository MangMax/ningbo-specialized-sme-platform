<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import { watchDebounced } from '@vueuse/core'
import { ChevronLeft, ChevronRight, ExternalLink, LayoutList, Search } from '@lucide/vue'
import {
  COMPARISON_LABELS,
  DIFFERENCE_MEASURES,
  DIFFERENCE_REASONS,
  DIFFERENCE_REASON_ORDER,
  DIFFERENCE_STATUSES,
  DIFFERENCE_STATUS_ORDER,
  TITLES,
  TITLE_ORDER,
  TITLE_SHORT,
} from '~~/lib/labels'
import type { ComparisonDirection } from '~~/lib/comparison'
import { NINGBO_DISTRICTS, NINGBO_INDEPENDENT_ZONES } from '~~/lib/domain'
import FilterChip from '@/components/FilterChip.vue'
import MultiSelectFilter from '@/components/MultiSelectFilter.vue'
import RosterEnterprisePanel from '@/components/RosterEnterprisePanel.vue'
import TitleBadge from '@/components/TitleBadge.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

/**
 * **企业总表**(RL-04;契约 §7.1 / §7.3)。
 *
 * 两个标签页:
 *  - 企业总表 —— **一家企业一行**(跨称号去重),展开看该企业的全部称号、批次、
 *    认定/复核事件、正式出处、差异解释与平台关联;
 *  - 差异与原因 —— 每 (企业 × 称号 × 方向) 一条**当前**解释,两个方向都能筛,
 *    原因与措施成对显示,迁入缺项显示**待补证**。
 *
 * ── 总数口径(页面上必须说清)────────────────────────────────────────────
 * `total` 是**企业数**;`titlePairs` 是**企业 × 称号**数。多称号企业在总数里只算一家,
 * 但在每个称号桶里各计一次。导出(`/api/roster/export`)与这里**同一套筛选、同一段读模型**,
 * 所以两者口径必然一致 —— 这也是页面上敢直接写「企业与导出同口径」的原因。
 */

interface Counts {
  total: number
  titlePairs: number
  titles: Record<string, number>
}
interface EnterpriseRow {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  city: string | null
  regStatus: string | null
  rosterState: 'current' | 'removed_platform_only'
  titles: string[]
  aliasNames: string[]
  firstRecognition: { titleCode: string; year: number; needsReview: boolean }[]
  nextReviewYear: number | null
  anchorNeedsReview: boolean
}
interface DifferenceRow {
  explanationId: number | null
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  direction: ComparisonDirection
  status: string
  reasonCode: string | null
  reasonNote: string | null
  measureCode: string | null
  measureNote: string | null
  movedIn: { city: string | null; titleCode: string | null; year: number | null; batch: number | null; complete: boolean } | null
  verificationStatus: string
  recordedAt: string | null
  inCurrentDifference: boolean
  evidence: { queryId: number; queriedAt: string; interface: string; status: string; relationIds: number[] } | null
}

const apiGet = $fetch as unknown as <T>(url: string, opts?: { query?: Record<string, unknown> }) => Promise<T>

const tab = shallowRef<'enterprises' | 'differences'>('enterprises')
const title = shallowRef<string[]>([])
const district = shallowRef('')
const rosterState = shallowRef('')
const search = shallowRef('')
const q = shallowRef('')
const page = shallowRef(1)
const pageSize = 25
const expanded = shallowRef<number | null>(null)

const direction = shallowRef<ComparisonDirection | ''>('')
const status = shallowRef<string[]>([])
const reason = shallowRef<string[]>([])

watchDebounced(
  search,
  (v) => {
    q.value = v.trim()
    page.value = 1
  },
  { debounce: 300 },
)
watch([title, district, rosterState], () => {
  page.value = 1
})
watch([direction, status, reason], () => {
  page.value = 1
})

const baseQuery = computed<Record<string, unknown>>(() => {
  const out: Record<string, unknown> = {}
  if (title.value.length) out.title = title.value.join(',')
  if (district.value) out.district = district.value
  if (rosterState.value) out.rosterState = rosterState.value
  if (q.value) out.q = q.value
  return out
})

const enterpriseParams = computed(() => ({ ...baseQuery.value, page: page.value, pageSize }))
const differenceParams = computed(() => {
  const out: Record<string, unknown> = {}
  if (title.value.length) out.title = title.value.join(',')
  if (direction.value) out.direction = direction.value
  if (status.value.length) out.status = status.value.join(',')
  if (reason.value.length) out.reason = reason.value.join(',')
  out.page = page.value
  out.pageSize = pageSize
  return out
})

const { data: enterprises, isLoading: loadingEnterprises, error: enterprisesError, refetch: refetchEnterprises } =
  useQuery({
    key: () => ['roster-enterprises', enterpriseParams.value],
    query: () =>
      apiGet<{ rows: EnterpriseRow[]; counts: Counts; page: number; pageSize: number }>(
        '/api/roster/enterprises',
        { query: enterpriseParams.value },
      ),
    placeholderData: (previous) => previous,
  })

const { data: differences, isLoading: loadingDifferences, error: differencesError, refetch: refetchDifferences } =
  useQuery({
    key: () => ['roster-differences', differenceParams.value],
    query: () =>
      apiGet<{
        rows: DifferenceRow[]
        counts: Record<string, Record<ComparisonDirection, number>>
        total: number
        page: number
        pageSize: number
      }>('/api/roster/differences', { query: differenceParams.value }),
    placeholderData: (previous) => previous,
  })

const enterpriseRows = computed(() => enterprises.value?.rows ?? [])
const counts = computed<Counts>(() => enterprises.value?.counts ?? { total: 0, titlePairs: 0, titles: {} })
const differenceRows = computed(() => differences.value?.rows ?? [])

const total = computed(() =>
  tab.value === 'enterprises' ? counts.value.total : (differences.value?.total ?? 0),
)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
watch(totalPages, (max) => {
  if (page.value > max) page.value = max
})

const titleOptions = computed(() =>
  TITLE_ORDER.map((code) => ({ value: code, label: TITLES[code] ?? code, short: TITLE_SHORT[code] })),
)
const districtOptions = [...NINGBO_DISTRICTS, ...NINGBO_INDEPENDENT_ZONES]
const statusOptions = DIFFERENCE_STATUS_ORDER.map((code) => ({
  value: code,
  label: DIFFERENCE_STATUSES[code] ?? code,
}))
const reasonOptions = DIFFERENCE_REASON_ORDER.map((code) => ({
  value: code,
  label: DIFFERENCE_REASONS[code] ?? code,
}))

interface ActiveFilter {
  key: string
  label: string
  clear: () => void
}
const activeFilters = computed<ActiveFilter[]>(() => [
  ...title.value.map((code) => ({
    key: `title:${code}`,
    label: `称号 · ${TITLES[code] ?? code}`,
    clear: () => (title.value = title.value.filter((x) => x !== code)),
  })),
  ...(district.value
    ? [{ key: 'district', label: `属地 · ${district.value}`, clear: () => (district.value = '') }]
    : []),
  ...(rosterState.value
    ? [
        {
          key: 'rosterState',
          label: `总表状态 · ${rosterState.value === 'current' ? '当前总表' : '仅平台引入(已移除)'}`,
          clear: () => (rosterState.value = ''),
        },
      ]
    : []),
  ...(q.value
    ? [
        {
          key: 'q',
          label: `搜索 · ${q.value}`,
          clear: () => {
            search.value = ''
            q.value = ''
          },
        },
      ]
    : []),
  ...(direction.value
    ? [
        {
          key: 'direction',
          label: `方向 · ${COMPARISON_LABELS[direction.value]}`,
          clear: () => (direction.value = ''),
        },
      ]
    : []),
  ...status.value.map((code) => ({
    key: `status:${code}`,
    label: `状态 · ${DIFFERENCE_STATUSES[code] ?? code}`,
    clear: () => (status.value = status.value.filter((x) => x !== code)),
  })),
  ...reason.value.map((code) => ({
    key: `reason:${code}`,
    label: `原因 · ${DIFFERENCE_REASONS[code] ?? code}`,
    clear: () => (reason.value = reason.value.filter((x) => x !== code)),
  })),
])

function clearFilters() {
  title.value = []
  district.value = ''
  rosterState.value = ''
  search.value = ''
  q.value = ''
  direction.value = ''
  status.value = []
  reason.value = []
}

/** 导出与筛选同源:同一个 `baseQuery`(由读接口的同一套解析读懂)。 */
const exportUrl = computed(() => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(baseQuery.value)) p.set(k, String(v))
  const s = p.toString()
  return s ? `/api/roster/export?${s}` : '/api/roster/export'
})

function toggle(id: number) {
  expanded.value = expanded.value === id ? null : id
}
/** 差异状态徽章:已确认实色,未查/失败/待核描边或红 —— 「确定」与「还没确定」分得开。 */
function statusVariant(code: string) {
  if (code === 'confirmed_reason' || code === 'confirmed_no_diff') return 'secondary' as const
  if (code === 'needs_review' || code === 'query_failed') return 'destructive' as const
  return 'outline' as const
}
const movedInText = (m: DifferenceRow['movedIn']) =>
  m == null
    ? ''
    : [
        m.city,
        m.titleCode ? (TITLES[m.titleCode] ?? m.titleCode) : null,
        m.year == null ? null : String(m.year),
        m.batch == null ? null : `第${m.batch}批`,
      ]
        .filter(Boolean)
        .join(' · ')
const TH_CLASS = 'bg-muted text-muted-foreground sticky top-0 z-20 h-9 text-xs font-medium'
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <PageHeader class="rise-in" title="企业总表">
      <template #breadcrumb>
        <span>名录</span>
        <span class="mx-1.5">/</span>
        <span>企业总表</span>
      </template>
      <template #description>
        <span class="inline-block">跨称号去重:<strong>一家企业一行</strong>,称号与事件在展开里一条不折叠。</span>
        <span class="inline-block">公布文件是唯一权威来源,平台只作对照。</span>
      </template>
      <template #actions>
        <Button as-child variant="outline" size="sm">
          <a :href="exportUrl"><ExternalLink class="size-3.5" />导出当前筛选</a>
        </Button>
      </template>
    </PageHeader>

    <Tabs v-model="tab" class="min-w-0 gap-4">
      <TabsList aria-label="名录视图">
        <TabsTrigger value="enterprises">企业总表</TabsTrigger>
        <TabsTrigger value="differences">差异与原因</TabsTrigger>
      </TabsList>

      <!-- 筛选条:两个标签页共用(称号/属地/总表状态/搜索对两者都有意义)。 -->
      <div class="flex flex-wrap items-center gap-2">
        <div class="relative">
          <Search class="text-muted-foreground pointer-events-none absolute top-2 left-2 size-3.5" />
          <Input
            v-model="search"
            class="h-8 w-56 pl-7 text-sm"
            placeholder="企业名 / 曾用名"
            aria-label="搜索企业名称或已确认曾用名"
          />
        </div>
        <MultiSelectFilter
          v-model="title"
          :options="titleOptions"
          placeholder="全部称号"
          summary-prefix="称号"
        />
        <select
          v-model="district"
          class="border-input bg-background h-8 rounded-md border px-2 text-sm"
          aria-label="按属地筛选"
        >
          <option value="">全部属地</option>
          <option v-for="d in districtOptions" :key="d" :value="d">{{ d }}</option>
        </select>
        <select
          v-model="rosterState"
          class="border-input bg-background h-8 rounded-md border px-2 text-sm"
          aria-label="按总表状态筛选"
        >
          <option value="">全部总表状态</option>
          <option value="current">当前总表</option>
          <option value="removed_platform_only">仅平台引入(已从当前总表移除)</option>
        </select>

        <template v-if="tab === 'differences'">
          <select
            v-model="direction"
            class="border-input bg-background h-8 rounded-md border px-2 text-sm"
            aria-label="按差异方向筛选"
          >
            <option value="">两个方向</option>
            <option value="missing_in_miit">{{ COMPARISON_LABELS.missing_in_miit }}(公布有而平台无)</option>
            <option value="extra_in_miit">{{ COMPARISON_LABELS.extra_in_miit }}(平台有而公布无)</option>
          </select>
          <MultiSelectFilter v-model="status" :options="statusOptions" placeholder="全部状态" summary-prefix="状态" />
          <MultiSelectFilter v-model="reason" :options="reasonOptions" placeholder="全部原因" summary-prefix="原因" />
        </template>
      </div>

      <div v-if="activeFilters.length" class="flex flex-wrap items-center gap-1.5" data-testid="active-filters">
        <FilterChip
          v-for="f in activeFilters"
          :key="f.key"
          :label="f.label"
          @remove="f.clear()"
        />
        <Button variant="ghost" size="sm" class="h-6 px-1.5 text-xs" @click="clearFilters">全部清除</Button>
      </div>

      <!-- ── 企业总表 ────────────────────────────────────────────────────── -->
      <TabsContent value="enterprises" class="flex min-w-0 flex-col gap-3">
        <p class="text-muted-foreground text-[13px] tabular-nums" aria-live="polite" data-testid="roster-counts">
          共 <span class="text-foreground font-medium">{{ counts.total }}</span> <strong>家企业</strong>
          · 合计 <span class="text-foreground font-medium">{{ counts.titlePairs }}</span> 个
          <strong>企业 × 称号</strong>(多称号企业在企业数里只算一家,在每个称号里各计一次;导出与本页同筛选同口径)
          <template v-if="title.length">
            · 本页称号桶:
            <span v-for="code in title" :key="code" class="mr-2">
              {{ TITLES[code] ?? code }} {{ counts.titles[code] ?? 0 }} 家
            </span>
          </template>
        </p>

        <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span v-for="code in TITLE_ORDER" :key="code" class="text-muted-foreground tabular-nums">
            {{ TITLES[code] }} <span class="text-foreground font-medium">{{ counts.titles[code] ?? 0 }}</span> 家
          </span>
        </div>

        <div
          v-if="rosterState === 'removed_platform_only'"
          class="border-destructive/40 bg-destructive/5 rounded-sm border px-3 py-2 text-xs"
        >
          这些企业**仅由平台导出引入、从未出现在任何公布名单**,且已不在最新快照里 ——
          从当前总表移除,但企业行与全部公布历史**仍然保留**(官方历史不因平台快照变化被删)。
        </div>

        <Alert v-if="enterprisesError" variant="destructive">
          <AlertTitle>企业总表加载失败</AlertTitle>
          <AlertDescription
            ><Button variant="outline" size="sm" @click="refetchEnterprises()">重试</Button></AlertDescription
          >
        </Alert>

        <Card class="min-w-0 gap-0 overflow-hidden py-0">
          <CardContent class="p-0">
            <div class="max-h-[max(360px,calc(100dvh-26rem))] overflow-auto">
              <Empty v-if="!loadingEnterprises && !enterprisesError && !enterpriseRows.length">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><LayoutList /></EmptyMedia>
                  <EmptyTitle>没有匹配的企业</EmptyTitle>
                  <EmptyDescription>当前筛选下没有企业。可放宽称号或属地条件再试。</EmptyDescription>
                </EmptyHeader>
              </Empty>
              <Table v-else class="min-w-[1100px]">
                <TableHeader>
                  <TableRow class="hover:bg-transparent">
                    <TableHead :class="[TH_CLASS, 'w-[30%]']">企业名称</TableHead>
                    <TableHead :class="[TH_CLASS, 'w-44']">统一社会信用代码</TableHead>
                    <TableHead :class="[TH_CLASS, 'w-20']">属地</TableHead>
                    <TableHead :class="[TH_CLASS, 'w-56']">称号</TableHead>
                    <TableHead :class="[TH_CLASS, 'w-48']">首次认定 / 下次复核</TableHead>
                    <TableHead :class="[TH_CLASS, 'w-32']">总表状态</TableHead>
                    <TableHead :class="[TH_CLASS, 'w-20']" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <template v-if="loadingEnterprises && !enterpriseRows.length">
                    <TableRow v-for="i in 8" :key="i" class="h-11">
                      <TableCell v-for="j in 7" :key="j"><Skeleton class="h-4 w-full" /></TableCell>
                    </TableRow>
                  </template>
                  <template v-for="row in enterpriseRows" v-else :key="row.enterpriseId">
                    <TableRow class="h-11 [&>td]:py-1.5">
                      <TableCell class="font-medium">
                        <button
                          type="button"
                          class="hover:text-primary truncate text-left hover:underline"
                          :title="row.name"
                          @click="toggle(row.enterpriseId)"
                        >
                          {{ row.name }}
                        </button>
                        <div v-if="row.aliasNames.length" class="mt-1 flex flex-wrap gap-1">
                          <Badge
                            v-for="alias in row.aliasNames"
                            :key="alias"
                            variant="quiet"
                            class="font-normal"
                          >
                            曾用名 {{ alias }}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell class="text-muted-foreground font-mono text-xs">{{ row.uscc ?? '—' }}</TableCell>
                      <TableCell class="text-muted-foreground text-xs">{{ row.district ?? '—' }}</TableCell>
                      <TableCell>
                        <div class="flex flex-wrap gap-1">
                          <TitleBadge v-for="code in row.titles" :key="code" :code="code" />
                        </div>
                      </TableCell>
                      <TableCell class="text-muted-foreground text-xs">
                        <div v-if="row.firstRecognition.length">
                          首次
                          <span v-for="f in row.firstRecognition" :key="f.titleCode" class="mr-1.5">
                            {{ TITLES[f.titleCode] }} {{ f.year }}<template v-if="f.needsReview">(待核)</template>
                          </span>
                        </div>
                        <div v-else class="text-muted-foreground">首次认定 —</div>
                        <div>
                          下次复核
                          <template v-if="row.nextReviewYear == null">—</template>
                          <template v-else>
                            {{ row.nextReviewYear }}<template v-if="row.anchorNeedsReview">(待核)</template>
                          </template>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge :variant="row.rosterState === 'current' ? 'secondary' : 'destructive'" class="font-normal">
                          {{ row.rosterState === 'current' ? '当前总表' : '仅平台引入' }}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="h-7 px-1.5 text-xs"
                          :aria-expanded="expanded === row.enterpriseId"
                          @click="toggle(row.enterpriseId)"
                        >
                          {{ expanded === row.enterpriseId ? '收起' : '展开' }}
                        </Button>
                      </TableCell>
                    </TableRow>
                    <TableRow v-if="expanded === row.enterpriseId" class="hover:bg-transparent">
                      <TableCell :colspan="7" class="p-0">
                        <RosterEnterprisePanel :enterprise-id="row.enterpriseId" />
                      </TableCell>
                    </TableRow>
                  </template>
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      <!-- ── 差异与原因 ──────────────────────────────────────────────────── -->
      <TabsContent value="differences" class="flex min-w-0 flex-col gap-3">
        <p class="text-muted-foreground text-[13px] leading-relaxed" aria-live="polite">
          一行 = 一个 <strong>企业 × 称号 × 方向</strong>的<strong>当前</strong>解释(时态化:旧解释不丢,只是不再列在这里)。
          状态只从已存下的解释记录取;没有解释记录的显示状态机的「未查询」,并用「无解释记录」标出。
        </p>
        <p class="text-muted-foreground text-[13px] tabular-nums">
          本筛选下 <span class="text-foreground font-medium">{{ differences?.total ?? 0 }}</span> 项差异
          <template v-for="code in TITLE_ORDER" :key="code">
            <span class="ml-3">
              {{ TITLES[code] }}:公布有而平台无 {{ differences?.counts[code]?.missing_in_miit ?? 0 }} ·
              平台有而公布无 {{ differences?.counts[code]?.extra_in_miit ?? 0 }}
            </span>
          </template>
        </p>

        <Alert v-if="differencesError" variant="destructive">
          <AlertTitle>差异数据加载失败</AlertTitle>
          <AlertDescription
            ><Button variant="outline" size="sm" @click="refetchDifferences()">重试</Button></AlertDescription
          >
        </Alert>

        <Card class="min-w-0 gap-0 overflow-hidden py-0">
          <CardContent class="p-0">
            <div class="max-h-[max(360px,calc(100dvh-26rem))] overflow-auto">
              <Empty v-if="!loadingDifferences && !differencesError && !differenceRows.length">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><LayoutList /></EmptyMedia>
                  <EmptyTitle>没有匹配的差异</EmptyTitle>
                  <EmptyDescription>当前筛选下没有差异项。两个方向与六种状态都可单独筛。</EmptyDescription>
                </EmptyHeader>
              </Empty>
              <Table v-else class="min-w-[1200px]">
                <TableHeader>
                  <TableRow class="hover:bg-transparent">
                    <TableHead :class="[TH_CLASS, 'w-[22%]']">企业名称</TableHead>
                    <TableHead :class="[TH_CLASS, 'w-48']">称号</TableHead>
                    <TableHead :class="[TH_CLASS, 'w-40']">方向</TableHead>
                    <TableHead :class="[TH_CLASS, 'w-28']">状态</TableHead>
                    <TableHead :class="[TH_CLASS, 'w-52']">原因</TableHead>
                    <TableHead :class="[TH_CLASS, 'w-56']">后续措施</TableHead>
                    <TableHead :class="[TH_CLASS, 'w-56']">迁入来源</TableHead>
                    <TableHead :class="[TH_CLASS, 'w-64']">接口证据</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <template v-if="loadingDifferences && !differenceRows.length">
                    <TableRow v-for="i in 8" :key="i" class="h-11">
                      <TableCell v-for="j in 8" :key="j"><Skeleton class="h-4 w-full" /></TableCell>
                    </TableRow>
                  </template>
                  <TableRow
                    v-for="row in differenceRows"
                    v-else
                    :key="`${row.enterpriseId}-${row.titleCode}-${row.direction}`"
                    class="h-11 [&>td]:py-1.5 align-top"
                  >
                    <TableCell class="font-medium">
                      <span :title="row.name">{{ row.name }}</span>
                      <div v-if="!row.inCurrentDifference" class="mt-1">
                        <Badge variant="outline" class="font-normal">当前已不是差异(解释留档)</Badge>
                      </div>
                    </TableCell>
                    <TableCell><TitleBadge :code="row.titleCode" /></TableCell>
                    <TableCell class="text-xs">{{ COMPARISON_LABELS[row.direction] }}</TableCell>
                    <TableCell>
                      <Badge :variant="statusVariant(row.status)" class="font-normal">
                        {{ DIFFERENCE_STATUSES[row.status] ?? row.status }}
                      </Badge>
                    </TableCell>
                    <TableCell class="text-xs">
                      <template v-if="row.reasonCode || row.reasonNote">
                        {{ DIFFERENCE_REASONS[row.reasonCode ?? 'other'] ?? row.reasonCode }}
                        <span v-if="row.reasonNote" class="text-muted-foreground">— {{ row.reasonNote }}</span>
                      </template>
                      <span v-else-if="row.explanationId == null" class="text-muted-foreground">无解释记录</span>
                      <span v-else class="text-muted-foreground">—</span>
                    </TableCell>
                    <TableCell class="text-xs">
                      <template v-if="row.measureCode">
                        {{ DIFFERENCE_MEASURES[row.measureCode] ?? row.measureCode }}
                        <span v-if="row.measureNote" class="text-muted-foreground">— {{ row.measureNote }}</span>
                      </template>
                      <span v-else class="text-muted-foreground">—</span>
                    </TableCell>
                    <TableCell class="text-xs">
                      <template v-if="row.movedIn">
                        <template v-if="row.movedIn.complete">{{ movedInText(row.movedIn) }}</template>
                        <template v-else>
                          <span class="text-destructive">待补证</span>
                          <span class="text-muted-foreground">(已知:{{ movedInText(row.movedIn) || '无' }})</span>
                        </template>
                      </template>
                      <span v-else class="text-muted-foreground">—</span>
                    </TableCell>
                    <TableCell class="text-xs">
                      <template v-if="row.evidence">
                        {{ row.evidence.interface === 'business_list' ? '业务接口' : '申报接口' }} ·
                        {{ row.evidence.status === 'success' ? '查询成功' : row.evidence.status === 'failed' ? '查询失败' : row.evidence.status === 'no_record' ? '无记录' : '未查询' }} ·
                        {{ row.evidence.queriedAt.slice(0, 10) }} · 关系 {{ row.evidence.relationIds.length }} 条
                      </template>
                      <span v-else class="text-muted-foreground">—</span>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      <div class="flex items-center justify-between gap-2">
        <span class="text-muted-foreground text-xs tabular-nums">
          第 {{ page }} / {{ totalPages }} 页 · 每页 {{ pageSize }}
          {{ tab === 'enterprises' ? '家企业' : '项差异' }}
        </span>
        <div class="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            :disabled="page <= 1"
            aria-label="上一页"
            @click="page--"
            ><ChevronLeft />上一页</Button
          >
          <Button
            variant="outline"
            size="sm"
            :disabled="page >= totalPages"
            aria-label="下一页"
            @click="page++"
            >下一页<ChevronRight
          /></Button>
        </div>
      </div>
    </Tabs>
  </div>
</template>
