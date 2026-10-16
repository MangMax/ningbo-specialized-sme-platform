<script setup lang="ts">
import {
  FIRST_RECOGNITION_HINT,
  FIRST_RECOGNITION_REASONS,
  TITLES,
  TITLE_SHORT,
} from '~~/lib/labels'
import {
  evidencePointerText,
  firstRecognitionYearText,
} from '~~/lib/roster/first-recognition'
import RosterEnterprisePanel from '@/components/RosterEnterprisePanel.vue'
import TitleBadge from '@/components/TitleBadge.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
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
 * **按企业**的分组表(合并台账的默认视图;RL-04 §7.1 的一企一行)。
 *
 * ── 相对 RL-04 原总表改了什么(RL-17)────────────────────────────────────
 *
 * 1. **行变矮了**。原表把称号徽章 `flex-wrap` 堆成三行、首次认定再占两行,一行 ~110px,
 *    一屏只放得下 5 家。这里称号 `nowrap`、首次认定与下次复核压成一行(称号用短名),
 *    一行回到 ~44px —— 一屏 20 家。信息一条没少,只是不再各占一行。
 *
 * 2. **「当前总表」不再是常态列**。295 页里绝大多数行都是「当前总表」,逐行盖一个徽章
 *    只是噪声。改成只给**例外**打标:非 `current` 的行在名称旁挂「仅平台引入」。
 *    筛选(总表状态)照旧,展开面板与导出里的状态列照旧。
 *
 * 3. **名称单元格里的曾用名与例外标**同一行,不换行撑高行高。
 */

export interface EnterpriseRow {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  city: string | null
  regStatus: string | null
  rosterState: 'current' | 'removed_platform_only'
  titles: string[]
  aliasNames: string[]
  /**
   * 每个有认定的称号一项(RL-08 起带首次认定**自己的**状态与依据)。
   * `year` 可为 `null`:一条认定都定不了年时**留空并标待确认**,不拿别的年份顶上。
   * `needsReview` 是**锚点**口径的待核,与 `status` 是两件事(见 §7.1 的注释)。
   */
  firstRecognition: {
    titleCode: string
    year: number | null
    status: 'confirmed' | 'pending'
    pendingReason: string | null
    evidence: { sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }[]
    needsReview: boolean
  }[]
  nextReviewYear: number | null
  anchorNeedsReview: boolean
}

const props = defineProps<{
  rows: EnterpriseRow[]
  loading: boolean
  hasError: boolean
  expandedId: number | null
  /** 当前台账的筛选串(不含 `view`),用于「返回台账不丢上下文」。 */
  backQuery: string
}>()

const emit = defineEmits<{ toggle: [id: number] }>()

/**
 * 首次认定 + 下次复核压成一行。三种标记各跟各的值,不合并:
 *  - `(待确认)` 是**首次认定本身**:年份给不出 / 有更早的认定定不了年 / 没有出处;
 *  - `(待核)`    是**复核锚点**:算到期时用到了缺结论年份的事件;
 *  - 年份给不出时显示 `年份未知`,而不是把一个别的年份当成首次。
 */
function lifecycleText(row: EnterpriseRow): string {
  const first = row.firstRecognition.length
    ? row.firstRecognition
        .map((f) => {
          // 年份文案与「未记录」的写法都取自单一出处(`first-recognition.ts`),
          // 与导出、展开面板逐字一致 —— 三处各写一遍必然有一处先漂。
          const year = firstRecognitionYearText({ firstYear: f.year })
          const pending = f.status === 'pending' ? '(待确认)' : ''
          return `${TITLE_SHORT[f.titleCode] ?? TITLES[f.titleCode] ?? f.titleCode} ${year}${pending}${f.needsReview ? '(待核)' : ''}`
        })
        .join(' · ')
    : '—'
  const next = row.nextReviewYear == null ? '—' : `${row.nextReviewYear}${row.anchorNeedsReview ? '(待核)' : ''}`
  return `首次 ${first}　复核 ${next}`
}

/**
 * 悬停说明:每个称号的首次认定**依据**。
 *
 * 出处(哪个文件、哪个附件、哪个序号)**挂在 tooltip 上**,不另开一列 ——
 * 这一列本来就按实测宽度切过(`w-72`,见文件顶部那段),再塞一段出处必然靠裁字换列,
 * 而「首次认定的依据」正是这张票要求能看到的东西,不能裁。展开面板里逐条列全文。
 */
function firstRecognitionTitle(row: EnterpriseRow): string {
  return row.firstRecognition
    .map((f) => {
      const title = TITLES[f.titleCode] ?? f.titleCode
      const year = firstRecognitionYearText({ firstYear: f.year })
      if (f.status === 'pending') {
        // 待确认时**明说它待确认** —— 悬停说明里给出一个年份却不声明它是待确认,
        // 读的人会把它当成结论(这正是票面要防的误标)。
        const why = FIRST_RECOGNITION_REASONS[f.pendingReason ?? ''] ?? f.pendingReason ?? ''
        return `${title}:待确认(${year})— ${why}`
      }
      const where = f.evidence.map(evidencePointerText).join(' ; ')
      return `${title}:${year} — 出处 ${where || '未记录'}`
    })
    .join('\n')
}

const COLUMNS = 4
const TH_CLASS = 'bg-muted text-muted-foreground sticky top-0 z-20 h-9 text-xs font-medium'
</script>

<template>
  <!--
    ── 列宽为什么是这么切的(实测,不是拍的)──────────────────────────────
    1440 视口下这张表只有 **约 1134px** 可用。而三样东西各自要的宽度是:
    企业名(全称最长 21 个汉字 ≈ 300)、三个称号全称徽章 ≈ 336、首次认定+下次复核
    那一串文字 ≈ 330。三者相加已经超过可用宽度 —— 上一版因此把称号的第三个徽章
    **切掉**、把复核那串**截断**,两个都是真丢信息。

    所以这里按「同一件事的字段放一起」重切:
      - 名称 / 统代 / 属地都是**身份**,合成一列两行(统代与属地缩小一号跟在名称下面),
        把它自己的宽度需求从 ≈300+144+80 降到 ≈300;
      - 称号独占一列,按实际需要给足,三个徽章一排放得下、不裁;
      - 复核那串按两行自然换行(`leading-snug`,不用 `truncate` 也不 `line-clamp`),
        宁可多一行,也不把「(待核)」这种状态截掉。

    `table-fixed` + 只给后面三列写死宽度:名称列自动吃掉剩余空间,长名字拿到最宽的一份。
  -->
  <!--
    自己的滚动容器:表头 `sticky top-0` 要有一个**最近的可滚动祖先**才吸得住
    (否则它会贴着页面滚、钻到顶栏底下),窄屏的横向滚动也由这同一层管
    (`table-container` 的默认 `overflow-auto` 会另起一个滚动上下文,这里放开)。
  -->
  <div class="max-h-[max(360px,calc(100dvh-22rem))] overflow-auto [&_[data-slot=table-container]]:overflow-visible">
    <Table class="min-w-[1000px] table-fixed">
    <TableHeader>
      <TableRow class="hover:bg-transparent">
        <TableHead :class="TH_CLASS">企业名称</TableHead>
        <TableHead :class="[TH_CLASS, 'w-[22.5rem]']">称号</TableHead>
        <!-- 表头带一句口径(悬停可见)。这一列里「(待确认)」和「(待核)」是两个不同的东西,
             不写清就没人分得清,而口径说明**不占版面**(不进小字说明区)。 -->
        <TableHead :class="[TH_CLASS, 'w-72']" :title="FIRST_RECOGNITION_HINT">
          首次认定 · 下次复核
        </TableHead>
        <TableHead :class="[TH_CLASS, 'w-14']">
          <span class="sr-only">展开</span>
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <template v-if="loading && !rows.length">
        <TableRow v-for="i in 8" :key="i" class="h-11">
          <TableCell v-for="j in COLUMNS" :key="j"><Skeleton class="h-4 w-full" /></TableCell>
        </TableRow>
      </template>

      <template v-for="row in rows" v-else :key="row.enterpriseId">
        <TableRow class="[&>td]:py-1.5">
          <TableCell class="max-w-0">
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="hover:text-primary truncate text-left font-medium hover:underline"
                :title="row.name"
                @click="emit('toggle', row.enterpriseId)"
              >
                {{ row.name }}
              </button>
              <Badge
                v-if="row.rosterState !== 'current'"
                variant="destructive"
                class="shrink-0 font-normal"
                title="该企业仅由平台导出引入、从未出现在任何公布名单,且已不在最新快照里。企业行与全部公布历史仍然保留。"
              >
                仅平台引入
              </Badge>
              <Badge
                v-for="alias in row.aliasNames"
                :key="alias"
                variant="quiet"
                class="shrink-0 font-normal"
                :title="`曾用名:${alias}`"
              >
                <span class="max-w-40 truncate">曾用名 {{ alias }}</span>
              </Badge>
            </div>
            <!-- 身份的第二行:统代与属地。独立成列会各占 144 / 80px,而这张表一共只有
                 约 1134px —— 省下来的宽度给称号与复核,不至于靠裁字换列数。 -->
            <div class="text-muted-foreground mt-0.5 truncate font-mono text-[11px]">
              {{ row.uscc ?? '无统一社会信用代码' }}
              <span class="font-sans">· {{ row.district ?? '属地未知' }}</span>
            </div>
          </TableCell>
          <TableCell>
            <div class="flex flex-nowrap items-center gap-1 overflow-hidden">
              <span v-for="code in row.titles" :key="code" class="shrink-0">
                <TitleBadge :code="code" />
              </span>
              <span v-if="!row.titles.length" class="text-muted-foreground text-xs">—</span>
            </div>
          </TableCell>
          <!-- `whitespace-normal` 是必须的:shadcn 的 `TableCell` 基础类带 `whitespace-nowrap`,
               不覆盖它,这串文字既不会换行、又会被单元格的溢出裁掉尾部的「复核 …(待核)」。 -->
          <TableCell class="text-muted-foreground text-[11px] leading-snug whitespace-normal">
            <div :title="`${lifecycleText(row)}\n${firstRecognitionTitle(row)}`">{{ lifecycleText(row) }}</div>
          </TableCell>
          <TableCell>
            <Button
              variant="ghost"
              size="sm"
              class="h-7 px-1.5 text-xs"
              :aria-expanded="expandedId === row.enterpriseId"
              @click="emit('toggle', row.enterpriseId)"
            >
              {{ expandedId === row.enterpriseId ? '收起' : '展开' }}
            </Button>
          </TableCell>
        </TableRow>
        <TableRow v-if="expandedId === row.enterpriseId" class="hover:bg-transparent">
          <TableCell :colspan="COLUMNS" class="p-0">
            <RosterEnterprisePanel :enterprise-id="row.enterpriseId" :back-query="props.backQuery" />
          </TableCell>
        </TableRow>
      </template>

      <TableRow v-if="!loading && !hasError && !rows.length" class="hover:bg-transparent">
        <TableCell :colspan="COLUMNS" class="p-0">
          <Empty class="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon"><LayoutList /></EmptyMedia>
              <EmptyTitle>没有匹配的企业</EmptyTitle>
              <EmptyDescription>可放宽称号、属地或记录侧条件再试。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </TableCell>
      </TableRow>
    </TableBody>
    </Table>
  </div>
</template>
