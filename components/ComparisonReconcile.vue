<script setup lang="ts">
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { RECONCILE_LABELS, RECONCILE_SOURCE, RECONCILE_VARIANTS } from '~~/lib/labels'
import type { ReconcileEntry } from '~~/lib/reconcile'
import { formatFetchTime } from '~~/lib/reconcile-time'

/**
 * 比对行的**平台解释**(票 16)。一句话解释「为什么这一行是差异」,
 * 悬停/聚焦展开平台侧的取数与**这一行自己的取数时间**。没有解释时显示占位。
 *
 * 三处与验收相关的约束(见 `.scratch/ingest-pipeline/issues/16-platform-reconcile.md`):
 * - **时间只来自本行的 `fetchedAt`**;本行没取过数就**不显示时间**(不拿缓存文件的
 *   `generatedAt` 顶上来,那会让「未查询」看起来像「取过」)。条数与口径在页脚,
 *   这里不重复。
 * - tooltip 一律挂在徽章**下方**(`side="bottom"`):上方是吸顶表头与口径说明,
 *   盖住它们等于盖住判读依据;偏移 16px 让它落在**本行以下**,不压当前行的核实控件。
 * - 正文三行对比度 ≥ 4.5:1(用组件自己的 `text-page` 前景,不再用 `text-background/*`
 *   ——亮色下后者是白底透出,最淡一行只有 4.2:1)。
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
</script>

<template>
  <TooltipProvider v-if="explanation && label">
    <Tooltip>
      <TooltipTrigger as-child>
        <Badge :variant="variant" tabindex="0" class="cursor-help" data-testid="reconcile-badge">
          {{ label }}
        </Badge>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="end"
        :side-offset="16"
        :collision-padding="12"
        class="max-w-[24rem]"
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
