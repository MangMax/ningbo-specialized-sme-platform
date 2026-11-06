<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import StatisticsMovementsSection from '@/components/statistics/StatisticsMovementsSection.vue'
import type { PublishedStatistics } from '~~/lib/roster/published-statistics'
import { TITLES, TITLE_ORDER } from '~~/lib/labels'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
const title = ref('')
const status = ref('confirmed')
const page = ref(1)
const pageSize = ref(25)
const result = shallowRef<PublishedStatistics>()
const loading = ref(false)
const failed = ref(false)
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
function select(code: string, state: string) { title.value = code; status.value = state; page.value = 1 }
const target = computed(() => `${TITLES[title.value] ?? '全部称号'} · ${status.value === 'pending' ? '身份待核' : '累计公布'} · 第 ${page.value} 页`)
</script>

<template>
  <div class="flex flex-col gap-5">
    <PageHeader title="统计概览" description="按称号查看正式公布规模，数字可查看同口径企业与出处。" />
    <section class="flex flex-col gap-4" aria-labelledby="published-title">
      <div class="flex items-center justify-between gap-3"><h2 id="published-title" class="text-lg font-semibold">公布名单累计企业数</h2><Button variant="outline" :disabled="loading" @click="load">刷新</Button></div>
      <p class="text-muted-foreground">同企业同称号只计一次，保留失效、迁出、注销及无平台匹配企业。不同称号可重叠，不能直接相加。</p>
      <div class="grid gap-4 lg:grid-cols-3">
        <Card v-for="code in TITLE_ORDER" :key="code">
          <CardHeader><CardTitle>{{ TITLES[code] }}</CardTitle><CardDescription>正式认定依据支持的累计企业数</CardDescription></CardHeader>
          <CardContent class="flex flex-col items-start gap-3">
            <Skeleton v-if="!result && loading" class="h-10 w-24" />
            <template v-else-if="result">
              <Button variant="link" class="h-auto p-0 text-3xl tabular-nums" :aria-label="`${TITLES[code]}累计公布明细`" @click="select(code, 'confirmed')">{{ result.titles.find(t => t.titleCode === code)?.confirmed.toLocaleString('zh-CN') }}</Button>
              <Button variant="ghost" @click="select(code, 'pending')">身份待核 {{ result.titles.find(t => t.titleCode === code)?.pending }} 家 · 查看明细</Button>
            </template>
            <span v-else>尚未加载</span>
          </CardContent>
        </Card>
      </div>
    </section>
    <Card>
      <CardHeader>
        <CardTitle>公布企业明细</CardTitle>
        <CardDescription>正在查询：{{ target }}。仅列有正式认定出处的企业；复核不单独增加企业。</CardDescription>
        <p v-if="result" class="text-sm">显示：{{ TITLES[result.title ?? ''] ?? '全部称号' }} · {{ result.status === 'pending' ? '身份待核' : '累计公布' }} · 第 {{ result.page }} 页</p>
      </CardHeader>
      <CardContent class="relative flex flex-col gap-4" :aria-busy="loading">
        <TableFailureState v-if="failed" :title="`${target}加载失败`" :compact="!!result" :pending="loading" :description="result ? '保留上次成功结果；请重试当前查询。' : '数据尚未加载，请重试。'" @retry="load" />
        <TableLoadingStatus :loading="loading" kind="ledger" label="正在加载公布明细" />
        <div v-if="result" class="flex flex-col divide-y">
          <p v-if="!result.rows.length" class="py-6 text-muted-foreground">此口径暂无企业</p>
          <article v-for="row in result.rows" :key="`${row.enterpriseId}/${row.titleCode}`" class="flex min-w-0 flex-col gap-2 py-4">
            <NuxtLink :to="`/enterprises/${row.enterpriseId}`" class="font-medium underline underline-offset-4">{{ row.name }}</NuxtLink>
            <p>{{ TITLES[row.titleCode] }} · {{ row.status === 'pending' ? '身份待核' : '正式公布' }}</p>
            <p class="break-all text-muted-foreground">{{ row.uscc ?? '未记录统一社会信用代码' }}</p>
            <ul class="flex flex-col gap-2">
              <li v-for="evidence in row.evidence" :key="evidence.evidenceId" class="break-all text-sm">{{ evidence.sourceFile }} · {{ evidence.attachment ?? '附件未记录' }} · 序号 {{ evidence.listNo ?? '未记录' }} · 页码 {{ evidence.page ?? '未记录' }}</li>
            </ul>
          </article>
        </div>
        <TablePagination v-if="result" :page="result.page" :page-size="result.pageSize" :total="result.total" unit="家·称号" :loading="loading || failed" @update:page="page = $event" @update:page-size="pageSize = $event; page = 1" />
      </CardContent>
    </Card>
    <StatisticsMovementsSection />
    <StatisticsAnnualSection />
    <StatisticsDistrictSection />
  </div>
</template>
