<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { MOVEMENT_KINDS, type MovementStatistics, type MovementKind } from '#sme-roster/lib/roster/movement-statistics'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { Button } from '#core/app/components/ui/button'
import { ArrowDownLeft, ArrowUpRight, Minus } from '@lucide/vue'
const labels = { moved_in: '迁入', moved_out: '迁出', cancelled: '注销' }
const year = ref('all')
const kind = ref<MovementKind>('moved_in')
const status = ref('confirmed')
const page = ref(1)
const pageSize = ref(25)
const result = shallowRef<MovementStatistics>()
const buckets = computed(() => result.value?.kinds ?? MOVEMENT_KINDS.map(kind => ({ kind, confirmed: null, unknown: null, pending: null })))
const loading = ref(false)
const failed = ref(false)
const statusLabel = (s: string) => s === 'pending' ? '待核' : s === 'unknown' ? '发生年未知（已确认）' : '已确认累计'
const yearLabel = (y?: string) => !y || y === 'all' ? '全部发生年' : y === 'unknown' ? '发生年未知' : `${y} 年`
const target = computed(() => `${yearLabel(year.value)} · ${labels[kind.value]} · ${statusLabel(status.value)} · 第 ${page.value} 页`)
const open = ref(false)
let sequence = 0
async function load() {
  const current = ++sequence
  const query = { year: year.value === 'all' ? undefined : year.value, kind: kind.value, status: status.value, page: page.value, pageSize: pageSize.value }
  loading.value = true; failed.value = false
  try {
    const next = await $fetch<MovementStatistics>('/api/statistics/movements', { query })
    if (current === sequence) result.value = next
  } catch { if (current === sequence) failed.value = true }
  finally { if (current === sequence) loading.value = false }
}
watch([year, kind, status, page, pageSize], load, { immediate: true })
function select(k: MovementKind, s: string) { year.value = result.value?.year ?? 'all'; kind.value = k; status.value = s; page.value = 1; open.value = true }
</script>
<template>
<section class="stats-movement-panel" aria-labelledby="movements-title" :aria-busy="loading">
  <div class="stats-movement-heading"><div><h2 id="movements-title">企业流动与注销</h2><p>已确认的主体事实</p></div><div class="flex items-center gap-1"><Select :model-value="year" @update:model-value="year=String($event);page=1"><SelectTrigger aria-label="发生年" class="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部发生年</SelectItem><SelectItem value="unknown">发生年未知</SelectItem><SelectItem v-for="y in result?.years ?? []" :key="y" :value="y">{{ y }} 年</SelectItem></SelectContent></Select></div></div>
  <div class="stats-movement-metrics">
    <article v-for="bucket in buckets" :key="bucket.kind" class="stats-movement-item">
      <div class="stats-movement-label"><span class="stats-movement-icon" :class="`stats-movement-icon--${bucket.kind}`" aria-hidden="true"><component :is="bucket.kind==='moved_in'?ArrowDownLeft:bucket.kind==='moved_out'?ArrowUpRight:Minus" class="size-4" /></span><span>{{ labels[bucket.kind] }}</span></div>
      <Button variant="ghost" class="stats-movement-number h-auto justify-start p-0 hover:bg-transparent hover:text-inherit dark:hover:bg-transparent" :aria-label="`${labels[bucket.kind]}已确认明细`" :disabled="!result" @click="select(bucket.kind, 'confirmed')">
        {{ bucket.confirmed ?? '—' }}<small>家</small>
      </Button>
      <div class="stats-movement-foot">
        <Button variant="link" class="h-auto p-0 text-xs" :aria-label="`${labels[bucket.kind]}发生年未知明细`" :disabled="!result" @click="select(bucket.kind, 'unknown')">年份未知 {{ bucket.unknown ?? '—' }}</Button>
        <Button variant="link" class="h-auto p-0 text-xs" :aria-label="`${labels[bucket.kind]}待核明细`" :disabled="!result" @click="select(bucket.kind, 'pending')">待核 {{ bucket.pending ?? '—' }}</Button>
      </div>
    </article>
  </div>
  <div v-if="failed" class="stats-inline-failure"><TableFailureState :title="`${target}加载失败`" :compact="!!result" :pending="loading" :description="result ? `保留${yearLabel(result.year)}的上次结果，请重试。` : '尚未加载主体事实，请重试。'" @retry="load" /></div>
  <RosterStatsDetailSheet v-model:open="open" title="主体事实明细" :target="target" :source="result ? `${yearLabel(result.year)} · ${result.kind?labels[result.kind]:'全部种类'} · ${statusLabel(result.status)} · 第${result.page}页` : undefined" :loading="loading" :failed="failed" @retry="load">
    <p class="stats-source">全部已录入企业，按每种事实去重；迁入、迁出可同时发生。</p><p v-if="result && !result.rows.length" class="stats-empty">此口径暂无企业</p>
    <article v-for="row in result?.rows ?? []" :key="`${row.enterpriseId}/${row.kind}`" class="stats-enterprise">
                <NuxtLink :to="`/enterprises/${row.enterpriseId}`" class="font-medium underline underline-offset-4">{{ row.name }} · {{ labels[row.kind] }}</NuxtLink>
                <ul class="flex flex-col gap-3">
                  <li v-for="e in row.evidence" :key="`${e.factId}/${e.revision}`" class="break-words">
                    <p>发生时间：{{ e.effective.value ?? '未知' }} · {{ e.pending ? '待核' : '已确认' }}</p>
                    <p>来源：{{ e.source.reference || '未记录' }} · {{ e.source.statement || '未记录' }}</p>
                    <p>确认依据：{{ e.basis || '未记录' }}</p>
                  </li>
                </ul>
              </article>
    <TablePagination v-if="result" :page="result.page" :page-size="result.pageSize" :total="result.total" unit="家" :loading="loading || failed" @update:page="page = $event" @update:page-size="pageSize = $event; page = 1" />
  </RosterStatsDetailSheet>
</section>
</template>
