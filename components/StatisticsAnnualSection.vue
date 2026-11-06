<script setup lang="ts">
import { motion, useReducedMotion } from 'motion-v'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
const reducedMotion = useReducedMotion()
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { AnnualStatistics } from '~~/lib/roster/annual-statistics'
import { TITLES, TITLE_ORDER } from '~~/lib/labels'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ArrowUpRight } from '@lucide/vue'
import { CurveType } from 'nuxt-charts/enums'
const year = ref('today'), title = ref('specialized_sme'), status = ref('effective'), page = ref(1), pageSize = ref(25)
const result = shallowRef<AnnualStatistics>()
const loading = ref(false), failed = ref(false)
const open = ref(false)
let sequence = 0
onBeforeUnmount(() => { sequence++ })
async function load() {
  const request = ++sequence
  loading.value = true; failed.value = false
  try {
    const next = await $fetch<AnnualStatistics>('/api/statistics/annual', { query: { year: year.value === 'today' ? undefined : year.value, title: title.value, status: status.value, page: page.value, pageSize: pageSize.value } })
    if (request === sequence) result.value = next
  } catch { if (request === sequence) failed.value = true }
  finally { if (request === sequence) loading.value = false }
}
watch([year, title, status], () => { page.value = 1 })
watch([year, title, status, page, pageSize], load, { immediate: true })
const target = computed(() => `${year.value === 'today' ? '本年' : year.value + '年'} · ${TITLES[title.value]} · ${status.value === 'effective' ? '有效' : '待核'} · 第 ${page.value} 页`)
const colors=['var(--chart-1)','var(--chart-2)','var(--chart-3)']
const hiddenTitles = ref<string[]>([])
const lines = computed(() => TITLE_ORDER.map((code, index) => ({ code, color: colors[index] })))
const chartData = computed<Array<{ year: number; [key: string]: number }>>(() => (result.value?.years ?? []).map(row => ({
  year: row.year,
  ...Object.fromEntries(row.titles.map(count => [count.titleCode, count.effective])),
})))
const categories = computed(() => Object.fromEntries(lines.value.map(line => [line.code, {
  name: TITLES[line.code] ?? line.code, color: line.color ?? colors[0]!, hidden: hiddenTitles.value.includes(line.code),
}])))
function toggleTitle(code: string) {
  if (hiddenTitles.value.includes(code)) hiddenTitles.value = hiddenTitles.value.filter(item => item !== code)
  else if (hiddenTitles.value.length < TITLE_ORDER.length - 1) hiddenTitles.value = [...hiddenTitles.value, code]
}
const formatYear = (index: number) => String(chartData.value[index]?.year ?? '')
const formatCount = (value: number) => value.toLocaleString('zh-CN')
const requestedYear = computed(() => year.value === 'today' ? Number(result.value?.evaluationDay.slice(0,4)) : Number(year.value))
const activeYear = computed({ get: () => String(requestedYear.value), set: value => { year.value = value } })
const switchingYear = computed(() => !failed.value && result.value?.year !== requestedYear.value)
const selectedYear=computed(()=>result.value?.years.find(row=>row.year===result.value?.year))
function select(selected:number,code:string,state:string){year.value=String(selected);title.value=code;status.value=state;page.value=1;open.value=true}
</script>
<template>
<section class="stats-chart-panel" aria-labelledby="annual-title" :aria-busy="loading">
  <header class="stats-panel-heading"><div><p class="stats-eyebrow">有效存量</p><h2 id="annual-title">各称号年度变化</h2></div></header>
  <div class="stats-chart-legend"><button v-for="line in lines" :key="line.code" type="button" :aria-pressed="!hiddenTitles.includes(line.code)" :aria-label="`${TITLES[line.code]}趋势线`" @click="toggleTitle(line.code)"><i :style="{background:line.color}" />{{ TITLES[line.code] }}</button></div>
  <Skeleton v-if="!result && loading" class="h-64 w-full" />
  <template v-if="result">
    <div class="stats-trend-canvas">
      <LineChart
        :data="chartData" :categories="categories" :height="250"
        :curve-type="CurveType.Linear" :line-width="2" dot-variant="default" :dot-size="3"
        :x-formatter="formatYear" :y-formatter="formatCount" :x-num-ticks="4" :y-num-ticks="5"
        :y-grid-line="true" :x-domain-line="false" :y-domain-line="false"
        :hide-legend="true" :hide-tooltip="false" :duration="0" :accessible-data-table="false"
        aria-label="各称号年度有效企业数趋势"
        aria-description="悬停查看年份与企业数，图例切换趋势线；下方年份按钮和数量按钮可查看企业明细。"
      >
        <template #tooltip="{ values }">
          <div v-if="values" class="stats-trend-tooltip">
            <strong>{{ values.year }}年{{ values.year===Number(result.evaluationDay.slice(0,4))?' · 截至评价日':' · 年末' }}</strong>
            <div v-for="line in lines.filter(item => !hiddenTitles.includes(item.code))" :key="line.code"><i :style="{background:line.color}" /><span>{{ TITLES[line.code] }}</span><b>{{ formatCount(values[line.code] ?? 0) }} 家</b></div>
          </div>
        </template>
      </LineChart>
    </div>
    <Tabs v-model="activeYear" class="gap-4">
      <TabsList class="stats-year-tabs" aria-label="选择统计年度"><TabsTrigger v-for="row in result.years" :key="row.year" :value="String(row.year)">{{ row.year }}<span v-if="row===result.years.at(-1)" class="text-[10px]">截至今日</span></TabsTrigger></TabsList>
      <TabsContent v-for="row in result.years" :key="row.year" :value="String(row.year)">
        <div v-if="switchingYear" role="status" :aria-label="`正在加载${requestedYear}年统计`">
          <span class="sr-only">正在加载{{ requestedYear }}年统计</span>
          <div class="stats-year-counts" aria-hidden="true"><div v-for="(code,i) in TITLE_ORDER" :key="code" class="stats-year-count"><span><i :style="{background:colors[i]}" />{{ TITLES[code] }}</span><Skeleton class="h-8 w-20 max-w-full" /><Skeleton class="h-4 w-14" /></div></div>
        </div>
        <motion.div v-else :initial="reducedMotion ? false : { opacity: 0, y: 4 }" :animate="{ opacity: 1, y: 0 }" :transition="{ duration: reducedMotion ? 0 : 0.18 }">
          <p v-if="result.year !== requestedYear" class="stats-source" role="status">当前查询失败，以下保留{{ result.year }}年的上次结果。</p>
    <div v-if="selectedYear" class="stats-year-counts">
      <div v-for="(count,i) in selectedYear.titles" :key="count.titleCode" class="stats-year-count"><span><i :style="{background:colors[i]}" />{{ TITLES[count.titleCode] }}</span><button :aria-label="`${selectedYear.year}年${TITLES[count.titleCode]}有效明细 ${count.effective}家`" @click="select(selectedYear.year,count.titleCode,'effective')"><strong><StatsAnimatedNumber :value="count.effective" /></strong><small>家</small><ArrowUpRight class="size-3" aria-hidden="true" /></button><button class="stats-small-link" :aria-label="`${selectedYear.year}年${TITLES[count.titleCode]}待核明细 ${count.pending}家`" @click="select(selectedYear.year,count.titleCode,'pending')">待核 <StatsAnimatedNumber :value="count.pending" /> 家</button></div>
    </div>
        </motion.div>
      </TabsContent>
    </Tabs>
  </template>
  <TableFailureState v-if="failed" :title="`${target}加载失败`" :compact="!!result" :pending="loading" :description="result ? `已保留${result.year}年的上次结果，请重试。` : '尚未加载年度数据，请重试。'" @retry="load" />
  <div class="stats-panel-foot"><span v-if="switchingYear">{{ requestedYear ? `${requestedYear}年` : '本年' }}统计加载中…</span><span v-else>{{ result?.year===Number(result?.evaluationDay.slice(0,4))?'本年截至评价日':'历史年末存量' }} · {{ selectedYear?.evaluationDay ?? '—' }}</span><DisclosurePanel title="统计口径" compact><p>按当前已录入证据重算，非当年系统归档；各称号独立统计。历史取上海年末，本年取评价日。迁入本身不授予称号，也不抵消现行规则中的迁出排除。未确定的历史状态单列待核。</p></DisclosurePanel></div>
  <StatsDetailSheet v-model:open="open" title="年度企业明细" :target="target" :source="result ? `${result.year}年 · ${TITLES[result.title??'']} · ${result.status==='effective'?'有效':'待核'} · 第${result.page}页` : undefined" :loading="loading" :failed="failed" @retry="load">
    <div class="grid gap-3 sm:grid-cols-3"><Select v-model="year"><SelectTrigger aria-label="年度"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="today">本年截至评价日</SelectItem><SelectItem v-for="row in result?.years" :key="row.year" :value="String(row.year)">{{ row.year }}年</SelectItem></SelectContent></Select><Select v-model="title"><SelectTrigger aria-label="年度称号"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="code in TITLE_ORDER" :key="code" :value="code">{{ TITLES[code] }}</SelectItem></SelectContent></Select><Select v-model="status"><SelectTrigger aria-label="年度资格状态"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="effective">有效</SelectItem><SelectItem value="pending">待核</SelectItem></SelectContent></Select></div>
    <p v-if="result && !result.rows.length" class="stats-empty">此年度与口径暂无企业</p>
    <article v-for="row in result?.rows ?? []" :key="`${row.enterpriseId}/${row.titleCode}`" class="stats-enterprise">
                <NuxtLink :to="`/enterprises/${row.enterpriseId}`" class="font-medium underline underline-offset-4">{{ row.name }}</NuxtLink>
                <p>{{ TITLES[row.titleCode] }} · {{ row.evaluationDay }} · {{ row.status === 'effective' ? '有效' : '待核' }}</p>
                <p v-for="note in row.notes" :key="note" class="break-words">{{ note }}</p>
                <ul class="flex flex-col gap-1"><li v-for="e in row.evidence" :key="e.evidenceId" class="break-all text-sm">{{ e.sourceFile }} · {{ e.attachment ?? '附件未记录' }} · 序号 {{ e.listNo ?? '未记录' }} · 页码 {{ e.page ?? '未记录' }}</li></ul>
                <p v-if="!row.evidence.length" class="text-sm">未记录正式出处位置，请进入企业详情核实。</p>
              </article>
    <TablePagination v-if="result" :page="result.page" :page-size="result.pageSize" :total="result.total" unit="家·称号" :loading="loading || failed" @update:page="page = $event" @update:page-size="pageSize = $event; page = 1" />
  </StatsDetailSheet>
</section>
</template>
