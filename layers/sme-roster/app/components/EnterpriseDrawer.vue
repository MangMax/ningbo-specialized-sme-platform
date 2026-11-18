<script setup lang="ts">
import { ROSTER_LEDGER_PATH } from '#sme-roster/lib/sme-roster/routes'
import RosterPlatformRecords from './PlatformRecords.vue'
import type { RosterEnterpriseDetail } from '#sme-roster/lib/roster/enterprise-roster'
import type { ReviewAssessment, ReviewScope } from '~~/lib/roster/evidence-review-ui'
import { computed, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import { DialogClose, DialogContent, DialogRoot, DialogTitle } from 'reka-ui'
import { ExternalLink, X } from '@lucide/vue'
import {
  comparisonDirectionNote,
  DIFFERENCE_MEASURES,
  DIFFERENCE_REASONS,
  DIFFERENCE_STATUSES,
  DIFFERENCE_STATUS_RAILS,
  EVENT_ORDER,
  EVENTS,
  TITLE_ORDER,
  TITLES,
} from '#sme-roster/lib/labels'
import { reviewEventSuffix, timelineEventIdentity } from '#sme-roster/lib/roster/enterprise-timeline'
import { rememberEvidencePreviewReturn } from '~~/lib/roster/evidence-preview-return'
import { historicalAliasNamesForDisplay } from '#sme-roster/lib/roster/enterprise-name-display'
import TableFailureState from '../../../core/app/components/TableFailureState.vue'
import DisclosurePanel from '#core/app/components/DisclosurePanel.vue'
import { Button } from '#core/app/components/ui/button'
import { Skeleton } from '#core/app/components/ui/skeleton'

interface Lifecycle {
  firstRecognitionYear: number | null
  dueYear: number | null
  state: 'none' | 'active' | 'terminated'
  needsReview: boolean
  anchorEventId?: number | null
}
interface RecordRow {
  id: number
  titleCode: string
  source: string
  district: string | null
  lifecycle: Lifecycle
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
interface Difference {
  explanationId: number | null
  titleCode: string
  direction: string
  status: string
  reasonCode: string | null
  reasonNote: string | null
  measureCode: string | null
  measureNote: string | null
  verificationStatus: string
  inCurrentDifference: boolean
}
interface Detail {
  businessTimeline: RosterEnterpriseDetail['businessTimeline']
  qualificationAssessment: RosterEnterpriseDetail['qualificationAssessment']
  enterprise: {
    enterpriseId: number
    name: string
    uscc: string | null
    district: string | null
    aliasNames: string[]
    firstRecognition: { titleCode: string; year: number }[]
    nextReviewYear: number | null
    anchorNeedsReview: boolean
  }
  aliases: { id: number; name: string; verificationStatus: string }[]
  records: RecordRow[]
  events: EventRow[]
  evidence: { eventId: number; sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }[]
  differences: Difference[]
  titleAssessments?: (ReviewAssessment & ReviewScope)[]
}

const props = defineProps<{
  /** `null` = 抽屉关着。 */
  enterpriseId: number | null
  /** 当前台账的筛选串(不含分页),用于「完整企业页」返回时落回同一批筛选。 */
  backQuery: string
  /** 打开此抽屉的企业按钮;仅主动关闭时恢复焦点。 */
  returnFocusTarget: HTMLButtonElement | null
}>()

const emit = defineEmits<{ close: [] }>()

const open = computed(() => props.enterpriseId != null)
let interactedOutside = false
let openingTrigger: HTMLElement | null = null

watch(open, (isOpen) => {
  if (isOpen) interactedOutside = false
}, { flush: 'post' })

function onInteractOutside(event: Event) {
  if (!event.defaultPrevented) interactedOutside = true
}

function onOpenAutoFocus() {
  const activeElement = document.activeElement
  openingTrigger = activeElement instanceof HTMLButtonElement && activeElement.closest('tbody')
    ? activeElement
    : null
}

function onCloseAutoFocus(event: Event) {
  const shouldRestoreFocus = !interactedOutside
  const target = props.returnFocusTarget?.isConnected ? props.returnFocusTarget : openingTrigger
  interactedOutside = false
  openingTrigger = null
  if (shouldRestoreFocus && target?.isConnected) {
    event.preventDefault()
    target.focus()
  } else if (!shouldRestoreFocus) {
    event.preventDefault()
  }
}

const apiGet = $fetch as unknown as <T>(url: string) => Promise<T>
const { data, isLoading, error, refetch } = useQuery({
  key: () => ['ledger-drawer', props.enterpriseId],
  query: () => apiGet<Detail>(`/api/roster/enterprises/${props.enterpriseId}`),
  enabled: () => props.enterpriseId != null,
})

const detail = computed(() => data.value?.enterprise.enterpriseId === props.enterpriseId ? data.value : null)
/** 每个称号的复核安排使用后端生命周期；认定年份与批次必须来自对应事件。 */
const nextReviews = computed(() => {
  if (!detail.value) return []
  const records = detail.value.records
  const events = detail.value.events
  const recordTitles = new Map(records.map(record => [record.id, record.titleCode]))
  const seen = new Set<string>()
  return records.filter(record => {
    if (seen.has(record.titleCode) || record.lifecycle.state !== 'active') return false
    seen.add(record.titleCode)
    return true
  }).map(record => {
    const lifecycle = record.lifecycle
    const anchor = events.find(event => event.id === lifecycle.anchorEventId && recordTitles.get(event.recordId) === record.titleCode)
    const originalYear = anchor?.eventType === 'award'
      ? anchor.year ?? anchor.decidedYear
      : anchor?.eventType === 'review' ? anchor.year : null
    const awards = anchor?.eventType === 'award' ? [anchor] : events.filter(event =>
      event.eventType === 'award' && recordTitles.get(event.recordId) === record.titleCode && originalYear != null && event.year === originalYear,
    )
    const batches = new Set(awards.map(event => event.batchSeq))
    const batchSeq = batches.size === 1 && !batches.has(null) ? [...batches][0]! : null
    return {titleCode:record.titleCode, dueYear:lifecycle.dueYear, needsReview:lifecycle.needsReview, originalYear, batchSeq}
  }).sort((a,b) => (a.dueYear ?? Infinity) - (b.dueYear ?? Infinity) || TITLE_ORDER.indexOf(a.titleCode) - TITLE_ORDER.indexOf(b.titleCode))
})
const visibleHistoricalAliasNames = computed(() => {
  const enterprise = detail.value?.enterprise
  return enterprise
    ? historicalAliasNamesForDisplay(enterprise.aliasNames, enterprise.name)
    : []
})

/** 记录 id → 称号;事件只带 `recordId`,时间轴要按称号分。 */
const titleOfRecord = computed(() => {
  const map = new Map<number, string>()
  for (const record of detail.value?.records ?? []) map.set(record.id, record.titleCode)
  return map
})

/** 出处按事件回连称号与事件名;页码直接保留后端值,RL-10 可在此接入跳转。 */
const evidenceItems = computed(() => {
  const events = new Map((detail.value?.events ?? []).map((event) => [event.id, event]))
  return (detail.value?.evidence ?? []).map((item) => {
    const event = events.get(item.eventId)
    return {
      ...item,
      titleCode: event ? titleOfRecord.value.get(event.recordId) ?? null : null,
      eventType: event?.eventType ?? null,
      year: event ? event.decidedYear ?? event.year : null,
    }
  })
})

/**
 * 称号的「先来后到」序号:按**首次认定年**升序,同年按称号等级。
 *
 * 时间轴同年内的顺序就靠它 —— 于是那一年里先拿到的称号排在前面,与设计稿逐行一致
 * (开诚 2024 那一组:专精特新维护 → 创新型维护 → 小巨人认定 → 小巨人维护)。
 */
const titleSequence = computed(() => {
  const order = new Map<string, number>()
  const years = new Map<string, number>()
  for (const f of detail.value?.enterprise.firstRecognition ?? []) years.set(f.titleCode, f.year)
  for (const record of detail.value?.records ?? []) {
    if (!years.has(record.titleCode) && record.lifecycle.firstRecognitionYear != null) {
      years.set(record.titleCode, record.lifecycle.firstRecognitionYear)
    }
  }
  const codes = [...new Set((detail.value?.records ?? []).map((r) => r.titleCode))]
  codes.sort((a, b) => {
    const ya = years.get(a) ?? Number.MAX_SAFE_INTEGER
    const yb = years.get(b) ?? Number.MAX_SAFE_INTEGER
    return ya - yb || TITLE_ORDER.indexOf(a) - TITLE_ORDER.indexOf(b)
  })
  codes.forEach((code, i) => order.set(code, i))
  return order
})

interface TimelineItem {
  key: string
  titleCode: string
  eventType: string
  /** 「这条是什么时候发生的」:结论年份优先(`decidedYear ?? year`),与生命周期锚点同一口径。 */
  year: number | null
  /** 复核所指向的原认定年;`year` 在复核事件中可能是结论年份。 */
  originalYear: number | null
  batchSeq: number | null
  reviewOutcome: string | null
  /** 结论年份缺失的复核事件 ⇒ 锚点待核(不猜填)。 */
  yearUnknown: boolean
}

/**
 * 时间轴。三步:
 *  1. 事件按 `recordId` 认回称号;只有同一称号下**批次、原年份、结论年份和结论**
 *     都相同的事件才合并,避免跨来源重复,同时保住不同批次与不同复核事实;
 *  2. 按 (年份, 称号先来后到, 事件类型) 排 —— `EVENT_ORDER` 正好是「认定 → 复核 → 维护」;
 *  3. 每条事件都保留自己的结论年份;待核年份显示「待核」,不从原认定年份推测。
 */
const timeline = computed<TimelineItem[]>(() => {
  const events = detail.value?.events ?? []
  const seen = new Set<string>()
  const items: TimelineItem[] = []
  for (const event of events) {
    const titleCode = titleOfRecord.value.get(event.recordId)
    if (!titleCode) continue
    const year = event.decidedYear ?? event.year
    const key = timelineEventIdentity(titleCode, event)
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      key: `${key}|${event.id}`,
      titleCode,
      eventType: event.eventType,
      year,
      originalYear: event.eventType === 'review' ? event.year : null,
      batchSeq: event.batchSeq,
      reviewOutcome: event.reviewOutcome,
      yearUnknown: event.eventType === 'review' && event.decidedYear == null,
    })
  }

  items.sort(
    (a, b) =>
      (a.year ?? Number.MAX_SAFE_INTEGER) - (b.year ?? Number.MAX_SAFE_INTEGER) ||
      (titleSequence.value.get(a.titleCode) ?? 0) - (titleSequence.value.get(b.titleCode) ?? 0) ||
      EVENT_ORDER.indexOf(a.eventType) - EVENT_ORDER.indexOf(b.eventType) ||
      a.key.localeCompare(b.key),
  )

  return items
})

/** 差异块:状态机顺序已经在读模型里排过(`§7.2` 的排序),这里原样用。 */
const differences = computed(() => detail.value?.differences ?? [])

const fullPageTo = computed(() => {
  const q = props.backQuery ? `?back=${encodeURIComponent(props.backQuery)}` : ''
  return `/enterprises/${props.enterpriseId}${q}`
})

function rememberLedger(event: MouseEvent) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  rememberEvidencePreviewReturn(props.backQuery ? `${ROSTER_LEDGER_PATH}?${props.backQuery}` : ROSTER_LEDGER_PATH, document.querySelector('[data-testid="enterprise-table-scroll"]') ?? document.querySelector('[data-evidence-return-scroll-container]'))
}

const statusTextClass = (code: string) => {
  switch (DIFFERENCE_STATUS_RAILS[code]) {
    case 'confirmed': return 'text-primary'
    case 'failed': return 'text-destructive'
    default: return 'text-muted-foreground'
  }
}
const eventLabel = (type: string) => EVENTS[type] ?? type

function directionLabel(direction: string) {
  if (direction === 'missing_in_miit') return '应纳未纳'
  if (direction === 'extra_in_miit') return '平台多出'
  return comparisonDirectionNote(direction)
}

function measureLabel(code: string) {
  if (code === 'mark_platform_snapshot') return '标记平台快照'
  return DIFFERENCE_MEASURES[code] ?? code
}

/**
 * 「认定 / 复核 / 维护」这一档上要跟的那半句。
 * 复核的**结论年份未知**时必须说出来 —— 锚点待核靠它,不能只写一个年份让人以为已知。
 */
function eventSuffix(item: TimelineItem): string {
  if (item.eventType !== 'review') return ''
  return reviewEventSuffix(item.reviewOutcome, item.originalYear, item.yearUnknown)
}
</script>

<template>
  <DialogRoot :open="open" :modal="false" @update:open="(v: boolean) => { if (!v) emit('close') }">
    <DialogContent
      data-testid="enterprise-drawer"
      data-floating-drawer="detail"
      data-drawer-side="right"
      :aria-describedby="undefined"
      class="enterprise-drawer bg-card data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right ease-snap fixed z-40 flex flex-col duration-200 outline-none motion-reduce:animate-none"
      @interact-outside="onInteractOutside"
      @open-auto-focus="onOpenAutoFocus"
      @close-auto-focus="onCloseAutoFocus"
    >
      <div v-if="detail" class="flex min-h-0 flex-1 flex-col">
        <!-- 抬头:企业名 + 统代。`DialogTitle` 就是企业名本身,不另造一个标题层。 -->
        <header class="flex items-start gap-3 border-b px-5 py-4">
          <div class="min-w-0 flex-1">
            <DialogTitle class="wrap-anywhere text-[15px] leading-6 font-semibold">{{ detail.enterprise.name }}</DialogTitle>
            <p class="text-muted-foreground mt-1 font-mono text-xs tabular-nums">
              {{ detail.enterprise.uscc ?? '无统一社会信用代码' }}
            </p>
          </div>
          <DialogClose as-child>
            <Button variant="ghost" size="icon" class="size-7 shrink-0" aria-label="关闭">
              <X class="size-4" />
            </Button>
          </DialogClose>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 wrap-anywhere">
          <!-- 事实三行 -->
          <dl class="grid grid-cols-[70px_minmax(0,1fr)] items-baseline gap-y-2">
            <dt class="text-muted-foreground text-xs">属地</dt>
            <dd class="text-table">{{ detail.enterprise.district ?? '属地未知' }}</dd>
            <dt class="text-muted-foreground text-xs">曾用名</dt>
            <dd class="text-table">
              <template v-if="visibleHistoricalAliasNames.length">
                {{ visibleHistoricalAliasNames.join('、') }}
              </template>
              <span v-else class="text-muted-foreground">—</span>
            </dd>
            <dt class="text-muted-foreground text-xs">下次复核</dt>
            <dd data-testid="next-review-value" class="min-w-0 text-table tabular-nums">
              <ul v-if="nextReviews.length" class="space-y-2">
                <li v-for="item in nextReviews" :key="item.titleCode" data-testid="next-review-item" :data-title-code="item.titleCode">
                  <div class="flex flex-wrap items-baseline gap-x-2">
                    <span class="font-medium">{{ TITLES[item.titleCode] ?? item.titleCode }}</span>
                    <span data-testid="next-review-year" :data-review-year="item.dueYear" :data-needs-review="item.needsReview">
                      {{ item.dueYear == null ? '复核年份待核' : `${item.dueYear}年复核` }}<span v-if="item.needsReview" class="text-muted-foreground"> · 待核</span>
                    </span>
                  </div>
                  <div class="text-muted-foreground" data-testid="next-review-cohort">原认定：{{ item.originalYear == null ? '年份待核' : `${item.originalYear}年` }} · {{ item.batchSeq == null ? '批次待核' : `第${item.batchSeq}批` }}</div>
                </li>
              </ul>
              <span v-else class="text-muted-foreground">—</span>
            </dd>
          </dl>

          <RosterPlatformRecords :key="detail.enterprise.enterpriseId" :timeline="detail.businessTimeline" />

          <!-- 称号历史：年份 + 事件；普通分隔线，不做节点/连线装饰。 -->
          <h3 class="text-muted-foreground mt-5 border-t pt-4 text-xs font-medium">称号历史</h3>
          <ol v-if="timeline.length" class="mt-3 divide-y rounded-lg border" data-testid="drawer-timeline">
            <li
              v-for="item in timeline"
              :key="item.key"
              data-testid="timeline-event"
              class="grid grid-cols-[3.5rem_minmax(0,1fr)] items-baseline gap-x-3 px-3 py-2"
            >
              <span
                data-testid="timeline-event-year"
                class="text-muted-foreground text-xs leading-5 tabular-nums"
                :aria-label="item.yearUnknown || item.year == null ? '结论年份待核' : `${item.year}年`"
              >
                {{ item.yearUnknown || item.year == null ? '待核' : item.year }}
              </span>
              <span class="text-table leading-5">
                <span>{{ TITLES[item.titleCode] ?? item.titleCode }}</span>
                <span class="text-muted-foreground ml-1.5 text-xs">
                  {{ eventLabel(item.eventType)
                  }}<template v-if="item.batchSeq != null"> · 第{{ item.batchSeq }}批</template>
                  <template v-if="eventSuffix(item)"> {{ eventSuffix(item) }}</template>
                </span>
              </span>
            </li>
          </ol>
          <p v-else class="text-muted-foreground mt-3 text-table">尚无称号历史。</p>

          <DisclosurePanel v-if="evidenceItems.length" compact content-class="pb-0" class="mt-5 border-t pt-4" data-testid="enterprise-evidence" :title="`出处 · ${evidenceItems.length}`">
            <ul class="mt-2 flex flex-col gap-2">
              <li v-for="(item, index) in evidenceItems" :key="`${item.eventId}-${item.sourceFile}-${index}`" class="py-2 first:pt-0">
                <p class="text-muted-foreground text-table leading-5">
                  <template v-if="item.year != null">{{ item.year }} · </template>
                  <template v-if="item.titleCode">{{ TITLES[item.titleCode] ?? item.titleCode }} · </template>
                  <template v-if="item.eventType">{{ eventLabel(item.eventType) }}</template>
                </p>
                <p class="break-words text-table leading-5" :title="item.sourceFile">
                  {{ item.sourceFile }}<template v-if="item.attachment"> · {{ item.attachment }}</template>
                </p>
                <p class="text-muted-foreground text-table leading-5 tabular-nums">
                  <template v-if="item.listNo != null">序号 {{ item.listNo }} · </template>页码 {{ item.page ?? '—' }}
                </p>
              </li>
            </ul>
          </DisclosurePanel>

          <!-- 差异块:方向 · 原因 → 措施 的可视化链 + 依据原文 -->
          <template v-if="differences.length">
            <h3 class="text-muted-foreground mt-5 border-t pt-4 text-xs font-medium">差异</h3>
            <div v-for="d in differences" :key="`${d.titleCode}-${d.direction}`" class="mt-3">
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-table leading-5">
                <span class="font-medium">{{ TITLES[d.titleCode] ?? d.titleCode }}</span>
                <span data-testid="enterprise-difference-status" :class="statusTextClass(d.status)">{{ DIFFERENCE_STATUSES[d.status] ?? d.status }}</span>
                <span v-if="!d.inCurrentDifference" class="text-muted-foreground">历史差异</span>
              </div>
              <dl class="mt-2 grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 border-t pt-2 text-table leading-5" data-testid="difference-reason-chain">
                <dt class="text-muted-foreground">方向</dt>
                <dd>{{ directionLabel(d.direction) }}</dd>
                <dt class="text-muted-foreground">原因</dt>
                <dd>
                  {{ d.reasonCode
                    ? (DIFFERENCE_REASONS[d.reasonCode] ?? d.reasonCode)
                    : d.status === 'confirmed_no_diff'
                      ? '无需原因'
                      : '待核实' }}
                </dd>
                <dt class="text-muted-foreground">措施</dt>
                <dd>{{ d.measureCode ? measureLabel(d.measureCode) : '—' }}</dd>
              </dl>

            </div>
          </template>
        </div>

        <footer class="border-t px-5 py-3">
          <Button as-child variant="ghost" size="sm" class="h-7 gap-1 px-1.5 text-xs">
            <NuxtLink :to="fullPageTo" @click="rememberLedger">完整企业页 <ExternalLink class="size-3" /></NuxtLink>
          </Button>
        </footer>
      </div>

      <!-- 取数中与失败时仍保留可见的关闭操作,窄屏上不能让用户等请求结束才能退出。 -->
      <div v-else class="flex min-h-0 flex-1 flex-col">
        <header class="flex items-center justify-between border-b px-5 py-4">
          <DialogTitle class="text-table leading-5 font-medium">企业详情</DialogTitle>
          <Button variant="ghost" size="icon" class="size-7 shrink-0" aria-label="关闭" @click="emit('close')">
            <X class="size-4" />
          </Button>
        </header>
        <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          <TableFailureState v-if="error" title="未能加载该企业详情。" :pending="isLoading" description="尚未读取平台证据，可以重新加载。" @retry="refetch()" />
          <template v-else>
            <Skeleton class="h-4 w-56" />
            <Skeleton class="h-3 w-36" />
            <Skeleton class="h-24 w-full" />
          </template>
        </div>
      </div>
    </DialogContent>
  </DialogRoot>
</template>

<style scoped>
.enterprise-drawer :deep([data-slot='button']) {
  box-shadow: none;
}

.enterprise-drawer :deep(.text-xs) {
  font-size: 13px;
  line-height: 1.5;
}
</style>
