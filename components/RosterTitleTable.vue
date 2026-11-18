<script setup lang="ts">
import { ROSTER_LEDGER_PATH } from '~~/lib/sme-roster/routes'
import { computed, nextTick, ref, watch, type Ref } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { Search } from '@lucide/vue'
import { EVENTS, SOURCES, TITLES } from '~~/lib/labels'
import EventChip from '@/components/EventChip.vue'
import SourceChip from '@/components/SourceChip.vue'
import TitleBadge from '@/components/TitleBadge.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Skeleton } from '@/components/ui/skeleton'
import { rememberEvidencePreviewReturn } from '~~/lib/roster/evidence-preview-return'
import { evidencePreviewHref } from '~~/lib/roster/evidence-page'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

/**
 * **按企业×称号**的分组表(原 `/` 台账;RL-17 收进合并页的第二个分组)。
 *
 * 一行 = 一个企业 × 一个称号,合并该组合下**全部来源**的记录,事件直接列在行内。
 * 与「按企业」是同一份数据的另一种分组 —— 页面的筛选条与 URL 两者共用,
 * 所以下钻(`/roster?source=…&year=…`)在两种分组下落到的是同一批企业。
 *
 * 表体虚拟化:一页最多 200 行 × 每行 44px,不虚拟化在窄屏上会明显掉帧。
 */

export interface TitleRow {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  sources: string[]
  events: {
    type: string
    year: number | null
    seq: number | null
    source: string
    evidence?: { sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }[]
  }[]
}

const props = defineProps<{
  rows: TitleRow[]
  loading: boolean
  hasError: boolean
  /** 当前台账的筛选串(不含 `view`),企业详情页靠它「返回台账」不丢上下文。 */
  backQuery: string
}>()

const emit = defineEmits<{ open: [path: string] }>()

const scrollRef = ref<HTMLElement | null>(null)

/** 行虚拟化(表体大时只渲染可视行)。 */
const rowVirtualizer = useVirtualizer(
  computed(() => ({
    count: props.rows.length,
    getScrollElement: () => scrollRef.value,
    estimateSize: () => 44,
    overscan: 8,
  })),
)
const virtualRows = computed(() => rowVirtualizer.value.getVirtualItems())
const usingVirtual = computed(() => virtualRows.value.length > 0)
/** 可视行(表体未测量完成时回退为整页渲染,避免空白)。 */
const visibleRows = computed(() =>
  usingVirtual.value
    ? virtualRows.value.map((vi) => ({ index: vi.index, row: props.rows[vi.index]! }))
    : props.rows.map((row, index) => ({ index, row })),
)
const totalSize = computed(() => rowVirtualizer.value.getTotalSize())
const paddingTop = computed(() => (usingVirtual.value ? (virtualRows.value[0]?.start ?? 0) : 0))
const paddingBottom = computed(() => {
  const last = virtualRows.value[virtualRows.value.length - 1]
  return usingVirtual.value && last ? Math.max(0, totalSize.value - last.end) : 0
})

// 换页/换筛选后把表体滚回顶部,否则新一页会停在上一页的滚动位置。
watch(
  () => props.rows,
  () => nextTick(() => scrollRef.value?.scrollTo({ top: 0 })),
)

/** 表格内联展示的事件上限,超出折叠为 +N,悬浮展开完整卡片。 */
const MAX_VISIBLE_EVENTS = 2
const COLUMNS = 6
const TH_CLASS = 'bg-muted text-muted-foreground sticky top-0 z-20 h-9 text-xs font-medium'
const rowKey = (r: TitleRow) => `${r.enterpriseId}-${r.titleCode}`

function enterpriseDetailHref(id: number): string {
  return `/enterprises/${id}${props.backQuery ? `?back=${encodeURIComponent(props.backQuery)}` : ''}`
}

function rememberEnterpriseReturn(event: MouseEvent): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const back = props.backQuery ? `${ROSTER_LEDGER_PATH}?${props.backQuery}` : ROSTER_LEDGER_PATH
  rememberEvidencePreviewReturn(back, event.currentTarget)
}

function evidenceHref(evidence: NonNullable<TitleRow['events'][number]['evidence']>[number]): string {
  const back = props.backQuery ? `${ROSTER_LEDGER_PATH}?${props.backQuery}` : ROSTER_LEDGER_PATH
  return evidencePreviewHref({ sourceFile: evidence.sourceFile, page: evidence.page, back })
}

function evidenceLabel(evidence: NonNullable<TitleRow['events'][number]['evidence']>[number]): string {
  const filename = evidence.sourceFile.split('/').pop() ?? evidence.sourceFile
  return `${evidence.page == null ? '' : `第 ${evidence.page} 页 · `}${filename}`
}

function rememberEvidenceReturn(event: MouseEvent): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const back = props.backQuery ? `${ROSTER_LEDGER_PATH}?${props.backQuery}` : ROSTER_LEDGER_PATH
  rememberEvidencePreviewReturn(back, scrollRef.value)
}

/** 整行可点,但拖选文字时不该跳走。 */
function openRow(id: number, event: MouseEvent) {
  if (typeof window !== 'undefined' && window.getSelection()?.toString()) return
  rememberEnterpriseReturn(event)
  emit('open', enterpriseDetailHref(id))
}
</script>

<template>
  <div
    ref="scrollRef"
    data-evidence-return-scroll-container
    class="max-h-[max(360px,calc(100dvh-22rem))] overflow-auto [&_[data-slot=table-container]]:overflow-visible"
  >
    <Table class="min-w-[1040px]">
      <TableHeader>
        <TableRow class="hover:bg-transparent">
          <TableHead :class="TH_CLASS">企业名称</TableHead>
          <TableHead :class="[TH_CLASS, 'w-40']">统一社会信用代码</TableHead>
          <TableHead :class="[TH_CLASS, 'w-20']">区县</TableHead>
          <TableHead :class="[TH_CLASS, 'w-40']">称号</TableHead>
          <TableHead :class="[TH_CLASS, 'w-32']">来源</TableHead>
          <TableHead :class="[TH_CLASS, 'w-64']">事件</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-if="loading && !rows.length" class="hover:bg-transparent">
          <TableCell :colspan="COLUMNS" class="p-0">
            <div class="flex flex-col">
              <div
                v-for="i in 8"
                :key="i"
                class="flex h-11 items-center gap-3 border-b px-3 last:border-b-0"
              >
                <Skeleton class="h-4 flex-1" />
                <Skeleton class="h-4 w-40" />
                <Skeleton class="h-4 w-16" />
                <Skeleton class="h-5 w-28 rounded-sm" />
              </div>
            </div>
          </TableCell>
        </TableRow>

        <template v-else-if="rows.length">
          <TableRow aria-hidden class="hover:bg-transparent border-0">
            <TableCell :colspan="COLUMNS" :style="{ height: `${paddingTop}px`, padding: 0 }" />
          </TableRow>

          <TableRow
            v-for="item in visibleRows"
            :key="rowKey(item.row)"
            class="hover:bg-accent/70 h-11 cursor-pointer"
            @click="openRow(item.row.enterpriseId, $event)"
          >
            <TableCell class="max-w-0 truncate font-medium">
              <NuxtLink
                :to="enterpriseDetailHref(item.row.enterpriseId)"
                :title="item.row.name"
                class="hover:text-primary hover:underline"
                @click.stop="rememberEnterpriseReturn($event)"
              >
                {{ item.row.name }}
              </NuxtLink>
            </TableCell>
            <TableCell class="text-muted-foreground font-mono text-xs">
              {{ item.row.uscc ?? '—' }}
            </TableCell>
            <TableCell class="text-muted-foreground text-xs">
              {{ item.row.district ?? '—' }}
            </TableCell>
            <TableCell>
              <TitleBadge :code="item.row.titleCode" />
            </TableCell>
            <TableCell>
              <div class="flex flex-wrap items-center gap-1">
                <SourceChip v-for="s in item.row.sources" :key="s" :code="s" />
              </div>
            </TableCell>
            <TableCell @click.stop>
              <HoverCard :open-delay="100" :close-delay="120">
                <HoverCardTrigger class="flex flex-wrap items-center gap-1">
                  <template v-for="(e, i) in item.row.events.slice(0, MAX_VISIBLE_EVENTS)" :key="i">
                    <EventChip :type="e.type" :year="e.year" :seq="e.seq" />
                    <NuxtLink
                      v-for="(evidence, evidenceIndex) in (e.evidence ?? []).slice(0, 1)"
                      :key="`${evidence.sourceFile}-${evidenceIndex}`"
                      :to="evidenceHref(evidence)"
                      :title="evidence.sourceFile"
                      :aria-label="`${evidence.sourceFile}${evidence.page == null ? '' : `，第 ${evidence.page} 页`}`"
                      class="text-primary max-w-36 truncate text-[10px] underline underline-offset-2 hover:no-underline"
                      @click.stop="rememberEvidenceReturn"
                    >
                      {{ evidenceLabel(evidence) }}
                    </NuxtLink>
                  </template>
                  <Badge
                    v-if="item.row.events.length > MAX_VISIBLE_EVENTS"
                    variant="quiet"
                    class="tabular-nums"
                  >
                    +{{ item.row.events.length - MAX_VISIBLE_EVENTS }}
                  </Badge>
                  <span v-if="item.row.events.length === 0" class="text-muted-foreground text-xs">
                    —
                  </span>
                </HoverCardTrigger>
                <HoverCardContent v-if="item.row.events.length" align="start" class="w-80 p-3">
                  <div class="flex items-baseline justify-between gap-2">
                    <span class="text-sm font-medium">全部事件</span>
                    <span class="text-muted-foreground text-xs tabular-nums">
                      {{ item.row.events.length }} 个
                    </span>
                  </div>
                  <ul class="mt-2.5 flex flex-col gap-1.5 border-t pt-2.5">
                    <li v-for="(e, i) in item.row.events" :key="i" class="flex flex-col items-start gap-1.5">
                      <EventChip :type="e.type" :year="e.year" :seq="e.seq" />
                      <SourceChip :code="e.source" />
                      <NuxtLink
                        v-for="(evidence, evidenceIndex) in e.evidence ?? []"
                        :key="`${evidence.sourceFile}-${evidenceIndex}`"
                        :to="evidenceHref(evidence)"
                        class="text-primary max-w-full break-all text-[11px] underline underline-offset-2 hover:no-underline"
                        @click.stop="rememberEvidenceReturn"
                      >
                        {{ evidence.sourceFile }}<template v-if="evidence.page != null"> · 第 {{ evidence.page }} 页</template>
                      </NuxtLink>
                    </li>
                  </ul>
                </HoverCardContent>
              </HoverCard>
            </TableCell>
          </TableRow>

          <TableRow aria-hidden class="hover:bg-transparent border-0">
            <TableCell :colspan="COLUMNS" :style="{ height: `${paddingBottom}px`, padding: 0 }" />
          </TableRow>
        </template>

        <TableRow v-else class="hover:bg-transparent">
          <TableCell :colspan="COLUMNS" class="p-0">
            <Empty class="border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Search /></EmptyMedia>
                <EmptyTitle>没有匹配的企业 × 称号</EmptyTitle>
                <EmptyDescription>去掉一两个筛选条件,或换个关键词再试。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
