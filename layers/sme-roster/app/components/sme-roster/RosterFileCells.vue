<script setup lang="ts">
import { computed } from 'vue'
import { Badge } from '#core/app/components/ui/badge'
import { TableCell } from '#core/app/components/ui/table'
import RosterSourceChip from '#sme-roster/app/components/SourceChip.vue'
import { CATEGORY_STATES, KINDS, PARSE_STATES, SOURCES } from '#sme-roster/lib/labels'
import { joinSeries, partBatches, partYears } from '#sme-roster/lib/file-parts'
import type { RosterFileFields } from '#sme-roster/server/modules/sme-roster/files'

const { file: row, mode = 'columns' } = defineProps<{
  file: Partial<RosterFileFields>
  mode?: 'columns' | 'summary' | 'details'
}>()
const isComplete = (file: Partial<RosterFileFields>) => file.source != null && file.kind != null

/**
 * 「内容年份 / 内容批次」列的展示值:**文件内容**里各段去重后的年份(如 `2021、2024`)。
 *
 * 列窄,值可以很多(工信部导出表跨 2021–2026 六个年份、四个批次)。所以只平铺前 2 个,
 * 其余折成 `+4年` / `+4批` —— 带上单位才读得懂「还剩几个」;只写 `+4` 看不出那是什么,
 * 直接截断又让人以为年份就这么多。完整清单在展开的段明细里,悬停 `title` 也能看全。
 *
 * `+4年` 里不留空格:这一列的量过的上限就是 `2021、2022 +4年`(98.6px),加空格会把
 * 「+4年」挤出列宽、只剩省略号 —— 那就等于没写。
 */
const SERIES_HEAD = 2
function seriesCell(values: readonly number[], unit: string) {
  if (!values.length) return null
  const rest = values.length - SERIES_HEAD
  return {
    head: joinSeries(values.slice(0, SERIES_HEAD))!,
    more: rest > 0 ? `+${rest}${unit}` : '',
  }
}
const registeredParts = computed(() => row.registeredSummary?.declarations.map(d => d.part) ?? [])
const years = computed(() => partYears(registeredParts.value))
const batches = computed(() => partBatches(registeredParts.value))
const yearSeries = computed(() => seriesCell(years.value, '年'))
const batchSeries = computed(() => seriesCell(batches.value, '批'))
const emptyYears = computed(() => row.categoryState === undefined ? '—'
  : row.registeredSummary?.count ? '未知' : row.registeredSummary ? '未登记' : '读取未确认')
/** 「文件发布年份/批次」列:文件级**单值**(目录给的),形如 `2024 / 2`、`2024`、`—`。 */
function publishedYearBatch(row: Partial<RosterFileFields>): string {
  if (row.year == null) return '—'
  return row.batch == null ? String(row.year) : `${row.year} / ${row.batch}`
}
const parseLabel = computed(() => row.parseState ? PARSE_STATES[row.parseState] : '—')
const parseVariant = computed(() => row.parseState === 'failed' ? 'destructive'
  : row.parseState === 'parsed' ? 'solid' : 'dashed')
const details = computed(() => [
  { label: '来源', value: row.source ? SOURCES[row.source] : '—' },
  { label: '类别', value: row.kind ? KINDS[row.kind] : '—' },
  { label: '文件发布', value: publishedYearBatch(row) },
  { label: '内容年份', value: joinSeries(years.value) ?? emptyYears.value },
  { label: '内容批次', value: joinSeries(batches.value) ?? '—' },
  { label: '分类状态', value: row.categoryState ? CATEGORY_STATES[row.categoryState] : '—' },
  { label: '解析状态', value: parseLabel.value },
  { label: '被引用', value: row.referenceCount ?? '—' },
])
</script>

<template>
  <div v-if="mode === 'summary'" class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
    <RosterSourceChip v-if="row.source" :code="row.source" />
    <Badge v-if="row.parseState" :variant="parseVariant">{{ parseLabel }}</Badge>
  </div>
  <dl v-else-if="mode === 'details'" class="bg-card mb-3 grid grid-cols-2 gap-x-4 gap-y-3 rounded-md border p-3 text-sm sm:grid-cols-4">
    <div v-for="item in details" :key="item.label" class="min-w-0">
      <dt class="text-muted-foreground">{{ item.label }}</dt>
      <dd class="mt-0.5 font-medium wrap-anywhere">{{ item.value }}</dd>
    </div>
  </dl>
  <template v-else>
  <TableCell>
    <!-- 方标 = 来源语言:经信局藏青、工信部金色(与台账页同一个 SourceChip)。
         写成一个灰底 Badge 就看不出哪份是国家级名单了。 -->
    <RosterSourceChip v-if="row.source" :code="row.source" />
    <span v-else class="text-muted-foreground text-xs">—</span>
  </TableCell>
  <TableCell class="text-muted-foreground text-xs">
    <!-- 类别是低信息量的属性(公布文件/导出表),写成正文色小字即可。
         一行里已经有来源方标 + 两个状态徽章,再挂一个同形的徽章只是噪音。 -->
    <span class="block truncate">{{ row.kind ? KINDS[row.kind] : '—' }}</span>
  </TableCell>
  <!-- 文件发布年份/批次:文件级单值(目录给的),退到次级色 —— 内容年份才是要读的信息。 -->
  <TableCell class="text-muted-foreground text-xs tabular-nums">
    {{ publishedYearBatch(row) }}
  </TableCell>
  <!-- 内容年份:文件**内容**含哪几年(如 2021、2024)。超过两个折成 `+N 年`。 -->
  <TableCell
    class="truncate text-xs font-medium tabular-nums"
    :title="joinSeries(years) ?? undefined"
  >
    <template v-if="yearSeries">
      {{ yearSeries.head
      }}<span
        v-if="yearSeries.more"
        class="text-muted-foreground ml-1 font-normal"
      >
        {{ yearSeries.more }}</span
      >
    </template>
    <span v-else class="text-muted-foreground font-normal">{{ emptyYears }}</span>
  </TableCell>
  <TableCell class="truncate text-xs tabular-nums" :title="joinSeries(batches) ?? undefined">
    <template v-if="batchSeries">
      {{ batchSeries.head
      }}<span
        v-if="batchSeries.more"
        class="text-muted-foreground ml-1"
      >
        {{ batchSeries.more }}</span
      >
    </template>
    <span v-else class="text-muted-foreground">—</span>
  </TableCell>
  <TableCell>
    <!-- 分类状态:已定 / 程序推的 / 未定。三档靠**线型**分开(与事件同一套
         语言 —— `dashed` = 还没坐实),不靠颜色 —— 颜色已被称号梯度占用。 -->
    <Badge
      v-if="row.categoryState"
      :variant="row.categoryState === 'set' ? 'quiet' : 'dashed'"
      :title="
        row.categoryState === 'unset' && !isComplete(row)
          ? '来源或类别未填全'
          : undefined
      "
    >
      {{ CATEGORY_STATES[row.categoryState] }}
    </Badge>
    <span v-else class="text-muted-foreground text-xs">—</span>
  </TableCell>
  <TableCell>
    <!-- 解析状态:未解析 / 已解析 / 解析失败。
         与左边那列刻意用**不同**的线型:两列挨着、列宽也差不多,若默认态
         都画成同一条实线灰边(改前就是这样),扫视时这两列读成一个东西,
         「这份文件还没解析」这个信号就没了。`unparsed` 是**待办**,走虚线
         (与入库培育同一档语义);`parsed` 已坐实走实线;`failed` 才是红。 -->
    <Badge
      v-if="row.parseState"
      :variant="parseVariant"
    >
      {{ parseLabel }}
    </Badge>
    <span v-else class="text-muted-foreground text-xs">—</span>
  </TableCell>
  <TableCell class="text-right text-xs tabular-nums">
    <span
      :class="
        (row.referenceCount ?? 0) > 0 ? 'text-foreground font-medium' : 'text-muted-foreground'
      "
    >
      {{ row.referenceCount ?? '—' }}
    </span>
  </TableCell>
  </template>
</template>
