<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { ChevronLeft, GitCompareArrows } from '@lucide/vue'
import { PLATFORM_INTERFACES, PLATFORM_QUERY_STATUSES, PLATFORM_RDJBS } from '~~/lib/labels'
import type { PlatformQueriesResult } from '~~/lib/platform/read'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import PlatformQueryEvidence from '@/components/PlatformQueryEvidence.vue'
import TablePagination from '@/components/TablePagination.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import TableLoadingStatus from '@/components/TableLoadingStatus.vue'

const route = useRoute()
const enterpriseId = computed(() => typeof route.query.enterpriseId === 'string' ? route.query.enterpriseId || undefined : undefined)
const queryKey = computed(() => typeof route.query.queryKey === 'string' ? route.query.queryKey || undefined : undefined)
const scope = computed(() => JSON.stringify([enterpriseId.value, queryKey.value]))
const page = ref(1)
const pageSize = ref(50)
const data = shallowRef<PlatformQueriesResult>()
const isLoading = ref(false)
const error = ref('')
let generation = 0
let controller: AbortController | undefined
const params = computed(() => ({ enterpriseId: enterpriseId.value, queryKey: queryKey.value, view: 'summary' as const, page: page.value, pageSize: pageSize.value }))
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
// The public archive API has no revision token. Invalidate on every observable
// summary identity change; never invent a version/cursor from missing fields.
const identity = (row: PlatformQueriesResult['rows'][number]) => JSON.stringify([scope.value, row.query])
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4" :aria-busy="isLoading">
    <PageHeader title="平台查询证据">
      <template #breadcrumb><NuxtLink to="/comparison" class="hover:underline">两侧名录比对</NuxtLink><span> / 平台查询证据</span></template>
      <template #description>查询摘要先加载；关系和原文按需读取。查询失败、未查询、无记录与查询成功分别显示。</template>
      <template #actions><NuxtLink to="/comparison" class="text-muted-foreground inline-flex items-center gap-1 text-xs"><ChevronLeft class="size-3.5" />返回比对</NuxtLink></template>
    </PageHeader>
    <div class="relative h-6"><TableLoadingStatus kind="comparison" :loading="isLoading" label="正在加载查询摘要…" /></div>
    <p class="text-muted-foreground break-all text-xs" aria-live="polite">
      共 {{ data?.total ?? '尚未加载' }} 次查询 · 显示第 {{ sourcePage }} 页
      <template v-if="queryKey"> · 查询键 {{ queryKey }}</template><template v-if="enterpriseId"> · 企业 #{{ enterpriseId }}</template>
    </p>
    <TableFailureState v-if="error" :title="`查询摘要第 ${page} 页加载失败`" :description="`${error}${data ? `；保留第 ${sourcePage} 页结果。` : ''}`" :pending="isLoading" @retry="load" />
    <template v-if="isLoading && !rows.length"><Skeleton v-for="i in 3" :key="i" class="h-24 w-full" /></template>
    <Empty v-else-if="!error && !rows.length"><EmptyHeader><EmptyMedia variant="icon"><GitCompareArrows /></EmptyMedia><EmptyTitle>暂无平台查询证据</EmptyTitle><EmptyDescription>这个查询键或企业还没有落库的平台查询记录。</EmptyDescription></EmptyHeader></Empty>
    <Card v-for="row in rows" :key="identity(row)" class="min-w-0 gap-0 overflow-hidden py-0" :data-query-id="row.query.id">
      <CardHeader class="gap-2 border-b px-5 py-4">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{{ label(PLATFORM_INTERFACES, row.query.interface) }}</Badge>
          <Badge variant="secondary">{{ PLATFORM_RDJBS[row.query.rdjb] ?? (row.query.rdjb || '未记录') }}</Badge>
          <Badge :variant="statusVariant(row.query.status)">{{ label(PLATFORM_QUERY_STATUSES, row.query.status) }}</Badge>
          <span class="text-muted-foreground break-all font-mono text-xs">{{ row.query.queryKey }}</span>
          <span class="text-muted-foreground text-xs">查询 #{{ row.query.id }} · {{ row.query.queriedAt }} · {{ row.query.relationCount }} 条关系</span>
          <NuxtLink v-if="row.query.interface === 'business_list'" :to="{ path: '/platform-business-processes', query: { q: row.query.queryKey } }" class="text-xs hover:underline">本地办理记录</NuxtLink>
          <NuxtLink v-if="row.query.interface === 'recognized_list'" :to="{ path: '/platform-recognized-directory', query: recognizedDirectoryQuery(row.query.queryKey) }" class="text-xs hover:underline">本地目录记录</NuxtLink>
        </div>
        <p v-if="row.query.failureReason" class="text-destructive break-all text-xs">失败原因：{{ row.query.failureReason }}</p>
        <p class="text-muted-foreground text-xs">摘要未携带关系内容、采集原档和响应原文；尚未加载的字段请展开后读取，各项进度分别显示。</p>
      </CardHeader>
      <CardContent class="p-0"><PlatformQueryEvidence :query-id="row.query.id" /></CardContent>
    </Card>
    <TablePagination :page="sourcePage" :page-size="sourcePageSize" :total="data?.total ?? 0" :loading="isLoading" unit="次查询" @update:page="page = $event" @update:page-size="pageSize = $event; page = 1" />
  </div>
</template>
