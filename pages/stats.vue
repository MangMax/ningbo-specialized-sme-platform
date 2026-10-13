<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed } from 'vue'
import { TITLES, TITLE_ORDER, TITLE_SHORT, SOURCES, SOURCE_ORDER, EVENTS, EVENT_ORDER } from '~~/lib/labels'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

interface Bucket {
  key: string
  n: number
}
interface Stats {
  totalRecords: number
  totalEnterprises: number
  byTitle: Bucket[]
  bySource: Bucket[]
  byEvent: Bucket[]
  byDistrict: Bucket[]
  byYear: Bucket[]
}

const apiGet = $fetch as unknown as <T>(url: string) => Promise<T>
const { data, isLoading } = useQuery({
  key: () => ['stats'],
  query: () => apiGet<Stats>('/api/stats'),
})

/**
 * 称号系列色 —— 与台账里的称号徽章同一族:由高到低「藏青 → 中蓝 → 钢灰」。
 * 徽章本身是实心/浅底/描边三种,环图上不能照搬,所以取同族的三个色阶,
 * 保证「小巨人最深」这个直觉在列表和图表里一致。
 */
const TITLE_COLORS: Record<string, string> = {
  little_giant: 'var(--chart-1)',
  specialized_sme: 'var(--chart-2)',
  innovative_sme: 'var(--chart-4)',
}
/** 来源色沿用表格里的方标语义:经信局藏青,工信部金。 */
const SOURCE_COLORS: Record<string, string> = {
  jxj: 'var(--chart-1)',
  miit: 'var(--chart-3)',
}

/** 按给定顺序排列,未知键置后并按计数降序。 */
function ordered(buckets: Bucket[] | undefined, order: string[]): Bucket[] {
  if (!buckets) return []
  const idx = (k: string) => {
    const i = order.indexOf(k)
    return i === -1 ? order.length : i
  }
  return [...buckets].sort((a, b) => idx(a.key) - idx(b.key) || b.n - a.n)
}

const titles = computed(() => ordered(data.value?.byTitle, TITLE_ORDER))
const sources = computed(() => ordered(data.value?.bySource, SOURCE_ORDER))
const events = computed(() => ordered(data.value?.byEvent, EVENT_ORDER))
/** 区县按计数降序,全部列出(不截断成 Top 20 —— 清单本来就该看得全)。 */
const districts = computed(() => [...(data.value?.byDistrict ?? [])].sort((a, b) => b.n - a.n))
const years = computed(() => data.value?.byYear ?? [])

const maxOf = (b: Bucket[]) => Math.max(1, ...b.map((x) => x.n))
const titleMax = computed(() => maxOf(titles.value))
const eventMax = computed(() => maxOf(events.value))
const districtMax = computed(() => maxOf(districts.value))

/** 称号环图:label 为展示文案,n 为计数,color 取称号色阶。 */
const titleRows = computed(() =>
  titles.value.map((b) => ({
    key: b.key,
    label: TITLES[b.key] ?? b.key,
    n: b.n,
    color: TITLE_COLORS[b.key] ?? 'var(--chart-4)',
  })),
)
/** 多系列图(称号环图)的图例:键与数据行一一对应。 */
const titleCats = computed(() =>
  Object.fromEntries(titleRows.value.map((r) => [r.key, { name: r.label, color: r.color }])),
)

/** 年份趋势:单系列折线,只取可下钻的四位年份。 */
const yearRows = computed(() =>
  years.value
    .filter((b) => /^\d{4}$/.test(b.key))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((b) => ({ key: b.key, label: b.key, n: b.n, color: 'var(--chart-1)' })),
)
const countCats = { n: { name: '记录数', color: 'var(--chart-1)' } }

/** 台账页的筛选链接,如 /?title=little_giant。 */
const drillTo = (param: string, value: string) => `/?${param}=${encodeURIComponent(value)}`

/** 户均记录数,保留一位小数。 */
const recordsPerEnterprise = computed(() => {
  const e = data.value?.totalEnterprises ?? 0
  if (!e) return '—'
  return ((data.value?.totalRecords ?? 0) / e).toFixed(2)
})

const kpis = computed(() => [
  {
    label: '记录总数',
    value: data.value?.totalRecords ?? 0,
    hint: '每条 = 企业 × 称号 × 来源',
  },
  {
    label: '企业总数',
    value: data.value?.totalEnterprises ?? 0,
    hint: `户均 ${recordsPerEnterprise.value} 条记录`,
  },
  {
    label: '专精特新“小巨人”',
    value: titles.value.find((t) => t.key === 'little_giant')?.n ?? 0,
    hint: '国家级,仅工信部名单',
  },
  {
    label: '覆盖区县',
    value: districts.value.length,
    hint: '含大榭、保税区等独立属地',
  },
])
</script>

<template>
  <div class="flex flex-col gap-5">
    <PageHeader
      title="统计概览"
      description="按记录计数,点任意一项跳到台账页的对应筛选。"
    />

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <template v-if="isLoading">
        <Skeleton v-for="i in 4" :key="i" class="h-[104px] rounded-lg" />
      </template>
      <StatTile
        v-for="(k, i) in kpis"
        v-else
        :key="k.label"
        :label="k.label"
        :value="k.value"
        :hint="k.hint"
        :index="i"
      />
    </div>

    <div class="grid gap-5 lg:grid-cols-2">
      <Card class="rise-in" style="--rise-index: 4">
        <CardHeader class="gap-1">
          <CardTitle class="text-base">称号梯度</CardTitle>
          <CardDescription>由高到低:小巨人 → 专精特新中小企业 → 创新型中小企业</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-1 flex-col gap-4">
          <DonutChart
            :data="titleRows"
            name-key="label"
            value-key="n"
            :categories="titleCats"
            :height="200"
            :loading="isLoading"
            hide-legend
            empty-label="暂无数据"
            aria-label="称号梯度分布"
          />
          <div class="mt-auto flex flex-wrap gap-1.5 border-t pt-4">
            <DrillChip
              v-for="r in titleRows"
              :key="r.key"
              :to="drillTo('title', r.key)"
              :label="TITLE_SHORT[r.key] ?? r.label"
              :value="r.n"
              :mark="r.color"
            />
            <span v-if="!isLoading && !titleRows.length" class="text-muted-foreground text-xs">
              暂无数据
            </span>
          </div>
        </CardContent>
      </Card>

      <Card class="rise-in" style="--rise-index: 5">
        <CardHeader class="gap-1">
          <CardTitle class="text-base">来源与事件构成</CardTitle>
          <CardDescription>两个来源并列记录;一条记录可含认定、复核等多个事件</CardDescription>
        </CardHeader>
        <CardContent class="grid flex-1 gap-x-8 gap-y-5 sm:grid-cols-2">
          <section class="flex flex-col gap-1">
            <h3 class="text-muted-foreground mb-1 text-xs font-medium">来源</h3>
            <BarRow
              v-for="b in sources"
              :key="b.key"
              :label="SOURCES[b.key] ?? b.key"
              :value="b.n"
              :max="maxOf(sources)"
              :color="SOURCE_COLORS[b.key] ?? 'var(--chart-1)'"
              :to="drillTo('source', b.key)"
            />
            <p class="text-muted-foreground mt-auto border-t pt-3 text-[13px] leading-relaxed">
              同一企业同一称号可能两个来源各一条记录,是并列来源不是重复。
            </p>
          </section>
          <section class="flex flex-col gap-1">
            <h3 class="text-muted-foreground mb-1 text-xs font-medium">事件</h3>
            <BarRow
              v-for="b in events"
              :key="b.key"
              :label="EVENTS[b.key] ?? b.key"
              :value="b.n"
              :max="eventMax"
              color="var(--chart-1)"
              :to="drillTo('eventType', b.key)"
            />
            <p class="text-muted-foreground mt-auto border-t pt-3 text-[13px] leading-relaxed">
              工信部名单只记「维护」,不分认定与复核;「入库培育」尚不构成称号。
            </p>
          </section>
        </CardContent>
      </Card>
    </div>

    <div class="grid gap-5 lg:grid-cols-2">
      <Card class="rise-in" style="--rise-index: 6">
        <CardHeader class="gap-1">
          <CardTitle class="text-base">区县分布</CardTitle>
          <CardDescription>按记录属地计数,共 {{ districts.length }} 个属地</CardDescription>
        </CardHeader>
        <CardContent>
          <div class="grid gap-x-8 gap-y-0.5 sm:grid-cols-2">
            <BarRow
              v-for="b in districts"
              :key="b.key"
              :label="b.key"
              :value="b.n"
              :max="districtMax"
              color="var(--chart-1)"
              :to="drillTo('district', b.key)"
            />
          </div>
          <p v-if="!isLoading && !districts.length" class="text-muted-foreground text-xs">
            暂无数据
          </p>
        </CardContent>
      </Card>

      <Card class="rise-in" style="--rise-index: 7">
        <CardHeader class="gap-1">
          <CardTitle class="text-base">年份趋势</CardTitle>
          <CardDescription>按记录事件的年份计数,缺失年份不计入</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-1 flex-col gap-4">
          <LineChart
            :data="yearRows"
            x-axis="label"
            :categories="countCats"
            :height="240"
            :loading="isLoading"
            dot-variant="default"
            hide-legend
            empty-label="暂无数据"
            aria-label="年份趋势"
          />
          <div class="mt-auto flex flex-wrap gap-1.5 border-t pt-4">
            <DrillChip
              v-for="r in yearRows"
              :key="r.key"
              :to="drillTo('year', r.key)"
              :label="r.label"
              :value="r.n"
            />
            <span v-if="!isLoading && !yearRows.length" class="text-muted-foreground text-xs">
              暂无数据
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
