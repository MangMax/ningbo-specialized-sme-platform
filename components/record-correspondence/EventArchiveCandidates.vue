<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { PlatformBusinessGroup } from '~~/lib/platform/business-record'
import { humanRecordTime } from '~~/lib/roster/record-ledger'
import type { EventArchiveCandidate, EventArchivePage } from '~~/lib/roster/event-archive-candidates'
import { ARCHIVE_CONFLICT_LABELS, ARCHIVE_OUTCOME_LABELS } from '~~/lib/roster/event-archive-candidates'
import { PLATFORM_INTERFACES, PLATFORM_QUERY_STATUSES, TITLES, RELATION_DECLARE_KINDS, PLATFORM_RDJBS } from '~~/lib/labels'
import { fileNameOf } from '~~/lib/preview'
import SourceReader from './SourceReader.vue'
import EventCorrespondenceDecision from './EventCorrespondenceDecision.vue'
import { useCorrespondenceReadback } from '~/composables/useCorrespondenceReadback'
import TablePagination from '@/components/TablePagination.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import TableLoadingStatus from '@/components/TableLoadingStatus.vue'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const props = defineProps<{ eventId: number; back: string; autoLoad?: boolean }>()
type ArchiveRow = EventArchiveCandidate & Partial<Pick<PlatformBusinessGroup, 'observationRefs'>>
type ArchivePage = Omit<EventArchivePage, 'rows'> & { rows: ArchiveRow[] }
const result = ref<ArchivePage | null>(null)
const pending = ref(false)
const failed = ref(false)
const target = ref({ page: 1, pageSize: 50, queryPage: 1, queryPageSize: 25 })
const sourceId = ref<number | null>(null)
const candidateOpened = ref(false)
let sequence = 0
watch(() => props.eventId, () => {
  sequence++; candidateOpened.value = false; result.value = null; pending.value = false; failed.value = false; sourceId.value = null
  target.value = { page: 1, pageSize: 50, queryPage: 1, queryPageSize: 25 }
  if (props.autoLoad) void discover()
}, { immediate: true })
onBeforeUnmount(() => { sequence++ })
async function discover(patch: Partial<typeof target.value> = {}) {
  target.value = { ...target.value, ...patch }
  const request = { ...target.value }, token = ++sequence
  pending.value = true; failed.value = false
  try {
    const next = await $fetch<ArchivePage>('/api/roster/correspondences/discover', { method: 'POST', body: { eventId: props.eventId, ...request } })
    if (token !== sequence) return
    if (next.event.id !== props.eventId || next.page !== request.page || next.coverage.page !== request.queryPage) throw new Error('Discovery page mismatch')
    result.value = next
    return true
  } catch { if (token === sequence) failed.value = true; return false }
  finally { if (token === sequence) pending.value = false }
}
useCorrespondenceReadback(async () => result.value ? discover() : true)
const conflictText = (row: EventArchiveCandidate) => row.conflicts.map(code => ARCHIVE_CONFLICT_LABELS[code] ?? code).join('；')
const queryStateText = (item: EventArchivePage['interfaces'][number]) => item.states.length ? item.states.map(state => `${PLATFORM_QUERY_STATUSES[state.status] ?? state.status} ${state.count} 次`).join('；') : '尚无查询归档（未查询）'
const statusLabel = (status: string | null) => ({ confirmed: '已有确认记录（有效性见原行）', rejected: '已标为不对应', unlinked: '已取消对应', candidate: '已登记候选' })[status ?? ''] ?? '未确认候选'
</script>

<template>
  <section class="relative min-w-0 border-t p-4 text-base leading-6 sm:px-5" aria-label="查找平台对应候选" data-testid="event-archive-candidates">
    <TableLoadingStatus :loading="pending" kind="ledger" label="正在查找归档候选…" />
    <TableFailureState v-if="failed" compact :pending="pending" :title="`候选第 ${target.page} 页读取失败（查询归档第 ${target.queryPage} 页）`" :description="result ? `保留第 ${result.page} 页候选和第 ${result.coverage.page} 页查询归档；目标页面未更新。` : '尚未取得查询结果，不能据此判断无记录。'" @retry="discover()" />
    <p v-if="result?.interfaces.some(item => item.states.some(state => ['failed', 'partial'].includes(state.status)))" class="text-sm" role="status">查询归档含失败或部分结果，请查看查询覆盖。</p>
    <DisclosurePanel :key="eventId" title="人工核对平台候选" keep-mounted data-testid="candidate-disclosure" @update:open="open => { if (open) candidateOpened = true }">
    <template v-if="candidateOpened">
    <div class="flex flex-wrap items-center gap-2 text-base leading-6">
      <Button variant="outline" size="sm" :disabled="pending" data-testid="discover-event-archives" @click="discover()">{{ result ? '重新查找平台候选' : '查找平台对应候选' }}</Button>

    </div>
    <div v-if="result" class="mt-3 flex min-w-0 flex-col gap-4 text-base leading-6">
      <section aria-label="候选依据">
        <h4 class="font-medium">本页可核对项 · {{ result.rows.length }} 项</h4>
        <p>来源记录共 {{ result.total }} 条；本页按同接口业务归组展示，各次原观察可展开查看。</p>
        <p class="text-muted-foreground">来源记录第 {{ result.page }} 页 · 公布出处：<span v-for="(item, i) in result.event.evidence" :key="i">{{ fileNameOf(item.sourceFile) }} · {{ item.attachment ?? '附件未记录' }} · 序号 {{ item.listNo ?? '未记录' }} · 页 {{ item.page ?? '待核' }}；</span><span v-if="!result.event.evidence.length">未记录</span></p>
        <p v-if="!result.rows.length" class="mt-2 text-muted-foreground">本页无对应候选。请结合下方查询覆盖判断，不能据此认定平台无记录。</p>
        <ul v-else class="mt-2 flex flex-col gap-3">
          <li v-for="row in result.rows" :key="row.edge.relationId" class="min-w-0 rounded-sm border p-3 break-words [overflow-wrap:anywhere]">
            <div class="flex flex-wrap items-center gap-2"><span class="font-medium">{{ PLATFORM_INTERFACES[row.evidence.source.interface] ?? '平台接口' }} · {{ RELATION_DECLARE_KINDS[row.evidence.process.declareKind ?? ''] ?? '事项未核实' }}</span><Badge variant="outline">{{ statusLabel(row.existingStatus) }}</Badge></div>
            <p class="text-muted-foreground text-sm">采集于 {{ humanRecordTime(row.evidence.source.queriedAt) }} · {{ PLATFORM_QUERY_STATUSES[row.evidence.source.status] ?? row.evidence.source.status }}</p>
            <p>身份：公布 {{ row.evidence.identity.officialUsccRaw ?? '未提供' }} / 平台 {{ row.evidence.identity.rowUsccRaw ?? '未提供，按已核实归属' }}</p>
            <p>称号：{{ TITLES[row.evidence.title.official] }} / {{ TITLES[row.evidence.title.row] }}</p>
            <p>年份：{{ row.evidence.temporal.eventYear ?? '未提供' }} / {{ row.evidence.temporal.relationYear ?? '未提供' }} · 公布批次 {{ row.evidence.temporal.eventBatchSeq ?? '未提供' }} / 平台 {{ row.evidence.temporal.relationBatch ?? row.evidence.temporal.awardBatchLabel ?? '未提供' }}</p>
            <p v-if="row.evidence.process.appliedAt">申报时间：{{ row.evidence.process.appliedAt }}</p>
            <p v-if="row.conflicts.length">待核依据：{{ conflictText(row) }}</p>
            <p v-if="row.existingStatus" class="text-muted-foreground">保留已有决定，未重新推荐或改写。</p>
            <Button variant="ghost" size="sm" @click="sourceId = row.edge.relationId">查看平台业务详情</Button>
            <DisclosurePanel :title="`各次来源观察 · ${row.observationRefs?.length ?? 1} 条`">
              <ul class="flex flex-col gap-2" aria-label="各次来源观察">
                <li v-for="(observation, index) in row.observationRefs ?? [{ interface: row.evidence.source.interface, relationId: row.edge.relationId, queriedAt: row.evidence.source.queriedAt, queryStatus: row.evidence.source.status }]" :key="observation.relationId" class="flex flex-wrap items-center gap-2">
                  <span>来源观察 {{ index + 1 }} · {{ PLATFORM_INTERFACES[observation.interface] ?? '平台接口' }} · 采集于 {{ humanRecordTime(observation.queriedAt) }} · {{ PLATFORM_QUERY_STATUSES[observation.queryStatus] ?? '查询状态待核' }}</span>
                  <Button variant="ghost" size="sm" @click="sourceId = observation.relationId">查看本次观察</Button>
                </li>
              </ul>
            </DisclosurePanel>
            <EventCorrespondenceDecision :edge="row.edge" :event="result.event" :candidate="row" :back="back" :existing="row.existingCorrespondenceId && row.revision && row.existingStatus ? { id: row.existingCorrespondenceId, revision: row.revision, status: row.existingStatus } : null" />
          </li>
        </ul>
        <TablePagination class="mt-3" :page="result.page" :page-size="result.pageSize" :total="result.total" unit="条来源记录" :loading="pending" @update:page="discover({ page: $event })" @update:page-size="discover({ page: 1, pageSize: $event })" />
      </section>
      <DisclosurePanel title="查询覆盖与技术出处" class="min-w-0 border-t pt-3" data-testid="candidate-coverage">
        <h4 class="font-medium">三接口查询覆盖</h4>
        <p v-for="item in result.interfaces" :key="item.interface" class="text-muted-foreground">{{ PLATFORM_INTERFACES[item.interface] }}：{{ queryStateText(item) }}</p>
        <p class="text-muted-foreground">以下保留各次查询事实，其他称号的查询不能证明本事件无记录。</p>
        <ul class="mt-2 flex flex-col gap-2">
          <li v-for="query in result.coverage.rows" :key="query.id" class="min-w-0 break-words [overflow-wrap:anywhere]">
            <p>{{ PLATFORM_INTERFACES[query.interface] }} · {{ ARCHIVE_OUTCOME_LABELS[query.outcome] ?? query.outcome }}</p>
            <p class="text-muted-foreground text-sm">采集于 {{ humanRecordTime(query.queriedAt) }} · {{ TITLES[query.titleCode ?? ''] ?? PLATFORM_RDJBS[query.rdjb] ?? '来源称号未核实' }} · 来源记录 {{ query.relationCount }} / 可查找记录 {{ query.candidateCount }}</p>
            <p v-if="query.failureReason">失败原因：{{ query.failureReason }}</p>
            <DisclosurePanel><template #trigger>原始查询条件与覆盖</template><p>查询 #{{ query.id }} · {{ query.queryKey }} · 来源级别原值 {{ query.rdjb || '未标注' }}</p><pre class="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{{ JSON.stringify(query.collectionEvidence, null, 2) }}</pre></DisclosurePanel>
          </li>
        </ul>
        <TablePagination class="mt-3" :page="result.coverage.page" :page-size="result.coverage.pageSize" :total="result.coverage.total" unit="次查询" :loading="pending" @update:page="discover({ queryPage: $event })" @update:page-size="discover({ queryPage: 1, queryPageSize: $event })" />
      </DisclosurePanel>
    </div>
    </template>
    </DisclosurePanel>
    <Dialog :open="sourceId !== null" @update:open="value => { if (!value) sourceId = null }">
      <DialogContent class="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>平台业务详情</DialogTitle><DialogDescription>核对原始事实；此处不提交对应结论。</DialogDescription></DialogHeader><SourceReader v-if="sourceId != null" :key="sourceId" kind="relation" presentation="business" :id="sourceId" :return-to="back" /></DialogContent>
    </Dialog>
  </section>
</template>
