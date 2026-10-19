<script setup lang="ts">
import { computed, ref } from 'vue'
import { Eye, FileText } from '@lucide/vue'
import type { CorrespondenceDetail } from '~~/lib/roster/correspondence-view'
import { CORRESPONDENCE_ROLES, correspondenceStatusText } from '~~/lib/roster/correspondence-view'
import { groupEventEdges, humanRecordTime, isConfirmedSourceEdge, isCurrentContextEdge } from '~~/lib/roster/record-ledger'
import { PLATFORM_INTERFACES, PLATFORM_QUERY_STATUSES } from '~~/lib/labels'
import { evidencePageState, evidencePreviewHref } from '~~/lib/roster/evidence-page'
import { fileUrl, fileNameOf, isPreviewable } from '~~/lib/preview'
import SourceReader from './SourceReader.vue'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
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

const props = defineProps<{
  event: LedgerEvent
  evidence: OfficialEvidence[]
  edges: CorrespondenceDetail[]
  back: string
  returnTo?: string | null
}>()
const emit = defineEmits<{
  preview: [evidence: OfficialEvidence]
  'event-navigate': [eventId: number]
  'page-open': [eventId: number, event: MouseEvent]
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

const pageState = (evidence: OfficialEvidence) => evidencePageState(evidence.sourceFile, evidence.page)
const pageHref = (evidence: OfficialEvidence) => evidencePreviewHref({ sourceFile: evidence.sourceFile, page: evidence.page, back: props.back })
function rememberPageReturn(event: MouseEvent) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  emit('page-open', props.event.id, event)
}
const relationLabel = (edge: CorrespondenceDetail) => edge.relation
  ? PLATFORM_INTERFACES[edge.relation.query.interface] ?? '平台接口'
  : edge.exportRow ? fileNameOf(edge.exportRow.batch.originalFilename) : '来源记录'
const relationMeta = (edge: CorrespondenceDetail) => edge.relation
  ? `查询 #${edge.relation.query.id} · 原行 ${edge.relation.sequenceNo} · ${humanRecordTime(edge.relation.query.queriedAt)}`
  : edge.exportRow ? `${edge.exportRow.batch.collectedOn} · 源行 ${edge.exportRow.sourceRowNo}` : '来源记录未绑定'
const relationStatus = (edge: CorrespondenceDetail) => edge.relation
  ? PLATFORM_QUERY_STATUSES[edge.relation.query.status] ?? '状态待核'
  : '状态待核'
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4 border-t p-4 text-[13px] leading-5 sm:px-5" data-testid="record-event-source">
    <div class="grid min-w-0 gap-4 lg:grid-cols-2">
      <section class="min-w-0" aria-label="正式公布文件">
        <h4 class="text-muted-foreground mb-2 text-xs font-medium">正式公布文件</h4>
        <p v-if="!evidence.length" class="text-muted-foreground">此事件未记录公布文件出处。</p>
        <ul v-else class="flex flex-col gap-2">
          <li v-for="(item, index) in evidence" :key="`${item.sourceFile}:${item.listNo}:${index}`" class="min-w-0 border-t pt-2 first:border-t-0 first:pt-0">
            <div class="flex items-start gap-2">
              <FileText class="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <p class="font-medium break-words">{{ fileNameOf(item.sourceFile) }}</p>
                <p class="text-muted-foreground">
                  <span v-if="item.listNo != null">序号 {{ item.listNo }} · </span>
                  <NuxtLink
                    v-if="pageState(item) === 'assigned'"
                    :to="pageHref(item)"
                    class="text-primary tabular-nums underline underline-offset-2 hover:no-underline"
                    @click="rememberPageReturn"
                  >第 {{ item.page }} 页</NuxtLink>
                  <span v-else-if="pageState(item) === 'pending'">页码待核</span>
                  <span v-else>这类文件没有可复核的页码</span>
                  <span v-if="item.attachment" class="text-muted-foreground"> · {{ item.attachment }}</span>
                </p>
                <div class="mt-1 flex flex-wrap items-center gap-2">
                  <Button v-if="isPreviewable(item.sourceFile)" variant="outline" size="sm" class="h-7 gap-1 px-2 text-[13px]" @click="emit('preview', item)">
                    <Eye class="size-3.5" />查看原文件
                  </Button>
                  <a v-else :href="fileUrl(item.sourceFile)" target="_blank" rel="noopener" class="text-primary underline underline-offset-2">下载原文件</a>
                </div>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section class="min-w-0" aria-label="平台接口记录">
        <h4 class="text-muted-foreground mb-2 text-xs font-medium">平台接口记录</h4>
        <p v-if="!groups.sources.length" class="text-muted-foreground">
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
            <DisclosurePanel compact content-class="pb-0" class="text-muted-foreground mt-0.5">
              <template #trigger><span>原行字段与查询条件</span></template>
              <p>{{ CORRESPONDENCE_ROLES[edge.role] ?? '对应关系' }} · {{ relationMeta(edge) }}</p>
            </DisclosurePanel>
            <Button variant="ghost" size="sm" class="mt-1 h-7 px-2 text-[13px]" @click="openSource(edge)">查看原始记录</Button>
          </li>
        </ul>
      </section>
    </div>

    <div v-if="groups.candidates.length" class="border-t pt-3" data-testid="event-candidates">
      <p class="font-medium">候选记录 · 待确认（{{ groups.candidates.length }} 条）</p>
      <ul class="mt-2 flex flex-col gap-1.5">
        <li v-for="edge in groups.candidates" :key="edge.id" class="flex flex-wrap items-center gap-2">
          <span>{{ relationLabel(edge) }}</span>
          <Badge variant="outline">{{ correspondenceStatusText(edge) }}</Badge>
          <DisclosurePanel compact content-class="pb-0" class="text-muted-foreground">
            <template #trigger><span>原行字段与查询条件</span></template>
            <p>{{ CORRESPONDENCE_ROLES[edge.role] ?? '对应关系' }} · {{ relationMeta(edge) }}</p>
          </DisclosurePanel>
          <Button v-if="edge.relationId != null || edge.exportRowId != null" variant="ghost" size="sm" class="h-7 px-2 text-[13px]" @click="openSource(edge)">查看原始记录</Button>
        </li>
      </ul>
    </div>

    <div v-if="groups.revalidation.length" class="border-t pt-3" data-testid="event-revalidation">
      <p class="font-medium">待重新核验（{{ groups.revalidation.length }} 条）</p>
      <p class="text-muted-foreground mt-0.5">这些对应在出处变更后需要重新核验，当前不按已确认出处计。</p>
      <ul class="mt-2 flex flex-col gap-1.5">
        <li v-for="edge in groups.revalidation" :key="edge.id" class="flex flex-wrap items-center gap-2">
          <span>{{ relationLabel(edge) }}</span>
          <Badge variant="outline">{{ correspondenceStatusText(edge) }}</Badge>
          <DisclosurePanel compact content-class="pb-0" class="text-muted-foreground">
            <template #trigger><span>原行字段与查询条件</span></template>
            <p>{{ CORRESPONDENCE_ROLES[edge.role] ?? '对应关系' }} · {{ relationMeta(edge) }}</p>
          </DisclosurePanel>
          <Button v-if="edge.relationId != null || edge.exportRowId != null" variant="ghost" size="sm" class="h-7 px-2 text-[13px]" @click="openSource(edge)">查看原始记录</Button>
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
          <DisclosurePanel compact content-class="pb-0" class="text-muted-foreground">
            <template #trigger><span>原行字段与查询条件</span></template>
            <p>{{ relationMeta(edge) }}</p>
          </DisclosurePanel>
          <Button v-if="edge.relationId != null || edge.exportRowId != null" variant="ghost" size="sm" @click="openSource(edge)">查看原始记录</Button>
        </li>
      </ul>
    </div>

    <DisclosurePanel v-if="groups.history.length" compact content-class="pb-0" class="text-[13px]" data-testid="event-match-history" :title="`匹配历史 · ${groups.history.length} 条（已拒绝 / 已解除，不计为出处）`">
      <ul class="mt-2 flex flex-col gap-1.5">
        <li v-for="edge in groups.history" :key="edge.id" class="flex flex-wrap items-center gap-2 border-t pt-1.5">
          <span>{{ relationLabel(edge) }}</span>
          <Badge variant="outline">{{ correspondenceStatusText(edge) }}</Badge>
          <span class="text-muted-foreground">{{ relationMeta(edge) }}</span>
          <Button v-if="edge.relationId != null || edge.exportRowId != null" variant="ghost" size="sm" class="h-7 px-2 text-[13px]" @click="openSource(edge)">查看原始记录</Button>
        </li>
      </ul>
    </DisclosurePanel>

    <DisclosurePanel v-if="otherEdges.length" compact content-class="pb-0" class="text-[13px]" :title="`其他登记关系 · ${otherEdges.length} 条`">
      <ul class="mt-2 flex flex-col gap-1.5">
        <li v-for="edge in otherEdges" :key="edge.id" class="flex flex-wrap items-center gap-2 border-t pt-1.5">
          <span>{{ CORRESPONDENCE_ROLES[edge.role] ?? '对应关系' }}</span>
          <Badge variant="outline">{{ correspondenceStatusText(edge) }}</Badge>
          <span class="text-muted-foreground">{{ relationMeta(edge) }}</span>
        </li>
      </ul>
    </DisclosurePanel>

    <p v-if="!hasEitherSide" class="text-muted-foreground">这条事件目前没有已登记的两侧出处；这不表示公布文件或平台没有记录。</p>

    <Dialog :open="sourceDialogId !== null" @update:open="onDialogOpenChange">
      <DialogContent class="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-3xl" @close-auto-focus="onDialogCloseAutoFocus">
        <DialogHeader>
          <DialogTitle>平台原行与查询条件</DialogTitle>
          <DialogDescription>查看这条记录的原始字段与查询信息。</DialogDescription>
        </DialogHeader>
        <SourceReader v-if="sourceDialogId !== null" :kind="sourceDialogKind" :id="sourceDialogId" :return-to="returnTo" @event-navigate="closeForEventFromReader" />
      </DialogContent>
    </Dialog>
  </div>
</template>
