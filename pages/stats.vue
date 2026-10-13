<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed } from 'vue'
import { Orientation } from 'nuxt-charts/enums'
import { TITLES, TITLE_ORDER, SOURCES, SOURCE_ORDER, EVENTS, EVENT_ORDER } from '~~/lib/labels'

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

/** 图表行:label 为展示文案,n 为计数,color 为语义色 token(仅多系列图使用)。 */
interface ChartRow {
  key: string
  label: string
  n: number
  color: string
}

const apiGet = $fetch as unknown as <T>(url: string) => Promise<T>
const { data, isLoading } = useQuery({
  key: () => ['stats'],
  query: () => apiGet<Stats>('/api/stats'),
})

/**
 * 图表系列色 —— 一律取项目语义 token(明暗自适应),不写裸色值。
 * 页面为中性单色设计,故用主色到浅灰的梯度区分系列。
 */
const SERIES_COLORS = [
  'var(--primary)',
  'var(--muted-foreground)',
  'var(--ring)',
  'var(--secondary-foreground)',
  'var(--accent-foreground)',
] as const

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
const districts = computed(() => data.value?.byDistrict ?? [])
const years = computed(() => data.value?.byYear ?? [])

/** bucket → 图表行。 */
const toRows = (buckets: Bucket[], label: (key: string) => string): ChartRow[] =>
  buckets.map((b, i) => ({
    key: b.key,
    label: label(b.key),
    n: b.n,
    color: SERIES_COLORS[i % SERIES_COLORS.length]!,
  }))

const titleRows = computed(() => toRows(titles.value, (k) => TITLES[k] ?? k))
const sourceRows = computed(() => toRows(sources.value, (k) => SOURCES[k] ?? k))
const eventRows = computed(() => toRows(events.value, (k) => EVENTS[k] ?? k))
const districtRows = computed(() => toRows(districts.value, (k) => k))
const yearRows = computed(() => toRows(years.value, (k) => k))

/** 单系列计数图的图例项(值轴字段 n)。 */
const countCats = { n: { name: '记录数', color: 'var(--primary)' } }

/** 多系列图(称号环图)的图例:键与数据行一一对应,颜色按序取语义 token。 */
const titleCats = computed(() =>
  Object.fromEntries(titleRows.value.map((r) => [r.key, { name: r.label, color: r.color }])),
)

/** 柱上数值标签:取该柱的数值(entry.y)。 */
const countValueLabel = { label: (d: unknown) => Number((d as { y?: number }).y ?? 0) }

/** 横向柱图高度随条目数增长,避免标签挤压。 */
const districtHeight = computed(() => Math.min(640, Math.max(180, districtRows.value.length * 30 + 24)))

/** 台账页的筛选链接,如 /?title=little_giant。 */
const drillTo = (param: string, value: string) => `/?${param}=${encodeURIComponent(value)}`

/** 年份键为四位数字才可下钻;`—`(年份缺失)只展示不可点。 */
const isYear = (key: string) => /^\d{4}$/.test(key)
const clickableYears = computed(() => yearRows.value.filter((r) => isYear(r.key)))
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-semibold">统计概览</h1>
      <p class="text-muted-foreground text-sm">点击图表下方的标签可下钻到台账页查看对应记录</p>
    </div>

    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Skeleton v-if="isLoading" class="h-24 rounded-xl" />
      <NuxtLink v-else to="/" class="block focus-visible:outline-none">
        <Card class="hover:border-primary/50 transition-colors">
          <CardHeader class="gap-1">
            <CardDescription>记录总数</CardDescription>
            <CardTitle class="text-3xl tabular-nums">{{ data?.totalRecords ?? 0 }}</CardTitle>
          </CardHeader>
        </Card>
      </NuxtLink>
      <Skeleton v-if="isLoading" class="h-24 rounded-xl" />
      <Card v-else>
        <CardHeader class="gap-1">
          <CardDescription>企业总数</CardDescription>
          <CardTitle class="text-3xl tabular-nums">{{ data?.totalEnterprises ?? 0 }}</CardTitle>
        </CardHeader>
      </Card>
    </div>

    <div class="grid gap-6 lg:grid-cols-3">
      <Card>
        <CardHeader class="gap-1">
          <CardTitle>称号分布</CardTitle>
          <CardDescription>按记录所属称号计数</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-4">
          <DonutChart
            :data="titleRows"
            name-key="label"
            value-key="n"
            :categories="titleCats"
            :height="220"
            :loading="isLoading"
            hide-legend
            empty-label="暂无数据"
            aria-label="称号分布"
          />
          <div class="flex flex-wrap gap-2 border-t pt-4">
            <NuxtLink
              v-for="r in titleRows"
              :key="r.key"
              :to="drillTo('title', r.key)"
              class="focus-visible:outline-none"
            >
              <Badge
                variant="secondary"
                class="hover:bg-primary hover:text-primary-foreground cursor-pointer gap-1.5 transition-colors"
              >
                <span class="size-2 rounded-full" :style="{ backgroundColor: r.color }" />
                {{ r.label }} · {{ r.n }}
              </Badge>
            </NuxtLink>
            <span v-if="!isLoading && titleRows.length === 0" class="text-muted-foreground text-sm">
              暂无数据
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="gap-1">
          <CardTitle>来源对比</CardTitle>
          <CardDescription>经信局与工信部并列来源</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-4">
          <BarChart
            :data="sourceRows"
            x-axis="label"
            :y-axis="['n']"
            :categories="countCats"
            :height="220"
            :loading="isLoading"
            hide-legend
            empty-label="暂无数据"
            aria-label="来源对比"
          />
          <div class="flex flex-wrap gap-2 border-t pt-4">
            <NuxtLink
              v-for="r in sourceRows"
              :key="r.key"
              :to="drillTo('source', r.key)"
              class="focus-visible:outline-none"
            >
              <Badge
                variant="secondary"
                class="hover:bg-primary hover:text-primary-foreground cursor-pointer transition-colors"
              >
                {{ r.label }} · {{ r.n }}
              </Badge>
            </NuxtLink>
            <span v-if="!isLoading && sourceRows.length === 0" class="text-muted-foreground text-sm">
              暂无数据
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="gap-1">
          <CardTitle>事件类型分布</CardTitle>
          <CardDescription>认定 / 复核 / 维护 / 入库培育</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-4">
          <BarChart
            :data="eventRows"
            x-axis="label"
            :y-axis="['n']"
            :categories="countCats"
            :height="220"
            :loading="isLoading"
            hide-legend
            empty-label="暂无数据"
            aria-label="事件类型分布"
          />
          <div class="flex flex-wrap gap-2 border-t pt-4">
            <NuxtLink
              v-for="r in eventRows"
              :key="r.key"
              :to="drillTo('eventType', r.key)"
              class="focus-visible:outline-none"
            >
              <Badge
                variant="secondary"
                class="hover:bg-primary hover:text-primary-foreground cursor-pointer transition-colors"
              >
                {{ r.label }} · {{ r.n }}
              </Badge>
            </NuxtLink>
            <span v-if="!isLoading && eventRows.length === 0" class="text-muted-foreground text-sm">
              暂无数据
            </span>
          </div>
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader class="gap-1">
        <CardTitle>区县 Top 20</CardTitle>
        <CardDescription>按记录属地计数</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <BarChart
          :data="districtRows"
          x-axis="label"
          :y-axis="['n']"
          :categories="countCats"
          :orientation="Orientation.Horizontal"
          :height="districtHeight"
          :loading="isLoading"
          :value-label="countValueLabel"
          hide-legend
          empty-label="暂无数据"
          aria-label="区县 Top 20"
        />
        <div class="flex flex-wrap gap-2 border-t pt-4">
          <NuxtLink
            v-for="r in districtRows"
            :key="r.key"
            :to="drillTo('district', r.key)"
            class="focus-visible:outline-none"
          >
            <Badge
              variant="secondary"
              class="hover:bg-primary hover:text-primary-foreground cursor-pointer transition-colors"
            >
              {{ r.label }} · {{ r.n }}
            </Badge>
          </NuxtLink>
          <span v-if="!isLoading && districtRows.length === 0" class="text-muted-foreground text-sm">
            暂无数据
          </span>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader class="gap-1">
        <CardTitle>年份趋势</CardTitle>
        <CardDescription>按记录事件年份计数(认定 / 复核 / 维护 / 入库培育)</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <LineChart
          :data="yearRows"
          x-axis="label"
          :categories="countCats"
          :height="260"
          :loading="isLoading"
          dot-variant="default"
          hide-legend
          empty-label="暂无数据"
          aria-label="年份趋势"
        />
        <div class="flex flex-wrap gap-2 border-t pt-4">
          <NuxtLink
            v-for="r in clickableYears"
            :key="r.key"
            :to="drillTo('year', r.key)"
            class="focus-visible:outline-none"
          >
            <Badge
              variant="secondary"
              class="hover:bg-primary hover:text-primary-foreground cursor-pointer transition-colors"
            >
              {{ r.label }} · {{ r.n }}
            </Badge>
          </NuxtLink>
          <span v-if="!isLoading && clickableYears.length === 0" class="text-muted-foreground text-sm">
            暂无数据
          </span>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
