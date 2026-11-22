<script setup lang="ts">
import { ROSTER_LEDGER_PATH } from '#sme-roster/lib/sme-roster/routes'
import { computed, ref, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import { ExternalLink, Eye, FileText } from '@lucide/vue'
import {
  ALIAS_SOURCE_KINDS,
  FIRST_RECOGNITION_REASONS,
  FIRST_RECOGNITION_STATUSES,
  PLATFORM_INTERFACES,
  PLATFORM_QUERY_STATUSES,
  PLATFORM_RDJBS,
  RELATION_DECLARE_KINDS,
  RELATION_MATCH_BASES,
  REVIEW_OUTCOMES,
  SOURCE_ORDER,
  TITLE_ORDER,
  VERIFICATION_STATUSES,
} from '#sme-roster/lib/labels'
import { fileNameOf, fileUrl, isPreviewable } from '#core/lib/preview'
import { EVIDENCE_PAGE_WORDS, evidencePageState, evidencePreviewHref } from '#sme-roster/lib/roster/evidence-page'
import { rememberEvidencePreviewReturn } from '#sme-roster/lib/roster/evidence-preview-return'
import { evidencePointerText } from '#sme-roster/lib/roster/first-recognition'
import FilePreviewDialog from '#core/app/components/preview/FilePreviewDialog.vue'
import RosterEventChip from '#sme-roster/app/components/EventChip.vue'
import RosterSourceChip from '#sme-roster/app/components/SourceChip.vue'
import RosterTitleBadge from '#sme-roster/app/components/TitleBadge.vue'
import { Badge } from '#core/app/components/ui/badge'
import { Button } from '#core/app/components/ui/button'
import DisclosurePanel from '#core/app/components/DisclosurePanel.vue'
import { Skeleton } from '#core/app/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#core/app/components/ui/table'

/**
 * 企业展开面板 —— 一家企业的**全部**称号历史与证据(契约 §7.2 的落点)。
 *
 * 展开才取数(点开一次、取一次),不预取整页的详情:总表一屏几十家企业,
 * 每家的记录/事件/出处/关系都取回来,绝大多数永远不会被展开。
 */
interface Alias {
  id: number
  name: string
  sourceKind: string
  verificationStatus: string
  validFrom: string | null
  note: string | null
}
interface Lifecycle {
  firstRecognitionYear: number | null
  anchorYear: number | null
  dueYear: number | null
  state: 'none' | 'active' | 'terminated'
  needsReview: boolean
}
interface EventRow {
  id: number
  recordId: number
  eventType: string
  year: number | null
  batchSeq: number | null
  decidedYear: number | null
  reviewOutcome: string | null
}
interface Evidence {
  eventId: number
  sourceFile: string
  attachment: string | null
  listNo: number | null
  page: number | null
}
interface RecordRow {
  id: number
  titleCode: string
  source: string
  district: string | null
  lifecycle: Lifecycle
}
interface QueryRow {
  id: number
  interface: string
  rdjb: string
  queriedAt: string
  status: string
  relationCount: number
}
interface Relation {
  id: number
  queryId: number
  usccRaw: string | null
  nameRaw: string | null
  province: string | null
  status: string | null
  batch: string | null
  declareKind: string | null
  appliedAt: string | null
  awardBatchLabel: string | null
  year: number | null
  matchBasis: string
  verificationStatus: string
}
/**
 * 首次认定(§7.2 的 `recognitions` 段,RL-08)。**与总表、§7.5 是同一处计算** ——
 * 面板不自己判「哪条算首次」,只把它标出来。
 */
interface Recognition {
  titleCode: string
  firstYear: number | null
  firstEventId: number | null
  source: string | null
  status: 'confirmed' | 'pending'
  pendingReason: string | null
  /** 首次认定那条事件的出处(与 `Evidence` 同形状,但不带 `eventId` —— 事件就是 `firstEventId`)。 */
  evidence: { sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }[]
}
interface Detail {
  enterprise: { name: string; uscc: string | null }
  aliases: Alias[]
  records: RecordRow[]
  events: EventRow[]
  evidence: Evidence[]
  recognitions: Recognition[]
  platform: { queries: QueryRow[]; relations: Relation[] }
}

const props = defineProps<{
  enterpriseId: number
  /**
   * 当前台账的筛选串(不含 `view`)—— 带上它跳到完整企业页,那边的「返回台账」
   * 才能落回同一批筛选,而不是把用户丢回一个没筛过的第一页。
   */
  backQuery?: string
}>()

const emit = defineEmits<{ detailSettled: [enterpriseId: number] }>()

const fullPageTo = computed(
  () =>
    `/enterprises/${props.enterpriseId}${props.backQuery ? `?back=${encodeURIComponent(props.backQuery)}` : ''}`,
)

const apiGet = $fetch as unknown as <T>(url: string) => Promise<T>
const { data, isLoading, error } = useQuery({
  key: () => ['roster-enterprise', props.enterpriseId],
  query: () => apiGet<Detail>(`/api/roster/enterprises/${props.enterpriseId}`),
})

watch(
  [isLoading, data, error],
  () => {
    if (!isLoading.value && (data.value != null || error.value != null)) {
      emit('detailSettled', props.enterpriseId)
    }
  },
  { immediate: true, flush: 'post' },
)

const detail = computed(() => data.value ?? null)
const eventsByRecord = computed(() => {
  const map = new Map<number, EventRow[]>()
  for (const event of detail.value?.events ?? []) {
    const list = map.get(event.recordId) ?? []
    list.push(event)
    map.set(event.recordId, list)
  }
  return map
})
const evidenceByEvent = computed(() => {
  const map = new Map<number, Evidence[]>()
  for (const item of detail.value?.evidence ?? []) {
    const list = map.get(item.eventId) ?? []
    list.push(item)
    map.set(item.eventId, list)
  }
  return map
})
const groupedRecords = computed(() => {
  const groups = new Map<string, RecordRow[]>()
  for (const record of detail.value?.records ?? []) {
    const list = groups.get(record.titleCode) ?? []
    list.push(record)
    groups.set(record.titleCode, list)
  }
  return [...groups.entries()]
    .map(([titleCode, records]) => ({
      titleCode,
      records: [...records].sort(
        (a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source),
      ),
    }))
    .sort((a, b) => titleRank(a.titleCode) - titleRank(b.titleCode))
})
/** 称号等级由高到低(小巨人 → 专精特新 → 创新型),与台账/总表同一主序。 */
function titleRank(code: string) {
  const i = TITLE_ORDER.indexOf(code)
  return i === -1 ? TITLE_ORDER.length : i
}

const relationsByQuery = computed(() => {
  const map = new Map<number, Relation[]>()
  for (const relation of detail.value?.platform.relations ?? []) {
    const list = map.get(relation.queryId) ?? []
    list.push(relation)
    map.set(relation.queryId, list)
  }
  return map
})
const relationCount = computed(() => detail.value?.platform.relations.length ?? 0)

/** 称号 → 该称号的首次认定(§7.2 的 `recognitions` 段;缺席 = 该称号没有正式认定)。 */
const recognitionByTitle = computed(
  () => new Map((detail.value?.recognitions ?? []).map((r) => [r.titleCode, r])),
)

/**
 * 首次认定那一条事件的身份与状态。`pending` 只能标「已知最早」,不能写成结论。
 */
const firstRecognitionByEvent = computed(() => {
  const map = new Map<number, Recognition>()
  for (const recognition of detail.value?.recognitions ?? []) {
    if (recognition.firstEventId != null) map.set(recognition.firstEventId, recognition)
  }
  return map
})

/** 首次认定的状态徽章文案与悬停原因(待确认时必须答得出「为什么」)。 */
function recognitionNote(recognition: Recognition): string {
  if (recognition.status !== 'pending') return ''
  const why = FIRST_RECOGNITION_REASONS[recognition.pendingReason ?? ''] ?? recognition.pendingReason ?? ''
  return `首次认定状态待确认；这是当前已知最早的认定事件,不作为确立结论。原因：${why}`
}

function recognitionEventLabel(recognition: Recognition): string {
  return recognition.status === 'pending' ? '已知最早的认定(待确认)' : '首次认定'
}

function recognitionEventTitle(recognition: Recognition): string {
  if (recognition.status === 'pending') return recognitionNote(recognition)
  return '该称号的首次认定就是这一条(最早的认定;复核通过或失败后再次获批都不会改变它)。'
}

// 出处预览(与台账的企业详情同一套)。
const previewSrc = ref('')
const previewName = ref('')
const previewOpen = ref(false)
function openPreview(e: Evidence) {
  previewSrc.value = fileUrl(e.sourceFile)
  previewName.value = fileNameOf(e.sourceFile)
  previewOpen.value = true
}

// —— RL-10:出处页码的跳转 ——

/**
 * 展开面板里的页码是**链接**(跳转是一次真导航,不是弹窗),所以它得带上「回哪去」。
 * `backQuery` 本来就是这个面板已经握着的台账筛选串(含 `view` / 页码 / `expand`),
 * 拼成台账地址即可 —— 回来时筛选与展开位置原样落回。
 */
const previewBack = computed(() => (props.backQuery ? `${ROSTER_LEDGER_PATH}?${props.backQuery}` : ROSTER_LEDGER_PATH))

function rememberFullDetailReturn(event: MouseEvent): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  rememberEvidencePreviewReturn(previewBack.value, event.currentTarget)
}

function pageHref(v: Evidence): string {
  return evidencePreviewHref({ sourceFile: v.sourceFile, page: v.page, back: previewBack.value })
}

function rememberPreviewReturn(event: MouseEvent) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return
  }
  rememberEvidencePreviewReturn(previewBack.value, event.currentTarget)
}

/** 三态里有页码的那种才可点;另两种只写字,不给链接(没有页码就没有可跳的页)。 */
const pageStateOf = (v: Evidence) => evidencePageState(v.sourceFile, v.page)
</script>

<template>
  <div class="bg-muted/30 border-t px-4 py-3">
    <p v-if="isLoading && !detail" class="text-muted-foreground text-xs">正在取该企业的称号历史与证据…</p>
    <p v-else-if="error" class="text-destructive text-xs">
      未能加载该企业详情。可收起后重试,或稍后再开。
    </p>

    <div v-else-if="detail" class="flex flex-col gap-4">
      <!-- 展开已经装下称号历史与证据;要更深的（文件出处、拆分记录）去完整企业页。 -->
      <div class="flex justify-end">
        <Button as-child variant="ghost" size="sm" class="h-6 gap-1 px-1.5 text-[11px]">
          <NuxtLink :to="fullPageTo" @click="rememberFullDetailReturn">
            完整企业页 <ExternalLink class="size-3" />
          </NuxtLink>
        </Button>
      </div>

      <!-- 曾用名:已确认的参与搜索,pending 的也在(只是不参与) -->
      <section v-if="detail.aliases.length" class="flex flex-col gap-1.5">
        <h4 class="text-muted-foreground text-xs font-medium">曾用名 / 别名</h4>
        <ul class="flex flex-wrap gap-1.5">
          <li v-for="a in detail.aliases" :key="a.id" class="flex items-center gap-1.5">
            <Badge variant="quiet" class="font-normal">{{ a.name }}</Badge>
            <span class="text-muted-foreground text-[11px]">
              {{ ALIAS_SOURCE_KINDS[a.sourceKind] ?? a.sourceKind }} ·
              {{ VERIFICATION_STATUSES[a.verificationStatus] ?? a.verificationStatus }}
            </span>
          </li>
        </ul>
      </section>

      <!-- 称号 × 来源:事件与出处一条不折叠 -->
      <section class="flex flex-col gap-2">
        <h4 class="text-muted-foreground text-xs font-medium">称号历史与出处</h4>
        <div
          v-for="group in groupedRecords"
          :key="group.titleCode"
          class="bg-card rounded-sm border p-2.5"
        >
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <RosterTitleBadge :code="group.titleCode" />
            <span class="text-muted-foreground text-[11px]">
              首次认定
              {{ group.records[0]?.lifecycle.firstRecognitionYear ?? '—' }}
              <template v-if="group.records[0]?.lifecycle.needsReview">(待核)</template>
              · 下次复核
              {{ group.records[0]?.lifecycle.dueYear ?? '—' }}
              <template v-if="group.records[0]?.lifecycle.state === 'terminated'">
                · 资格已终止(复核未通过)
              </template>
            </span>
            <!-- RL-08:首次认定**自己的**状态(与上面那个「待核」是两件事)与出处。 -->
            <template v-if="recognitionByTitle.get(group.titleCode)">
              <Badge
                v-if="recognitionByTitle.get(group.titleCode)!.status === 'pending'"
                variant="dashed"
                class="font-normal"
                :title="recognitionNote(recognitionByTitle.get(group.titleCode)!)"
              >
                首次认定{{ FIRST_RECOGNITION_STATUSES.pending }}
              </Badge>
              <span class="text-muted-foreground text-[11px]">
                出处
                <template v-if="recognitionByTitle.get(group.titleCode)!.evidence.length">
                  {{
                    recognitionByTitle
                      .get(group.titleCode)!
                      .evidence.map((v) => evidencePointerText(v))
                      .join(' ; ')
                  }}
                </template>
                <template v-else>未记录</template>
              </span>
            </template>
          </div>
          <div class="flex flex-col gap-2">
            <div v-for="record in group.records" :key="record.id" class="flex flex-col gap-1.5">
              <div class="flex flex-wrap items-center gap-2">
                <RosterSourceChip :code="record.source" />
                <span class="text-muted-foreground text-[11px]">属地 {{ record.district ?? '—' }}</span>
              </div>
              <ul class="flex flex-col gap-1">
                <li
                  v-for="event in eventsByRecord.get(record.id) ?? []"
                  :key="event.id"
                  class="flex flex-wrap items-center gap-x-2 gap-y-1"
                >
                  <RosterEventChip :type="event.eventType" :year="event.year" :seq="event.batchSeq" />
                  <Badge
                    v-if="firstRecognitionByEvent.has(event.id)"
                    variant="secondary"
                    class="font-normal"
                    data-testid="first-recognition-mark"
                    :title="recognitionEventTitle(firstRecognitionByEvent.get(event.id)!)"
                  >
                    {{ recognitionEventLabel(firstRecognitionByEvent.get(event.id)!) }}
                  </Badge>
                  <Badge v-if="event.reviewOutcome" variant="outline" class="font-normal">
                    {{ REVIEW_OUTCOMES[event.reviewOutcome] ?? event.reviewOutcome }}
                  </Badge>
                  <span
                    v-if="event.eventType === 'review' && event.decidedYear != null"
                    class="text-muted-foreground text-[11px] tabular-nums"
                  >
                    结论年份 {{ event.decidedYear }}
                  </span>
                  <span
                    v-else-if="event.eventType === 'review'"
                    class="text-muted-foreground text-[11px]"
                  >
                    结论年份未知(待核)
                  </span>
                  <span class="text-muted-foreground text-[11px]">
                    出处 {{ (evidenceByEvent.get(event.id) ?? []).length }}
                  </span>
                </li>
              </ul>
              <div
                v-for="event in eventsByRecord.get(record.id) ?? []"
                :key="`v-${event.id}`"
                class="flex flex-col gap-1"
              >
                <div
                  v-for="(v, i) in evidenceByEvent.get(event.id) ?? []"
                  :key="i"
                  class="bg-muted/60 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm px-2 py-1 text-[11px]"
                >
                  <FileText class="text-muted-foreground size-3 shrink-0" />
                  <span class="font-mono break-all">{{ v.sourceFile }}</span>
                  <span v-if="v.attachment" class="text-muted-foreground">{{ v.attachment }}</span>
                  <span v-if="v.listNo != null" class="text-muted-foreground tabular-nums">
                    序号 {{ v.listNo }}
                  </span>
                  <!--
                    页码(RL-10):可点时**跳到该 PDF 的实际页**;没有页码时留空 ——
                    PDF 写「页码待核」,Word / Excel 不写(这类来源没有可复核的「第 N 页」)。
                  -->
                  <NuxtLink
                    v-if="pageStateOf(v) === 'assigned'"
                    :to="pageHref(v)"
                    @click="rememberPreviewReturn"
                    class="text-primary tabular-nums underline underline-offset-2 hover:no-underline"
                  >
                    第 {{ v.page }} 页
                  </NuxtLink>
                  <span v-else-if="pageStateOf(v) === 'pending'" class="text-muted-foreground/70">
                    {{ EVIDENCE_PAGE_WORDS.pending }}
                  </span>
                  <Button
                    v-if="isPreviewable(v.sourceFile)"
                    variant="ghost"
                    size="sm"
                    class="h-5 gap-1 px-1.5 text-[11px]"
                    @click="openPreview(v)"
                  >
                    <Eye class="size-3" />预览
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 平台证据:查询四态 + 该企业的**全部**关系(不按统代折叠) -->
      <DisclosurePanel compact content-class="flex flex-col gap-3 pt-2 pb-0" class="text-xs" :title="`平台证据(查询 ${detail.platform.queries.length} 次 · 关联 ${relationCount} 条)`">
          <div v-if="!detail.platform.queries.length" class="text-muted-foreground text-xs">
            该企业尚未查询平台记录。
          </div>
          <div
            v-for="q in detail.platform.queries"
            :key="q.id"
            class="bg-card flex flex-col gap-1.5 rounded-sm border p-2.5"
          >
            <div class="flex flex-wrap items-center gap-2 text-[11px]">
              <Badge variant="quiet" class="font-normal">
                {{ PLATFORM_INTERFACES[q.interface] ?? q.interface }}
              </Badge>
              <span v-if="PLATFORM_RDJBS[q.rdjb]" class="text-muted-foreground">
                {{ PLATFORM_RDJBS[q.rdjb] }}
              </span>
              <Badge
                :variant="q.status === 'success' ? 'secondary' : q.status === 'failed' ? 'destructive' : 'outline'"
                class="font-normal"
              >
                {{ PLATFORM_QUERY_STATUSES[q.status] ?? q.status }}
              </Badge>
              <span class="text-muted-foreground tabular-nums">
                {{ q.queriedAt.slice(0, 19).replace('T', ' ') }}
              </span>
              <span class="text-muted-foreground">关系 {{ q.relationCount }} 条</span>
            </div>
            <div v-if="(relationsByQuery.get(q.id) ?? []).length" class="data-table-scroll" role="region" aria-label="平台查询关系" tabindex="0">
              <Table class="data-table">
                <TableHeader>
                  <TableRow class="text-left">
                    <TableHead scope="col" class="pr-3 font-medium">企业名称</TableHead>
                    <TableHead scope="col" class="pr-3 font-medium">统一社会信用代码</TableHead>
                    <TableHead scope="col" class="pr-3 font-medium">申报类型</TableHead>
                    <TableHead scope="col" class="pr-3 font-medium">维护批次</TableHead>
                    <TableHead scope="col" class="pr-3 font-medium">认定批次</TableHead>
                    <TableHead scope="col" class="pr-3 font-medium">申报时间</TableHead>
                    <TableHead scope="col" class="pr-3 font-medium">匹配依据</TableHead>
                    <TableHead scope="col" class="font-medium">核验</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow
                    v-for="r in relationsByQuery.get(q.id) ?? []"
                    :key="r.id"
                    class="border-t"
                  >
                    <TableCell class="pr-3">{{ r.nameRaw ?? '—' }}</TableCell>
                    <TableCell class="pr-3 font-mono">{{ r.usccRaw ?? '—' }}</TableCell>
                    <TableCell class="pr-3">{{ RELATION_DECLARE_KINDS[r.declareKind ?? ''] ?? '未记录' }}</TableCell>
                    <TableCell class="pr-3">{{ r.batch ?? '—' }}</TableCell>
                    <TableCell class="pr-3">{{ r.awardBatchLabel ?? '—' }}</TableCell>
                    <TableCell class="pr-3 tabular-nums">{{ r.appliedAt ?? '—' }}</TableCell>
                    <TableCell class="pr-3">{{ RELATION_MATCH_BASES[r.matchBasis] ?? r.matchBasis }}</TableCell>
                    <TableCell>{{ VERIFICATION_STATUSES[r.verificationStatus] ?? r.verificationStatus }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </div>
      </DisclosurePanel>
    </div>

    <div v-else class="flex flex-col gap-1">
      <Skeleton class="h-4 w-40" />
      <Skeleton class="h-4 w-64" />
    </div>
    <FilePreviewDialog v-model:open="previewOpen" :src="previewSrc" :name="previewName" />
  </div>
</template>
