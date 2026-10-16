<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery } from '@pinia/colada'
import { ExternalLink, Eye, FileText } from '@lucide/vue'
import {
  ALIAS_SOURCE_KINDS,
  comparisonDirectionNote,
  DIFFERENCE_MEASURES,
  DIFFERENCE_REASONS,
  DIFFERENCE_STATUSES,
  DIFFERENCE_STATUS_ORDER,
  DIFFERENCE_STATUS_VARIANTS,
  FIRST_RECOGNITION_REASONS,
  FIRST_RECOGNITION_STATUSES,
  PLATFORM_INTERFACES,
  PLATFORM_QUERY_STATUSES,
  PLATFORM_RDJBS,
  RELATION_MATCH_BASES,
  REVIEW_OUTCOMES,
  SOURCE_ORDER,
  TITLES,
  TITLE_ORDER,
  VERIFICATION_STATUSES,
} from '~~/lib/labels'
import { fileNameOf, fileUrl, isPreviewable } from '~~/lib/preview'
import { EVIDENCE_PAGE_WORDS, evidencePageState, evidencePreviewHref } from '~~/lib/roster/evidence-page'
import { rememberEvidencePreviewReturn } from '~~/lib/roster/evidence-preview-return'
import { evidencePointerText } from '~~/lib/roster/first-recognition'
import FilePreviewDialog from '@/components/preview/FilePreviewDialog.vue'
import EventChip from '@/components/EventChip.vue'
import SourceChip from '@/components/SourceChip.vue'
import TitleBadge from '@/components/TitleBadge.vue'
import { Badge, type BadgeVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'

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
  sourceRefId: number
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
interface MovedIn {
  city: string | null
  titleCode: string | null
  year: number | null
  batch: number | null
  complete: boolean
}
interface Difference {
  explanationId: number | null
  titleCode: string
  direction: string
  status: string
  reasonCode: string | null
  reasonNote: string | null
  measureCode: string | null
  measureNote: string | null
  movedIn: MovedIn | null
  verificationStatus: string
  recordedAt: string | null
  inCurrentDifference: boolean
  evidence: { queryId: number; queriedAt: string; interface: string; status: string; relationIds: number[] } | null
}
interface QueryRow {
  id: number
  interface: string
  queryKey: string
  rdjb: string
  queriedAt: string
  status: string
  failureReason: string | null
  relationCount: number
}
interface Relation {
  id: number
  queryId: number
  sequenceNo: number
  relationKey: string | null
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
  differences: Difference[]
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

const fullPageTo = computed(
  () =>
    `/enterprises/${props.enterpriseId}${props.backQuery ? `?back=${encodeURIComponent(props.backQuery)}` : ''}`,
)

const apiGet = $fetch as unknown as <T>(url: string) => Promise<T>
const { data, isLoading, error } = useQuery({
  key: () => ['roster-enterprise', props.enterpriseId],
  query: () => apiGet<Detail>(`/api/roster/enterprises/${props.enterpriseId}`),
})

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

const statusOrder = (code: string) => {
  const i = DIFFERENCE_STATUS_ORDER.indexOf(code)
  return i === -1 ? DIFFERENCE_STATUS_ORDER.length : i
}
const differences = computed(() =>
  [...(detail.value?.differences ?? [])].sort((a, b) => statusOrder(a.status) - statusOrder(b.status)),
)
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

/**
 * 差异状态徽章:六态颜色**只从 `DIFFERENCE_STATUS_VARIANTS` 取**(单一出处,与台账表同款)。
 * 这里不再写本地级联 —— 原来的那份把「未查询」与「无记录」画成同一枚 outline、
 * 把「待核实」与「查询失败」一律画红,恰好违反契约 §3.2 的「四态必须彼此可区分」。
 * 状态值本身只来自读模型的 `difference_reason.status`,不回推到别处。
 */
const statusVariant = (code: string): BadgeVariants['variant'] =>
  (DIFFERENCE_STATUS_VARIANTS[code] ?? 'outline') as BadgeVariants['variant']
const movedInText = (movedIn: MovedIn) =>
  [
    movedIn.city,
    movedIn.titleCode ? (TITLES[movedIn.titleCode] ?? movedIn.titleCode) : null,
    movedIn.year == null ? null : String(movedIn.year),
    movedIn.batch == null ? null : `第${movedIn.batch}批`,
  ]
    .filter(Boolean)
    .join(' · ')

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
const previewBack = computed(() => (props.backQuery ? `/?${props.backQuery}` : '/'))

function pageHref(v: Evidence): string {
  return evidencePreviewHref({ sourceFile: v.sourceFile, page: v.page, back: previewBack.value })
}

function rememberPreviewReturn(event: MouseEvent) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return
  }
  rememberEvidencePreviewReturn(previewBack.value)
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
          <NuxtLink :to="fullPageTo">完整企业页 <ExternalLink class="size-3" /></NuxtLink>
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
              <template v-if="a.sourceRefId"> · 证据行 #{{ a.sourceRefId }}</template>
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
            <TitleBadge :code="group.titleCode" />
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
                <SourceChip :code="record.source" />
                <span class="text-muted-foreground text-[11px]">属地 {{ record.district ?? '—' }}</span>
              </div>
              <ul class="flex flex-col gap-1">
                <li
                  v-for="event in eventsByRecord.get(record.id) ?? []"
                  :key="event.id"
                  class="flex flex-wrap items-center gap-x-2 gap-y-1"
                >
                  <EventChip :type="event.eventType" :year="event.year" :seq="event.batchSeq" />
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

      <!-- 差异与解释:状态、原因、措施、迁入、证据 -->
      <section v-if="differences.length" class="flex flex-col gap-1.5">
        <h4 class="text-muted-foreground text-xs font-medium">差异与解释</h4>
        <div
          v-for="d in differences"
          :key="`${d.titleCode}-${d.direction}`"
          class="bg-card flex flex-col gap-1 rounded-sm border p-2.5"
        >
          <div class="flex flex-wrap items-center gap-2">
            <TitleBadge :code="d.titleCode" />
            <Badge variant="quiet" class="font-normal">
              {{ comparisonDirectionNote(d.direction) }}
            </Badge>
            <Badge :variant="statusVariant(d.status)">
              {{ DIFFERENCE_STATUSES[d.status] ?? d.status }}
            </Badge>
            <Badge v-if="!d.inCurrentDifference" variant="outline" class="font-normal">
              当前已不是差异(解释留档)
            </Badge>
            <span v-if="d.recordedAt" class="text-muted-foreground text-[11px] tabular-nums">
              登记于 {{ d.recordedAt.slice(0, 10) }}
            </span>
          </div>
          <p v-if="d.reasonCode || d.reasonNote" class="text-xs">
            <span class="text-muted-foreground">原因</span>
            {{ DIFFERENCE_REASONS[d.reasonCode ?? 'other'] ?? d.reasonCode }}
            <span v-if="d.reasonNote" class="text-muted-foreground">— {{ d.reasonNote }}</span>
          </p>
          <p v-if="d.measureCode || d.measureNote" class="text-xs">
            <span class="text-muted-foreground">后续措施</span>
            {{ DIFFERENCE_MEASURES[d.measureCode ?? 'none'] ?? d.measureCode }}
            <span v-if="d.measureNote" class="text-muted-foreground">— {{ d.measureNote }}</span>
          </p>
          <p v-if="d.movedIn" class="text-xs">
            <span class="text-muted-foreground">迁入来源</span>
            <template v-if="d.movedIn.complete">{{ movedInText(d.movedIn) }}</template>
            <template v-else>
              <span class="text-destructive">待补证</span>
              <span class="text-muted-foreground">
                (已知:{{ movedInText(d.movedIn) || '无' }};缺项不猜填)
              </span>
            </template>
          </p>
          <p v-if="d.explanationId == null" class="text-muted-foreground text-[11px]">
            还没有针对该差异的解释记录 —— 状态即状态机的「未查询」。
          </p>
          <p v-else-if="d.status === 'needs_review'" class="text-muted-foreground text-[11px]">
            证据不足 / 关系冲突 ⇒ 待核实,不自动合并、不猜填。
          </p>
          <p v-if="d.evidence" class="text-muted-foreground text-[11px]">
            接口证据:{{ PLATFORM_INTERFACES[d.evidence.interface] ?? d.evidence.interface }} ·
            {{ PLATFORM_QUERY_STATUSES[d.evidence.status] ?? d.evidence.status }} ·
            {{ d.evidence.queriedAt.slice(0, 19).replace('T', ' ') }} · 关系
            {{ d.evidence.relationIds.length }} 条
          </p>
        </div>
      </section>

      <!-- 平台证据:查询四态 + 该企业的**全部**关系(不按统代折叠) -->
      <Collapsible v-slot="{ open }">
        <CollapsibleTrigger as-child>
          <Button variant="outline" size="sm" class="h-7 w-fit gap-1.5 text-xs">
            <ExternalLink class="size-3.5" />
            {{ open ? '收起平台证据' : `平台证据(查询 ${detail.platform.queries.length} 次 · 关联 ${relationCount} 条)` }}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent class="mt-2 flex flex-col gap-3">
          <div v-if="!detail.platform.queries.length" class="text-muted-foreground text-xs">
            该企业还没有平台查询记录(未查询 ≠ 无记录)。
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
              <span v-if="q.rdjb" class="text-muted-foreground">
                认定级别 {{ PLATFORM_RDJBS[q.rdjb] ?? q.rdjb }}
              </span>
              <Badge
                :variant="q.status === 'success' ? 'secondary' : q.status === 'failed' ? 'destructive' : 'outline'"
                class="font-normal"
              >
                {{ PLATFORM_QUERY_STATUSES[q.status] ?? q.status }}
              </Badge>
              <span class="text-muted-foreground font-mono">{{ q.queryKey }}</span>
              <span class="text-muted-foreground tabular-nums">
                {{ q.queriedAt.slice(0, 19).replace('T', ' ') }}
              </span>
              <span class="text-muted-foreground">关系 {{ q.relationCount }} 条</span>
              <span v-if="q.failureReason" class="text-destructive">{{ q.failureReason }}</span>
            </div>
            <div v-if="(relationsByQuery.get(q.id) ?? []).length" class="overflow-x-auto">
              <table class="w-full text-[11px]">
                <thead class="text-muted-foreground">
                  <tr class="text-left">
                    <th class="pr-3 font-medium">#</th>
                    <th class="pr-3 font-medium">关联主键</th>
                    <th class="pr-3 font-medium">企业名称</th>
                    <th class="pr-3 font-medium">统一社会信用代码</th>
                    <th class="pr-3 font-medium">申报类型</th>
                    <th class="pr-3 font-medium">维护批次</th>
                    <th class="pr-3 font-medium">认定批次</th>
                    <th class="pr-3 font-medium">申报时间</th>
                    <th class="pr-3 font-medium">匹配依据</th>
                    <th class="font-medium">核验</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="r in relationsByQuery.get(q.id) ?? []"
                    :key="r.id"
                    class="border-t"
                  >
                    <td class="pr-3 tabular-nums">{{ r.sequenceNo }}</td>
                    <td class="pr-3 font-mono">{{ r.relationKey ?? '—' }}</td>
                    <td class="pr-3">{{ r.nameRaw ?? '—' }}</td>
                    <td class="pr-3 font-mono">{{ r.usccRaw ?? '—' }}</td>
                    <td class="pr-3">{{ r.declareKind ?? '—' }}</td>
                    <td class="pr-3">{{ r.batch ?? '—' }}</td>
                    <td class="pr-3">{{ r.awardBatchLabel ?? '—' }}</td>
                    <td class="pr-3 tabular-nums">{{ r.appliedAt ?? '—' }}</td>
                    <td class="pr-3">{{ RELATION_MATCH_BASES[r.matchBasis] ?? r.matchBasis }}</td>
                    <td>{{ VERIFICATION_STATUSES[r.verificationStatus] ?? r.verificationStatus }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>

    <div v-else class="flex flex-col gap-1">
      <Skeleton class="h-4 w-40" />
      <Skeleton class="h-4 w-64" />
    </div>
    <FilePreviewDialog v-model:open="previewOpen" :src="previewSrc" :name="previewName" />
  </div>
</template>
