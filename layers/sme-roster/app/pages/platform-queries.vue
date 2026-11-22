<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { GitCompareArrows } from '@lucide/vue'
import { ENTERPRISE_LIST_TITLE, PLATFORM_INTERFACES, PLATFORM_QUERY_STATUSES, PLATFORM_RDJBS } from '#sme-roster/lib/labels'
import type { PlatformQueriesResult } from '#sme-roster/lib/platform/read'
import { ROSTER_LEDGER_PATH } from '#sme-roster/lib/sme-roster/routes'
import { Badge } from '#core/app/components/ui/badge'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '#core/app/components/ui/breadcrumb'
import { Card, CardContent, CardHeader } from '#core/app/components/ui/card'
import { Skeleton } from '#core/app/components/ui/skeleton'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '#core/app/components/ui/empty'
import PageHeader from '#core/app/components/PageHeader.vue'
import RosterPlatformQueryEvidence from '#sme-roster/app/components/PlatformQueryEvidence.vue'
import TablePagination from '#core/app/components/TablePagination.vue'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import TableLoadingStatus from '#core/app/components/TableLoadingStatus.vue'

const route = useRoute()
const enterpriseId = computed(() => typeof route.query.enterpriseId === 'string' ? route.query.enterpriseId || undefined : undefined)
const queryKey = computed(() => typeof route.query.queryKey === 'string' ? route.query.queryKey || undefined : undefined)
const queryId = computed(() => {
  const id = route.query.queryId
  // Empty or repeated query IDs must fail validation instead of opening all queries.
  return id === undefined || typeof id === 'string' ? id : ''
})
const scope = computed(() => JSON.stringify([enterpriseId.value, queryKey.value, queryId.value]))
const page = ref(1)
const pageSize = ref(50)
const data = shallowRef<PlatformQueriesResult>()
const isLoading = ref(false)
const error = ref('')
let generation = 0
let controller: AbortController | undefined
const params = computed(() => ({ enterpriseId: enterpriseId.value, queryKey: queryKey.value, queryId: queryId.value, view: 'summary' as const, page: page.value, pageSize: pageSize.value }))
async function load() {
  const request = ++generation
  controller?.abort()
  controller = new AbortController()
  isLoading.value = true
  error.value = ''
  try {
    const result = await $fetch<PlatformQueriesResult>('/api/platform/queries', { query: params.value, signal: controller.signal, retry: 0 })
    if (request === generation) data.value = result
  } catch (cause) { if (request === generation) error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (request === generation) isLoading.value = false }
}
watch(scope, () => { ++generation; controller?.abort(); data.value = undefined; page.value = 1 }, { flush: 'sync' })
watch(params, () => { void load() }, { immediate: true })
onBeforeUnmount(() => { ++generation; controller?.abort() })
const rows = computed(() => data.value?.rows ?? [])
const sourcePage = computed(() => data.value?.page ?? page.value)
const sourcePageSize = computed(() => data.value?.pageSize ?? pageSize.value)
const parentPage = computed(() => {
  if (queryId.value !== undefined) {
    switch (rows.value[0]?.query.interface) {
      case 'apply_list': return { path: '/platform-declarations', title: '申报记录' }
      case 'business_list': return { path: '/platform-business-processes', title: '关联办理' }
      case 'recognized_list': return { path: '/platform-recognized-directory', title: '平台认定目录' }
    }
  }
  return { path: ROSTER_LEDGER_PATH, title: ENTERPRISE_LIST_TITLE }
})
const statusVariant = (status: string) => status === 'failed' ? 'destructive' : status === 'success' ? 'secondary' : 'quiet'
const label = (map: Record<string, string>, code: string) => map[code] ?? code
/** Secondary entry only: q matches enterprise name/USCC, so only those keys map to a filter. */
const USCC_LIKE_KEY = /^[0-9A-Z]{18}$/i
const recognizedDirectoryQuery = (key: string) => {
  if (USCC_LIKE_KEY.test(key)) return { q: key }
  if (key.startsWith('name:')) {
    const name = key.slice('name:'.length).trim()
    return name ? { q: name } : {}
  }
  return {}
}
// Recreate the lazy detail when the selected query changes.
const identity = (row: PlatformQueriesResult['rows'][number]) => JSON.stringify([scope.value, row.query])
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4" :aria-busy="isLoading">
    <PageHeader title="平台查询历史">
      <template #breadcrumb>
        <Breadcrumb aria-label="页面路径">
          <BreadcrumbList class="text-xs">
            <BreadcrumbItem>
              <BreadcrumbLink as-child class="hover:underline focus-visible:underline motion-reduce:transition-none">
                <NuxtLink :to="parentPage.path">{{ parentPage.title }}</NuxtLink>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem><BreadcrumbPage>平台查询历史</BreadcrumbPage></BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </template>
    </PageHeader>
    <div class="relative" :class="{ 'min-h-6': isLoading }">
      <TableLoadingStatus kind="comparison" :loading="isLoading" label="正在加载平台查询历史…" />
      <p v-if="data || queryKey || enterpriseId || queryId" class="text-muted-foreground wrap-anywhere text-xs" aria-live="polite">
        <template v-if="queryId">原查询 #{{ queryId }}</template>
        <template v-else-if="data">共 {{ data.total.toLocaleString('zh-CN') }} 次查询 · 第 {{ sourcePage }} 页</template>
        <template v-if="queryKey"><span v-if="data || queryId"> · </span>查询键 {{ queryKey }}</template>
        <template v-if="enterpriseId"><span v-if="data || queryId || queryKey"> · </span>企业 #{{ enterpriseId }}</template>
      </p>
    </div>
    <TableFailureState v-if="error" :title="`查询摘要第 ${page} 页加载失败`" :description="`${error}${data ? `；保留第 ${sourcePage} 页结果。` : ''}`" :pending="isLoading" @retry="load" />
    <template v-if="isLoading && !rows.length"><Skeleton v-for="i in 3" :key="i" class="h-24 w-full" /></template>
    <Empty v-else-if="!error && !rows.length"><EmptyHeader><EmptyMedia variant="icon"><GitCompareArrows aria-hidden="true" /></EmptyMedia><EmptyTitle>{{ queryId ? '未找到原查询' : '暂无平台查询历史' }}</EmptyTitle></EmptyHeader></Empty>
    <Card v-for="row in rows" :key="identity(row)" class="min-w-0 gap-0 overflow-hidden py-0" :data-query-id="row.query.id">
      <CardHeader class="gap-2 border-b px-5 py-4">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{{ label(PLATFORM_INTERFACES, row.query.interface) }}</Badge>
          <Badge variant="secondary">{{ PLATFORM_RDJBS[row.query.rdjb] ?? (row.query.rdjb || '未记录') }}</Badge>
          <Badge :variant="statusVariant(row.query.status)">{{ label(PLATFORM_QUERY_STATUSES, row.query.status) }}</Badge>
          <span class="text-muted-foreground break-all font-mono text-xs">{{ row.query.queryKey }}</span>
          <span class="text-muted-foreground text-xs">查询 #{{ row.query.id }} · {{ row.query.queriedAt }} · {{ row.query.relationCount }} 条记录</span>
          <NuxtLink v-if="row.query.interface === 'business_list'" :to="{ path: '/platform-business-processes', query: { q: row.query.queryKey } }" class="text-xs hover:underline">本地办理记录</NuxtLink>
          <NuxtLink v-if="row.query.interface === 'recognized_list'" :to="{ path: '/platform-recognized-directory', query: recognizedDirectoryQuery(row.query.queryKey) }" class="text-xs hover:underline">本地目录记录</NuxtLink>
        </div>
        <p v-if="row.query.failureReason" class="text-destructive break-all text-xs">失败原因：{{ row.query.failureReason }}</p>
      </CardHeader>
      <CardContent class="p-0"><RosterPlatformQueryEvidence :query-id="row.query.id" /></CardContent>
    </Card>
    <TablePagination v-if="queryId === undefined && rows.length" :page="sourcePage" :page-size="sourcePageSize" :total="data?.total ?? 0" :loading="isLoading" unit="次查询" @update:page="page = $event" @update:page-size="pageSize = $event; page = 1" />
  </div>
</template>
