<script setup lang="ts">
import { computed, ref } from 'vue'
import { HoverCard, HoverCardTrigger } from '@/components/ui/hover-card'
import TableHoverCardContent from './TableHoverCardContent.vue'
import {
  DIFFERENCE_MEASURES,
  DIFFERENCE_REASONS,
  DIFFERENCE_STATUSES,
  DIFFERENCE_STATUS_RAILS,
  RECONCILE_LABELS,
  RECONCILE_SOURCE,
  TITLES,
  VERIFICATION_STATUSES,
} from '~~/lib/labels'
import type { ComparisonDisposition } from '~~/lib/comparison-platform'
import type { ReconcileEntry } from '~~/lib/reconcile'
import { platformNoteForDisplay } from '~~/lib/roster/platform-records'
import { formatFetchTime } from '~~/lib/reconcile-time'

/**
 * 比对行的**平台解释**(票 16 起;RL-15 收口为**以库内为准**)。
 *
 * ── 数据来源为什么换了 ────────────────────────────────────────────────────
 * 原来这一列只读 `data/platform-reconcile.json` 的离线解释缓存。用户 2026-10-16 反馈
 * 「三个称号从平台获取的数据都没了」—— 根因正是**缓存缺失时整列退化成 `—`**,
 * 而库里其实有 `difference_reason` / `platform_query` / `platform_relation`。
 * 现在**主状态文字取自库内解释记录**(`disposition`),离线缓存只在 tooltip 里作**对照**。
 *
 * ── 显示纪律(与契约 §3 / §2.8 一致)────────────────────────────────────
 *  - 状态**只**从 `difference_reason.status` 取;没有解释记录时是状态机的默认态
 *    `not_queried`(「还没查过」,**不是**「没有」),由 `explanationId === null` 说清。
 *  - **读侧不二次推导**:不从查询/关系反推「无记录」或「已确认」,也不改写原因 ——
 *    接口有记录时库里的 `confirmed_reason` + `platform_stale`(平台未更新)原样显示,
 *    **绝不**显示成「无记录」/「已确认无差异」。
 *  - 原因与后续措施**成对**出现;缺项(`movedIn` 不全)标「待补证」,不猜填。
 *
 * ## 打开方式(三轮:触屏必须能开)
 *
 * 一个受控的 `open`,三种触发都写进同一个状态:
 * - **悬停 / 键盘聚焦**:鼠标进→开、出→关(桌面习惯保留);
 * - **点击 / 触摸 tap**:记录按下前的状态，再切换开关；键盘聚焦可直接阅读。
 * - **键盘**:`Enter` / `Space` 等价于点击;`Escape`、失焦、点到别处都关。
 *
 * 触屏没有 hover,这也是**唯一**能在手机上看到说明正文的路径。
 *
 * ## 位置与样式
 * 与企业列表共用浅色悬浮卡片：贴近触发文字、左对齐，交由浮层自动避让视口边缘。
 */
const props = defineProps<{
  /** 库内**当前**处置(始终存在;没有解释记录时状态即 `not_queried`)。 */
  disposition: ComparisonDisposition
  /** 旧解释缓存条目,只作**对照**;缺失时为 `null`。 */
  explanation?: ReconcileEntry | null
}>()

const statusLabel = computed(
  () => DIFFERENCE_STATUSES[props.disposition.status] ?? props.disposition.status,
)
const statusTone = computed(() => {
  switch (DIFFERENCE_STATUS_RAILS[props.disposition.status]) {
    case 'confirmed': return 'text-primary'
    case 'failed': return 'text-destructive'
    default: return 'text-muted-foreground'
  }
})
const reasonLabel = computed(() =>
  props.disposition.reasonCode
    ? (DIFFERENCE_REASONS[props.disposition.reasonCode] ?? props.disposition.reasonCode)
    : null,
)
const measureLabel = computed(() =>
  props.disposition.measureCode
    ? (DIFFERENCE_MEASURES[props.disposition.measureCode] ?? props.disposition.measureCode)
    : null,
)
/**
 * 迁入的原城市/称号/年份/批次;**四项齐全才算完整**,缺项页面显示「待补证」。
 *
 * `movedIn.titleCode` 是 **`title.code`**(契约 §1.5:`moved_in_title_code` FK→`title.code`),
 * 所以查 `TITLES` —— 不是 `PLATFORM_RDJBS`(那张表按 `rdjb` 的 `'1'|'2'|'3'` 索引,查不到)。
 */
const movedInText = computed(() => {
  const value = props.disposition.movedIn
  if (!value) return null
  const parts = [
    value.city,
    value.titleCode ? (TITLES[value.titleCode] ?? value.titleCode) : null,
    value.year != null ? `${value.year} 年` : null,
    value.batch != null ? `第 ${value.batch} 批` : null,
  ].filter((part): part is string => !!part)
  return parts.length ? parts.join(' · ') : null
})
const movedInComplete = computed(() => {
  const value = props.disposition.movedIn
  if (!value) return true
  return value.city != null && value.titleCode != null && value.year != null && value.batch != null
})
/** 还没有解释记录 —— 状态是状态机的默认态,不是「无数据」。 */
const hasRecord = computed(() => props.disposition.explanationId != null)

/**
 * 说明里的**补充部分**:写入侧的 `measure_note` / `reason_note` 有时就是标签本身
 * (如措施 `mark_platform_snapshot` 的说明写成「标明平台时点,不覆盖历史。」),
 * 那样 `标签 — 标签` 会读成复读。note 与标签同义(只差句末标点)时**不再重复**。
 */
function noteSuffix(label: string | null, note: string | null): string | null {
  if (!note) return null
  if (!label) return platformNoteForDisplay(note)
  return note.replace(/[。.]+$/, '') === label.replace(/[。.]+$/, '') ? null : platformNoteForDisplay(note)
}
const reasonSuffix = computed(() => /business_list|businessList|rdjb=/.test(props.disposition.reasonNote ?? '') ? null : noteSuffix(reasonLabel.value, props.disposition.reasonNote))
const measureSuffix = computed(() => noteSuffix(measureLabel.value, props.disposition.measureNote))

/** 旧缓存的对照行;取数时间与缓存自身的 `fetchedAt` 同源(与旧版行为一致)。 */
const cachedLabel = computed(() =>
  props.explanation ? RECONCILE_LABELS[props.explanation.explanation.code] : null,
)
const cachedNote = computed(() => props.explanation?.explanation.note ?? '')
const cachedFetched = computed(() => formatFetchTime(props.explanation?.fetchedAt))
const recordedAt = computed(() => formatFetchTime(props.disposition.recordedAt))

/** 唯一真源:reka 的请求(hover / focus / Escape / blur)与本地点击都写它。 */
const open = ref(false)
/** 按下瞬间是否已经打开 —— 决定这次点击是「开」还是「关」。 */
let openOnPointerDown = false
let openOnClickCapture = false

function onPointerDown() {
  openOnPointerDown = open.value
}
function onClickCapture() {
  // Snapshot before Reka's bubbling click listener requests a close.
  openOnClickCapture = open.value
}
function onClick(event: MouseEvent) {
  // Pointer activation uses the pre-pointerdown snapshot; keyboard/AT click
  // uses the capture-phase snapshot.
  open.value = !(event.detail === 0 ? openOnClickCapture : openOnPointerDown)
}
</script>

<template>
  <HoverCard v-model:open="open" :open-delay="120" :close-delay="120">
      <HoverCardTrigger as-child>
        <button
          type="button"
          :aria-expanded="open"
          :aria-label="`${statusLabel}${reasonLabel ? `：${reasonLabel}` : ''}，展开平台原因与证据`"
          data-testid="reconcile-status-trigger"
          class="inline-flex max-w-full flex-wrap items-baseline gap-x-1 text-left text-[13px] leading-5 underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          @focus="open = true"
          @blur="open = false"
          @keydown.esc="open = false"
          @pointerdown="onPointerDown"
          @click.capture="onClickCapture"
          @click="onClick"
        >
          <span class="font-medium" :class="statusTone">{{ reasonLabel ?? statusLabel }}</span>
        </button>
      </HoverCardTrigger>
      <TableHoverCardContent>
        <div class="flex flex-col gap-1 text-[13px] leading-5">
          <p class="font-medium text-[13px] leading-5">{{ statusLabel }}</p>
          <!-- 没有解释记录:如实说明「还没存下解释」,不说「无数据」。 -->
          <p v-if="!hasRecord" class="text-muted-foreground text-[13px] leading-5" data-testid="reconcile-no-record">
            尚未核实差异，请查看平台记录。
          </p>
          <template v-else>
            <p v-if="reasonLabel || disposition.reasonNote" class="text-muted-foreground text-[13px] leading-5">
              <span class="font-medium">原因:</span>{{ reasonLabel ?? '—'
              }}<template v-if="reasonSuffix"> — {{ reasonSuffix }}</template>
            </p>
            <p v-else class="text-muted-foreground text-[13px] leading-5">原因:尚无已确认原因</p>
            <p v-if="measureLabel || disposition.measureNote" class="text-muted-foreground text-[13px] leading-5">
              <span class="font-medium">后续措施:</span>{{ measureLabel ?? '—'
              }}<template v-if="measureSuffix"> — {{ measureSuffix }}</template>
            </p>
            <p v-else class="text-muted-foreground text-[13px] leading-5">后续措施:—</p>
            <p class="text-muted-foreground text-[13px] leading-5">
              <span class="font-medium">迁入来源:</span>
              <template v-if="movedInText">
                {{ movedInText }}<span v-if="!movedInComplete" class="text-destructive"> · 待补证</span>
              </template>
              <template v-else>—</template>
            </p>
            <p class="text-muted-foreground text-[13px] leading-5">
              核验:{{ VERIFICATION_STATUSES[disposition.verificationStatus] ?? disposition.verificationStatus
              }}<template v-if="recordedAt"> · 登记 {{ recordedAt }}</template>
            </p>
          </template>
          <!-- 历史核实结果:只作对照,不是主源;它缺失时这一行不出现。 -->
          <p
            v-if="explanation && cachedLabel"
            class="text-muted-foreground text-[13px] leading-5"
            data-testid="reconcile-cached"
          >
            历史核实结果:{{ cachedLabel }}<template v-if="cachedNote"> — {{ platformNoteForDisplay(cachedNote) }}</template>
            <template v-if="cachedFetched">({{ RECONCILE_SOURCE }} · 取数 {{ cachedFetched }})</template>
          </p>
        </div>
      </TableHoverCardContent>
  </HoverCard>
</template>
