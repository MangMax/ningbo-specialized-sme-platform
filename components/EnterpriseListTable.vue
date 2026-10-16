<script setup lang="ts">
import {
  DIFFERENCE_REASONS,
  DIFFERENCE_STATUSES,
  DIFFERENCE_STATUS_RAILS,
  DIFF_STATUS_NONE_LABEL,
  TITLE_SHORT,
} from '~~/lib/labels'
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

/**
 * **企业列表**的唯一表格(RL-20)。一行 = 一家企业。
 *
 * ── 相对上一版(RosterEnterpriseTable)改了什么 ──────────────────────────
 *
 * 1. **称号 × 认定年压进一个单元格并列**(方向卡写死的第二条账)。旧表把三个称号摆成
 *    一排徽章、首次认定与下次复核另占一列,一眼扫下来是「徽章墙 + 一串「(待核)」」;
 *    现在这一列就是 `小巨人 2024 · 专精特新 2021 · 创新型 2022`,完整事件链
 *    (认定/复核/维持)**只在抽屉里**出现。
 * 2. **最左多了一条 6px 状态条**(方向卡的结构性突破)。它把「差异状态」从彩色胶囊里
 *    拿出来放到边上,于是向下滚动时那一列连成一条**可读的带**,一眼就是这 7,298 家
 *    企业的差异分布;同屏也少了一列花色。
 * 3. **加载态不再清空表体**。旧表 `loading && !rows.length` 时渲染 8 行骨架 ——
 *    换筛选条件时整张表先白一下(而且骨架也是「行」,把 `verify-ledger-ui` 的就绪判据
 *    骗过去过一次)。现在旧行**留在原地**,只在末尾补一行骨架 + 页面顶部一条进度线,
 *    表体本身「浮起再落定」——这才是「正在搜索」该有的样子。
 * 4. **没有解释性小字**。空态只剩一句标题加一个**动作**(清除筛选),不再写「可放宽…再试」。
 */

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

const emit = defineEmits<{ select: [id: number]; clearFilters: [] }>()

const COLUMNS = 6

/**
 * 「称号 · 认定年」那一格的内容。
 *
 * **只写认定年**,不写复核/维持、也不写「(待核)」—— `_shared-brief.md` 写死了这一条
 * (「『称号 · 认定年』只写认定年;完整事件链(认定/复核/维持)只在抽屉里出现」),
 * 方向卡的 36px 行高也是按它定的。`needsReview` 这类**锚点待核**的信息因此只在抽屉里出现
 * —— 那是本条记录的事实层,不属于「一眼扫过去」的那一列。
 *
 * 顺序就是 `firstRecognition` 自己的顺序(称号等级由高到低),与全站的称号主序一致。
 *
 * 称号在这里用 `TITLE_SHORT`(小巨人 / 专精特新 / 创新型):三个全称加年份约 **585px**,
 * 而这一列在 1440 视口下只有 ~272px —— 用全称必然换行成两行,方向卡的「一行一家企业」
 * 当场破掉。抽屉里那几行时间轴写的是**全称**(那里不挤)。
 */
function titleItems(row: EnterpriseListRow) {
  const firstYear = new Map(row.firstRecognition.map((item) => [item.titleCode, item.year]))
  return row.titles.map((code) => ({
    code,
    label: TITLE_SHORT[code] ?? code,
    year: firstYear.get(code) ?? null,
  }))
}

/** 差异状态那一格的**文字**(状态 + 配对原因);一个差异记录都没有时是「无差异」。 */
function differenceStatusText(row: EnterpriseListRow): string {
  const d = row.difference
  if (!d.count || d.status == null) return DIFF_STATUS_NONE_LABEL
  return DIFFERENCE_STATUSES[d.status] ?? d.status
}

/** 差异原因的单独一段(好把它画成次要色,与设计稿一致)。 */
function differenceReason(row: EnterpriseListRow): string {
  const code = row.difference.reasonCode
  return code ? (DIFFERENCE_REASONS[code] ?? code) : ''
}

/**
 * 状态条取向 → 类名。**映射只有这一处**(取值表在 `lib/labels.ts` 的
 * `DIFFERENCE_STATUS_RAILS`)。三档的含义与「为什么不是六档」写在那张表的注释里。
 *
 * `open` 用 `bg-input`(`--input`,浅一档的描边灰):6px 的条要在白底上看得见,
 * 又要比「无差异」那一档的**空白**更明确 —— 空白 / 藏青 / 浅灰 / 红四种观感各有含义,
 * 滚动时那条带才读得出来。
 */
function railClass(row: EnterpriseListRow): string {
  const status = row.difference.status
  if (!row.difference.count || status == null) return 'bg-transparent'
  switch (DIFFERENCE_STATUS_RAILS[status]) {
    case 'confirmed':
      return 'bg-primary'
    case 'failed':
      return 'bg-destructive'
    default:
      return 'bg-input'
  }
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
    class="overflow-auto lg:max-h-[min(640px,calc(100dvh-260px))] [&_[data-slot=table-container]]:overflow-visible"
  >
    <Table class="w-full min-w-0 table-fixed sm:min-w-[980px]">
      <TableHeader class="sticky top-0 z-10">
        <TableRow class="hover:bg-transparent">
          <TableHead class="bg-muted h-9 w-[6px] p-0">
            <span class="sr-only">差异状态</span>
          </TableHead>
          <TableHead class="bg-muted text-muted-foreground h-9 w-[32%] text-xs font-semibold tracking-wide sm:w-auto">
            企业名称
          </TableHead>
          <TableHead class="bg-muted text-muted-foreground hidden h-9 w-[11.5rem] text-xs font-semibold tracking-wide sm:table-cell">
            统一社会信用代码
          </TableHead>
          <TableHead class="bg-muted text-muted-foreground hidden h-9 w-[4.5rem] text-xs font-semibold tracking-wide sm:table-cell">
            属地
          </TableHead>
          <TableHead class="bg-muted text-muted-foreground h-9 w-[33%] text-xs font-semibold tracking-wide sm:w-[17rem]">
            称号 · 认定年
          </TableHead>
          <TableHead class="bg-muted text-muted-foreground h-9 w-[35%] text-xs font-semibold tracking-wide sm:w-[12rem]">
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
          @click="emit('select', row.enterpriseId)"
        >
          <TableCell class="p-0 align-middle">
          <span class="block h-5 w-[6px] rounded-r-sm" :class="railClass(row)" />
          </TableCell>

          <TableCell class="max-w-0 break-words [overflow-wrap:anywhere]">
            <button
              type="button"
              class="block max-w-full whitespace-normal break-words text-left text-[13px] leading-4 font-medium hover:underline sm:truncate"
              :title="row.name"
              @click.stop="emit('select', row.enterpriseId)"
            >
              {{ row.name }}
            </button>
            <!-- 曾用名跟在名称下面一行(设计稿的「原 …」),不占一列、也不撑宽这一格。 -->
            <span
              v-for="alias in row.aliasNames"
              :key="alias"
              class="text-muted-foreground hidden truncate text-xs leading-4 sm:block"
              :title="`曾用名:${alias}`"
            >
              原 {{ alias }}
            </span>
          </TableCell>

          <TableCell class="text-muted-foreground hidden font-mono text-xs tabular-nums sm:table-cell">
            {{ row.uscc ?? '无统一社会信用代码' }}
          </TableCell>

          <TableCell class="hidden text-[13px] sm:table-cell">{{ row.district ?? '属地未知' }}</TableCell>

          <TableCell class="text-[13px] whitespace-normal break-words leading-4 [overflow-wrap:anywhere] sm:whitespace-nowrap" data-testid="title-recognition-cell">
            <span v-if="!row.titles.length" class="text-muted-foreground">—</span>
            <template v-for="(item, i) in titleItems(row)" v-else :key="item.code">
              <span v-if="i" class="text-muted-foreground px-1">·</span>
              <span>{{ item.label }}</span>
              <span class="text-muted-foreground tabular-nums"> {{ item.year ?? '年待核' }}</span>
            </template>
          </TableCell>

          <TableCell class="text-[13px] whitespace-normal break-words leading-4 [overflow-wrap:anywhere] sm:whitespace-nowrap" data-testid="enterprise-difference-cell">
            <span :class="row.difference.count ? '' : 'text-muted-foreground'">
              {{ differenceStatusText(row) }}
            </span>
            <template v-if="differenceReason(row)">
              <span class="text-muted-foreground px-1">·</span>
              <span class="text-muted-foreground">{{ differenceReason(row) }}</span>
            </template>
          </TableCell>
        </TableRow>

        <!--
          加载态只在末尾补**一行**骨架(`_shared-brief.md` 写死的):旧行留在原地,
          用户看得见自己在哪一批数据上等,而不是面对一张白表。这一行也**不兼任铺满表体**。
        -->
        <TableRow v-if="loading" class="hover:bg-transparent">
          <TableCell class="p-0"><span class="block h-5 w-[6px]" /></TableCell>
          <TableCell><Skeleton class="h-3 w-40" /></TableCell>
          <TableCell><Skeleton class="h-3 w-32" /></TableCell>
          <TableCell><Skeleton class="h-3 w-12" /></TableCell>
          <TableCell>
            <Skeleton class="h-3 w-28" />
            <Skeleton class="ml-2 inline-block h-3 w-16" />
          </TableCell>
          <TableCell><Skeleton class="h-3 w-24" /></TableCell>
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
