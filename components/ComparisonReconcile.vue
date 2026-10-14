<script setup lang="ts">
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { RECONCILE_LABELS, RECONCILE_SOURCE, RECONCILE_VARIANTS } from '~~/lib/labels'
import type { ReconcileEntry } from '~~/lib/reconcile'

/**
 * 比对行的**平台解释**(票 16)。一句话解释「为什么这一行是差异」,
 * 悬停展开平台侧的取数与取数时间。没有解释(缓存未生成 / 该行未抽到)时显示占位。
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
const fetched = computed(() => {
  const at = props.explanation?.fetchedAt
  if (!at) return null
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString('zh-CN', { hour12: false })
})
</script>

<template>
  <TooltipProvider v-if="explanation && label">
    <Tooltip>
      <TooltipTrigger as-child>
        <Badge :variant="variant" tabindex="0" class="cursor-help" data-testid="reconcile-badge">
          {{ label }}
        </Badge>
      </TooltipTrigger>
      <TooltipContent class="max-w-80">
        <div class="flex flex-col gap-1">
          <p class="font-medium">{{ label }}</p>
          <p class="text-background/80 text-xs leading-relaxed">{{ note }}</p>
          <p v-if="evidence" class="text-background/70 text-xs tabular-nums">
            平台关联 {{ evidence.businessCount }} 条 · 申报 {{ evidence.applyCount }} 条 ｜ 认定类型:{{
              evidence.rdjbLabel ?? '—'
            }}
          </p>
          <p class="text-background/60 text-xs">
            {{ RECONCILE_SOURCE }}{{ fetched ? ` · 取数 ${fetched}` : '' }}
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
  <span v-else class="text-muted-foreground text-xs" title="未抽到该企业的平台解释">—</span>
</template>
