<script setup lang="ts">
import { projectionDisplay } from '~~/lib/platform/projection-display'
import { computed } from 'vue'
import { ExternalLink, History } from '@lucide/vue'
import type { DeclarationRow } from '~~/lib/platform/declarations'
import { formatFetchTime } from '~~/lib/reconcile-time'
import { PLATFORM_RDJBS, RELATION_DECLARE_KINDS } from '~~/lib/labels'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const props = defineProps<{ view: 'records' | 'isolated'; rows: DeclarationRow[]; loading?: boolean }>()
const emit = defineEmits<{ 'open-record': [recordId: number] }>()

const records = computed(() => props.rows.filter((row): row is Extract<DeclarationRow, { kind: 'record' }> => row.kind === 'record'))
const isolated = computed(() => props.rows.filter((row): row is Extract<DeclarationRow, { kind: 'observation' }> => row.kind === 'observation'))
const missing = (value: string | number | null | undefined) => value === null || value === undefined || value === '' ? '未提供' : String(value)
const titleLabel = (value: string | null | undefined) => PLATFORM_RDJBS[value ?? ''] ?? missing(value)
const declareKind = (value: string | null) => value ? RELATION_DECLARE_KINDS[value] ?? value : '未提供'
const time = (value: string | null) => value ? formatFetchTime(value) ?? value : '未提供'
const enterprise = (row: Extract<DeclarationRow, { kind: 'record' }>) => {
  if (row.enterpriseNames.length === 1) return row.enterpriseNames[0]!
  if (row.enterpriseNames.length > 1) return `${row.enterpriseNames.length} 家企业归属冲突`
  return row.matchedVersion.nameRaw ?? '未匹配主体'
}
const enterpriseId = (row: Extract<DeclarationRow, { kind: 'record' }>) => row.enterpriseIds.length === 1 ? row.enterpriseIds[0]! : null
const conflictLabel: Record<string, string> = {
  enterprise_assignment_conflict: '企业归属冲突',
  unverifiable_observation: '存在内容未核实观察',
}
</script>

<template>
  <div class="min-w-0" data-testid="platform-declaration-table">
    <template v-if="view === 'records'">
      <p v-if="records.length" class="text-muted-foreground mb-2 text-table leading-5 sm:hidden">点开「版本详情」查看完整字段、内容版本。</p>
      <div v-if="records.length" class="data-table-scroll hidden sm:block [&_[data-slot=table-container]]:overflow-visible">
        <Table class="data-table min-w-[980px] table-fixed 2xl:min-w-[1080px]" aria-label="申报记录">
          <TableHeader>
            <TableRow class="hover:bg-transparent">
              <TableHead class="w-[19%]">企业</TableHead>
              <TableHead class="w-[14%] whitespace-nowrap">称号</TableHead>
              <TableHead class="w-[8%] whitespace-nowrap">事项</TableHead>
              <TableHead class="w-[6%] whitespace-nowrap">年度</TableHead>
              <TableHead class="w-[9%] whitespace-nowrap">状态</TableHead>
              <TableHead class="w-[13%] whitespace-nowrap">申报时间</TableHead>
              <TableHead class="w-[9%] whitespace-nowrap">版本</TableHead>
              <TableHead class="hidden w-[12%] whitespace-nowrap 2xl:table-cell">最近采集</TableHead>
              <TableHead class="sticky right-0 z-20 w-[13%] border-l bg-muted">详情</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="row in records" :key="row.record.id" class="align-top" data-testid="platform-declaration-row" :data-record-id="row.record.id">
              <TableCell class="whitespace-normal break-words [overflow-wrap:anywhere]">
                <NuxtLink v-if="enterpriseId(row) != null" :to="`/enterprises/${enterpriseId(row)}`" class="font-medium hover:underline">{{ enterprise(row) }}</NuxtLink>
                <span v-else class="font-medium">{{ enterprise(row) }}</span>
                <span class="text-muted-foreground mt-1 block break-all font-mono text-xs">{{ projectionDisplay(row.matchedVersion, row.matchedVersion.usccRaw) }}</span>
              </TableCell>
              <TableCell class="whitespace-normal">{{ projectionDisplay(row.matchedVersion, row.matchedVersion.titleRaw, titleLabel) }}</TableCell>
              <TableCell class="whitespace-normal break-words">{{ projectionDisplay(row.matchedVersion, row.matchedVersion.declareKind, declareKind) }}</TableCell>
              <TableCell class="break-words tabular-nums">{{ projectionDisplay(row.matchedVersion, row.matchedVersion.declarationYear) }}</TableCell>
              <TableCell class="whitespace-normal break-words">{{ projectionDisplay(row.matchedVersion, row.matchedVersion.status) }}</TableCell>
              <TableCell class="whitespace-normal break-words tabular-nums">{{ projectionDisplay(row.matchedVersion, row.matchedVersion.appliedAt, time) }}</TableCell>
              <TableCell class="tabular-nums">{{ row.versionCount }}<span v-if="row.matchedVersionCount > 1" class="text-muted-foreground block text-xs">匹配 {{ row.matchedVersionCount }} 个版本</span></TableCell>
              <TableCell class="hidden whitespace-nowrap tabular-nums 2xl:table-cell">{{ time(row.latestObservationAt) }}</TableCell>
              <TableCell class="sticky right-0 z-10 border-l bg-card">
                <Button variant="ghost" size="sm" :disabled="loading" @click="emit('open-record', row.record.id)"><History data-icon="inline-start" />版本详情</Button>
                <span v-for="conflict in row.conflicts" :key="conflict" class="text-muted-foreground mt-1 block text-xs">{{ conflictLabel[conflict] ?? conflict }}</span>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <ul v-if="records.length" class="flex flex-col divide-y sm:hidden" aria-label="申报记录列表">
        <li v-for="row in records" :key="row.record.id" class="flex min-w-0 flex-col gap-1.5 p-3" data-testid="platform-declaration-card" :data-record-id="row.record.id">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <NuxtLink v-if="enterpriseId(row) != null" :to="`/enterprises/${enterpriseId(row)}`" class="font-medium break-words hover:underline">{{ enterprise(row) }}</NuxtLink>
              <p v-else class="font-medium break-words">{{ enterprise(row) }}</p>
              <p class="text-muted-foreground break-all font-mono text-xs">{{ projectionDisplay(row.matchedVersion, row.matchedVersion.usccRaw) }}</p>
            </div>
            <Button variant="outline" size="sm" class="min-h-11 shrink-0" :disabled="loading" @click="emit('open-record', row.record.id)"><History data-icon="inline-start" />版本详情</Button>
          </div>
          <p class="text-sm font-medium leading-5">{{ projectionDisplay(row.matchedVersion, row.matchedVersion.titleRaw, titleLabel) }}</p>
          <p class="text-sm leading-5">{{ projectionDisplay(row.matchedVersion, row.matchedVersion.declareKind, declareKind) }} · 年度 {{ projectionDisplay(row.matchedVersion, row.matchedVersion.declarationYear) }} · {{ projectionDisplay(row.matchedVersion, row.matchedVersion.status) }}</p>
          <p class="text-muted-foreground text-sm leading-5">申报时间 {{ projectionDisplay(row.matchedVersion, row.matchedVersion.appliedAt, time) }} · 版本 {{ row.versionCount }}</p>
          <p class="text-muted-foreground text-sm leading-5">最近采集 {{ time(row.latestObservationAt) }}</p>
          <p v-for="conflict in row.conflicts" :key="conflict" class="text-muted-foreground text-xs">{{ conflictLabel[conflict] ?? conflict }}</p>
        </li>
      </ul>
    </template>

    <template v-else>
      <p v-if="isolated.length" class="text-muted-foreground mb-2 text-table leading-5 sm:hidden">缺编号或内容不可核实的观察逐条隔离；点开「查看原查询」核对来源。</p>
      <div v-if="isolated.length" class="data-table-scroll hidden sm:block [&_[data-slot=table-container]]:overflow-visible">
        <Table class="data-table min-w-[980px] table-fixed 2xl:min-w-[1080px]" aria-label="缺编号观察">
          <TableHeader>
            <TableRow class="hover:bg-transparent">
              <TableHead class="w-[14%]">原行 / 查询</TableHead>
              <TableHead class="w-[21%]">企业原值</TableHead>
              <TableHead class="w-[14%] whitespace-nowrap">称号</TableHead>
              <TableHead class="w-[8%] whitespace-nowrap">事项</TableHead>
              <TableHead class="w-[6%] whitespace-nowrap">年度</TableHead>
              <TableHead class="w-[9%] whitespace-nowrap">状态</TableHead>
              <TableHead class="w-[11%] whitespace-nowrap">申报时间</TableHead>
              <TableHead class="hidden w-[10%] whitespace-nowrap 2xl:table-cell">采集</TableHead>
              <TableHead class="w-[10%]">隔离原因</TableHead>
              <TableHead class="sticky right-0 z-20 w-[11%] border-l bg-muted">查询证据</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="row in isolated" :key="row.relationId" class="align-top" data-testid="platform-declaration-isolated-row" :data-relation-id="row.relationId">
              <TableCell class="whitespace-nowrap">行 #{{ row.relationId }} · 查询 #{{ row.queryId }}</TableCell>
              <TableCell class="whitespace-normal break-words [overflow-wrap:anywhere]">{{ missing(row.nameRaw) }}<span class="text-muted-foreground mt-1 block break-all font-mono text-xs">{{ missing(row.usccRaw) }}</span><span v-if="row.enterpriseName" class="text-muted-foreground mt-1 block text-xs">已归属 {{ row.enterpriseName }}</span></TableCell>
              <TableCell class="whitespace-normal">{{ titleLabel(row.titleRaw) }}</TableCell>
              <TableCell class="whitespace-nowrap">{{ declareKind(row.declareKind) }}</TableCell>
              <TableCell class="tabular-nums">{{ missing(row.declarationYear) }}</TableCell>
              <TableCell class="whitespace-nowrap">{{ missing(row.status) }}</TableCell>
              <TableCell class="tabular-nums">{{ time(row.appliedAt) }}</TableCell>
              <TableCell class="hidden tabular-nums 2xl:table-cell">{{ time(row.queriedAt) }}</TableCell>
              <TableCell class="text-xs">
                <span v-if="row.identityState === 'missing_key'">缺少平台业务编号</span>
                <span v-else-if="row.identityState === 'conflict'">平台编号冲突</span>
                <span v-if="row.contentState === 'unverifiable'">原文内容无法核实</span>
              </TableCell>
              <TableCell class="sticky right-0 z-10 border-l bg-card">
                <NuxtLink :to="{ path: '/platform-queries', query: { queryKey: row.queryKey } }" class="inline-flex items-center gap-1 text-xs hover:underline">查看原查询<ExternalLink class="size-3" /></NuxtLink>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <ul v-if="isolated.length" class="flex flex-col divide-y sm:hidden" aria-label="缺编号观察列表">
        <li v-for="row in isolated" :key="row.relationId" class="flex min-w-0 flex-col gap-1.5 p-3" data-testid="platform-declaration-isolated-card" :data-relation-id="row.relationId">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="break-words font-medium">{{ missing(row.nameRaw) }}</p>
              <p class="text-muted-foreground break-all font-mono text-xs">{{ missing(row.usccRaw) }}</p>
              <p v-if="row.enterpriseName" class="text-muted-foreground text-xs">已归属 {{ row.enterpriseName }}</p>
            </div>
            <span class="text-muted-foreground shrink-0 text-xs">行 #{{ row.relationId }} · 查询 #{{ row.queryId }}</span>
          </div>
          <p class="text-sm font-medium leading-5">{{ titleLabel(row.titleRaw) }}</p>
          <p class="text-sm leading-5">{{ declareKind(row.declareKind) }} · 年度 {{ missing(row.declarationYear) }} · {{ missing(row.status) }}</p>
          <p class="text-muted-foreground text-sm leading-5">申报时间 {{ time(row.appliedAt) }} · 采集 {{ time(row.queriedAt) }}</p>
          <p class="text-xs">
            <span v-if="row.identityState === 'missing_key'">缺少平台业务编号</span>
            <span v-else-if="row.identityState === 'conflict'">平台编号冲突</span>
            <span v-if="row.contentState === 'unverifiable'">原文内容无法核实</span>
          </p>
          <NuxtLink :to="{ path: '/platform-queries', query: { queryKey: row.queryKey } }" class="inline-flex items-center gap-1 text-xs hover:underline">查看原查询<ExternalLink class="size-3" /></NuxtLink>
        </li>
      </ul>
    </template>
  </div>
</template>
