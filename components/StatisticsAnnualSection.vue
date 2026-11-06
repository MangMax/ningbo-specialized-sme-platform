<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { AnnualStatistics } from '~~/lib/roster/annual-statistics'
import { TITLES, TITLE_ORDER } from '~~/lib/labels'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
const year = ref('today'), title = ref('specialized_sme'), status = ref('effective'), page = ref(1), pageSize = ref(25)
const result = shallowRef<AnnualStatistics>()
const loading = ref(false), failed = ref(false)
const open = ref(false)
const detailRegion = ref<HTMLDivElement>()
async function openDetail() {
  open.value = true
  await nextTick()
  detailRegion.value?.focus({ preventScroll: true })
  detailRegion.value?.scrollIntoView({ block: 'nearest' })
}
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
const maximum = computed(() => Math.max(1, ...(result.value?.years.flatMap(y => y.titles.map(t => t.effective)) ?? [])))
const colors = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)']
const x = (index: number) => 35 + index * 530 / Math.max(1, (result.value?.years.length ?? 1) - 1)
const y = (value: number) => 170 - value * 140 / maximum.value
const lines = computed(() => TITLE_ORDER.map((code, index) => ({ code, color: colors[index], points: result.value?.years.map((row, i) => `${x(i)},${y(row.titles.find(t => t.titleCode === code)?.effective ?? 0)}`).join(' ') ?? '' })))
function select(selectedYear: number, code: string, selectedStatus: string) {
  year.value = String(selectedYear); title.value = code; status.value = selectedStatus; page.value = 1; void openDetail()
}
</script>

<template>
  <section class="flex min-w-0 flex-col gap-4" aria-labelledby="annual-title" :aria-busy="loading">
    <div class="flex items-center justify-between gap-3"><h2 id="annual-title" class="text-lg font-semibold">年度有效企业数</h2><Button variant="outline" :disabled="loading" @click="load">刷新年度数据</Button></div>
    <p>按当前已录入证据重算，非当年系统归档。历史按上海年末，本年截至评价日；同企业同称号只计一次。</p>
    <p v-if="result" class="break-words text-sm text-muted-foreground">评价日 {{ result.evaluationDay }}（上海）</p>
    <DisclosurePanel v-if="result" title="统计口径"><p class="break-words text-sm text-muted-foreground">规则 {{ result.ruleVersion }} / {{ result.assessmentVersion }}</p></DisclosurePanel>
    <p class="text-sm">迁入本身不授予称号；按现行规则，迁入也不抵消既有迁出排除。不完整排除事实在本年仅作备注，历史时点确有不确定性则单列待核。</p>
    <Skeleton v-if="!result && loading" class="h-60 w-full" />
    <Card v-if="result">
      <CardHeader><CardTitle>有效存量趋势</CardTitle><CardDescription>三种称号独立统计，可重叠；图下数值可查看企业明细。</CardDescription></CardHeader>
      <CardContent class="flex min-w-0 flex-col gap-4">
        <div class="flex flex-wrap gap-x-5 gap-y-2"><span v-for="line in lines" :key="line.code" class="flex items-center gap-2"><span class="h-3 w-3 rounded-full" :style="{ background: line.color }" />{{ TITLES[line.code] }}</span></div>
        <svg viewBox="0 0 600 210" role="img" aria-label="各称号年度有效存量趋势，完整数值见下表" class="w-full">
          <path d="M35 20 V170 H565" fill="none" stroke="var(--border)" />
          <text x="5" y="30" fill="currentColor" font-size="12">{{ maximum }}</text><text x="15" y="174" fill="currentColor" font-size="12">0</text>
          <g v-for="line in lines" :key="line.code"><polyline :points="line.points" fill="none" :stroke="line.color" stroke-width="2" /><circle v-for="(row, i) in result.years" :key="row.year" :cx="x(i)" :cy="y(row.titles.find(t => t.titleCode === line.code)?.effective ?? 0)" r="3" :fill="line.color" /></g>
          <text x="35" y="200" fill="currentColor" font-size="12">{{ result.years[0]?.year }}</text><text x="565" y="200" text-anchor="end" fill="currentColor" font-size="12">{{ result.years.at(-1)?.year }}</text>
        </svg>
        <Table class="data-table tabular-nums">
          <TableCaption class="sr-only">年度有效企业数及待核数，点击数字查看同口径明细</TableCaption>
          <TableHeader><TableRow><TableHead>评价日</TableHead><TableHead v-for="code in TITLE_ORDER" :key="code">{{ TITLES[code] }}</TableHead></TableRow></TableHeader>
          <TableBody>
            <TableRow v-for="row in result.years" :key="row.year">
              <TableHead scope="row">{{ row.evaluationDay }}</TableHead>
              <TableCell v-for="count in row.titles" :key="count.titleCode">
                <div class="flex flex-col items-start gap-2">
                  <Button variant="link" class="h-auto p-0 tabular-nums" :aria-label="`${row.year}年${TITLES[count.titleCode]}有效明细 ${count.effective}家`" @click="select(row.year, count.titleCode, 'effective')">{{ count.effective }} 家</Button>
                  <Button variant="ghost" class="h-auto p-0 tabular-nums" :aria-label="`${row.year}年${TITLES[count.titleCode]}待核明细 ${count.pending}家`" @click="select(row.year, count.titleCode, 'pending')">待核 {{ count.pending }}</Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
    <TableFailureState v-if="failed" :title="`${target}加载失败`" :compact="!!result" :pending="loading" :description="result ? '保留上次成功结果及其年度、称号和页码，请重试当前查询。' : '尚无年度结果，请重试。'" @retry="load" />
    <div class="relative h-6">
      <TableLoadingStatus :loading="loading" kind="ledger" label="正在加载年度明细" />
    </div>
    <p v-if="result">显示：{{ result.year }}年 · {{ TITLES[result.title ?? ''] }} · {{ result.status === 'effective' ? '有效' : '待核' }} · 第 {{ result.page }} 页</p>
    <div ref="detailRegion" tabindex="-1" aria-label="年度企业明细">
      <DisclosurePanel v-model:open="open" title="年度企业明细">
        <Card>
          <CardHeader><CardDescription>查询：{{ target }}</CardDescription></CardHeader>
          <CardContent class="flex flex-col gap-4">
            <div class="grid gap-3 sm:grid-cols-3">
              <Select v-model="year"><SelectTrigger aria-label="年度"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="today">本年截至评价日</SelectItem><SelectItem v-for="row in result?.years" :key="row.year" :value="String(row.year)">{{ row.year }}年</SelectItem></SelectContent></Select>
              <Select v-model="title"><SelectTrigger aria-label="年度称号"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="code in TITLE_ORDER" :key="code" :value="code">{{ TITLES[code] }}</SelectItem></SelectContent></Select>
              <Select v-model="status"><SelectTrigger aria-label="年度资格状态"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="effective">有效</SelectItem><SelectItem value="pending">待核</SelectItem></SelectContent></Select>
            </div>
            <div v-if="result" class="divide-y">
              <p v-if="!result.rows.length" class="py-6">此年度与口径暂无企业</p>
              <article v-for="row in result.rows" :key="`${row.enterpriseId}/${row.titleCode}`" class="flex min-w-0 flex-col gap-2 py-4">
                <NuxtLink :to="`/enterprises/${row.enterpriseId}`" class="font-medium underline underline-offset-4">{{ row.name }}</NuxtLink>
                <p>{{ TITLES[row.titleCode] }} · {{ row.evaluationDay }} · {{ row.status === 'effective' ? '有效' : '待核' }}</p>
                <p v-for="note in row.notes" :key="note" class="break-words">{{ note }}</p>
                <ul class="flex flex-col gap-1"><li v-for="e in row.evidence" :key="e.evidenceId" class="break-all text-sm">{{ e.sourceFile }} · {{ e.attachment ?? '附件未记录' }} · 序号 {{ e.listNo ?? '未记录' }} · 页码 {{ e.page ?? '未记录' }}</li></ul>
                <p v-if="!row.evidence.length" class="text-sm">未记录正式出处位置，请进入企业详情核实。</p>
              </article>
            </div>
            <TablePagination v-if="result" :page="result.page" :page-size="result.pageSize" :total="result.total" unit="家·称号" :loading="loading || failed" @update:page="page = $event" @update:page-size="pageSize = $event; page = 1" />
          </CardContent>
        </Card>
      </DisclosurePanel>
    </div>
  </section>
</template>
