<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed, ref } from 'vue'
import { watchDebounced } from '@vueuse/core'

interface Rec {
  recordId: number
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  source: string
  events: { type: string; year: number | null; seq: number | null }[]
}

const TITLES: Record<string, string> = {
  little_giant: '小巨人',
  specialized_sme: '专精特新中小企业',
  innovative_sme: '创新型中小企业',
}
const EVENTS: Record<string, string> = {
  award: '认定',
  review: '复核',
  maintain: '维护',
  nurture: '入库培育',
}

const apiGet = $fetch as unknown as <T>(url: string, opts?: { query?: Record<string, unknown> }) => Promise<T>

interface Bucket {
  key: string
  n: number
}
interface Stats {
  byEvent: Bucket[]
  byYear: Bucket[]
}

/** 事件类型选项顺序,与 stats/index 展示一致。 */
const EVENT_ORDER = ['award', 'review', 'maintain', 'nurture']

const route = useRoute()
const queryStr = (v: unknown) => (typeof v === 'string' ? v : '')

// 导入快照(票 11):默认最新,选择后作为筛选参数传入 /api/records。
interface Batch {
  id: number
  label: string
  sourceRoot: string
  importedAt: string
  note: string | null
  recordCount: number
}
const { data: batches } = useQuery({
  key: ['batches'],
  query: () => apiGet<Batch[]>('/api/batches'),
})
const batch = ref(queryStr(route.query.batch) || 'latest') // 'latest' | 'all' | '<id>'
const effectiveBatch = computed<number | undefined>(() => {
  if (batch.value === 'all') return undefined
  if (batch.value === 'latest') return batches.value?.[0]?.id
  const n = Number(batch.value)
  return Number.isFinite(n) && n > 0 ? n : undefined
})

// 支持从外链带入初始筛选(统计页下钻、分享链接)。
const title = ref(queryStr(route.query.title) || 'all')
const source = ref(queryStr(route.query.source) || 'all')
const district = ref(queryStr(route.query.district))
const eventType = ref(queryStr(route.query.eventType) || 'all')
const year = ref(queryStr(route.query.year) || 'all')
const search = ref('')
const q = ref('')
watchDebounced(search, (v) => {
  q.value = v.trim()
  page.value = 1
}, { debounce: 300 })

// 事件类型 / 年份的可选项来自数据(统计端点),口径与统计页一致。
const { data: stats } = useQuery({
  key: () => ['stats'],
  query: () => apiGet<Stats>('/api/stats'),
})
const eventOptions = computed(() => {
  const present = new Set((stats.value?.byEvent ?? []).map((b) => b.key))
  const known = EVENT_ORDER.filter((k) => present.has(k))
  return known.length ? known : EVENT_ORDER
})
const yearOptions = computed(() =>
  (stats.value?.byYear ?? [])
    .map((b) => b.key)
    .filter((k) => /^\d{4}$/.test(k))
    .sort((a, b) => b.localeCompare(a)),
)

const page = ref(1)
const pageSize = 25

const resetPage = () => (page.value = 1)
const clearExtraFilters = () => {
  source.value = 'all'
  district.value = ''
  eventType.value = 'all'
  year.value = 'all'
  page.value = 1
}

const params = computed(() => ({
  title: title.value === 'all' ? undefined : title.value,
  source: source.value === 'all' ? undefined : source.value,
  district: district.value || undefined,
  eventType: eventType.value === 'all' ? undefined : eventType.value,
  year: year.value === 'all' ? undefined : year.value,
  q: q.value || undefined,
  batch: effectiveBatch.value,
  page: page.value,
  pageSize,
}))

const { data, isLoading } = useQuery({
  key: () => ['records', params.value],
  query: () => apiGet<{ rows: Rec[]; total: number }>('/api/records', { query: params.value }),
})

const totalPages = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / pageSize)))
const exportUrl = computed(() => {
  const p = new URLSearchParams()
  if (title.value !== 'all') p.set('title', title.value)
  if (source.value !== 'all') p.set('source', source.value)
  if (district.value) p.set('district', district.value)
  if (eventType.value !== 'all') p.set('eventType', eventType.value)
  if (year.value !== 'all') p.set('year', year.value)
  if (q.value) p.set('q', q.value)
  if (effectiveBatch.value) p.set('batch', String(effectiveBatch.value))
  return `/api/export?${p.toString()}`
})
function fmt(e: Rec['events'][number]) {
  return `${EVENTS[e.type] ?? e.type} ${e.year ? `${e.year}${e.seq ? '-' + e.seq : ''}` : '—'}`
}
</script>

<template>
  <div class="space-y-4">
    <div>
      <h1 class="text-xl font-semibold">记录台账</h1>
      <p class="text-muted-foreground text-sm">记录 = 企业 × 称号 × 来源 · 共 {{ data?.total ?? 0 }} 条</p>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <Select v-model="batch" @update:model-value="resetPage">
        <SelectTrigger class="w-56">
          <SelectValue placeholder="当前快照" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="latest">最新快照</SelectItem>
          <SelectItem value="all">全部快照</SelectItem>
          <SelectItem v-for="b in batches" :key="b.id" :value="String(b.id)">
            {{ b.label }} · {{ b.importedAt.slice(0, 10) }}({{ b.recordCount }} 条)
          </SelectItem>
        </SelectContent>
      </Select>

      <Select v-model="title" @update:model-value="resetPage">
        <SelectTrigger class="w-44">
          <SelectValue placeholder="全部称号" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部称号</SelectItem>
          <SelectItem value="little_giant">小巨人</SelectItem>
          <SelectItem value="specialized_sme">专精特新中小企业</SelectItem>
          <SelectItem value="innovative_sme">创新型中小企业</SelectItem>
        </SelectContent>
      </Select>

      <Select v-model="source" @update:model-value="resetPage">
        <SelectTrigger class="w-36">
          <SelectValue placeholder="全部来源" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部来源</SelectItem>
          <SelectItem value="jxj">经信局</SelectItem>
          <SelectItem value="miit">工信部</SelectItem>
        </SelectContent>
      </Select>

      <Select v-model="eventType" @update:model-value="resetPage">
        <SelectTrigger class="w-36">
          <SelectValue placeholder="全部事件" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部事件</SelectItem>
          <SelectItem v-for="k in eventOptions" :key="k" :value="k">
            {{ EVENTS[k] ?? k }}
          </SelectItem>
        </SelectContent>
      </Select>

      <Select v-model="year" @update:model-value="resetPage">
        <SelectTrigger class="w-32">
          <SelectValue placeholder="全部年份" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部年份</SelectItem>
          <SelectItem v-for="y in yearOptions" :key="y" :value="y">{{ y }}</SelectItem>
        </SelectContent>
      </Select>

      <Badge v-if="district" variant="secondary">区县:{{ district }}</Badge>
      <Button
        v-if="source !== 'all' || district || eventType !== 'all' || year !== 'all'"
        variant="ghost"
        size="sm"
        @click="clearExtraFilters"
      >
        清除筛选
      </Button>

      <Input v-model="search" placeholder="搜索企业名称或统一社会信用代码" class="w-72" />

      <Button as-child variant="outline" size="sm" class="ml-auto">
        <a :href="exportUrl">导出当前结果</a>
      </Button>
    </div>

    <Card>
      <CardContent class="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>企业名称</TableHead>
              <TableHead>统一社会信用代码</TableHead>
              <TableHead>区县</TableHead>
              <TableHead>称号</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>事件</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-if="isLoading">
              <TableCell :colspan="6"><Skeleton class="h-4 w-full" /></TableCell>
            </TableRow>
            <TableRow v-for="r in data?.rows" v-else :key="r.recordId">
              <TableCell class="font-medium">
                <NuxtLink :to="`/enterprises/${r.enterpriseId}`" class="hover:underline">{{ r.name }}</NuxtLink>
              </TableCell>
              <TableCell class="text-muted-foreground font-mono text-xs">{{ r.uscc ?? '—' }}</TableCell>
              <TableCell>{{ r.district ?? '—' }}</TableCell>
              <TableCell>{{ TITLES[r.titleCode] ?? r.titleCode }}</TableCell>
              <TableCell>
                <Badge :variant="r.source === 'jxj' ? 'secondary' : 'outline'">
                  {{ r.source === 'jxj' ? '经信局' : '工信部' }}
                </Badge>
              </TableCell>
              <TableCell class="space-x-1">
                <Badge v-for="(e, i) in r.events" :key="i" variant="outline">{{ fmt(e) }}</Badge>
              </TableCell>
            </TableRow>
            <TableRow v-if="!isLoading && data && data.rows.length === 0">
              <TableCell :colspan="6" class="text-muted-foreground h-24 text-center">没有匹配的记录</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <div class="flex items-center justify-between">
      <span class="text-muted-foreground text-sm">第 {{ page }} / {{ totalPages }} 页</span>
      <div class="flex gap-2">
        <Button variant="outline" size="sm" :disabled="page <= 1" @click="page--">上一页</Button>
        <Button variant="outline" size="sm" :disabled="page >= totalPages" @click="page++">下一页</Button>
      </div>
    </div>
  </div>
</template>
