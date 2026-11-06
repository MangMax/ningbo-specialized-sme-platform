<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { DistrictStatistics } from '~~/lib/roster/district-statistics'
import { TITLES, TITLE_ORDER } from '~~/lib/labels'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
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
</script>

<template>
<section class="flex min-w-0 flex-col gap-4" aria-labelledby="district-title" :aria-busy="loading">
  <div class="flex flex-wrap items-center justify-between gap-3"><h2 id="district-title" class="text-lg font-semibold">当前有效企业区县分布</h2><Button variant="outline" :disabled="loading" @click="load">刷新区县数据</Button></div>
  <p>采用企业当前已确认属地，不重建历史属地。各称号独立统计，同企业同称号只计一次；未知属地纳入合计。</p>
  <p v-if="result" class="break-words text-sm text-muted-foreground">评价日 {{ result.evaluationDay }}（上海）</p>
    <DisclosurePanel v-if="result" title="统计口径"><p class="break-words text-sm text-muted-foreground">规则 {{ result.ruleVersion }} / {{ result.assessmentVersion }}</p></DisclosurePanel>
  <TableFailureState v-if="failed" :title="`${target}加载失败`" :compact="!!result" :pending="loading" description="保留上次成功结果及其筛选与页码，请重试当前查询。" @retry="load" />
  <Skeleton v-if="!result && loading" class="h-60 w-full" />
  <Card v-if="result"><CardHeader><CardTitle>各区县有效企业</CardTitle><CardDescription>点击数字查看该区县、该称号的企业。称号之间可重叠，不跨称号合计。</CardDescription></CardHeader>
  <CardContent class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    <article v-for="bucket in result.districts" :key="bucket.district ?? 'unknown'" class="rounded-md border p-4">
      <h3 class="mb-3 font-medium">{{ bucket.district ?? '未知属地' }}</h3>
      <div v-for="count in bucket.titles" :key="count.titleCode" class="flex items-center justify-between gap-3"><span>{{ TITLES[count.titleCode] }}</span><Button variant="link" class="shrink-0 tabular-nums" :aria-label="`${bucket.district ?? '未知属地'}${TITLES[count.titleCode]}明细 ${count.effective}家`" @click="select(count.titleCode, bucket.district)">{{ count.effective }} 家</Button></div>
    </article>
    <p v-if="!result.districts.length">暂无当前有效企业</p>
    <p class="sm:col-span-2 lg:col-span-3">含未知属地合计：<span v-for="count in result.titles" :key="count.titleCode" class="mr-4 inline-block tabular-nums">{{ TITLES[count.titleCode] }} {{ count.effective }} 家</span></p>
  </CardContent></Card>
  <DisclosurePanel v-model:open="open" title="区县企业明细">
    <div class="flex min-w-0 flex-col gap-4">
      <p>查询：{{ target }}</p>
      <div class="grid gap-3 sm:grid-cols-2">
        <Select v-model="title"><SelectTrigger aria-label="区县称号"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="code in TITLE_ORDER" :key="code" :value="code">{{ TITLES[code] }}</SelectItem></SelectContent></Select>
        <Select v-model="district"><SelectTrigger aria-label="区县"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部区县</SelectItem><SelectItem v-for="bucket in result?.districts" :key="bucket.district ?? 'unknown'" :value="bucket.district ?? 'unknown'">{{ bucket.district ?? '未知属地' }}</SelectItem></SelectContent></Select>
      </div>
      <TableLoadingStatus :loading="loading" kind="ledger" label="正在加载区县明细" />
      <template v-if="result">
        <p>显示：{{ TITLES[result.title ?? ''] }} · {{ result.district === undefined ? '全部区县' : result.district === 'unknown' ? '未知属地' : result.district }} · 第 {{ result.page }} 页</p>
        <p v-if="!result.rows.length">此口径暂无企业</p>
        <article v-for="row in result.rows" :key="`${row.enterpriseId}/${row.titleCode}`" class="flex min-w-0 flex-col gap-2 border-b py-4">
          <NuxtLink :to="`/enterprises/${row.enterpriseId}`" class="font-medium underline underline-offset-4">{{ row.name }}</NuxtLink>
          <p>{{ TITLES[row.titleCode] }} · {{ row.district ?? '未知属地' }}</p>
          <p class="whitespace-pre-line break-words">{{ row.basis }}</p>
          <NuxtLink :to="`/enterprises/${row.enterpriseId}`" class="underline">查看资格依据与出处</NuxtLink>
          <ul><li v-for="e in row.evidence" :key="e.evidenceId" class="break-all text-sm">{{ e.sourceFile }} · {{ e.attachment ?? '附件未记录' }} · 序号 {{ e.listNo ?? '未记录' }} · 页码 {{ e.page ?? '未记录' }}</li></ul>
        </article>
        <TablePagination :page="result.page" :page-size="result.pageSize" :total="result.total" unit="家·称号" :loading="loading || failed" @update:page="page = $event" @update:page-size="pageSize = $event; page = 1" />
      </template>
    </div>
  </DisclosurePanel>
</section>
</template>
