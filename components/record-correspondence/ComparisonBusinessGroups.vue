<script setup lang="ts">
import { shallowRef } from 'vue'
import type { RecordComparisonResult } from '~~/lib/roster/record-comparison-view'
import { PLATFORM_INTERFACES } from '~~/lib/labels'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import TablePagination from '@/components/TablePagination.vue'
import SourceReader from './SourceReader.vue'
import ComparisonBusinessObservation from './ComparisonBusinessObservation.vue'
import { comparisonLinkText as linkText } from '~~/lib/roster/record-comparison-display'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// Pure presentation boundary: the parent owns scope/loading/pagination; no client deduplication.
defineProps<{ groups: RecordComparisonResult['businessGroups']; counts: RecordComparisonResult['businessCounts']; loading: boolean; returnTo: string }>()
const emit = defineEmits<{ 'update:page': [page: number]; 'update:pageSize': [pageSize: number] }>()
const sourceId = shallowRef<number | null>(null)
const unknownText = (value: string) => ({ not_indexed: '未建立业务索引', missing_key: '缺业务编号', conflict: '业务编号冲突', unverifiable: '内容无法核实' }[value] ?? '身份或内容未知')
</script>

<template>
  <section class="flex min-w-0 flex-col gap-2" aria-label="所选平台业务记录" data-testid="comparison-business-groups" :aria-busy="loading">
    <h2 class="text-sm font-medium">所选平台业务记录</h2>
    <p class="text-muted-foreground text-table" aria-label="业务粒度计数">{{ counts.records }} 条已知业务 · {{ counts.versions }} 个已知内容版本 · {{ counts.observations }} 次采集观察 · {{ counts.unknownObservations }} 次身份或内容未知观察</p>
    <p class="text-muted-foreground text-table">计数覆盖所选查询与截止时点<span v-if="groups.scope.enterpriseId || groups.scope.titleCode">，并按指定企业或称号筛选</span>，先于业务分页；不随正式事件分类或事件翻页变化。无业务身份的观察独立保留；已知业务的未知内容观察不计入内容版本。</p>
    <p v-if="counts.unknownObservations" class="text-muted-foreground text-table">未知身份 {{ counts.unknownIdentityObservations }} 次 · 已知业务内容未知 {{ counts.unknownContentObservations }} 次；未索引 {{ counts.unknownByState.not_indexed }} · 缺编号 {{ counts.unknownByState.missing_key }} · 编号冲突 {{ counts.unknownByState.conflict }} · 内容无法核实 {{ counts.unknownByState.unverifiable }}</p>
    <p class="text-muted-foreground text-table">同版本的重复采集在一组内展开；每次观察的对应与比较资格独立保留。</p>
    <DisclosurePanel v-for="group in groups.rows" :key="group.key" compact padded class="min-w-0 rounded-sm border bg-card" content-class="px-3" data-testid="comparison-business-group">
      <template #trigger>
        <span class="flex min-w-0 flex-1 flex-col gap-1 text-left [overflow-wrap:anywhere]">
          <span>{{ PLATFORM_INTERFACES[group.interface] ?? '平台接口' }} · {{ group.platformKey ?? `观察 #${group.firstRelationId}` }}</span>
          <span class="text-muted-foreground font-normal">{{ group.groupState === 'resolved' ? `${group.versions.length} 个已知内容版本 · ${group.unknownObservations.length} 次内容未知观察` : unknownText(group.groupState) }} · {{ group.observationCount }} 次观察 · {{ linkText(group.linkState) }}<span v-if="group.resultState === 'mixed'"> · 观察结果混合</span></span>
        </span>
      </template>
      <div class="flex min-w-0 flex-col gap-2">
        <DisclosurePanel v-for="version in group.versions" :key="version.versionId ?? group.key" compact class="min-w-0 border-t" content-class="pb-0" :title="`内容版本 #${version.versionId} · ${version.observationCount} 次观察 · ${linkText(version.linkState)}`" data-testid="comparison-business-version">
          <ul class="flex min-w-0 flex-col gap-3">
            <ComparisonBusinessObservation v-for="observation in version.observations" :key="observation.relation.id" :observation="observation" @open-source="sourceId = $event" />
          </ul>
        </DisclosurePanel>
        <section v-if="group.unknownObservations.length" class="min-w-0" :aria-label="group.groupState === 'resolved' ? '内容版本未知的观察' : '业务身份未知的观察'">
          <h4 class="text-sm font-medium">{{ group.groupState === 'resolved' ? '内容版本未知的观察' : '业务身份未知的观察' }} · {{ group.unknownObservations.length }} 次</h4>
          <p class="text-muted-foreground text-table">{{ group.groupState === 'resolved' ? '业务身份已知，原文内容无法核实；这些观察不表示同版本或不同版本。' : '每条观察独立保留，不按名称或空编号合并。' }}</p>
          <ul class="flex min-w-0 flex-col gap-3"><ComparisonBusinessObservation v-for="observation in group.unknownObservations" :key="observation.relation.id" :observation="observation" @open-source="sourceId = $event" /></ul>
        </section>
      </div>
    </DisclosurePanel>
    <p v-if="!groups.total" class="text-muted-foreground text-table">本次范围没有平台观察。</p>
    <TablePagination :page="groups.page" :page-size="groups.pageSize" :total="groups.total" unit="组业务/未知观察" :loading="loading" @update:page="emit('update:page', $event)" @update:page-size="emit('update:pageSize', $event)" />
    <Dialog :open="sourceId !== null" @update:open="open => { if (!open) sourceId = null }">
      <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>采集观察原始记录</DialogTitle><DialogDescription>查看这次观察自己的归档字段与出处；本次比较资格见分组内的观察结果。</DialogDescription></DialogHeader>
        <SourceReader v-if="sourceId !== null" kind="relation" :id="sourceId" :return-to="returnTo" @event-navigate="sourceId = null" />
      </DialogContent>
    </Dialog>
  </section>
</template>
