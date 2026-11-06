<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { AnnualStatistics } from '~~/lib/roster/annual-statistics'
import { TITLES, TITLE_ORDER } from '~~/lib/labels'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ArrowUpRight } from '@lucide/vue'
const year = ref('today'), title = ref('specialized_sme'), status = ref('effective'), page = ref(1), pageSize = ref(25)
const result = shallowRef<AnnualStatistics>()
const loading = ref(false), failed = ref(false)
const open = ref(false)
function openDetail() { open.value = true }
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
const maximum = computed(() => Math.max(1,...(result.value?.years.flatMap(y=>y.titles.map(t=>t.effective))??[])))
const colors=['var(--chart-1)','var(--chart-2)','var(--chart-3)']
const x=(index:number)=>44+index*632/Math.max(1,(result.value?.years.length??1)-1)
const y=(value:number)=>212-value*174/maximum.value
const lines=computed(()=>TITLE_ORDER.map((code,index)=>({code,color:colors[index],points:result.value?.years.map((row,i)=>`${x(i)},${y(row.titles.find(t=>t.titleCode===code)?.effective??0)}`).join(' ')??''})))
const axisYears=computed(()=>{const years=result.value?.years??[];return years.filter((_,i)=>i===0||i===years.length-1)})
const selectedYear=computed(()=>result.value?.years.find(row=>row.year===result.value?.year))
function select(selected:number,code:string,state:string){year.value=String(selected);title.value=code;status.value=state;page.value=1;open.value=true}
</script>
<template>
<section class="stats-chart-panel" aria-labelledby="annual-title" :aria-busy="loading">
  <header class="stats-panel-heading"><div><p class="stats-eyebrow">有效存量</p><h2 id="annual-title">各称号年度变化</h2></div><Button variant="ghost" size="sm" :disabled="loading" @click="load">刷新</Button></header>
  <div class="stats-chart-legend"><span v-for="line in lines" :key="line.code"><i :style="{background:line.color}" />{{ TITLES[line.code] }}</span></div>
  <Skeleton v-if="!result && loading" class="h-64 w-full" />
  <template v-if="result">
    <div class="stats-trend-canvas">
      <svg viewBox="0 0 720 250" preserveAspectRatio="none" role="img" aria-label="各称号年度有效企业数趋势，按年份选择可查看精确数量">
        <g v-for="n in [0,1,2,3]" :key="n"><line x1="44" x2="676" :y1="y(maximum*n/3)" :y2="y(maximum*n/3)" stroke="var(--border)" stroke-dasharray="3 5" /></g>
        <g v-for="line in lines" :key="line.code"><polygon :points="`44,212 ${line.points} ${x(result.years.length-1)},212`" :fill="line.color" opacity=".045" /><polyline :points="line.points" fill="none" :stroke="line.color" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" /><g v-for="(row,i) in result.years" :key="row.year"><circle :cx="x(i)" :cy="y(row.titles.find(t=>t.titleCode===line.code)?.effective??0)" r="4.5" :fill="line.color" stroke="var(--card)" stroke-width="2" /></g></g>

      </svg><span class="stats-chart-max">{{ maximum }}</span><span class="stats-chart-zero">0</span><div class="stats-chart-xlabels"><span v-for="row in axisYears" :key="row.year">{{ row.year }}</span></div>
    </div>
    <div class="stats-year-switch" aria-label="选择统计年度"><button v-for="row in result.years" :key="row.year" :aria-pressed="row.year===result.year" @click="year=String(row.year)">{{ row.year }}<span v-if="row===result.years.at(-1)">截至今日</span></button></div>
    <div v-if="selectedYear" class="stats-year-counts">
      <div v-for="(count,i) in selectedYear.titles" :key="count.titleCode" class="stats-year-count"><span><i :style="{background:colors[i]}" />{{ TITLES[count.titleCode] }}</span><button :aria-label="`${selectedYear.year}年${TITLES[count.titleCode]}有效明细 ${count.effective}家`" @click="select(selectedYear.year,count.titleCode,'effective')"><strong>{{ count.effective.toLocaleString('zh-CN') }}</strong><small>家</small><ArrowUpRight class="size-3" aria-hidden="true" /></button><button class="stats-small-link" :aria-label="`${selectedYear.year}年${TITLES[count.titleCode]}待核明细 ${count.pending}家`" @click="select(selectedYear.year,count.titleCode,'pending')">待核 {{ count.pending }} 家</button></div>
    </div>
  </template>
  <TableFailureState v-if="failed" :title="`${target}加载失败`" :compact="!!result" :pending="loading" :description="result ? `已保留${result.year}年的上次结果，请重试。` : '尚未加载年度数据，请重试。'" @retry="load" />
  <div class="stats-panel-foot"><span>{{ result?.year===Number(result?.evaluationDay.slice(0,4))?'本年截至评价日':'历史年末存量' }} · {{ selectedYear?.evaluationDay ?? '—' }}</span><DisclosurePanel title="统计口径" compact><p>按当前已录入证据重算，非当年系统归档；各称号独立统计。历史取上海年末，本年取评价日。迁入本身不授予称号，也不抵消现行规则中的迁出排除。未确定的历史状态单列待核。</p></DisclosurePanel></div>
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
