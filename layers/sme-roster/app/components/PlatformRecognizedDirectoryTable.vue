<script setup lang="ts">
import { projectionDisplay } from '#sme-roster/lib/platform/projection-display'
import { computed } from 'vue'
import { ExternalLink, History } from '@lucide/vue'
import type { RecognizedDirectoryRow } from '#sme-roster/lib/platform/recognized-directory'
import { RDJB_TITLE_CODES } from '#sme-roster/lib/platform/recognized-evidence'
import { PLATFORM_RDJBS } from '#sme-roster/lib/labels'
import { formatFetchTime } from '#sme-roster/lib/reconcile-time'
import { Button } from '#core/app/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#core/app/components/ui/table'

const props = defineProps<{ view: 'records' | 'isolated'; rows: RecognizedDirectoryRow[]; loading?: boolean }>()
const emit = defineEmits<{ 'open-record': [recordId: number] }>()

type RecordRow = Extract<RecognizedDirectoryRow, { kind: 'record' }>
const records = computed(() => props.rows.filter((row): row is RecordRow => row.kind === 'record'))
const isolated = computed(() => props.rows.filter((row): row is Extract<RecognizedDirectoryRow, { kind: 'observation' }> => row.kind === 'observation'))
const projectionTitle = (rawCode: string) => PLATFORM_RDJBS[rawCode] ?? rawCode
const missing = (value: string | number | null | undefined) => value === null || value === undefined || value === '' ? '未提供' : String(value)
const time = (value: string | null) => value ? formatFetchTime(value) ?? value : '未提供'
const enterprise = (row: RecordRow) => {
  if (row.enterpriseNames.length === 1) return row.enterpriseNames[0]!
  if (row.enterpriseNames.length > 1) return `${row.enterpriseNames.length} 家企业归属冲突`
  return row.matchedVersion.nameRaw ?? '未匹配主体'
}
const enterpriseId = (row: RecordRow) => row.enterpriseIds.length === 1 ? row.enterpriseIds[0]! : null
/** Navigate using the title actually returned on this row. */
const currentQuery = (row: RecordRow) => {
  const titleCode = RDJB_TITLE_CODES[row.matchedVersion.titleRaw ?? '']
  const q = row.enterpriseNames.length === 1 ? row.enterpriseNames[0] : row.matchedVersion.nameRaw ?? row.matchedVersion.usccRaw ?? undefined
  return { titleCode, q }
}
const conflictLabel: Record<string, string> = {
  enterprise_assignment_conflict: '企业归属冲突',
  unverifiable_observation: '存在内容未核实观察',
}
</script>

<template>
  <div class="min-w-0" data-testid="platform-recognized-directory-table">
    <template v-if="view === 'records'">
      <div v-if="records.length" class="data-table-scroll hidden sm:block">
        <Table class="data-table min-w-[880px] table-fixed 2xl:min-w-[1160px]" aria-label="平台认定目录">
          <TableHeader>
            <TableRow class="hover:bg-transparent">
              <TableHead class="w-[22%]">企业</TableHead>
              <TableHead class="w-[14%] whitespace-nowrap">有效期</TableHead>
              <TableHead class="w-[10%] whitespace-nowrap">维护批次</TableHead>
              <TableHead class="w-[11%] whitespace-nowrap">属地</TableHead>
              <TableHead class="w-[15%] whitespace-nowrap">称号</TableHead>
              <TableHead class="w-[10%] whitespace-nowrap">版本</TableHead>
              <TableHead class="sticky right-0 z-20 w-[18%] border-l bg-muted">详情</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="row in records" :key="row.record.id" class="align-top" data-testid="platform-recognized-directory-row" :data-record-id="row.record.id">
              <TableCell class="whitespace-normal break-words [overflow-wrap:anywhere]">
                <NuxtLink v-if="enterpriseId(row) != null" :to="`/enterprises/${enterpriseId(row)}`" class="font-medium hover:underline">{{ enterprise(row) }}</NuxtLink>
                <span v-else class="font-medium">{{ enterprise(row) }}</span>
                <span class="text-muted-foreground mt-1 block break-all font-mono text-xs">{{ projectionDisplay(row.matchedVersion, row.matchedVersion.usccRaw) }}</span>
              </TableCell>
              <TableCell class="break-all font-mono text-xs">{{ projectionDisplay(row.matchedVersion, row.matchedVersion.validityDateRaw) }}</TableCell>
              <TableCell class="whitespace-normal break-all font-mono text-xs">{{ projectionDisplay(row.matchedVersion, row.matchedVersion.maintenanceBatch) }}</TableCell>
              <TableCell class="whitespace-normal break-all font-mono text-xs">{{ projectionDisplay(row.matchedVersion, row.matchedVersion.district) }}</TableCell>
              <TableCell class="whitespace-normal text-xs leading-5">{{ projectionDisplay(row.matchedVersion, row.matchedVersion.titleRaw, projectionTitle) }}</TableCell>
              <TableCell class="whitespace-nowrap tabular-nums">{{ row.versionCount }}<span v-if="row.matchedVersionCount > 1" class="text-muted-foreground block text-xs">匹配 {{ row.matchedVersionCount }} 个版本</span></TableCell>
              <TableCell class="sticky right-0 z-10 border-l bg-card">
                <Button variant="ghost" size="sm" :disabled="loading" @click="emit('open-record', row.record.id)"><History data-icon="inline-start" />版本详情</Button>
                <NuxtLink v-if="currentQuery(row).titleCode || currentQuery(row).q" :to="{ path: '/current-enterprises', query: { ...(currentQuery(row).titleCode ? { titleCode: currentQuery(row).titleCode } : {}), ...(currentQuery(row).q ? { q: currentQuery(row).q } : {}) } }" class="mt-1 block text-xs hover:underline" data-testid="platform-recognized-current-link">当前有效资格</NuxtLink>
                <span v-for="conflict in row.conflicts.filter(value => value !== 'title_conflict')" :key="conflict" class="text-muted-foreground mt-1 block text-xs">{{ conflictLabel[conflict] ?? conflict }}</span>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <ul v-if="records.length" class="flex flex-col divide-y sm:hidden" aria-label="平台认定目录列表">
        <li v-for="row in records" :key="row.record.id" class="flex min-w-0 flex-col gap-1.5 p-3" data-testid="platform-recognized-directory-card" :data-record-id="row.record.id">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <NuxtLink v-if="enterpriseId(row) != null" :to="`/enterprises/${enterpriseId(row)}`" class="font-medium break-words hover:underline">{{ enterprise(row) }}</NuxtLink>
              <p v-else class="font-medium break-words">{{ enterprise(row) }}</p>
              <p class="text-muted-foreground break-all font-mono text-xs">{{ projectionDisplay(row.matchedVersion, row.matchedVersion.usccRaw) }}</p>
            </div>
            <Button variant="outline" size="sm" class="min-h-11 shrink-0" :disabled="loading" @click="emit('open-record', row.record.id)"><History data-icon="inline-start" />版本详情</Button>
          </div>
          <p class="font-mono text-sm leading-5">有效期 {{ projectionDisplay(row.matchedVersion, row.matchedVersion.validityDateRaw) }}</p>
          <p class="text-sm leading-5">批次 {{ projectionDisplay(row.matchedVersion, row.matchedVersion.maintenanceBatch) }} · 属地 {{ projectionDisplay(row.matchedVersion, row.matchedVersion.district) }}</p>
          <p class="text-sm leading-5">称号 {{ projectionDisplay(row.matchedVersion, row.matchedVersion.titleRaw, projectionTitle) }}</p>
          <p class="text-muted-foreground text-sm leading-5">版本 {{ row.versionCount }}</p>
          <NuxtLink v-if="currentQuery(row).titleCode || currentQuery(row).q" :to="{ path: '/current-enterprises', query: { ...(currentQuery(row).titleCode ? { titleCode: currentQuery(row).titleCode } : {}), ...(currentQuery(row).q ? { q: currentQuery(row).q } : {}) } }" class="text-xs hover:underline" data-testid="platform-recognized-current-link">当前有效资格（既有查询）</NuxtLink>
          <p v-for="conflict in row.conflicts.filter(value => value !== 'title_conflict')" :key="conflict" class="text-muted-foreground text-xs">{{ conflictLabel[conflict] ?? conflict }}</p>
        </li>
      </ul>
    </template>

    <template v-else>
      <div v-if="isolated.length" class="data-table-scroll hidden sm:block">
        <Table class="data-table min-w-[880px] table-fixed" aria-label="隔离的目录观察">
          <TableHeader>
            <TableRow class="hover:bg-transparent">
              <TableHead class="w-[14%]">原行 / 查询</TableHead>
              <TableHead class="w-[22%]">企业原值</TableHead>
              <TableHead class="w-[18%] whitespace-nowrap">称号</TableHead>
              <TableHead class="w-[12%] whitespace-nowrap">采集时间</TableHead>
              <TableHead class="w-[18%]">隔离原因</TableHead>
              <TableHead class="sticky right-0 z-20 w-[12%] border-l bg-muted">查询证据</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="row in isolated" :key="row.relationId" class="align-top" data-testid="platform-recognized-directory-isolated-row" :data-relation-id="row.relationId">
              <TableCell class="whitespace-nowrap">行 #{{ row.relationId }} · 查询 #{{ row.queryId }}</TableCell>
              <TableCell class="whitespace-normal break-words [overflow-wrap:anywhere]">{{ missing(row.nameRaw) }}<span class="text-muted-foreground mt-1 block break-all font-mono text-xs">{{ missing(row.usccRaw) }}</span><span v-if="row.enterpriseName" class="text-muted-foreground mt-1 block text-xs">已归属 {{ row.enterpriseName }}</span></TableCell>
              <TableCell class="whitespace-normal">{{ PLATFORM_RDJBS[row.titleRaw ?? ''] ?? missing(row.titleRaw) }}</TableCell>
              <TableCell class="whitespace-nowrap tabular-nums">{{ time(row.queriedAt) }}</TableCell>
              <TableCell class="text-xs">
                <span v-if="row.identityState === 'missing_key'">缺少平台业务编号</span>
                <span v-else-if="row.identityState === 'conflict'">平台编号冲突</span>
                <span v-if="row.contentState === 'unverifiable'">原文内容无法核实</span>
              </TableCell>
              <TableCell class="sticky right-0 z-10 border-l bg-card">
                <NuxtLink :to="{ path: '/platform-queries', query: { queryId: row.queryId } }" class="inline-flex items-center gap-1 text-xs hover:underline">查看原查询<ExternalLink class="size-3" aria-hidden="true" /></NuxtLink>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <ul v-if="isolated.length" class="flex flex-col divide-y sm:hidden" aria-label="隔离的目录观察列表">
        <li v-for="row in isolated" :key="row.relationId" class="flex min-w-0 flex-col gap-1.5 p-3" data-testid="platform-recognized-directory-isolated-card" :data-relation-id="row.relationId">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="break-words font-medium">{{ missing(row.nameRaw) }}</p>
              <p class="text-muted-foreground break-all font-mono text-xs">{{ missing(row.usccRaw) }}</p>
              <p v-if="row.enterpriseName" class="text-muted-foreground text-xs">已归属 {{ row.enterpriseName }}</p>
            </div>
            <span class="text-muted-foreground shrink-0 text-xs">行 #{{ row.relationId }} · 查询 #{{ row.queryId }}</span>
          </div>
          <p class="text-sm font-medium leading-5">{{ PLATFORM_RDJBS[row.titleRaw ?? ''] ?? missing(row.titleRaw) }}</p>
          <p class="text-muted-foreground text-sm leading-5">采集 {{ time(row.queriedAt) }}</p>
          <p class="text-xs">
            <span v-if="row.identityState === 'missing_key'">缺少平台业务编号</span>
            <span v-else-if="row.identityState === 'conflict'">平台编号冲突</span>
            <span v-if="row.contentState === 'unverifiable'">原文内容无法核实</span>
          </p>
          <NuxtLink :to="{ path: '/platform-queries', query: { queryId: row.queryId } }" class="inline-flex items-center gap-1 text-xs hover:underline">查看原查询<ExternalLink class="size-3" aria-hidden="true" /></NuxtLink>
        </li>
      </ul>
    </template>
  </div>
</template>
