<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed } from 'vue'
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

const apiGet = $fetch as unknown as <T>(url: string) => Promise<T>
const { data, isLoading } = useQuery({
  key: () => ['stats'],
  query: () => apiGet<Stats>('/api/stats'),
})

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

interface Section {
  title: string
  desc: string
  labels: Record<string, string>
  rows: Bucket[]
  /** 下钻到台账页时使用的 query 参数名;留空则该区块不下钻。 */
  param?: string
}
const sections = computed<Section[]>(() => [
  { title: '称号分布', desc: '按记录所属称号计数', labels: TITLES, rows: titles.value, param: 'title' },
  { title: '来源对比', desc: '经信局与工信部并列来源', labels: SOURCES, rows: sources.value, param: 'source' },
  { title: '事件类型分布', desc: '认定 / 复核 / 维护 / 入库培育', labels: EVENTS, rows: events.value, param: 'eventType' },
  { title: '区县 Top 20', desc: '按记录属地计数', labels: {}, rows: districts.value, param: 'district' },
])

const maxOf = (rows: Bucket[]) => Math.max(1, ...rows.map((r) => r.n))
const barWidth = (n: number, max: number) => `${Math.round((n / max) * 100)}%`

const maxYear = computed(() => maxOf(years.value))
const yearHeight = (n: number) => `${Math.max(3, Math.round((n / maxYear.value) * 120))}px`

/** 年份键为四位数字才可下钻;`—`(年份缺失)只展示不可点。 */
const isYear = (key: string) => /^\d{4}$/.test(key)

/** 台账页的筛选链接,如 /?title=little_giant;无 param 时回落到台账首页。 */
const drillTo = (param: string | undefined, value: string) =>
  param ? `/?${param}=${encodeURIComponent(value)}` : '/'
const labelOf = (labels: Record<string, string>, key: string) => labels[key] ?? key
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold">统计概览</h1>
      <p class="text-muted-foreground text-sm">点击数字或行可下钻到台账页查看对应记录</p>
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

    <div class="grid gap-6 lg:grid-cols-2">
      <Card v-for="s in sections" :key="s.title">
        <CardHeader class="gap-1">
          <CardTitle>{{ s.title }}</CardTitle>
          <CardDescription>{{ s.desc }}</CardDescription>
        </CardHeader>
        <CardContent class="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead class="pl-6">项目</TableHead>
                <TableHead class="pr-6">数量</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-if="isLoading">
                <TableCell :colspan="2" class="pl-6"><Skeleton class="h-4 w-full" /></TableCell>
              </TableRow>
              <TableRow
                v-for="row in s.rows"
                v-else
                :key="row.key"
                :class="s.param ? 'cursor-pointer' : ''"
                @click="s.param && navigateTo(drillTo(s.param, row.key))"
              >
                <TableCell class="pl-6 font-medium">
                  <NuxtLink
                    v-if="s.param"
                    :to="drillTo(s.param, row.key)"
                    class="hover:underline"
                    @click.stop
                  >
                    {{ labelOf(s.labels, row.key) }}
                  </NuxtLink>
                  <span v-else>{{ labelOf(s.labels, row.key) }}</span>
                </TableCell>
                <TableCell class="pr-6">
                  <div class="flex items-center gap-3">
                    <div class="bg-muted h-2 w-full max-w-56 overflow-hidden rounded-full">
                      <div
                        class="bg-primary h-full rounded-full"
                        :style="{ width: barWidth(row.n, maxOf(s.rows)) }"
                      />
                    </div>
                    <span class="text-muted-foreground w-14 text-right text-xs tabular-nums">
                      {{ row.n }}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
              <TableRow v-if="!isLoading && s.rows.length === 0">
                <TableCell :colspan="2" class="text-muted-foreground h-16 pl-6">暂无数据</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader class="gap-1">
        <CardTitle>年份趋势</CardTitle>
        <CardDescription>按记录事件年份计数(认定 / 复核 / 维护 / 入库培育)</CardDescription>
      </CardHeader>
      <CardContent>
        <Skeleton v-if="isLoading" class="h-40 w-full" />
        <div v-else-if="years.length === 0" class="text-muted-foreground h-40 text-sm">
          暂无数据
        </div>
        <div v-else class="flex h-40 items-end gap-1">
          <template v-for="y in years" :key="y.key">
            <NuxtLink
              v-if="isYear(y.key)"
              :to="drillTo('year', y.key)"
              class="hover:bg-muted/60 flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1 rounded-sm transition-colors"
              :title="`${y.key}: ${y.n} · 点击查看记录`"
            >
              <span class="text-muted-foreground text-[10px] tabular-nums">{{ y.n }}</span>
              <div class="bg-primary w-full max-w-10 rounded-t-sm" :style="{ height: yearHeight(y.n) }" />
              <span class="text-muted-foreground w-full truncate text-center text-[10px]">{{ y.key }}</span>
            </NuxtLink>
            <div
              v-else
              class="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1 rounded-sm"
              :title="`${y.key}: ${y.n}`"
            >
              <span class="text-muted-foreground text-[10px] tabular-nums">{{ y.n }}</span>
              <div class="bg-primary w-full max-w-10 rounded-t-sm" :style="{ height: yearHeight(y.n) }" />
              <span class="text-muted-foreground w-full truncate text-center text-[10px]">{{ y.key }}</span>
            </div>
          </template>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
