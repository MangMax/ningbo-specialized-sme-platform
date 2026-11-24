<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import { ArrowLeft, FileText } from '@lucide/vue'
import DataTableCard from '#core/app/components/DataTableCard.vue'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import TableLoadingStatus from '#core/app/components/TableLoadingStatus.vue'
import TablePagination from '#core/app/components/TablePagination.vue'
import WorkspacePage from '#core/app/components/WorkspacePage.vue'
import { Button } from '#core/app/components/ui/button'
import { Badge } from '#core/app/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#core/app/components/ui/table'
import type { LeadCatalog, LeadRow, LeadVersionDetail } from '../../../lib/contracts'
import LeadListRegistration from '../../components/LeadListRegistration.vue'
import LeadListCatalog from '../../components/LeadListCatalog.vue'
import LeadListExport from '../../components/LeadListExport.vue'
import LeadListSupplement from '../../components/LeadListSupplement.vue'

const route = useRoute()
const router = useRouter()
const registration = ref(false)
const reviewing = ref<{ row: LeadRow; versionId: number } | null>(null)
const catalog = useQuery({
  key: () => ['lead-lists', 'versions'],
  query: () => $fetch<LeadCatalog>('/api/lead-lists/versions'), placeholderData: previous => previous,
})
const activeVersion = computed(() => {
  const raw = route.query.version
  return typeof raw === 'string' && /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : undefined
})
const catalogDestination = computed(() => ({ query: { ...route.query, version: undefined, exportJob: undefined } }))
const detailHeader = useTemplateRef('detail-header')
watch(activeVersion, id => {
  if (id) detailHeader.value?.focus({ preventScroll: true })
}, { flush: 'post' })
const detail = useQuery({
  key: () => ['lead-lists', 'detail', activeVersion.value ?? 0],
  query: ({ entry }) => $fetch<LeadVersionDetail>(`/api/lead-lists/versions/${entry.key[2]}`),
  enabled: () => Boolean(activeVersion.value),
  placeholderData: previous => previous,
})
const displayed = computed(() => detail.data.value)
const page = ref(1)
const pageSize = ref(25)
const tableScroll = useTemplateRef('lead-rows')
const total = computed(() => displayed.value?.rows.length ?? 0)
const visibleRows = computed(() => displayed.value?.rows.slice((page.value - 1) * pageSize.value, page.value * pageSize.value) ?? [])
watch(() => displayed.value?.id, () => { page.value = 1 })
watch([page, pageSize, () => displayed.value?.id], () => tableScroll.value?.scrollTo({ top: 0 }), { flush: 'post' })
function resize(size: number) {
  pageSize.value = size
  page.value = 1
}

const showingActive = computed(() => displayed.value?.id === activeVersion.value)
const sourceLabels = computed(() => new Map(catalog.data.value?.channels.map(item => [item.code, item.name])))
const listTypeLabels = computed(() => new Map(catalog.data.value?.listTypes.map(item => [item.code, item.name])))

function navigate(id: number) {
  if (Number.isSafeInteger(id) && id > 0) void router.push({ query: { ...route.query, version: String(id), exportJob: undefined } })
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
  <WorkspacePage title="线索名单">
    <LeadListRegistration v-if="catalog.data.value" v-model:open="registration" :catalog="catalog.data.value" @registered="registered" />
    <LeadListCatalog
      v-show="!activeVersion"
      :catalog="catalog.data.value" :loading="catalog.isLoading.value" :failed="Boolean(catalog.error.value)"
      @register="registration = true" @retry="catalog.refetch()"
    />
    <DataTableCard v-if="activeVersion">
      <template #status>
        <TableLoadingStatus kind="ledger" :loading="detail.isLoading.value" label="正在读取名单…" />
      </template>

      <template #toolbar>
        <div ref="detail-header" tabindex="-1" class="outline-none">
          <Button as-child variant="ghost" size="sm">
            <NuxtLink :to="catalogDestination" replace><ArrowLeft aria-hidden="true" />返回名单目录</NuxtLink>
          </Button>
        </div>
      </template>

      <TableFailureState v-if="catalog.error.value" title="名单目录加载失败" compact :pending="catalog.isLoading.value" @retry="catalog.refetch()" />
      <TableFailureState v-if="detail.error.value" title="名单详情加载失败" :compact="Boolean(displayed)" :description="displayed ? '仍显示上次成功读取的名单。' : undefined" :pending="detail.isLoading.value" @retry="detail.refetch()" />
      <template v-if="displayed">
        <div class="flex shrink-0 flex-col gap-2 border-b px-4 py-4">
          <h2 class="wrap-anywhere text-base leading-none font-semibold tracking-tight">{{ displayed.series }} · {{ displayed.acquiredOn }}</h2>
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="outline">类型 {{ listTypeLabels.get(displayed.listType) ?? displayed.listType }}</Badge>
            <Badge variant="outline">来源 {{ sourceLabels.get(displayed.channel) ?? displayed.channel }}</Badge>
            <Button v-if="displayed.fileAvailable" variant="link" size="sm" class="h-auto max-w-full whitespace-normal" as-child>
              <a :href="`/api/lead-lists/versions/${displayed.id}/source`" download><FileText aria-hidden="true" /><span class="wrap-anywhere">{{ displayed.fileName }}</span></a>
            </Button>
            <Badge v-else variant="outline">原文件已移出</Badge>
          </div>
          <LeadListExport :key="displayed.id" :version-id="displayed.id" :disabled="!showingActive || Boolean(detail.error.value)" />
        </div>
        <div ref="lead-rows" class="data-table-scroll" role="region" aria-label="名单企业" tabindex="0">
          <Table class="data-table table-fixed sm:min-w-[700px]">
            <TableHeader><TableRow><TableHead class="w-14">序号</TableHead><TableHead>企业名称</TableHead><TableHead class="hidden w-44 sm:table-cell">统一社会信用代码</TableHead><TableHead class="hidden w-24 sm:table-cell">区县</TableHead><TableHead class="hidden sm:table-cell">备注</TableHead><TableHead class="w-20">基础库</TableHead></TableRow></TableHeader>
            <TableBody><TableRow v-for="item in visibleRows" :key="item.id">
              <TableCell>{{ item.rowNumber }}</TableCell>
              <TableCell class="whitespace-normal wrap-anywhere">
                <div class="font-medium">{{ item.name }}</div>
                <dl v-if="item.uscc || item.district || item.note" class="text-muted-foreground mt-1 space-y-0.5 text-xs sm:hidden">
                  <div v-if="item.uscc"><dt class="sr-only">统一社会信用代码</dt><dd class="font-mono">{{ item.uscc }}</dd></div>
                  <div v-if="item.district"><dt class="sr-only">区县</dt><dd>{{ item.district }}</dd></div>
                  <div v-if="item.note"><dt class="sr-only">备注</dt><dd>{{ item.note }}</dd></div>
                </dl>
              </TableCell>
              <TableCell class="hidden whitespace-normal wrap-anywhere sm:table-cell">{{ item.uscc ?? '—' }}</TableCell>
              <TableCell class="hidden whitespace-normal sm:table-cell">{{ item.district ?? '—' }}</TableCell>
              <TableCell class="hidden whitespace-normal wrap-anywhere sm:table-cell">{{ item.note ?? '—' }}</TableCell>
              <TableCell>
                <Badge v-if="item.enterpriseId" variant="secondary">已关联</Badge>
                <Button v-else variant="ghost" size="sm" :disabled="!showingActive || Boolean(detail.error.value)" :aria-label="`补充企业基础库：${item.name}`" @click="reviewing = { row: item, versionId: displayed.id }">补充</Button>
              </TableCell>
            </TableRow></TableBody>
          </Table>
        </div>
      </template>

      <template #footer>
        <TablePagination
          v-if="total > 0" in-card :page="page" :page-size="pageSize" :total="total"
          :loading="!showingActive || detail.isLoading.value || Boolean(detail.error.value)" unit="家"
          @update:page="page = $event" @update:page-size="resize"
        />
      </template>
    </DataTableCard>
    <LeadListSupplement :row="reviewing?.row ?? null" :version-id="reviewing?.versionId" @close="reviewing = null" @saved="supplemented" />
  </WorkspacePage>
</template>
