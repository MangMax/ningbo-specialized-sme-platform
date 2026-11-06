<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { MOVEMENT_KINDS, type MovementStatistics, type MovementKind } from '~~/lib/roster/movement-statistics'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
function select(k: MovementKind, s: string) { kind.value = k; status.value = s; page.value = 1 }
</script>

<template>
  <section class="flex flex-col gap-4" aria-labelledby="movements-title">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 id="movements-title" class="text-lg font-semibold">迁入、迁出及注销</h2>
      <Button variant="outline" :disabled="loading" @click="load">刷新主体事实</Button>
    </div>
    <p>范围为全部已录入企业，不限于正式公布企业。每种事实按企业去重，是发生过的事实而非互斥当前状态，同企业可既迁出又迁入。</p>
    <div class="flex flex-wrap items-center gap-3">
      <span id="movement-year-label">发生年</span>
      <Select :model-value="year" @update:model-value="year = String($event); page = 1">
        <SelectTrigger class="w-44" aria-labelledby="movement-year-label"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部发生年</SelectItem>
          <SelectItem value="unknown">发生年未知</SelectItem>
          <SelectItem v-for="y in result?.years ?? []" :key="y" :value="y">{{ y }} 年</SelectItem>
        </SelectContent>
      </Select>
    </div>
    <p class="text-muted-foreground">采用当前修订、已确认且证据完整的断言；未知发生年包含在累计中并单列。未确认、依据不完整及冲突单列待核，不用采集年代替发生年。</p>
    <div class="grid gap-4 lg:grid-cols-3">
      <Card v-for="bucket in buckets" :key="bucket.kind">
        <CardHeader><CardTitle>{{ labels[bucket.kind] }}</CardTitle><CardDescription>{{ yearLabel(result?.year) }} · 企业数</CardDescription></CardHeader>
        <CardContent class="flex flex-col items-start gap-2">
          <Button variant="link" class="h-auto p-0 text-3xl tabular-nums" :aria-label="`${labels[bucket.kind]}已确认明细`" @click="select(bucket.kind, 'confirmed')">{{ bucket.confirmed ?? '—' }}</Button>
          <Button variant="ghost" @click="select(bucket.kind, 'unknown')">其中发生年未知 {{ bucket.unknown ?? '—' }} 家</Button>
          <Button variant="ghost" @click="select(bucket.kind, 'pending')">待核 {{ bucket.pending ?? '—' }} 家 · 查看明细</Button>
        </CardContent>
      </Card>
    </div>
    <Card>
      <CardHeader>
        <CardTitle>主体事实明细</CardTitle><CardDescription>正在查询：{{ target }}</CardDescription>
        <p v-if="result">显示：{{ yearLabel(result.year) }} · {{ result.kind ? labels[result.kind] : '全部种类' }} · {{ statusLabel(result.status) }} · 第 {{ result.page }} 页</p>
      </CardHeader>
      <CardContent class="relative flex min-h-40 flex-col gap-4" :aria-busy="loading">
        <TableFailureState v-if="failed" :title="`${target}加载失败`" :compact="!!result" :pending="loading" :description="result ? '保留上次成功结果；请重试当前查询。' : '数据尚未加载，请重试。'" @retry="load" />
        <TableLoadingStatus :loading="loading" kind="ledger" label="正在加载主体事实" />
        <template v-if="result">
          <p v-if="!result.rows.length">此口径暂无企业</p>
          <article v-for="row in result.rows" :key="`${row.enterpriseId}/${row.kind}`" class="flex min-w-0 flex-col gap-2 border-b py-4">
            <NuxtLink :to="`/enterprises/${row.enterpriseId}`" class="font-medium underline underline-offset-4">{{ row.name }} · {{ labels[row.kind] }}</NuxtLink>
            <ul class="flex flex-col gap-3">
              <li v-for="e in row.evidence" :key="`${e.factId}/${e.revision}`" class="break-words">
                <p>发生时间：{{ e.effective.value ?? '未知' }} · {{ e.pending ? '待核' : '已确认' }}</p>
                <p>来源：{{ e.source.reference || '未记录' }} · {{ e.source.statement || '未记录' }}</p>
                <p>确认依据：{{ e.basis || '未记录' }}</p>
              </li>
            </ul>
          </article>
          <TablePagination :page="result.page" :page-size="result.pageSize" :total="result.total" unit="家" :loading="loading || failed" @update:page="page = $event" @update:page-size="pageSize = $event; page = 1" />
        </template>
      </CardContent>
    </Card>
  </section>
</template>
