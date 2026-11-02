<script setup lang="ts">
import { computed } from 'vue'
import { ExternalLink, History } from '@lucide/vue'
import type { DeclarationRow } from '~~/lib/platform/declarations'
import { formatFetchTime } from '~~/lib/reconcile-time'
import { RELATION_DECLARE_KINDS } from '~~/lib/labels'
import { Button } from '@/components/ui/button'

const props = defineProps<{ view: 'records' | 'isolated'; rows: DeclarationRow[]; loading?: boolean }>()
const emit = defineEmits<{ 'open-record': [recordId: number] }>()

const records = computed(() => props.rows.filter((row): row is Extract<DeclarationRow, { kind: 'record' }> => row.kind === 'record'))
const isolated = computed(() => props.rows.filter((row): row is Extract<DeclarationRow, { kind: 'observation' }> => row.kind === 'observation'))
const missing = (value: string | number | null | undefined) => value === null || value === undefined || value === '' ? '未提供' : String(value)
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
      <p v-if="records.length" class="text-muted-foreground mb-2 text-[13px] leading-5 sm:hidden">
        左右滑动查看全部字段；申报编号与企业名称在起始侧。
      </p>
      <div v-if="records.length" class="min-w-0 overflow-x-auto rounded-sm border" tabindex="0" aria-label="申报记录表格，可横向滚动">
        <table class="w-full min-w-[980px] text-left text-[13px] leading-5" aria-label="申报记录">
          <thead class="bg-muted/40 text-muted-foreground">
            <tr>
              <th class="min-w-40 px-3 py-2 font-medium">申报编号</th>
              <th class="min-w-52 px-3 py-2 font-medium">企业</th>
              <th class="min-w-16 px-3 py-2 font-medium whitespace-nowrap">事项</th>
              <th class="min-w-[4.5rem] px-3 py-2 font-medium whitespace-nowrap">年度</th>
              <th class="min-w-20 px-3 py-2 font-medium whitespace-nowrap">状态</th>
              <th class="px-3 py-2 font-medium whitespace-nowrap">申报时间</th>
              <th class="px-3 py-2 font-medium whitespace-nowrap">版本 / 观察</th>
              <th class="px-3 py-2 font-medium whitespace-nowrap">最近采集</th>
              <th class="bg-muted border-l px-3 py-2 font-medium">详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in records" :key="row.record.id" class="border-t" data-testid="platform-declaration-row" :data-record-id="row.record.id">
              <td class="px-3 py-2 font-mono text-xs">{{ row.record.platformKey }}</td>
              <td class="px-3 py-2">
                <NuxtLink v-if="enterpriseId(row) != null" :to="`/enterprises/${enterpriseId(row)}`" class="hover:underline">{{ enterprise(row) }}</NuxtLink>
                <span v-else>{{ enterprise(row) }}</span>
                <span class="text-muted-foreground block text-xs">{{ missing(row.matchedVersion.usccRaw) }}</span>
              </td>
              <td class="px-3 py-2 whitespace-nowrap">{{ declareKind(row.matchedVersion.declareKind) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ missing(row.matchedVersion.declarationYear) }}</td>
              <td class="px-3 py-2 whitespace-nowrap">{{ missing(row.matchedVersion.status) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ time(row.matchedVersion.appliedAt) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ row.versionCount }} / {{ row.observationCount }}<span v-if="row.matchedVersionCount > 1" class="text-muted-foreground block text-xs">匹配 {{ row.matchedVersionCount }} 个版本</span><span v-if="row.matchedVersion.ruleVersion == null" class="text-muted-foreground block text-xs">尚未建立 typed 投影</span></td>
              <td class="px-3 py-2 tabular-nums">{{ time(row.latestObservationAt) }}</td>
              <td class="bg-card border-l px-3 py-2">
                <div class="flex flex-col items-start gap-1">
                  <Button variant="ghost" size="sm" :disabled="loading" @click="emit('open-record', row.record.id)"><History data-icon="inline-start" />观察与版本</Button>
                  <span v-for="conflict in row.conflicts" :key="conflict" class="text-xs">{{ conflictLabel[conflict] ?? conflict }}</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else>
      <p v-if="isolated.length" class="text-muted-foreground mb-2 text-[13px] leading-5 sm:hidden">
        左右滑动查看全部字段；缺编号或内容不可核实的观察逐条隔离，不并入任何申报记录。
      </p>
      <div v-if="isolated.length" class="min-w-0 overflow-x-auto rounded-sm border" tabindex="0" aria-label="缺编号观察表格，可横向滚动">
        <table class="w-full min-w-[980px] text-left text-[13px] leading-5" aria-label="缺编号观察">
          <thead class="bg-muted/40 text-muted-foreground">
            <tr>
              <th class="px-3 py-2 font-medium whitespace-nowrap">原行 / 查询</th>
              <th class="min-w-52 px-3 py-2 font-medium">企业原值</th>
              <th class="min-w-16 px-3 py-2 font-medium whitespace-nowrap">事项</th>
              <th class="min-w-[4.5rem] px-3 py-2 font-medium whitespace-nowrap">年度</th>
              <th class="min-w-20 px-3 py-2 font-medium whitespace-nowrap">状态</th>
              <th class="px-3 py-2 font-medium whitespace-nowrap">申报时间</th>
              <th class="px-3 py-2 font-medium whitespace-nowrap">采集</th>
              <th class="px-3 py-2 font-medium">隔离原因</th>
              <th class="bg-muted border-l px-3 py-2 font-medium">查询证据</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in isolated" :key="row.relationId" class="border-t" data-testid="platform-declaration-isolated-row" :data-relation-id="row.relationId">
              <td class="px-3 py-2 whitespace-nowrap">行 #{{ row.relationId }} · 查询 #{{ row.queryId }}</td>
              <td class="px-3 py-2">{{ missing(row.nameRaw) }}<span class="text-muted-foreground block text-xs">{{ missing(row.usccRaw) }}</span><span v-if="row.enterpriseName" class="text-muted-foreground block text-xs">已归属 {{ row.enterpriseName }}</span></td>
              <td class="px-3 py-2 whitespace-nowrap">{{ declareKind(row.declareKind) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ missing(row.declarationYear) }}</td>
              <td class="px-3 py-2 whitespace-nowrap">{{ missing(row.status) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ time(row.appliedAt) }}</td>
              <td class="px-3 py-2 tabular-nums">{{ time(row.queriedAt) }}</td>
              <td class="px-3 py-2 text-xs">
                <span v-if="row.identityState === 'missing_key'">缺少平台业务编号</span>
                <span v-else-if="row.identityState === 'conflict'">平台编号冲突</span>
                <span v-if="row.contentState === 'unverifiable'">原文内容无法核实</span>
              </td>
              <td class="bg-card border-l px-3 py-2">
                <NuxtLink :to="{ path: '/platform-queries', query: { queryKey: row.queryKey } }" class="inline-flex items-center gap-1 text-xs hover:underline">
                  查看原查询<ExternalLink class="size-3" />
                </NuxtLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
