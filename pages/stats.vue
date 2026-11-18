<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { motion, useReducedMotion } from 'motion-v'
const reducedMotion = useReducedMotion()
import StatisticsMovementsSection from '@/components/statistics/StatisticsMovementsSection.vue'
import type { PublishedStatistics } from '~~/lib/roster/published-statistics'
import { TITLES, TITLE_ORDER } from '#sme-roster/lib/labels'
const title = ref('')
const status = ref('confirmed')
const page = ref(1)
const pageSize = ref(25)
const result = shallowRef<PublishedStatistics>()
const loading = ref(false)
const failed = ref(false)
const open = ref(false)
let sequence = 0
async function load() {
  const current = ++sequence
  const query = { title: title.value || undefined, status: status.value, page: page.value, pageSize: pageSize.value }
  loading.value = true; failed.value = false
  try {
    const next = await $fetch<PublishedStatistics>('/api/statistics/published', { query })
    if (current === sequence) result.value = next
  } catch { if (current === sequence) failed.value = true }
  finally { if (current === sequence) loading.value = false }
}
watch([title, status, page, pageSize], load, { immediate: true })
function select(code: string, state: string) { title.value = code; status.value = state; page.value = 1; open.value = true }
const target = computed(() => `${TITLES[title.value] ?? '全部称号'} · ${status.value === 'pending' ? '身份待核' : '累计公布'} · 第 ${page.value} 页`)
import '@/assets/css/statistics.css'
import { ArrowUpRight, ArrowRight } from '@lucide/vue'
</script>
<template>
<div class="stats-dashboard">
  <header class="stats-page-header">
    <div><p class="stats-eyebrow">宁波 · 优质中小企业</p><h1>称号统计</h1></div>
    <div class="stats-header-note"><span class="stats-live-dot" />公布规模 · 有效存量</div>
  </header>
  <section aria-labelledby="published-title" class="stats-published">
    <div class="stats-section-heading"><div><h2 id="published-title">累计正式公布</h2><p>同一企业同一称号计一次，保留历年公布事实</p></div></div>
    <div class="stats-metric-grid">
      <motion.article :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }" :transition="{ duration: reducedMotion ? 0 : 0.22, delay: reducedMotion ? 0 : index * 0.04, ease: 'easeOut' }" v-for="(code,index) in TITLE_ORDER" :key="code" class="stats-metric" :class="`stats-metric--${index}`">
        <div class="stats-metric-label"><span>{{ TITLES[code] }}</span><span class="stats-tier-mark" /></div>
        <motion.button :while-hover="reducedMotion ? undefined : 'hover'" class="stats-number-button" :aria-label="`${TITLES[code]}累计公布明细`" :disabled="!result" @click="select(code,'confirmed')"><strong>{{ result ? result.titles.find(t=>t.titleCode===code)?.confirmed.toLocaleString('zh-CN') : '—' }}</strong><span>家</span><motion.span class="stats-number-arrow" :variants="{ hover: { x: 2, y: -2 } }" :transition="{ duration: reducedMotion ? 0 : 0.15 }" aria-hidden="true"><ArrowUpRight /></motion.span></motion.button>
        <div class="stats-metric-footer"><span>历年累计公布</span><button v-if="result" class="stats-pending-link" @click="select(code,'pending')">身份待核 {{ result.titles.find(t=>t.titleCode===code)?.pending }} <ArrowRight class="size-3" aria-hidden="true" /></button></div>
      </motion.article>
    </div>
    <TableFailureState v-if="failed" :title="`${target}加载失败`" :compact="!!result" :pending="loading" :description="result ? '上次成功数据已保留，可重新加载。' : '尚未加载公布数据，请重试。'" @retry="load" />
  </section>
  <StatisticsMovementsSection />
  <div class="stats-analysis-grid"><StatisticsAnnualSection /><StatisticsDistrictSection /></div>
  <footer class="stats-page-footer"><span>各称号独立统计，企业可重叠，不跨称号直接合计。</span><span>点击数字与图形查看企业依据</span></footer>
  <StatsDetailSheet v-model:open="open" title="公布企业明细" :target="target" :source="result ? `${TITLES[result.title ?? ''] ?? '全部称号'} · ${result.status==='pending'?'身份待核':'累计公布'} · 第${result.page}页` : undefined" :loading="loading" :failed="failed" @retry="load">
    <p v-if="result && !result.rows.length" class="stats-empty">此口径暂无企业</p>
    <article v-for="row in result?.rows ?? []" :key="`${row.enterpriseId}/${row.titleCode}`" class="stats-enterprise">
                <NuxtLink :to="`/enterprises/${row.enterpriseId}`" class="font-medium underline underline-offset-4">{{ row.name }}</NuxtLink>
                <p>{{ TITLES[row.titleCode] }} · {{ row.status === 'pending' ? '身份待核' : '正式公布' }}</p>
                <p class="break-all text-muted-foreground">{{ row.uscc ?? '未记录统一社会信用代码' }}</p>
                <ul class="flex flex-col gap-2">
                  <li v-for="evidence in row.evidence" :key="evidence.evidenceId" class="break-all text-sm">{{ evidence.sourceFile }} · {{ evidence.attachment ?? '附件未记录' }} · 序号 {{ evidence.listNo ?? '未记录' }} · 页码 {{ evidence.page ?? '未记录' }}</li>
                </ul>
              </article>
    <TablePagination v-if="result" :page="result.page" :page-size="result.pageSize" :total="result.total" unit="家·称号" :loading="loading || failed" @update:page="page = $event" @update:page-size="pageSize = $event; page = 1" />
  </StatsDetailSheet>
</div>
</template>
