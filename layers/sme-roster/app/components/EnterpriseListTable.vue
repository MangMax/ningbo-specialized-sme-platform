<script setup lang="ts">
import { computed } from 'vue'
import { historicalAliasNamesForDisplay } from '#sme-roster/lib/roster/enterprise-name-display'
import RosterEnterpriseTitleSummary from './EnterpriseTitleSummary.vue'
import RosterEnterpriseAliasSummary from './EnterpriseAliasSummary.vue'
import { Button } from '#core/app/components/ui/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '#core/app/components/ui/empty'
import { Skeleton } from '#core/app/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#core/app/components/ui/table'
import { LayoutList } from '@lucide/vue'

/** 企业粒度表格：身份和认定摘要；完整历史留在抽屉。 */

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

const COLUMNS = 4
const visibleAliasesByEnterpriseId = computed(() => new Map(
  props.rows.map((row) => [
    row.enterpriseId,
    historicalAliasNamesForDisplay(row.aliasNames, row.name),
  ]),
))

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
    class="data-table-scroll"
  >
    <Table class="data-table w-full min-w-0 table-fixed lg:min-w-[980px]">
      <TableHeader>
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
              class="block h-auto max-w-full rounded-sm p-0 whitespace-normal break-words text-left text-table leading-4 font-medium text-foreground hover:underline sm:truncate"
              data-testid="enterprise-name-trigger"
              :title="row.name"
              @click.stop="selectRow(row.enterpriseId, $event.currentTarget)"
            >
              {{ row.name }}
            </Button>
            <RosterEnterpriseAliasSummary :names="visibleAliasesByEnterpriseId.get(row.enterpriseId) ?? []" />
          </TableCell>

          <TableCell class="text-table whitespace-normal break-words leading-5 [overflow-wrap:anywhere] sm:whitespace-nowrap" data-testid="title-recognition-cell">
            <RosterEnterpriseTitleSummary :titles="row.titles" :first-recognition="row.firstRecognition" :awards="row.awards" />
          </TableCell>

          <TableCell class="text-muted-foreground hidden font-mono text-xs tabular-nums lg:table-cell">
            {{ row.uscc ?? '无统一社会信用代码' }}
          </TableCell>

          <TableCell class="hidden text-table lg:table-cell">{{ row.district ?? '属地未知' }}</TableCell>
        </TableRow>

        <!--
          加载态只在末尾补**一行**骨架(`_shared-brief.md` 写死的):旧行留在原地,
          用户看得见自己在哪一批数据上等,而不是面对一张白表。这一行也**不兼任铺满表体**。
        -->
        <TableRow v-if="loading" class="hover:bg-transparent" aria-hidden="true">
          <TableCell><Skeleton class="h-3 w-full max-w-40" /></TableCell>
          <TableCell>
            <Skeleton class="h-3 w-full max-w-28" />
            <Skeleton class="ml-2 hidden h-3 w-16 sm:inline-block" />
          </TableCell>
          <TableCell class="hidden lg:table-cell"><Skeleton class="h-3 w-32" /></TableCell>
          <TableCell class="hidden lg:table-cell"><Skeleton class="h-3 w-12" /></TableCell>
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
