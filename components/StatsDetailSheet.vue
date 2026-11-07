<script setup lang="ts">
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
const open = defineModel<boolean>('open', { default: false })
defineProps<{ title: string; target: string; source?: string; loading: boolean; failed: boolean }>()
defineEmits<{ retry: [] }>()
</script>
<template>
  <Sheet v-model:open="open">
    <SheetContent class="stats-sheet w-full sm:max-w-xl">
      <SheetHeader><SheetTitle>{{ title }}</SheetTitle><SheetDescription>{{ target }}</SheetDescription></SheetHeader>
      <div class="stats-sheet-body" :aria-busy="loading">
        <p v-if="source" class="stats-source">当前显示：{{ source }}</p>
        <TableFailureState v-if="failed" :title="`${target}加载失败`" :compact="!!source" :pending="loading" :description="source ? '上次结果已保留，请重试当前查询。' : '尚未加载，请重试。'" @retry="$emit('retry')" />
        <div v-if="loading" class="stats-loading" role="status">正在加载企业明细…</div>
        <slot />
      </div>
    </SheetContent>
  </Sheet>
</template>
