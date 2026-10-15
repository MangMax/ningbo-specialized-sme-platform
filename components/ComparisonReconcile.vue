<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { RECONCILE_LABELS, RECONCILE_SOURCE, RECONCILE_VARIANTS } from '~~/lib/labels'
import type { ReconcileEntry } from '~~/lib/reconcile'
import { formatFetchTime } from '~~/lib/reconcile-time'

/**
 * 比对行的**平台解释**(票 16)。徽章给出**结论**(外地注册 / 平台有记录 …),
 * 展开后给出登记位置、关联条数与**这一行自己的取数时间**。
 *
 * ## 打开方式(三轮:触屏必须能开)
 *
 * 一个受控的 `open`,三种触发都写进同一个状态:
 * - **悬停 / 键盘聚焦**:鼠标进→开、出→关(桌面习惯保留);
 * - **点击 / 触摸 tap**:自己 toggle —— 不用 reka 的内部切换,因为 Radix 系的 Tooltip
 *   在 `pointerdown` 会先请求关闭,再 toggle 会变成「关不掉」。所以记下 **按下瞬间**的
 *   状态,抬起时取反:开着的再点一下必然关。
 * - **键盘**:`Enter` / `Space` 等价于点击;`Escape`、失焦、点到别处都关。
 *
 * 触屏没有 hover,这也是**唯一**能在手机上看到 note 正文的路径。
 *
 * ## 宽度(窄屏:24rem 会超出视口)
 *
 * 桌面卡在 `24rem`。390px 视口下可用宽度只有 390 − 两侧 `collisionPadding` 12 = 366,
 * reka 只做位移、不缩定宽框,右端文字因此被视口切掉。改成
 * `min(24rem, var(--reka-tooltip-content-available-width))`:宽屏仍 384px,窄屏收到可用宽度。
 *
 * ## 位置(两轮评审都要过的约束)
 *
 * tooltip 固定挂在徽章**下方**并**整块让开徽章列**:`align="end"` + `align-offset`
 * ⇒ 它的右缘落在徽章左缘之外。于是既不遮吸顶表头 / 口径说明 / 任何一行的核实控件,
 * 也**不遮相邻行的同列徽章**。
 */
const props = defineProps<{ explanation: ReconcileEntry | null }>()

const label = computed(() =>
  props.explanation ? RECONCILE_LABELS[props.explanation.explanation.code] : null,
)
const variant = computed(() =>
  props.explanation ? RECONCILE_VARIANTS[props.explanation.explanation.code] : 'quiet',
)
const note = computed(() => props.explanation?.explanation.note ?? '')
const evidence = computed(() => props.explanation?.evidence ?? null)
/** 本行的取数时间;页脚用同一函数、同一字段,两处字面一致。 */
const fetched = computed(() => formatFetchTime(props.explanation?.fetchedAt))

/** 唯一真源:reka 的请求(hover / focus / Escape / blur)与本地点击都写它。 */
const open = ref(false)
/** 按下瞬间是否已经打开 —— 决定这次点击是「开」还是「关」。 */
let openOnPointerDown = false

/**
 * 让开多少:最长的标签「平台亦无记录」约 86px,留 100px 保证 tooltip 的右缘
 * 落在徽章左缘之外(实测各标签 ≤ 88px)。
 *
 * ⚠️ 实测 `align="end"` 下 **正** offset 才是往左让(reka 的 alignOffset 与直觉相反:
 * 传 -100 时右缘反而右移 100px)。窄屏另说 —— 352px 的面板放进 390px 视口,
 * 横向怎么挪都会压住表格,那时宁可不挪、直接让它在视口内居中,靠「点别处关掉」收回。
 */
const BADGE_COLUMN_CLEARANCE = 100
const wideEnough = useMediaQuery('(min-width: 640px)')

function onPointerDown() {
  openOnPointerDown = open.value
}
function onClick() {
  open.value = !openOnPointerDown
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    open.value = !open.value
  } else if (event.key === 'Escape') {
    open.value = false
  }
}
</script>

<template>
  <TooltipProvider v-if="explanation && label">
    <Tooltip :open="open" @update:open="open = $event">
      <TooltipTrigger as-child>
        <Badge
          :variant="variant"
          role="button"
          tabindex="0"
          :aria-expanded="open"
          :aria-label="`${label}:展开平台解释`"
          data-testid="reconcile-badge"
          class="cursor-pointer focus-visible:border-foreground/50 focus-visible:ring-2 focus-visible:ring-foreground/50 focus-visible:outline-none"
          @pointerdown="onPointerDown"
          @click="onClick"
          @keydown="onKeydown"
        >
          {{ label }}
        </Badge>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="end"
        :side-offset="16"
        :align-offset="wideEnough ? BADGE_COLUMN_CLEARANCE : 0"
        :collision-padding="12"
        class="max-w-[min(24rem,var(--reka-tooltip-content-available-width,24rem))]"
      >
        <div class="flex flex-col gap-1">
          <p class="font-medium">{{ label }}</p>
          <p class="text-page/90 text-xs leading-relaxed">{{ note }}</p>
          <p v-if="evidence" class="text-page/85 text-xs tabular-nums">
            平台关联 {{ evidence.businessCount }} 条 · 申报 {{ evidence.applyCount }} 条 ｜ 认定类型:{{
              evidence.rdjbLabel ?? '—'
            }}
          </p>
          <!-- 来源 + 时间同一行;不折行(过窄时整行省略而不是断成两行) -->
          <p class="text-page/85 overflow-hidden text-xs whitespace-nowrap text-ellipsis">
            {{ RECONCILE_SOURCE }}<template v-if="fetched"> · 取数 {{ fetched }}</template>
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
  <span v-else class="text-muted-foreground text-xs" title="未抽到该企业的平台解释">—</span>
</template>
