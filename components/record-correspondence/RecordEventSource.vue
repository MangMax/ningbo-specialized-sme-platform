<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CorrespondenceDetail } from '~~/lib/roster/correspondence-view'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import { CORRESPONDENCE_ROLES, correspondenceStatusText } from '~~/lib/roster/correspondence-view'
import { groupEventEdges, humanRecordTime, isConfirmedSourceEdge, isCurrentContextEdge } from '~~/lib/roster/record-ledger'
import { PLATFORM_INTERFACES, PLATFORM_QUERY_STATUSES } from '~~/lib/labels'
import { fileNameOf } from '~~/lib/preview'
import OfficialEvidence from './OfficialEvidence.vue'
import SourceReader from './SourceReader.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface OfficialEvidence {
  sourceFile: string
  attachment: string | null
  listNo: number | null
  page: number | null
}
interface LedgerEvent {
  id: number
  type: string
  year: number | null
  seq: number | null
  decidedYear: number | null
  reviewOutcome: string | null
}

const props = withDefaults(defineProps<{
  event: LedgerEvent
  evidence: OfficialEvidence[]
  edges: CorrespondenceDetail[]
  showOfficial?: boolean
  edgesReady?: boolean
  edgesLoading?: boolean
  edgesError?: boolean
  back: string
  returnTo?: string | null
}>(), { edgesReady: true, showOfficial: true })
const emit = defineEmits<{
  preview: [evidence: OfficialEvidence]
  'event-navigate': [eventId: number]
  'page-open': [eventId: number, event: MouseEvent]
  'retry-detail': []
}>()

const groups = computed(() => groupEventEdges(props.edges.filter(edge => edge.type !== 'later_process')))
const otherEdges = computed(() => props.edges.filter(edge => !isConfirmedSourceEdge(edge) && !isCurrentContextEdge(edge) && !edge.requiresRevalidation && edge.type !== 'later_process' && edge.status !== 'candidate' && edge.status !== 'rejected' && edge.status !== 'unlinked'))
const hasEitherSide = computed(() => props.evidence.length > 0 || groups.value.sources.length > 0)

const sourceDialogId = ref<number | null>(null)
const sourceDialogKind = ref<'relation' | 'export_row'>('relation')
const navigatingToEvent = ref(false)
const pendingEventId = ref<number | null>(null)
function openSource(edge: CorrespondenceDetail) {
  const id = edge.relationId ?? edge.exportRowId
  if (id == null) return
  navigatingToEvent.value = false
  pendingEventId.value = null
  sourceDialogKind.value = edge.relationId != null ? 'relation' : 'export_row'
  sourceDialogId.value = id
}
/** The reader asks to open an event: close the dialog first, then let the page scroll/reopen it. */
function closeForEventFromReader(eventId: number) {
  navigatingToEvent.value = true
  pendingEventId.value = eventId
  sourceDialogId.value = null
}
function onDialogOpenChange(open: boolean) {
  if (open) return
  sourceDialogId.value = null
}
function onDialogCloseAutoFocus(event: Event) {
  if (!navigatingToEvent.value) return
  event.preventDefault()
  const eventId = pendingEventId.value
  pendingEventId.value = null
  navigatingToEvent.value = false
  if (eventId != null) emit('event-navigate', eventId)
}

function rememberPageReturn(event: MouseEvent) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  emit('page-open', props.event.id, event)
}
const relationLabel = (edge: CorrespondenceDetail) => edge.relation
  ? PLATFORM_INTERFACES[edge.relation.query.interface] ?? '平台接口'
  : edge.exportRow ? fileNameOf(edge.exportRow.batch.originalFilename) : '来源记录'
const relationMeta = (edge: CorrespondenceDetail) => edge.relation
  ? `采集于 ${humanRecordTime(edge.relation.query.queriedAt)}`
  : edge.exportRow ? `采集于 ${edge.exportRow.batch.collectedOn}` : '来源记录未绑定'
const relationStatus = (edge: CorrespondenceDetail) => edge.relation
  ? PLATFORM_QUERY_STATUSES[edge.relation.query.status] ?? '状态待核'
  : '状态待核'
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4 border-t p-4 text-base leading-6 sm:px-5" data-testid="record-event-source">
    <div class="grid min-w-0 gap-4" :class="showOfficial ? 'lg:grid-cols-2' : undefined">
      <section v-if="showOfficial" class="min-w-0" aria-label="正式公布文件">
        <h4 class="text-muted-foreground mb-2 text-sm font-medium">正式公布文件</h4>
        <p v-if="!evidence.length" class="text-muted-foreground">此事件未记录公布文件出处。</p>
        <ul v-else class="flex flex-col gap-2">
          <li v-for="(item, index) in evidence" :key="`${item.sourceFile}:${item.listNo}:${index}`" class="min-w-0 border-t pt-2 first:border-t-0 first:pt-0">
            <OfficialEvidence :evidence="item" :back="back" preview-in-place @preview="emit('preview', item)" @page-open="rememberPageReturn" />
          </li>
        </ul>
      </section>

      <section class="min-w-0" aria-label="平台接口记录">
        <h4 class="text-muted-foreground mb-2 text-sm font-medium">平台接口记录</h4>
        <div v-if="edgesError && !edgesReady" class="flex flex-wrap items-center gap-2">
          <p class="text-muted-foreground">对应出处读取失败；不能据此判断没有来源。</p>
          <Button variant="outline" size="sm" @click="emit('retry-detail')">重试读取</Button>
        </div>
        <p v-else-if="!edgesReady" class="text-muted-foreground">{{ edgesLoading ? '正在读取对应出处…' : '对应出处尚未读取。' }}</p>
        <p v-else-if="!groups.sources.length" class="text-muted-foreground">
          暂无与这条记录匹配的已确认接口出处。
        </p>
        <ul v-else class="flex flex-col gap-2">
          <li v-for="edge in groups.sources" :key="edge.id" class="min-w-0 border-t pt-2 first:border-t-0 first:pt-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-medium">{{ relationLabel(edge) }}</span>
              <span class="text-muted-foreground">匹配</span>
              <Badge variant="secondary">{{ correspondenceStatusText(edge) }}</Badge>
            </div>
            <p class="text-muted-foreground mt-0.5">平台查询状态 {{ relationStatus(edge) }} · 原办理状态 {{ edge.relation?.status ?? '未提供' }}</p>
            <p v-if="edge.relation?.nameRaw" class="mt-0.5 break-words">原行名称：{{ edge.relation.nameRaw }}</p>
            <p class="mt-0.5">{{ CORRESPONDENCE_ROLES[edge.role] ?? '对应关系' }}</p>
            <Button variant="ghost" size="sm" class="mt-1" @click="openSource(edge)">查看平台业务详情</Button>
          </li>
        </ul>
      </section>
    </div>

    <DisclosurePanel v-if="groups.candidates.length" class="border-t pt-3" data-testid="event-candidates" :title="`未确认对应 · ${groups.candidates.length} 条`">
      <ul class="mt-2 flex flex-col gap-1.5">
        <li v-for="edge in groups.candidates" :key="edge.id" class="flex flex-wrap items-center gap-2">
          <span>{{ relationLabel(edge) }}</span>
          <Badge variant="outline">{{ correspondenceStatusText(edge) }}</Badge>
          <p class="text-muted-foreground">{{ CORRESPONDENCE_ROLES[edge.role] ?? '对应关系' }} · {{ relationMeta(edge) }}</p>
          <Button v-if="edge.relationId != null || edge.exportRowId != null" variant="ghost" size="sm" @click="openSource(edge)">查看平台业务详情</Button>
        </li>
      </ul>
    </DisclosurePanel>

    <div v-if="groups.revalidation.length" class="border-t pt-3" data-testid="event-revalidation">
      <p class="font-medium">待重新核验（{{ groups.revalidation.length }} 条）</p>
      <p class="text-muted-foreground mt-0.5">这些对应在出处变更后需要重新核验，当前不按已确认出处计。</p>
      <ul class="mt-2 flex flex-col gap-1.5">
        <li v-for="edge in groups.revalidation" :key="edge.id" class="flex flex-wrap items-center gap-2">
          <span>{{ relationLabel(edge) }}</span>
          <Badge variant="outline">{{ correspondenceStatusText(edge) }}</Badge>
          <p class="text-muted-foreground">{{ CORRESPONDENCE_ROLES[edge.role] ?? '对应关系' }} · {{ relationMeta(edge) }}</p>
          <Button v-if="edge.relationId != null || edge.exportRowId != null" variant="ghost" size="sm" @click="openSource(edge)">查看平台业务详情</Button>
        </li>
      </ul>
    </div>

    <div v-if="groups.currentContext.length" class="border-t pt-3" data-testid="event-current-reference">
      <p class="font-medium">当前导出快照（非历史出处，{{ groups.currentContext.length }} 条）</p>
      <p class="text-muted-foreground mt-0.5">仅核对当前名称与代码，不作历史认定证据。</p>
      <ul class="mt-2 flex flex-col gap-1.5">
        <li v-for="edge in groups.currentContext" :key="edge.id" class="flex flex-wrap items-center gap-2">
          <span>{{ relationLabel(edge) }}</span>
          <Badge variant="outline">{{ correspondenceStatusText(edge) }}</Badge>
          <p class="text-muted-foreground">{{ relationMeta(edge) }}</p>
          <Button v-if="edge.relationId != null || edge.exportRowId != null" variant="ghost" size="sm" @click="openSource(edge)">查看平台业务详情</Button>
        </li>
      </ul>
    </div>

    <DisclosurePanel v-if="groups.history.length" class="border-t pt-3" data-testid="event-match-history" :title="`匹配历史 · ${groups.history.length} 条`">
      <p class="text-muted-foreground mt-0.5">已拒绝 / 已解除，不计为出处。</p>
      <ul class="mt-2 flex flex-col gap-1.5">
        <li v-for="edge in groups.history" :key="edge.id" class="flex flex-wrap items-center gap-2">
          <span>{{ relationLabel(edge) }}</span>
          <Badge variant="outline">{{ correspondenceStatusText(edge) }}</Badge>
          <span class="text-muted-foreground">{{ relationMeta(edge) }}</span>
          <Button v-if="edge.relationId != null || edge.exportRowId != null" variant="ghost" size="sm" @click="openSource(edge)">查看平台业务详情</Button>
        </li>
      </ul>
    </DisclosurePanel>

    <section v-if="otherEdges.length" class="border-t pt-3 text-sm">
      <h5 class="font-medium">其他登记关系 · {{ otherEdges.length }} 条</h5>
      <ul class="mt-2 flex flex-col gap-1.5">
        <li v-for="edge in otherEdges" :key="edge.id" class="flex flex-wrap items-center gap-2">
          <span>{{ CORRESPONDENCE_ROLES[edge.role] ?? '对应关系' }}</span>
          <Badge variant="outline">{{ correspondenceStatusText(edge) }}</Badge>
          <span class="text-muted-foreground">{{ relationMeta(edge) }}</span>
        </li>
      </ul>
    </section>

    <p v-if="edgesReady && !hasEitherSide" class="text-muted-foreground">这条事件目前没有已登记的两侧出处；这不表示公布文件或平台没有记录。</p>

    <Dialog :open="sourceDialogId !== null" @update:open="onDialogOpenChange">
      <DialogContent class="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-3xl" @close-auto-focus="onDialogCloseAutoFocus">
        <DialogHeader>
          <DialogTitle>平台业务详情</DialogTitle>
          <DialogDescription>查看这条记录的原始字段与查询信息。</DialogDescription>
        </DialogHeader>
        <SourceReader v-if="sourceDialogId !== null" :kind="sourceDialogKind" presentation="business" :id="sourceDialogId" :return-to="returnTo" @event-navigate="closeForEventFromReader" />
      </DialogContent>
    </Dialog>
  </div>
</template>
