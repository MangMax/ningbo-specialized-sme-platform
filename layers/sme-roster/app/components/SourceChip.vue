<script setup lang="ts">
import { computed } from 'vue'
import { Badge } from '#core/app/components/ui/badge'
import { SOURCES } from '#sme-roster/lib/labels'

/**
 * 来源标签。两个来源并列,靠方标颜色和描边区分,不靠色块:
 *   经信局 = 市级公布文件 → 藏青方标;
 *   工信部 = 国家级名单   → 金色方标(与「国家级」的标记语言一致)。
 */
const props = defineProps<{ code: string }>()

const label = computed(() => SOURCES[props.code] ?? props.code)
const national = computed(() => props.code === 'miit')
</script>

<template>
  <Badge variant="quiet" class="gap-1.5 pl-1" :class="national ? 'border-mark-national/45' : ''">
    <span
      aria-hidden="true"
      class="size-1.5 shrink-0 rounded-[1px]"
      :class="national ? 'bg-mark-national' : 'bg-mark-municipal'"
    />
    {{ label }}
  </Badge>
</template>
