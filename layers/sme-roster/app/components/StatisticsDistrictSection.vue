<script setup lang="ts">
import { motion, useReducedMotion } from 'motion-v'
const reducedMotion = useReducedMotion()
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { DistrictStatistics } from '#sme-roster/lib/roster/district-statistics'
import { TITLES, TITLE_ORDER } from '#sme-roster/lib/labels'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { Skeleton } from '#core/app/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '#core/app/components/ui/tabs'
const title = ref('specialized_sme'), district = ref('all'), page = ref(1), pageSize = ref(25), open = ref(false)
const result = shallowRef<DistrictStatistics>()
const loading = ref(false), failed = ref(false)
let sequence = 0
onBeforeUnmount(() => { sequence++ })
async function load() {
  const request = ++sequence
  loading.value = true; failed.value = false
  try {
    const next = await $fetch<DistrictStatistics>('/api/statistics/districts', { query: { title: title.value, district: district.value === 'all' ? undefined : district.value, page: page.value, pageSize: pageSize.value } })
    if (request === sequence) result.value = next
  } catch { if (request === sequence) failed.value = true }
  finally { if (request === sequence) loading.value = false }
}
watch([title, district], () => { page.value = 1 })
watch([title, district, page, pageSize], load, { immediate: true })
const target = computed(() => `${TITLES[title.value]} · ${district.value === 'all' ? '全部区县' : district.value === 'unknown' ? '未知属地' : district.value} · 第 ${page.value} 页`)
function select(code: string, bucket: string | null) { title.value = code; district.value = bucket ?? 'unknown'; page.value = 1; open.value = true }
const switching = computed(() => !failed.value && (!result.value || result.value.title !== title.value))
const selectedTitle=computed(()=>result.value?.title ?? title.value)
const districtRows=computed(()=>(result.value?.districts??[]).map(b=>({district:b.district,n:b.titles.find(t=>t.titleCode===selectedTitle.value)?.effective??0})).sort((a,b)=>b.n-a.n))
const districtMax=computed(()=>Math.max(1,...districtRows.value.map(b=>b.n)))
</script>
<template>
<section class="stats-chart-panel stats-district-panel" aria-labelledby="district-title" :aria-busy="loading">
  <header class="stats-panel-heading"><div><p class="stats-eyebrow">属地分布</p><h2 id="district-title">当前有效企业</h2></div></header>
  <Tabs v-model="title" class="gap-4" @update:model-value="district='all'; page=1">
    <TabsList class="w-full" aria-label="区县统计称号">
      <TabsTrigger v-for="code in TITLE_ORDER" :key="code" :value="code" class="text-xs">{{ code==='little_giant'?'小巨人':code==='specialized_sme'?'专精特新':'创新型' }}</TabsTrigger>
    </TabsList>
    <TabsContent v-for="code in TITLE_ORDER" :key="code" :value="code" class="stats-district-content" :aria-busy="loading">
      <div v-if="switching" class="stats-district-placeholder" role="status" :aria-label="`正在加载${TITLES[title]}区县分布`">
        <span class="sr-only">正在加载{{ TITLES[title] }}区县分布</span>
        <div class="stats-district-total" aria-hidden="true"><Skeleton class="h-9 w-24" /><span>家有效企业<small>含未知属地</small></span></div>
        <div class="stats-district-bars" aria-hidden="true">
          <div v-for="(width,index) in [100,82,69,55,43]" :key="index" class="stats-district-bar">
            <span class="stats-district-rank">{{ String(index+1).padStart(2,'0') }}</span>
            <div class="stats-district-bar-body"><div class="stats-district-bar-label"><Skeleton class="h-4 w-16" /><Skeleton class="h-4 w-10" /></div><Skeleton class="h-1.5 rounded-full" :style="{width:`${width}%`}" /></div>
          </div>
        </div>
      </div>
      <motion.div v-else class="stats-district-placeholder" :initial="reducedMotion ? false : { opacity: 0 }" :animate="{ opacity: 1 }" :transition="{ duration: reducedMotion ? 0 : 0.18 }">
        <p v-if="result && result.title !== title" class="stats-source" role="status">当前查询失败，以下保留{{ TITLES[result.title ?? ''] }}的上次结果。</p>
  <div v-if="result" class="stats-district-total"><strong>{{ result.titles.find(t=>t.titleCode===selectedTitle)?.effective.toLocaleString('zh-CN') }}</strong><span>家有效企业<small>含未知属地</small></span></div>
  <div v-if="result" class="stats-district-bars">
    <button v-for="(bucket,i) in districtRows" :key="bucket.district??'unknown'" class="stats-district-bar" :aria-label="`${bucket.district??'未知属地'}${TITLES[selectedTitle]}明细 ${bucket.n}家`" @click="select(selectedTitle,bucket.district)"><span class="stats-district-rank">{{ String(i+1).padStart(2,'0') }}</span><span class="stats-district-bar-body"><span class="stats-district-bar-label"><span>{{ bucket.district??'未知属地' }}</span><strong>{{ bucket.n }}<small>家</small></strong></span><span class="stats-bar-track"><motion.span :initial="{ width: '0%' }" :animate="{ width: `${bucket.n/districtMax*100}%` }" :transition="{ duration: reducedMotion ? 0 : 0.28, ease: 'easeOut' }" /></span></span></button>
    <p v-if="!districtRows.length" class="stats-empty">暂无当前有效企业</p>
  </div>
      </motion.div>
    </TabsContent>
  </Tabs>
  <TableFailureState v-if="failed" :title="`${target}加载失败`" :compact="!!result" :pending="loading" :description="result?'已保留上次区县结果，请重试。':'尚无区县结果，请重试。'" @retry="load" />
  <div class="stats-panel-foot"><span>企业当前属地 · {{ result?.evaluationDay??'—' }}</span><span>按称号独立统计</span></div>
  <RosterStatsDetailSheet v-model:open="open" title="区县企业明细" :target="target" :source="result ? `${TITLES[result.title??'']} · ${result.district===undefined?'全部区县':result.district==='unknown'?'未知属地':result.district} · 第${result.page}页` : undefined" :loading="loading" :failed="failed" @retry="load">
    <div class="grid gap-3 sm:grid-cols-2"><Select v-model="title"><SelectTrigger aria-label="区县称号"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="code in TITLE_ORDER" :key="code" :value="code">{{ TITLES[code] }}</SelectItem></SelectContent></Select><Select v-model="district"><SelectTrigger aria-label="区县"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部区县</SelectItem><SelectItem v-for="bucket in result?.districts" :key="bucket.district??'unknown'" :value="bucket.district??'unknown'">{{ bucket.district??'未知属地' }}</SelectItem></SelectContent></Select></div>
    <p v-if="result && !result.rows.length" class="stats-empty">此口径暂无企业</p>
    <article v-for="row in result?.rows ?? []" :key="`${row.enterpriseId}/${row.titleCode}`" class="stats-enterprise">
          <NuxtLink :to="`/enterprises/${row.enterpriseId}`" class="font-medium underline underline-offset-4">{{ row.name }}</NuxtLink>
          <p>{{ TITLES[row.titleCode] }} · {{ row.district ?? '未知属地' }}</p>
          <NuxtLink :to="`/enterprises/${row.enterpriseId}`" class="underline">查看资格依据与出处</NuxtLink>
          <ul><li v-for="e in row.evidence" :key="e.evidenceId" class="break-all text-sm">{{ e.sourceFile }} · {{ e.attachment ?? '附件未记录' }} · 序号 {{ e.listNo ?? '未记录' }} · 页码 {{ e.page ?? '未记录' }}</li></ul>
        </article>
    <TablePagination v-if="result" :page="result.page" :page-size="result.pageSize" :total="result.total" unit="家·称号" :loading="loading || failed" @update:page="page = $event" @update:page-size="pageSize = $event; page = 1" />
  </RosterStatsDetailSheet>
</section>
</template>
