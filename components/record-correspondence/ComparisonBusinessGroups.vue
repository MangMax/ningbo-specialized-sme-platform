<script setup lang="ts">
import { shallowRef } from 'vue'
import type { RecordComparisonResult } from '~~/lib/roster/record-comparison-view'
import { comparisonReasonText } from '~~/lib/roster/record-comparison-view'
import { PLATFORM_INTERFACES, TITLES } from '~~/lib/labels'
import { humanRecordTime } from '~~/lib/roster/record-ledger'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import TablePagination from '@/components/TablePagination.vue'
import SourceReader from './SourceReader.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// Pure presentation boundary: the parent owns scope/loading/pagination; no client deduplication.
defineProps<{ groups: RecordComparisonResult['businessGroups']; counts: RecordComparisonResult['businessCounts']; loading: boolean; returnTo: string }>()
const emit = defineEmits<{ 'update:page': [page: number]; 'update:pageSize': [pageSize: number] }>()
const sourceId = shallowRef<number | null>(null)
const linkText = (value: string) => ({ linked: '已对应正式事件', later_process: '独立后续流程', unlinked: '未对应正式事件', mixed: '对应状态混合' }[value] ?? '待核')
const unknownText = (value: string) => ({ not_indexed: '未建立业务索引', missing_key: '缺业务编号', conflict: '业务编号冲突', unverifiable: '内容无法核实' }[value] ?? '身份或内容未知')
const qualificationText = (value: string) => ({ matched: '同范围同版本一致', interface_only: '接口原行独有', field_conflict: '同范围同版本字段冲突', not_comparable: '范围或版本待核，暂不可比较', platform_without_official: '已证明范围无正式对应', unresolved: '正式来源覆盖待核' }[value] ?? '待核')
const decisionText = (value: string) => ({ candidate: '候选', confirmed: '已确认', rejected: '已否定', unlinked: '已解除' }[value] ?? '待核')
</script>

<template>
  <section class="flex min-w-0 flex-col gap-2" aria-label="所选平台业务记录" data-testid="comparison-business-groups" :aria-busy="loading">
    <h2 class="text-sm font-medium">所选平台业务记录</h2>
    <p class="text-muted-foreground text-[13px]" aria-label="业务粒度计数">{{ counts.records }} 条可核实业务 · {{ counts.versions }} 个内容版本 · {{ counts.observations }} 次采集观察 · {{ counts.unknownObservations }} 次身份或内容未知观察</p>
    <p class="text-muted-foreground text-[13px]">计数覆盖所选查询与截止时点<span v-if="groups.scope.enterpriseId || groups.scope.titleCode">，并按指定企业或称号筛选</span>，先于业务分页；不随正式事件分类或事件翻页变化。未知观察各自保留，不计入可核实业务与版本。</p>
    <p v-if="counts.unknownObservations" class="text-muted-foreground text-[13px]">未知观察：未索引 {{ counts.unknownByState.not_indexed }} · 缺编号 {{ counts.unknownByState.missing_key }} · 编号冲突 {{ counts.unknownByState.conflict }} · 内容无法核实 {{ counts.unknownByState.unverifiable }}</p>
    <p class="text-muted-foreground text-[13px]">同版本的重复采集在一组内展开；每次观察的对应与比较资格独立保留。</p>
    <DisclosurePanel v-for="group in groups.rows" :key="group.key" compact padded class="min-w-0 rounded-sm border bg-card" content-class="px-3" data-testid="comparison-business-group">
      <template #trigger>
        <span class="flex min-w-0 flex-1 flex-col gap-1 text-left [overflow-wrap:anywhere]">
          <span>{{ PLATFORM_INTERFACES[group.interface] ?? '平台接口' }} · {{ group.platformKey ?? `观察 #${group.versions[0]!.observations[0]!.relation.id}` }}</span>
          <span class="text-muted-foreground font-normal">{{ group.groupState === 'verified' ? `${group.versions.length} 个内容版本` : unknownText(group.groupState) }} · {{ group.observationCount }} 次观察 · {{ linkText(group.linkState) }}<span v-if="group.resultState === 'mixed'"> · 观察结果混合</span></span>
        </span>
      </template>
      <div class="flex min-w-0 flex-col gap-2">
        <DisclosurePanel v-for="version in group.versions" :key="version.versionId ?? group.key" compact class="min-w-0 border-t" content-class="pb-0" :title="`${group.groupState === 'verified' ? `内容版本 #${version.versionId}` : '独立未知观察'} · ${version.observationCount} 次观察 · ${linkText(version.linkState)}`" data-testid="comparison-business-version">
          <ul class="flex min-w-0 flex-col gap-3">
            <li v-for="observation in version.observations" :key="observation.relation.id" class="min-w-0 border-t pt-2 text-[13px] [overflow-wrap:anywhere]" data-testid="comparison-business-observation">
              <div class="flex flex-wrap items-center gap-2"><strong>观察 #{{ observation.relation.id }} · {{ observation.relation.nameRaw ?? '企业原名未提供' }}</strong><Badge variant="outline">{{ linkText(observation.linkState) }}</Badge></div>
              <p>查询 #{{ observation.relation.queryId }} · 行 {{ observation.relation.sequenceNo }} · {{ humanRecordTime(observation.relation.queriedAt) }}</p>
              <p>{{ TITLES[observation.relation.titleCode ?? ''] ?? '称号未确定' }} · 原状态 {{ observation.relation.status ?? '未提供' }}</p>
              <p v-if="observation.currentSource">现状比较：{{ qualificationText(observation.currentSource.qualification) }}<span v-if="observation.currentSource.proofId"> · 范围依据 {{ observation.currentSource.proofId }}</span>。{{ observation.currentSource.reasons.map(comparisonReasonText).join('；') }}</p>
              <p v-if="observation.withoutOfficial">正式来源资格：{{ qualificationText(observation.withoutOfficial.qualification) }}<span v-if="observation.withoutOfficial.proofId"> · 范围依据 {{ observation.withoutOfficial.proofId }}</span>。{{ observation.withoutOfficial.reasons.map(comparisonReasonText).join('；') }}</p>
              <p v-if="observation.historicalDecisionUnavailable.length">截止时点后的决定状态无法还原，本观察保持待核。</p>
              <ul v-if="observation.correspondences.length">
                <li v-for="edge in observation.correspondences" :key="edge.id">原对应 #{{ edge.id }} · {{ decisionText(edge.status) }}<span v-if="edge.eventId"> · 正式事件 #{{ edge.eventId }}</span><span v-if="edge.requiresRevalidation"> · 需要重新核验</span></li>
              </ul>
              <p v-else class="text-muted-foreground">本次范围内没有可用的原对应；同组其他观察的决定不适用于本观察。</p>
              <Button variant="link" size="sm" @click="sourceId = observation.relation.id">查看观察 #{{ observation.relation.id }} 原始记录</Button>
            </li>
          </ul>
        </DisclosurePanel>
      </div>
    </DisclosurePanel>
    <p v-if="!groups.total" class="text-muted-foreground text-[13px]">本次范围没有平台观察。</p>
    <TablePagination :page="groups.page" :page-size="groups.pageSize" :total="groups.total" unit="组业务/未知观察" :loading="loading" @update:page="emit('update:page', $event)" @update:page-size="emit('update:pageSize', $event)" />
    <Dialog :open="sourceId !== null" @update:open="open => { if (!open) sourceId = null }">
      <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>采集观察原始记录</DialogTitle><DialogDescription>查看这次观察自己的归档字段与出处；本次比较资格见分组内的观察结果。</DialogDescription></DialogHeader>
        <SourceReader v-if="sourceId !== null" kind="relation" :id="sourceId" :return-to="returnTo" @event-navigate="sourceId = null" />
      </DialogContent>
    </Dialog>
  </section>
</template>
