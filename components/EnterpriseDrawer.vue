<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@pinia/colada'
import { DialogContent, DialogRoot, DialogTitle } from 'reka-ui'
import { ArrowDown, ExternalLink, X } from '@lucide/vue'
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
} from '~~/lib/labels'
import { reviewEventSuffix, timelineEventIdentity } from '~~/lib/roster/enterprise-timeline'
import { historicalAliasNamesForDisplay } from '~~/lib/roster/enterprise-name-display'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * **企业抽屉**(RL-20)—— 方向卡里的「事实三行 + 竖向时间轴 + 差异块」。
 *
 * ── 为什么不是模态弹窗 ──────────────────────────────────────────────────
 * 方向卡写的是「抽屉占右侧 420–480px,**覆盖在表之上**,不挤压表格列宽」,而设计稿里
 * 被选中那一行仍然高亮着、表格仍可读 —— 也就是说**开着抽屉还得能继续看表**。
 * 所以这里用 `DialogRoot :modal="false"`:没有遮罩层、不锁滚动、焦点不困在抽屉里,
 * 但**保留**了对话框该有的可达性(有标题、Esc 关闭、点关闭按钮回到原位)。
 *
 * ── 三块内容,都是实打实从 `/api/roster/enterprises/:id` 取的 ─────────────
 * 1. **事实三行**:属地 / 曾用名 / 差异状态;
 * 2. **竖向时间轴**:该企业**每个称号**的历次事件(认定 / 复核 / 维持),
 *    按「结论年份 → 称号先来后到 → 认定在复核维持前」排;同一年**只写一次年份**
 *    (设计稿点名的那个坑:小巨人的认定与维持同年,别画成两个年份);
 * 3. **差异块**:方向 · 原因 → 措施 的**可视化链**,外加依据原文与措施原文。
 *    这一块就是用户要求的「原因也要可视化」在行级之外的那一半(行级是那条 6px 状态条)。
 */

interface Lifecycle {
  firstRecognitionYear: number | null
  dueYear: number | null
  state: 'none' | 'active' | 'terminated'
  needsReview: boolean
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
  enterprise: {
    enterpriseId: number
    name: string
    uscc: string | null
    district: string | null
    aliasNames: string[]
    firstRecognition: { titleCode: string; year: number }[]
    nextReviewYear: number | null
  }
  aliases: { id: number; name: string; verificationStatus: string }[]
  records: RecordRow[]
  events: EventRow[]
  evidence: { eventId: number; sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }[]
  differences: Difference[]
}

const props = defineProps<{
  /** `null` = 抽屉关着。 */
  enterpriseId: number | null
  /** 当前台账的筛选串(不含分页),用于「完整企业页」返回时落回同一批筛选。 */
  backQuery: string
}>()

const emit = defineEmits<{ close: [] }>()

const open = computed(() => props.enterpriseId != null)

const apiGet = $fetch as unknown as <T>(url: string) => Promise<T>
const { data, isLoading, error } = useQuery({
  key: () => ['ledger-drawer', props.enterpriseId],
  query: () => apiGet<Detail>(`/api/roster/enterprises/${props.enterpriseId}`),
  enabled: () => props.enterpriseId != null,
})

const detail = computed(() => data.value ?? null)
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
 * (开诚 2024 那一组:专精特新维持 → 创新型维持 → 小巨人认定 → 小巨人维持)。
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
  /** 该企业**等级最高**的称号的首次认定 —— 时间轴上被点亮的那一枚。 */
  highlight: boolean
  /** 同一年里第一条才写年份(设计稿点名的坑)。 */
  firstOfYear: boolean
}

/**
 * 时间轴。三步:
 *  1. 事件按 `recordId` 认回称号;只有同一称号下**批次、原年份、结论年份和结论**
 *     都相同的事件才合并,避免跨来源重复,同时保住不同批次与不同复核事实;
 *  2. 按 (年份, 称号先来后到, 事件类型) 排 —— `EVENT_ORDER` 正好是「认定 → 复核 → 维持」;
 *  3. 年份只在每组的第一条上写出来。
 */
const timeline = computed<TimelineItem[]>(() => {
  const events = detail.value?.events ?? []
  const seen = new Set<string>()
  const items: Omit<TimelineItem, 'firstOfYear' | 'highlight'>[] = []
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

  // 点亮的那个:等级最高的称号的**首次认定**(取最早一条,同年刚拿到就算)。
  const awardTitles = items.filter((i) => i.eventType === 'award').map((i) => i.titleCode)
  const topTitle = [...new Set(awardTitles)].sort(
    (a, b) => TITLE_ORDER.indexOf(a) - TITLE_ORDER.indexOf(b),
  )[0]
  const highlightKey = items
    .filter((i) => i.eventType === 'award' && i.titleCode === topTitle)
    .sort((a, b) => (a.year ?? 0) - (b.year ?? 0))[0]?.key

  items.sort(
    (a, b) =>
      (a.year ?? Number.MAX_SAFE_INTEGER) - (b.year ?? Number.MAX_SAFE_INTEGER) ||
      (titleSequence.value.get(a.titleCode) ?? 0) - (titleSequence.value.get(b.titleCode) ?? 0) ||
      EVENT_ORDER.indexOf(a.eventType) - EVENT_ORDER.indexOf(b.eventType) ||
      a.key.localeCompare(b.key),
  )

  let lastYear: number | null | undefined
  return items.map((item) => {
    const firstOfYear = item.year !== lastYear
    lastYear = item.year
    return { ...item, firstOfYear, highlight: item.key === highlightKey }
  })
})

/** 差异块:状态机顺序已经在读模型里排过(`§7.2` 的排序),这里原样用。 */
const differences = computed(() => detail.value?.differences ?? [])

const fullPageTo = computed(() => {
  const q = props.backQuery ? `?back=${encodeURIComponent(props.backQuery)}` : ''
  return `/enterprises/${props.enterpriseId}${q}`
})

const statusTextClass = (code: string) => {
  switch (DIFFERENCE_STATUS_RAILS[code]) {
    case 'confirmed': return 'text-primary'
    case 'failed': return 'text-destructive'
    default: return 'text-muted-foreground'
  }
}
const eventLabel = (type: string) => {
  // 抽屉复用方向卡的事件词:认定 / 复核 / 维持。
  if (type === 'maintain') return '维持'
  return EVENTS[type] ?? type
}

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
 * 「认定 / 复核 / 维持」这一档上要跟的那半句。
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
      :aria-describedby="undefined"
      class="enterprise-drawer bg-card shadow-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right ease-snap fixed inset-y-0 right-0 z-40 flex w-[440px] max-w-full flex-col border-l duration-200 outline-none motion-reduce:animate-none"
    >
      <div v-if="detail" class="flex min-h-0 flex-1 flex-col">
        <!-- 抬头:企业名 + 统代。`DialogTitle` 就是企业名本身,不另造一个标题层。 -->
        <header class="flex items-start gap-3 border-b px-5 py-4">
          <div class="min-w-0 flex-1">
            <DialogTitle class="text-[15px] leading-6 font-semibold">{{ detail.enterprise.name }}</DialogTitle>
            <p class="text-muted-foreground mt-1 font-mono text-xs tabular-nums">
              {{ detail.enterprise.uscc ?? '无统一社会信用代码' }}
            </p>
          </div>
          <Button variant="ghost" size="icon" class="size-7 shrink-0" aria-label="关闭" @click="emit('close')">
            <X class="size-4" />
          </Button>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <!-- 事实三行 -->
          <dl class="grid grid-cols-[70px_1fr] items-baseline gap-y-2">
            <dt class="text-muted-foreground text-xs">属地</dt>
            <dd class="text-[13px]">{{ detail.enterprise.district ?? '属地未知' }}</dd>
            <dt class="text-muted-foreground text-xs">曾用名</dt>
            <dd class="text-[13px]">
              <template v-if="visibleHistoricalAliasNames.length">
                {{ visibleHistoricalAliasNames.join('、') }}
              </template>
              <span v-else class="text-muted-foreground">—</span>
            </dd>
            <dt class="text-muted-foreground text-xs">下次复核</dt>
            <dd class="text-[13px] tabular-nums">
              <span v-if="detail.enterprise.nextReviewYear == null" class="text-muted-foreground">—</span>
              <template v-else>{{ detail.enterprise.nextReviewYear }}</template>
            </dd>
          </dl>

          <!-- 竖向时间轴:称号历史 -->
          <h3 class="text-muted-foreground mt-5 border-t pt-4 text-xs font-medium">称号历史</h3>
          <ol class="mt-3 flex flex-col">
            <li
              v-for="item in timeline"
              :key="item.key"
              class="grid grid-cols-[38px_16px_1fr] items-start"
              :class="item.year == null ? 'min-h-0' : 'min-h-10'"
            >
              <span class="text-muted-foreground pr-2.5 text-right text-xs leading-5 tabular-nums">
                {{ item.firstOfYear && item.year != null ? item.year : '' }}
              </span>
              <!-- 轴线:除最后一条外都往下接;点亮的圆点 = 该企业等级最高称号的首次认定。 -->
              <span class="relative self-stretch">
                <span
                  class="bg-border absolute left-[6px] w-px"
                  :class="item === timeline[timeline.length - 1] ? 'top-[9px] h-3' : 'inset-y-0'"
                />
                <span
                  class="absolute top-[5px] left-[2px] size-[9px] rounded-full border-[1.5px] bg-card"
                  :class="item.highlight ? 'border-primary bg-primary' : 'border-input'"
                />
              </span>
              <span class="text-[13px] leading-5">
                <span>{{ TITLES[item.titleCode] ?? item.titleCode }}</span>
                <span class="text-muted-foreground ml-1.5 text-xs">
                  {{ eventLabel(item.eventType)
                  }}<template v-if="item.batchSeq != null"> · 第{{ item.batchSeq }}批</template>
                  <template v-if="eventSuffix(item)"> {{ eventSuffix(item) }}</template>
                </span>
              </span>
            </li>
          </ol>

          <details v-if="evidenceItems.length" class="mt-5 border-t pt-4" data-testid="enterprise-evidence">
            <summary class="cursor-pointer text-[13px] font-medium">出处 · {{ evidenceItems.length }}</summary>
            <ul class="mt-2 flex flex-col gap-2">
              <li v-for="(item, index) in evidenceItems" :key="`${item.eventId}-${item.sourceFile}-${index}`" class="border-l pl-2">
                <p class="text-muted-foreground text-[13px] leading-5">
                  <template v-if="item.year != null">{{ item.year }} · </template>
                  <template v-if="item.titleCode">{{ TITLES[item.titleCode] ?? item.titleCode }} · </template>
                  <template v-if="item.eventType">{{ eventLabel(item.eventType) }}</template>
                </p>
                <p class="break-words text-[13px] leading-5" :title="item.sourceFile">
                  {{ item.sourceFile }}<template v-if="item.attachment"> · {{ item.attachment }}</template>
                </p>
                <p class="text-muted-foreground text-[13px] leading-5 tabular-nums">
                  <template v-if="item.listNo != null">序号 {{ item.listNo }} · </template>页码 {{ item.page ?? '—' }}
                </p>
              </li>
            </ul>
          </details>

          <!-- 差异块:方向 · 原因 → 措施 的可视化链 + 依据原文 -->
          <template v-if="differences.length">
            <h3 class="text-muted-foreground mt-5 border-t pt-4 text-xs font-medium">差异</h3>
            <div v-for="d in differences" :key="`${d.titleCode}-${d.direction}`" class="mt-3">
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] leading-5">
                <span class="font-medium">{{ TITLES[d.titleCode] ?? d.titleCode }}</span>
                <span :class="statusTextClass(d.status)">{{ DIFFERENCE_STATUSES[d.status] ?? d.status }}</span>
                <span v-if="!d.inCurrentDifference" class="text-muted-foreground">历史差异</span>
              </div>
              <!--
                原因链:方向 → 原因 → 措施。三段之间用**连线**接起来(不是三个并排的 chip),
                于是「为什么会这样、接下来做什么」是一眼看出来的一条链,而不是三句要自己拼的话。
              -->
              <ol class="mt-2 flex flex-col" data-testid="difference-reason-chain">
                <li
                  v-for="(step, i) in [
                    { k: '方向', v: directionLabel(d.direction) },
                    {
                      k: '原因',
                      v: d.reasonCode
                        ? (DIFFERENCE_REASONS[d.reasonCode] ?? d.reasonCode)
                        : d.status === 'confirmed_no_diff'
                          ? '无需原因'
                          : '待核实',
                    },
                    {
                      k: '措施',
                      v: d.measureCode ? measureLabel(d.measureCode) : '—',
                    },
                  ]"
                  :key="step.k"
                  class="grid min-h-8 grid-cols-[50px_26px_1fr] items-start"
                >
                  <span class="text-muted-foreground pr-2 text-right text-xs leading-5">{{ step.k }}</span>
                  <span class="relative self-stretch">
                    <span
                      v-if="i < 2"
                      class="bg-border absolute top-3 bottom-0 left-[12px] w-px"
                    />
                    <span
                      class="absolute top-[6px] left-[8px] size-2 rounded-full"
                      :class="i === 0 ? 'bg-muted-foreground' : 'bg-primary'"
                    />
                    <ArrowDown
                      v-if="i < 2"
                      aria-hidden="true"
                      class="absolute bottom-[-2px] left-[6px] size-3"
                      :class="i === 1 ? 'text-primary' : 'text-muted-foreground'"
                    />
                  </span>
                  <span class="text-[13px] leading-5">{{ step.v }}</span>
                </li>
              </ol>
              <details v-if="d.reasonNote || d.measureNote" class="text-muted-foreground mt-2 border-l pl-2 text-[13px] leading-5">
                <summary class="cursor-pointer font-medium">原始说明</summary>
                <div class="mt-1 space-y-1">
                  <p v-if="d.reasonNote"><span class="font-medium">原因</span> {{ d.reasonNote }}</p>
                  <p v-if="d.measureNote"><span class="font-medium">措施</span> {{ d.measureNote }}</p>
                </div>
              </details>
            </div>
          </template>
        </div>

        <footer class="border-t px-5 py-3">
          <Button as-child variant="ghost" size="sm" class="h-7 gap-1 px-1.5 text-xs">
            <NuxtLink :to="fullPageTo">完整企业页 <ExternalLink class="size-3" /></NuxtLink>
          </Button>
        </footer>
      </div>

      <!-- 取数中与失败时仍保留可见的关闭操作,窄屏上不能让用户等请求结束才能退出。 -->
      <div v-else class="flex min-h-0 flex-1 flex-col">
        <header class="flex items-center justify-between border-b px-5 py-4">
          <DialogTitle class="text-[13px] leading-5 font-medium">企业详情</DialogTitle>
          <Button variant="ghost" size="icon" class="size-7 shrink-0" aria-label="关闭" @click="emit('close')">
            <X class="size-4" />
          </Button>
        </header>
        <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          <p v-if="error" class="text-destructive text-[13px] leading-5">未能加载该企业详情。</p>
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
