<script setup lang="ts">
import QueryAssessmentSummary from '@/components/evidence-review/QueryAssessmentSummary.vue'
import type { ReviewAssessment } from '~~/lib/roster/evidence-review-ui'
import {
  comparisonDirectionLabel,
  DIFFERENCE_MEASURES,
  DIFFERENCE_REASONS,
  DIFFERENCE_STATUSES,
  DIFFERENCE_STATUS_VARIANTS,
  PLATFORM_INTERFACES,
  PLATFORM_QUERY_STATUSES,
  TITLES,
} from '#sme-roster/lib/labels'
import RosterTitleBadge from '#sme-roster/app/components/TitleBadge.vue'
import { Badge, type BadgeVariants } from '#core/app/components/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '#core/app/components/ui/empty'
import { Skeleton } from '#core/app/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#core/app/components/ui/table'
import { GitCompareArrows } from '@lucide/vue'

/**
 * **差异与原因**(RL-04 §7.3)。一行 = 一个(企业 × 称号 × 方向)的**当前**解释。
 *
 * 四种展示态**互不冒充**:状态只从 `difference_reason.status` 取;没有解释记录的坐标
 * 由 queryCoverage / currentDecision / explanationValidity / assessment 分别展示；无决定是尚未判断。
 * 原因与后续措施**成对**显示;迁入缺项显示**待补证**,不猜填。
 *
 * 迁入来源是「企业名 / 称号 / 年份 / 批次」四项拼串 —— 单独抽出来是为了让它在单元格里
 * 与证据列共用同一段拼接,不至于两处各写一遍。
 */

export interface DifferenceRow extends Partial<ReviewAssessment> {
  explanationId: number | null
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  direction: string
  status: string
  reasonCode: string | null
  reasonNote: string | null
  measureCode: string | null
  measureNote: string | null
  movedIn: { city: string | null; titleCode: string | null; year: number | null; batch: number | null; complete: boolean } | null
  verificationStatus: string
  recordedAt: string | null
  inCurrentDifference: boolean
  evidence: { queryId: number; queriedAt: string; interface: string; status: string; relationIds: number[] } | null
}

defineProps<{ rows: DifferenceRow[]; loading: boolean; hasError: boolean }>()

/**
 * 差异状态徽章:六态的颜色**只从 `DIFFERENCE_STATUS_VARIANTS` 取**(单一出处)。
 * 这里不再写本地级联 —— 之前那种写法有两份,一份把「未查询」与「无记录」画成同一枚
 * outline、一份把「待核实」与「查询失败」一律画红,四态当场糊成两态(契约 §3.2)。
 * 状态值本身**只来自读模型的 `difference_reason.status`**,这里不做任何二次推导。
 */
const statusVariant = (code: string): BadgeVariants['variant'] =>
  (DIFFERENCE_STATUS_VARIANTS[code] ?? 'outline') as BadgeVariants['variant']

const movedInText = (m: DifferenceRow['movedIn']) =>
  m == null
    ? ''
    : [
        m.city,
        m.titleCode ? (TITLES[m.titleCode] ?? m.titleCode) : null,
        m.year == null ? null : String(m.year),
        m.batch == null ? null : `第${m.batch}批`,
      ]
        .filter(Boolean)
        .join(' · ')

const COLUMNS = 8
const TH_CLASS = 'bg-muted text-muted-foreground sticky top-0 z-20 h-9 text-xs font-medium'
</script>

<template>
  <div class="max-h-[max(360px,calc(100dvh-22rem))] overflow-auto [&_[data-slot=table-container]]:overflow-visible">
    <Empty v-if="!loading && !hasError && !rows.length" class="border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon"><GitCompareArrows /></EmptyMedia>
        <EmptyTitle>没有匹配的差异</EmptyTitle>
        <EmptyDescription>两个方向与六种状态都可单独筛。</EmptyDescription>
      </EmptyHeader>
    </Empty>
    <Table v-else class="min-w-[1200px]">
      <TableHeader>
        <TableRow class="hover:bg-transparent">
          <TableHead :class="[TH_CLASS, 'w-[22%]']">企业名称</TableHead>
          <TableHead :class="[TH_CLASS, 'w-48']">称号</TableHead>
          <TableHead :class="[TH_CLASS, 'w-40']">方向</TableHead>
          <TableHead :class="[TH_CLASS, 'w-28']">状态</TableHead>
          <TableHead :class="[TH_CLASS, 'w-52']">原因</TableHead>
          <TableHead :class="[TH_CLASS, 'w-56']">后续措施</TableHead>
          <TableHead :class="[TH_CLASS, 'w-56']">迁入来源</TableHead>
          <TableHead :class="[TH_CLASS, 'w-64']">接口证据</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <template v-if="loading && !rows.length">
          <TableRow v-for="i in 8" :key="i" class="h-11">
            <TableCell v-for="j in COLUMNS" :key="j"><Skeleton class="h-4 w-full" /></TableCell>
          </TableRow>
        </template>
        <TableRow
          v-for="row in rows"
          v-else
          :key="`${row.enterpriseId}-${row.titleCode}-${row.direction}`"
          class="h-11 [&>td]:py-1.5 align-top"
        >
          <TableCell class="font-medium">
            <span :title="row.name">{{ row.name }}</span>
            <div v-if="!row.inCurrentDifference" class="mt-1">
              <Badge variant="outline" class="font-normal">当前已不是差异(解释留档)</Badge>
            </div>
          </TableCell>
          <TableCell><RosterTitleBadge :code="row.titleCode" /></TableCell>
          <TableCell class="text-xs">{{ comparisonDirectionLabel(row.direction) }}</TableCell>
          <TableCell>
            <QueryAssessmentSummary v-if="row.queryCoverage && row.currentDecision && row.explanationValidity && row.assessment" :assessment="row as ReviewAssessment" compact />
            <Badge v-else :variant="statusVariant(row.status)">
              {{ DIFFERENCE_STATUSES[row.status] ?? row.status }}
            </Badge>
          </TableCell>
          <TableCell class="text-xs">
            <template v-if="row.reasonCode || row.reasonNote">
              {{ DIFFERENCE_REASONS[row.reasonCode ?? 'other'] ?? row.reasonCode }}
              <span v-if="row.reasonNote" class="text-muted-foreground">— {{ row.reasonNote }}</span>
            </template>
            <span v-else-if="row.explanationId == null" class="text-muted-foreground">无解释记录</span>
            <span v-else class="text-muted-foreground">—</span>
          </TableCell>
          <TableCell class="text-xs">
            <template v-if="row.measureCode">
              {{ DIFFERENCE_MEASURES[row.measureCode] ?? row.measureCode }}
              <span v-if="row.measureNote" class="text-muted-foreground">— {{ row.measureNote }}</span>
            </template>
            <span v-else class="text-muted-foreground">—</span>
          </TableCell>
          <TableCell class="text-xs">
            <template v-if="row.movedIn">
              <template v-if="row.movedIn.complete">{{ movedInText(row.movedIn) }}</template>
              <template v-else>
                <span class="text-destructive">待补证</span>
                <span class="text-muted-foreground">(已知:{{ movedInText(row.movedIn) || '无' }})</span>
              </template>
            </template>
            <span v-else class="text-muted-foreground">—</span>
          </TableCell>
          <TableCell class="text-xs">
            <template v-if="row.evidence">
              {{ PLATFORM_INTERFACES[row.evidence.interface] ?? row.evidence.interface }} ·
              {{ PLATFORM_QUERY_STATUSES[row.evidence.status] ?? row.evidence.status }} ·
              {{ row.evidence.queriedAt.slice(0, 10) }} · 关系 {{ row.evidence.relationIds.length }} 条
            </template>
            <span v-else class="text-muted-foreground">—</span>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
