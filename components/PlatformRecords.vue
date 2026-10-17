<script setup lang="ts">
import { computed } from 'vue'
import { PLATFORM_INTERFACES, PLATFORM_QUERY_STATUSES, PLATFORM_RDJBS, RELATION_DECLARE_KINDS, RELATION_MATCH_BASES, VERIFICATION_STATUSES } from '~~/lib/labels'
import { formatFetchTime } from '~~/lib/reconcile-time'
import { platformFailureForDisplay } from '~~/lib/roster/platform-records'
import type { PlatformRecord, PlatformRecordQuery } from '~~/lib/roster/platform-records'

const props = defineProps<{ queries: PlatformRecordQuery[]; relations: PlatformRecord[] }>()
const groups = computed(() => props.queries.map((query) => ({
  query,
  records: props.relations.filter((record) => record.queryId === query.id),
})))
const source = (value: string) => PLATFORM_INTERFACES[value] ?? '平台记录'
const title = (value: string) => value === '' ? '全部称号' : PLATFORM_RDJBS[value] ?? '称号待核'
const time = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : formatFetchTime(value) ?? '时间未提供'
</script>

<template>
  <div class="min-w-0 space-y-4" data-testid="platform-records">
    <p v-if="!groups.length" class="text-muted-foreground text-[13px] leading-5">尚无平台查询记录</p>
    <section v-for="{query,records} in groups" :key="query.id" class="min-w-0 overflow-hidden rounded-sm border" data-testid="platform-query-group">
      <div class="bg-muted/50 space-y-1 border-b px-3 py-2 text-[13px] leading-5" data-testid="platform-query-summary">
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h4 class="font-medium">{{ source(query.interface) }}</h4>
          <span>{{ title(query.rdjb) }}</span>
          <span :class="query.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'">{{ PLATFORM_QUERY_STATUSES[query.status] ?? '状态待核' }}</span>
          <span class="text-muted-foreground">{{ query.relationCount }} 条</span>
        </div>
        <div class="text-muted-foreground flex flex-wrap gap-x-3">
          <span>查询时间 {{ time(query.queriedAt) }}</span>
          <span class="break-all">查询企业 {{ query.queryKey.startsWith('name:') ? query.queryKey.slice(5) : query.queryKey }}</span>
        </div>
      </div>
      <p v-if="query.status === 'failed' && query.failureReason" class="text-destructive px-3 py-2 text-[13px] leading-5" data-testid="platform-query-failure">{{ platformFailureForDisplay(query.failureReason) }}</p>
      <div v-if="records.length" class="min-w-0 overflow-x-auto">
        <table class="w-full table-fixed text-left text-[13px] leading-5" aria-label="平台返回记录">
          <thead class="bg-muted/20 text-muted-foreground">
            <tr><th class="w-[35%] px-2 py-2 font-medium">企业信息</th><th class="w-[24%] px-2 py-2 font-medium">申报事项</th><th class="w-[18%] px-2 py-2 font-medium">办理状态</th><th class="w-[23%] px-2 py-2 font-medium">批次与年度</th></tr>
          </thead>
          <tbody>
            <tr v-for="record in records" :key="record.id" class="border-t align-top" data-testid="platform-relation">
              <td class="space-y-1 px-2 py-2 break-words [overflow-wrap:anywhere]">
                <div class="font-medium"><span class="text-muted-foreground">{{ record.sequenceNo }}. </span>{{ record.nameRaw ?? '企业名称未提供' }}</div>
                <div class="text-muted-foreground break-all">{{ record.usccRaw ?? '统一社会信用代码未提供' }}</div>
                <div v-if="record.province" class="text-muted-foreground">{{ record.province }}</div>
                <div v-if="record.aliasNameRaw" class="text-muted-foreground">曾用名 {{ record.aliasNameRaw }}</div>
                <div class="text-muted-foreground">{{ RELATION_MATCH_BASES[record.matchBasis] ?? '匹配待核' }} · {{ VERIFICATION_STATUSES[record.verificationStatus] ?? '待核实' }}</div>
              </td>
              <td class="space-y-1 px-2 py-2 break-words [overflow-wrap:anywhere]">
                <div>{{ record.declareKind ? RELATION_DECLARE_KINDS[record.declareKind] ?? '类型待核' : '类型未提供' }}</div>
                <div v-if="record.appliedAt" class="text-muted-foreground">申报时间 {{ record.appliedAt }}</div>
                <div v-if="record.relationKey" class="text-muted-foreground break-all">平台记录编号 {{ record.relationKey }}</div>
              </td>
              <td class="px-2 py-2 break-words [overflow-wrap:anywhere]">{{ record.status ?? '状态未提供' }}</td>
              <td class="space-y-1 px-2 py-2 break-words [overflow-wrap:anywhere]">
                <div>维护批次 {{ record.batch ?? '未提供' }}</div>
                <div>认定批次 {{ record.awardBatchLabel ?? '未提供' }}</div>
                <div v-if="record.year != null" class="text-muted-foreground">记录年份 {{ record.year }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="text-muted-foreground px-3 py-2 text-[13px] leading-5">{{ query.status === 'failed' ? '本次查询未完成，不能据此判断平台有无记录。' : query.status === 'not_queried' ? '尚未查询' : query.status === 'no_record' ? '平台未返回记录' : '本次查询的明细尚未保存' }}</p>
    </section>
  </div>
</template>
