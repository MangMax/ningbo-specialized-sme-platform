<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed } from 'vue'
import { ChevronLeft, GitCompareArrows } from '@lucide/vue'
import {
  PLATFORM_INTERFACES,
  PLATFORM_QUERY_STATUSES,
  PLATFORM_RDJBS,
  RELATION_DECLARE_KINDS,
  RELATION_MATCH_BASES,
  VERIFICATION_STATUSES,
} from '~~/lib/labels'
import type { PlatformQueriesResult, PlatformQueryRow } from '~~/lib/platform/read'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

/**
 * 平台查询证据(RL-03 交付物 3 的「查看」端)。
 *
 * 一个信用代码的多条关联**逐条列出、不折叠**;四态(未查询 / 查询失败 / 无记录 / 查询成功)
 * 各自成徽章 —— **失败不会被显示成「无记录」**。这是代理核对曾用名与**归并/回填**
 * 所依据的原始关系页面。
 */
const route = useRoute()
const enterpriseId = computed(() => {
  const raw = route.query.enterpriseId
  return typeof raw === 'string' && raw ? raw : undefined
})
const queryKey = computed(() => {
  const raw = route.query.queryKey
  return typeof raw === 'string' && raw ? raw : undefined
})

const params = computed(() => ({
  ...(enterpriseId.value ? { enterpriseId: enterpriseId.value } : {}),
  ...(queryKey.value ? { queryKey: queryKey.value } : {}),
  pageSize: 50,
}))

const { data, isLoading, error, refetch } = useQuery({
  key: () => ['platform-queries', params.value],
  query: () => $fetch<PlatformQueriesResult>('/api/platform/queries', { query: params.value }),
  placeholderData: (previous) => previous,
})

const rows = computed<PlatformQueryRow[]>(() => data.value?.rows ?? [])
const totalRelations = computed(() => rows.value.reduce((sum, row) => sum + row.relations.length, 0))

const statusVariant = (status: string) =>
  status === 'failed' ? 'destructive' : status === 'success' ? 'secondary' : 'quiet'
const label = (map: Record<string, string>, code: string) => map[code] ?? code
const rdjbLabel = (rdjb: string) => (rdjb ? (PLATFORM_RDJBS[rdjb] ?? rdjb) : '—')
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <PageHeader class="rise-in" title="平台查询证据">
      <template #breadcrumb>
        <NuxtLink to="/comparison" class="hover:text-foreground hover:underline">两侧名录比对</NuxtLink>
        <span class="mx-1.5">/</span><span>平台查询证据</span>
      </template>
      <template #description>
        <span class="inline-block">工信部平台两个接口取回的原始关系,逐条保留。</span>
        <span class="inline-block">查询失败、未查询、无记录与查询成功分别显示,不互相冒充。</span>
      </template>
      <template #actions>
        <NuxtLink to="/comparison" class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs">
          <ChevronLeft class="size-3.5" />返回比对
        </NuxtLink>
      </template>
    </PageHeader>

    <p v-if="!isLoading && !error" class="text-muted-foreground text-[13px] tabular-nums" aria-live="polite">
      共 {{ rows.length }} 次查询 · {{ totalRelations }} 条关系
      <template v-if="queryKey"> · 查询键 <span class="font-mono">{{ queryKey }}</span></template>
      <template v-if="enterpriseId"> · 企业 #{{ enterpriseId }}</template>
    </p>

    <Alert v-if="error" variant="destructive">
      <AlertTitle>平台证据加载失败</AlertTitle>
      <AlertDescription>
        <button class="text-primary underline" @click="refetch()">重试</button>
      </AlertDescription>
    </Alert>

    <template v-if="isLoading && !rows.length">
      <Card v-for="i in 3" :key="i" class="gap-0 py-0">
        <CardContent class="flex flex-col gap-2 p-5">
          <Skeleton class="h-5 w-56" /><Skeleton class="h-20 w-full" />
        </CardContent>
      </Card>
    </template>

    <Empty v-else-if="!error && !rows.length">
      <EmptyHeader>
        <EmptyMedia variant="icon"><GitCompareArrows /></EmptyMedia>
        <EmptyTitle>暂无平台查询证据</EmptyTitle>
        <EmptyDescription>这个查询键或企业还没有落库的平台查询记录。</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <Card v-for="row in rows" v-else :key="row.query.id" class="min-w-0 gap-0 overflow-hidden py-0">
      <CardHeader class="gap-2 border-b px-5 py-4">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="outline" class="font-normal">{{ label(PLATFORM_INTERFACES, row.query.interface) }}</Badge>
          <Badge variant="secondary" class="font-normal">{{ rdjbLabel(row.query.rdjb) }}</Badge>
          <Badge :variant="statusVariant(row.query.status)" class="font-normal">
            {{ label(PLATFORM_QUERY_STATUSES, row.query.status) }}
          </Badge>
          <span class="text-muted-foreground font-mono text-xs">{{ row.query.queryKey }}</span>
          <span class="text-muted-foreground ml-auto text-xs tabular-nums">
            {{ row.query.queriedAt }} · {{ row.relations.length }} 条关系
          </span>
        </div>
        <p v-if="row.query.failureReason" class="text-destructive text-xs">
          失败原因:{{ row.query.failureReason }}
        </p>
      </CardHeader>
      <CardContent class="p-0">
        <p v-if="!row.relations.length" class="text-muted-foreground px-5 py-4 text-xs">
          这条查询没有关系记录({{ row.query.status === 'no_record' ? '平台返回空' : '未取到关系' }})。
        </p>
        <div v-else class="overflow-x-auto">
          <Table class="min-w-[1040px]">
            <TableHeader>
              <TableRow>
                <TableHead class="w-12">#</TableHead>
                <TableHead class="w-40">主键</TableHead>
                <TableHead class="w-64">企业名称(qymc)</TableHead>
                <TableHead class="w-44">统一社会信用代码</TableHead>
                <TableHead class="w-24">状态</TableHead>
                <TableHead class="w-24">维护批次</TableHead>
                <TableHead class="w-20">类型</TableHead>
                <TableHead class="w-40">申请时间</TableHead>
                <TableHead class="w-24">认定批次</TableHead>
                <TableHead class="w-28">匹配依据</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="relation in row.relations" :key="relation.id" class="[&>td]:py-1.5">
                <TableCell class="text-muted-foreground tabular-nums">{{ relation.sequenceNo }}</TableCell>
                <TableCell class="font-mono text-xs">{{ relation.relationKey ?? '—' }}</TableCell>
                <TableCell class="font-medium">
                  {{ relation.nameRaw ?? '—' }}
                  <span v-if="relation.nameRaw && relation.matchedName && relation.nameRaw !== relation.matchedName" class="text-muted-foreground ml-1 text-xs">
                    → {{ relation.matchedName }}
                  </span>
                </TableCell>
                <TableCell class="text-muted-foreground font-mono text-xs">{{ relation.usccRaw ?? '—' }}</TableCell>
                <TableCell class="text-xs">{{ relation.status ?? '—' }}</TableCell>
                <TableCell class="text-muted-foreground text-xs">{{ relation.batch ?? '—' }}</TableCell>
                <TableCell class="text-muted-foreground text-xs">
                  {{ relation.declareKind ? label(RELATION_DECLARE_KINDS, relation.declareKind) : '—' }}
                </TableCell>
                <TableCell class="text-muted-foreground text-xs tabular-nums">{{ relation.appliedAt ?? '—' }}</TableCell>
                <TableCell class="text-muted-foreground text-xs">{{ relation.awardBatchLabel ?? '—' }}</TableCell>
                <TableCell class="text-xs">
                  <Badge :variant="relation.verificationStatus === 'confirmed' ? 'secondary' : 'quiet'" class="font-normal">
                    {{ label(RELATION_MATCH_BASES, relation.matchBasis) }}
                  </Badge>
                  <span class="text-muted-foreground ml-1 text-xs">
                    {{ label(VERIFICATION_STATUSES, relation.verificationStatus) }}
                  </span>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
