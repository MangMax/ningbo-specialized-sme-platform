<script setup lang="ts">
import { computed } from 'vue'
import {
  DIFFERENCE_REASONS,
  DIFFERENCE_STATUSES,
  DIFF_STATUS_NONE_LABEL,
} from '~~/lib/labels'
import { historicalAliasNamesForDisplay } from '~~/lib/roster/enterprise-name-display'
import EnterpriseTitleSummary from './EnterpriseTitleSummary.vue'
import EnterpriseAliasSummary from './EnterpriseAliasSummary.vue'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { LayoutList } from '@lucide/vue'

/** 企业粒度表格：身份、认定摘要与原因；完整历史留在抽屉。 */

export interface EnterpriseDifference {
  count: number
  status: string | null
  reasonCode: string | null
  anyCurrent: boolean
}

export interface EnterpriseListRow {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  aliasNames: string[]
  /** 所有企业 × 称号记录,包括没有认定事件的称号。 */
  titles: string[]
  firstRecognition: { titleCode: string; year: number; needsReview: boolean }[]
  awards?: { titleCode: string; year: number | null; batchSeq: number | null }[]
  difference: EnterpriseDifference
}

const props = defineProps<{
  rows: EnterpriseListRow[]
  loading: boolean
  hasError: boolean
  /** 当前在抽屉里展开的那家;**`null` = 没展开**。 */
  selectedId: number | null
  /** 当前有没有生效中的筛选(决定空态要不要给「清除筛选」这个动作)。 */
  filtered: boolean
}>()

const emit = defineEmits<{ select: [id: number, trigger: HTMLButtonElement | null]; clearFilters: [] }>()

function selectRow(id: number, currentTarget: EventTarget | null) {
  const trigger = currentTarget instanceof HTMLButtonElement
    ? currentTarget
    : currentTarget instanceof HTMLTableRowElement
      ? currentTarget.querySelector('button')
      : null
  emit('select', id, trigger)
}

const COLUMNS = 5
const visibleAliasesByEnterpriseId = computed(() => new Map(
  props.rows.map((row) => [
    row.enterpriseId,
    historicalAliasNamesForDisplay(row.aliasNames, row.name),
  ]),
))

/** 差异状态那一格的**文字**(状态 + 配对原因);一个差异记录都没有时是「无差异」。 */
function differenceStatusText(row: EnterpriseListRow): string {
  const d = row.difference
  if (!d.count || d.status == null) return DIFF_STATUS_NONE_LABEL
  const status = DIFFERENCE_STATUSES[d.status] ?? d.status
  const reason = differenceReason(row)
  if (!reason) return status
  // “其他”单看没有信息；补回差异状态，避免整格只剩一个无法扫读的标签。
  return d.reasonCode === 'other' ? `${status} · 其他原因` : reason
}

/** 差异原因的单独一段(好把它画成次要色,与设计稿一致)。 */
function differenceReason(row: EnterpriseListRow): string {
  const code = row.difference.reasonCode
  return code ? (DIFFERENCE_REASONS[code] ?? code) : ''
}

</script>

<template>
  <!--
    自己的滚动容器:表头 `sticky top-0` 要有一个**最近的可滚动祖先**才吸得住,
    窄屏的横向滚动也由这同一层管(`table-container` 的默认 `overflow-auto` 会另起一个
    滚动上下文,这里放开)。
  -->
  <div
    data-testid="enterprise-table-scroll"
    data-evidence-return-scroll-container
    class="data-table-scroll [&_[data-slot=table-container]]:overflow-visible"
  >
    <Table class="data-table w-full min-w-0 table-fixed lg:min-w-[980px]">
      <TableHeader class="sticky top-0 z-10">
        <TableRow class="hover:bg-transparent">
          <TableHead class="bg-muted text-muted-foreground h-9 w-[28%] text-xs font-semibold tracking-wide lg:w-[20rem]">
            企业名称
          </TableHead>
          <TableHead class="bg-muted text-muted-foreground h-9 w-[42%] text-xs font-semibold tracking-wide lg:w-[20rem]">
            称号 · 年份批次
          </TableHead>
          <TableHead class="bg-muted text-muted-foreground hidden h-9 w-[11.5rem] text-xs font-semibold tracking-wide lg:table-cell">
            统一社会信用代码
          </TableHead>
          <TableHead class="bg-muted text-muted-foreground hidden h-9 w-[4.5rem] text-xs font-semibold tracking-wide lg:table-cell">
            属地
          </TableHead>
          <TableHead class="bg-muted text-muted-foreground h-9 w-[30%] text-xs font-semibold tracking-wide lg:w-[12rem]">
            差异状态
          </TableHead>
        </TableRow>
      </TableHeader>

      <!--
        表体「浮起再落定」:筛选一变就轻微抬起,数据落定后回到原位。
        共用 `--ease-snap`(三处基本动效同一条缓动曲线)。
        **只用 transform,不碰 opacity** —— 本项目踩过「用 opacity 做加载遮罩」的坑:
        它会把 `--muted-foreground` 从 5.05:1 压到 2.7:1,加载时正文直接读不了。
      -->
      <TableBody
        class="transition-transform duration-200 ease-snap will-change-transform motion-reduce:transition-none"
        :class="loading ? '-translate-y-0.5' : 'translate-y-0'"
        :data-loading="loading ? 'true' : 'false'"
      >
        <TableRow
          v-for="row in rows"
          :key="row.enterpriseId"
          class="cursor-pointer [&>td]:py-1.5"
          :class="selectedId === row.enterpriseId ? 'bg-accent hover:bg-accent' : ''"
          :aria-current="selectedId === row.enterpriseId ? 'true' : undefined"
          @click="selectRow(row.enterpriseId, $event.currentTarget)"
        >
          <TableCell class="max-w-0 break-words [overflow-wrap:anywhere]">
            <Button
              variant="link"
              class="block h-auto max-w-full rounded-sm p-0 whitespace-normal break-words text-left text-[13px] leading-4 font-medium text-foreground hover:underline sm:truncate"
              data-testid="enterprise-name-trigger"
              :title="row.name"
              @click.stop="selectRow(row.enterpriseId, $event.currentTarget)"
            >
              {{ row.name }}
            </Button>
            <EnterpriseAliasSummary :names="visibleAliasesByEnterpriseId.get(row.enterpriseId) ?? []" />
          </TableCell>

          <TableCell class="text-[13px] whitespace-normal break-words leading-5 [overflow-wrap:anywhere] sm:whitespace-nowrap" data-testid="title-recognition-cell">
            <EnterpriseTitleSummary :titles="row.titles" :first-recognition="row.firstRecognition" :awards="row.awards" />
          </TableCell>

          <TableCell class="text-muted-foreground hidden font-mono text-xs tabular-nums lg:table-cell">
            {{ row.uscc ?? '无统一社会信用代码' }}
          </TableCell>

          <TableCell class="hidden text-[13px] lg:table-cell">{{ row.district ?? '属地未知' }}</TableCell>

          <TableCell class="text-[13px] whitespace-normal break-words leading-4 [overflow-wrap:anywhere] sm:whitespace-nowrap" data-testid="enterprise-difference-cell">
            <span :class="row.difference.count ? '' : 'text-muted-foreground'">
              {{ differenceStatusText(row) }}
            </span>

          </TableCell>
        </TableRow>

        <!--
          加载态只在末尾补**一行**骨架(`_shared-brief.md` 写死的):旧行留在原地,
          用户看得见自己在哪一批数据上等,而不是面对一张白表。这一行也**不兼任铺满表体**。
        -->
        <TableRow v-if="loading" class="hover:bg-transparent">
          <TableCell><Skeleton class="h-3 w-full max-w-40" /></TableCell>
          <TableCell>
            <Skeleton class="h-3 w-full max-w-28" />
            <Skeleton class="ml-2 hidden h-3 w-16 sm:inline-block" />
          </TableCell>
          <TableCell class="hidden lg:table-cell"><Skeleton class="h-3 w-32" /></TableCell>
          <TableCell class="hidden lg:table-cell"><Skeleton class="h-3 w-12" /></TableCell>
          <TableCell><Skeleton class="h-3 w-full max-w-24" /></TableCell>
        </TableRow>

        <TableRow v-if="!loading && !hasError && !rows.length" class="hover:bg-transparent">
          <TableCell :colspan="COLUMNS" class="p-0">
            <Empty class="border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon"><LayoutList /></EmptyMedia>
                <EmptyTitle>没有匹配的企业</EmptyTitle>
                <Button
                  v-if="filtered"
                  variant="outline"
                  size="sm"
                  class="mt-1"
                  @click="emit('clearFilters')"
                >
                  清除全部筛选
                </Button>
              </EmptyHeader>
            </Empty>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
