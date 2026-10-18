<script setup lang="ts">
import { ref } from 'vue'
import type { RecordComparisonResult } from '~~/lib/roster/record-comparison-view'
import { comparisonReasonText } from '~~/lib/roster/record-comparison-view'
import { PLATFORM_INTERFACES, PLATFORM_QUERY_STATUSES, TITLES } from '~~/lib/labels'
import { CORRESPONDENCE_ROLES } from '~~/lib/roster/correspondence-view'
import SourceReader from './SourceReader.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

defineProps<{ result: RecordComparisonResult; returnTo: string }>()
const navigatingToEvent = ref(false)
function closeForEvent() { navigatingToEvent.value = true; sourceId.value = null }
const sourceId = ref<number | null>(null)
const sourceKind = ref<'relation' | 'export_row'>('relation')
const observationLimit = ref(20)
const exportLimit = ref(20)
const unlinkedLimit = ref(20)
const laterLimit = ref(20)
function openSource(kind: 'relation' | 'export_row', id: number) { navigatingToEvent.value = false; sourceKind.value = kind; sourceId.value = id }
const qualificationText = (value: string) => ({ matched: '同范围同版本一致', interface_only: '接口原行独有', export_only: '导出原行独有', field_conflict: '同范围同版本字段冲突', not_comparable: '范围或版本待核，暂不可比较' }[value] ?? '待核')
const coverageTitle = (parts: { titleCode: string | null }[]) => parts.map(part => TITLES[part.titleCode ?? ''] ?? '未标注').join('、') || '未标注'
const conditionNames: Record<string, string> = { name: '企业名称', uscc: '信用代码', sqsj: '申报时间', rddqrq: '有效年份', whpcyear: '维护年份', whpc: '维护批次', szq: '属地代码', combination: '条件关系' }
const coverageConditions = (conditions: Record<string, unknown> | null) => conditions ? Object.entries(conditions).filter(([, value]) => value != null && value !== '').map(([key, value]) => `${conditionNames[key] ?? key} ${String(value)}`).join(' · ') || '无筛选条件' : '旧查询未保留条件'
const completenessText = (value: string) => ({ complete: '完整', partial: '部分', not_queried: '未查询', unknown: '未知' }[value] ?? '未知')
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3" data-testid="record-comparison-evidence">
    <section class="grid grid-cols-2 gap-2 rounded-sm border bg-card p-3 text-[13px] sm:grid-cols-4" aria-label="记录级计数">
      <p><strong class="block text-lg tabular-nums">{{ result.counts.distinctEvents }}</strong>正式事件（按事件去重）</p>
      <p><strong class="block text-lg tabular-nums">{{ result.counts.distinctPlatformRows }}</strong>接口原行（按原行去重）</p>
      <p><strong class="block text-lg tabular-nums">{{ result.counts.distinctEnterpriseTitles }}</strong>企业×称号</p>
      <p><strong class="block text-lg tabular-nums">{{ result.counts.laterProcessRows }}</strong>独立后续流程原行</p>
      <p>历史相符 <strong>{{ result.counts.historical_aligned }}</strong> 个事件</p>
      <p>历史陈述冲突 <strong>{{ result.counts.historical_conflict }}</strong> 个事件</p>
      <p>完整范围无对应 <strong>{{ result.counts.official_without_correspondence }}</strong> 个事件</p>
      <p>待核 <strong>{{ result.counts.unresolved }}</strong> 个事件</p>
      <p>无正式对应的接口原行 <strong>{{ result.counts.platformWithoutOfficialRows }}</strong> 条</p>
      <p>接口原行待核 <strong>{{ result.counts.unresolvedPlatformRows }}</strong> 条</p>
      <p>已认定接口原行 <strong>{{ result.counts.recognizedRows }}</strong> 条</p>
      <p>导出原行 <strong>{{ result.counts.exportRows }}</strong> 条</p>
    </section>
    <p class="text-muted-foreground text-xs">以上数字各有自己的记录粒度，均按所选来源全集计数，不随事件分类筛选或分页变化。导出行是指定版本的现状观察。</p>
    <div v-if="result.historicalDecisionUnavailable.length" class="text-muted-foreground rounded-sm border p-3 text-[13px]">截止时点后有 {{ result.historicalDecisionUnavailable.length }} 条对应关系发生决定或修订，历史决定态无法从当前行还原。受影响事件与接口原行保持待核。<ul class="mt-1 flex flex-wrap gap-x-3 gap-y-1"><li v-for="item in result.historicalDecisionUnavailable" :key="item.id">对应 #{{ item.id }}<span v-if="item.eventId != null"> · 事件 #{{ item.eventId }}</span><span v-if="item.relationId != null"> · 接口原行 #{{ item.relationId }}</span></li></ul></div>
    <details class="min-w-0 rounded-sm border bg-card p-3 text-[13px]" data-testid="record-comparison-coverage"><summary class="cursor-pointer font-medium">所选来源的查询覆盖 · {{ result.coverage.length }} 次</summary>
      <p class="text-muted-foreground mt-2">正式文件覆盖资格：{{ result.officialCoverage.qualification === 'verified' ? '已验证' : '未知' }}。{{ result.officialCoverage.reasons.map(comparisonReasonText).join('；') }}</p>
      <ul class="mt-2 flex flex-col gap-2"><li v-for="item in result.coverage" :key="item.queryId" class="border-t pt-2"><strong>{{ PLATFORM_INTERFACES[item.interface] ?? '平台接口' }} · {{ PLATFORM_QUERY_STATUSES[item.status] ?? '状态待核' }}</strong><p>查询时点 {{ item.queriedAt }} · 称号 {{ coverageTitle(item.titleCoverage) }}</p><p>原条件：{{ coverageConditions(item.effectiveConditions) }}</p><p>完整性 {{ completenessText(item.completeness) }} · {{ item.fullRange ? '从首页查询' : '非全范围或未知' }}<span v-if="item.reasons.length"> · {{ item.reasons.map(comparisonReasonText).join('；') }}</span></p></li></ul>
    </details>
    <details class="min-w-0 rounded-sm border bg-card p-3 text-[13px]" data-testid="record-current-consistency"><summary class="cursor-pointer font-medium">已认定接口与导出版本 · {{ result.counts.observedRecognizedExportPairs }} 组同主体称号原行观察</summary>
      <p class="text-muted-foreground mt-2">比较资格：{{ result.currentSourceConsistency.qualification === 'comparable' ? '已验证同范围同版本' : '范围/版本未获证明，暂不可比较' }}。{{ result.currentSourceConsistency.reasons.map(comparisonReasonText).join('；') }}</p>
      <ul v-if="result.currentSourceConsistency.recognizedObservations.length" class="mt-2 flex flex-col gap-2"><li v-for="observation in result.currentSourceConsistency.recognizedObservations.slice(0, observationLimit)" :key="observation.recognized.id" class="border-t pt-2"><div class="flex flex-wrap items-center gap-2"><strong>{{ observation.recognized.nameRaw ?? '企业原名未提供' }}</strong><Badge variant="outline">{{ qualificationText(observation.qualification) }}</Badge></div><p>查询 #{{ observation.recognized.queryId }} · 原行 {{ observation.recognized.sequenceNo }} · 记录 #{{ observation.recognized.id }} · 查询时点 {{ observation.recognized.queriedAt }} · 原状态 {{ observation.recognized.status ?? '未提供' }}</p><p v-if="observation.exportRows.length">同主体称号的导出观察：<Button v-for="exportRow in observation.exportRows" :key="exportRow.id" variant="link" size="sm" @click="openSource('export_row', exportRow.id)">{{ exportRow.collectedOn }} · 源行 {{ exportRow.sourceRowNo }}</Button></p><p v-else>所选导出版本无同主体称号的正向行观察；{{ qualificationText(observation.qualification) }}。</p><Button variant="link" size="sm" @click="openSource('relation', observation.recognized.id)">查看已认定接口原行</Button></li></ul>
      <Button v-if="result.currentSourceConsistency.recognizedObservations.length > observationLimit" variant="outline" size="sm" class="mt-2" @click="observationLimit += 20">继续显示已认定接口原行</Button>
      <p v-if="!result.currentSourceConsistency.recognizedObservations.length" class="text-muted-foreground mt-2">所选来源没有已认定接口原行观察；不据此认定导出或正式事件缺失。</p>
      <h4 class="mt-3 font-medium">所选导出版本原行 · {{ result.currentSourceConsistency.exportObservations.length }} 条</h4>
      <ul class="mt-1 flex flex-col gap-1.5"><li v-for="item in result.currentSourceConsistency.exportObservations.slice(0, exportLimit)" :key="item.exportRow.id" class="flex flex-wrap items-center gap-1.5 border-t pt-1.5"><span>{{ item.exportRow.nameRaw ?? '企业原名未提供' }} · {{ TITLES[item.exportRow.titleCode] ?? item.exportRow.titleCode }} · {{ item.exportRow.collectedOn }} · 源行 {{ item.exportRow.sourceRowNo }}</span><Badge variant="outline">{{ qualificationText(item.qualification) }}</Badge><Button variant="link" size="sm" @click="openSource('export_row', item.exportRow.id)">查看原行与反向对应</Button></li></ul>
      <Button v-if="result.currentSourceConsistency.exportObservations.length > exportLimit" variant="outline" size="sm" class="mt-2" @click="exportLimit += 20">继续显示导出原行</Button>
    </details>
    <details class="min-w-0 rounded-sm border bg-card p-3 text-[13px]" data-testid="record-platform-unlinked"><summary class="cursor-pointer font-medium">未对应正式事件的接口原行 · {{ result.platformWithoutOfficial.total }} 条</summary><p class="text-muted-foreground mt-2">无正式对应需要完整范围证明；资格未知的原行保持待核，不能直接称为正式文件遗漏。</p><ul class="mt-2 flex flex-col gap-1.5"><li v-for="item in result.platformWithoutOfficial.rows.slice(0, unlinkedLimit)" :key="item.relation.id" class="flex flex-wrap items-center gap-1.5 border-t pt-1.5"><span class="text-muted-foreground">查询 #{{ item.relation.queryId }} · 原行 {{ item.relation.sequenceNo }} · 记录 #{{ item.relation.id }}</span><span>{{ PLATFORM_INTERFACES[item.relation.interface] ?? '平台接口' }} · {{ item.relation.nameRaw ?? '原名未提供' }} · {{ item.relation.status ?? '状态未提供' }}</span><Badge variant="outline">{{ item.qualification === 'platform_without_official' ? '已证明范围无正式对应' : item.reasons.includes('row_identity_unverified') ? '主体身份待核' : '正式来源覆盖待核' }}</Badge><Button variant="link" size="sm" @click="openSource('relation', item.relation.id)">查看原行与反向对应</Button></li></ul><Button v-if="result.platformWithoutOfficial.rows.length > unlinkedLimit" variant="outline" size="sm" class="mt-2" @click="unlinkedLimit += 20">继续显示接口原行</Button></details>
    <details class="min-w-0 rounded-sm border bg-card p-3 text-[13px]" data-testid="record-independent-later"><summary class="cursor-pointer font-medium">独立后续流程原行 · {{ result.laterProcessPlatformRows.length }} 条</summary><p class="text-muted-foreground mt-2">这些流程独立于历史主分类；没有前序事件的流程也保留原行。</p><ul class="mt-2 flex flex-col gap-1.5"><li v-for="item in result.laterProcessPlatformRows.slice(0, laterLimit)" :key="item.relation.id" class="flex flex-wrap items-center gap-1.5 border-t pt-1.5"><span class="text-muted-foreground">查询 #{{ item.relation.queryId }} · 原行 {{ item.relation.sequenceNo }} · 记录 #{{ item.relation.id }}</span><span>{{ PLATFORM_INTERFACES[item.relation.interface] ?? '平台接口' }} · {{ item.relation.nameRaw ?? '原名未提供' }} · {{ item.relation.status ?? '状态未提供' }} · {{ item.relation.appliedAt ?? '时间未提供' }}</span><Badge v-for="edge in item.correspondences" :key="edge.id" variant="outline">{{ CORRESPONDENCE_ROLES[edge.role] ?? '后续流程' }} · {{ edge.status === 'confirmed' ? '已确认' : '待核' }}</Badge><Button variant="link" size="sm" @click="openSource('relation', item.relation.id)">查看原行与反向对应</Button></li></ul><Button v-if="result.laterProcessPlatformRows.length > laterLimit" variant="outline" size="sm" class="mt-2" @click="laterLimit += 20">继续显示后续流程</Button></details>
    <Dialog :open="sourceId !== null" @update:open="!$event && (sourceId = null)"><DialogContent @close-auto-focus="navigatingToEvent && $event.preventDefault()" class="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>现状来源原行</DialogTitle><DialogDescription>保留原查询条件和导出批次版本；范围/版本资格单独判断。</DialogDescription></DialogHeader><SourceReader v-if="sourceId !== null" :kind="sourceKind" :id="sourceId" :return-to="returnTo" @event-navigate="closeForEvent" /></DialogContent></Dialog>
  </div>
</template>
