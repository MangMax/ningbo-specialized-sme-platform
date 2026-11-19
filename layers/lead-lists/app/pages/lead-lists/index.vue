<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery } from '@pinia/colada'
import { FileText, Plus } from '@lucide/vue'
import PageHeader from '#core/app/components/PageHeader.vue'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import TableLoadingStatus from '#core/app/components/TableLoadingStatus.vue'
import { Button } from '#core/app/components/ui/button'
import { Badge } from '#core/app/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '#core/app/components/ui/card'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '#core/app/components/ui/empty'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#core/app/components/ui/table'
import type { LeadCatalog, LeadRow, LeadVersionDetail } from '../../../lib/contracts'
import LeadListRegistration from '../../components/LeadListRegistration.vue'
import LeadListSupplement from '../../components/LeadListSupplement.vue'

const route = useRoute()
const router = useRouter()
const registration = ref(false)
const reviewing = ref<LeadRow | null>(null)
const catalog = useQuery({
  key: () => ['lead-lists', 'versions'],
  query: () => $fetch<LeadCatalog>('/api/lead-lists/versions'), placeholderData: previous => previous,
})
const routeId = computed(() => {
  const raw = route.query.version
  return typeof raw === 'string' && /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : undefined
})
const versions = computed(() => catalog.data.value?.versions ?? [])
const activeVersion = computed(() => routeId.value ?? versions.value[0]?.id)
const selectedSeries = computed(() => versions.value.find(version => version.id === activeVersion.value)?.series ?? '')
const series = computed(() => [...new Set(versions.value.map(version => version.series))])
const displayedVersions = computed(() => versions.value.filter(version => version.series === selectedSeries.value))
const detail = useQuery({
  key: () => ['lead-lists', 'detail', activeVersion.value ?? 0],
  query: ({ entry }) => $fetch<LeadVersionDetail>(`/api/lead-lists/versions/${entry.key[2]}`),
  enabled: () => Boolean(activeVersion.value),
  placeholderData: previous => previous,
})
const displayed = computed(() => detail.data.value)
const showingActive = computed(() => displayed.value?.id === activeVersion.value)
const sourceLabels = computed(() => new Map(catalog.data.value?.channels.map(item => [item.code, item.name])))
const listTypeLabels = computed(() => new Map(catalog.data.value?.listTypes.map(item => [item.code, item.name])))

function navigate(id: number) {
  if (Number.isSafeInteger(id) && id > 0) void router.push({ query: { ...route.query, version: String(id) } })
}
function switchSeries(name: unknown) {
  const first = versions.value.find(item => item.series === name)
  if (first) navigate(first.id)
}
function registered(id: number) {
  navigate(id)
  void catalog.refetch()
}
function supplemented() {
  reviewing.value = null
  void detail.refetch()
}
useHead({ title: '线索名单' })
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <PageHeader title="线索名单">
      <template #actions><Button :disabled="!catalog.data.value" @click="registration = true"><Plus aria-hidden="true" />登记版本</Button></template>
    </PageHeader>
    <LeadListRegistration v-if="catalog.data.value" v-model:open="registration" :catalog="catalog.data.value" @registered="registered" />
    <TableFailureState v-if="catalog.error.value" title="名单目录加载失败" :compact="Boolean(catalog.data.value)" :description="catalog.data.value ? '仍显示上次读取的名单目录。' : '请重新加载名单目录。'" :pending="catalog.isLoading.value" @retry="catalog.refetch()" />
    <div v-if="versions.length" class="flex flex-wrap items-center gap-2">
      <Select :model-value="selectedSeries" @update:model-value="switchSeries">
        <SelectTrigger aria-label="所属系列" class="max-w-full"><SelectValue placeholder="选择系列" /></SelectTrigger>
        <SelectContent><SelectItem v-for="item in series" :key="item" :value="item">{{ item }}</SelectItem></SelectContent>
      </Select>
      <Select :model-value="String(activeVersion ?? '')" @update:model-value="navigate(Number($event))">
        <SelectTrigger aria-label="名单版本" class="max-w-full"><SelectValue placeholder="选择版本" /></SelectTrigger>
        <SelectContent><SelectItem v-for="item in displayedVersions" :key="item.id" :value="String(item.id)">{{ item.acquiredOn }} · {{ item.fileName }}</SelectItem></SelectContent>
      </Select>
    </div>
    <Card v-if="activeVersion" class="relative min-w-0 gap-0 overflow-hidden py-0 shadow-none">
      <TableLoadingStatus kind="ledger" :loading="detail.isLoading.value" label="正在读取名单…" />
      <TableFailureState v-if="detail.error.value" title="名单版本加载失败" :compact="Boolean(displayed)" :description="displayed ? '仍显示上次成功读取的版本。' : '请重新加载所选版本。'" :pending="detail.isLoading.value" @retry="detail.refetch()" />
      <template v-if="displayed">
        <CardHeader class="gap-2 border-b px-4 py-4">
          <CardTitle><h2 class="wrap-anywhere">{{ displayed.series }} · {{ displayed.acquiredOn }}</h2></CardTitle>
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{{ sourceLabels.get(displayed.channel) ?? displayed.channel }}</Badge>
            <Badge variant="outline">{{ listTypeLabels.get(displayed.listType) ?? displayed.listType }}</Badge>
            <Button v-if="displayed.fileAvailable" variant="link" size="sm" class="h-auto max-w-full whitespace-normal" as-child>
              <a :href="`/api/lead-lists/versions/${displayed.id}/source`" download><FileText aria-hidden="true" /><span class="wrap-anywhere">{{ displayed.fileName }}</span></a>
            </Button>
            <Badge v-else variant="outline">原文件已移出</Badge>
          </div>
        </CardHeader>
        <CardContent class="p-0">
          <div class="data-table-scroll">
            <Table class="data-table min-w-[700px]">
              <TableHeader><TableRow><TableHead>序号</TableHead><TableHead>企业名称</TableHead><TableHead>统一社会信用代码</TableHead><TableHead>区县</TableHead><TableHead>备注</TableHead><TableHead>基础库</TableHead></TableRow></TableHeader>
              <TableBody><TableRow v-for="item in displayed.rows" :key="item.id">
                <TableCell>{{ item.rowNumber }}</TableCell>
                <TableCell class="max-w-60 whitespace-normal wrap-anywhere">{{ item.name }}</TableCell>
                <TableCell>{{ item.uscc ?? '—' }}</TableCell>
                <TableCell>{{ item.district ?? '—' }}</TableCell>
                <TableCell class="max-w-60 whitespace-normal wrap-anywhere">{{ item.note ?? '—' }}</TableCell>
                <TableCell>
                  <Badge v-if="item.enterpriseId" variant="secondary">已关联</Badge>
                  <Button v-else variant="ghost" size="sm" :disabled="!showingActive || Boolean(detail.error.value)" :aria-label="`补充企业基础库：${item.name}`" @click="reviewing = item">补充</Button>
                </TableCell>
              </TableRow></TableBody>
            </Table>
          </div>
        </CardContent>
      </template>
    </Card>
    <div v-else-if="catalog.isLoading.value" class="relative h-9">
      <TableLoadingStatus kind="ledger" :loading="true" label="正在读取名单目录…" />
    </div>
    <Empty v-else-if="catalog.data.value">
      <EmptyHeader><EmptyMedia variant="icon"><FileText aria-hidden="true" /></EmptyMedia><EmptyTitle>还没有名单版本</EmptyTitle></EmptyHeader>
    </Empty>
    <LeadListSupplement :row="reviewing" :version-id="displayed?.id" @close="reviewing = null" @saved="supplemented" />
  </div>
</template>
