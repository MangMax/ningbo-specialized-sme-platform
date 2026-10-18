<script setup lang="ts">
import type { ComparisonRouteState, ComparisonSource } from '~~/lib/roster/record-comparison-view'

defineProps<{
  scope: ComparisonRouteState
  labels: Record<string, ComparisonSource>
  current: boolean
  description: string
}>()
</script>

<template>
  <details class="min-w-0 text-[13px]">
    <summary class="cursor-pointer py-2 font-medium">
      {{ current ? '本次结果所用来源' : '上次结果所用来源' }}
      <span class="text-muted-foreground ml-2 font-normal">查看明细</span>
    </summary>
    <div class="flex min-w-0 flex-col gap-3 border-l pl-3 pb-2">
      <div class="grid min-w-0 gap-3 sm:grid-cols-2">
        <section><h3 class="mb-1 font-medium">正式文件</h3><ul class="flex flex-col gap-1"><li v-for="id in scope.selection.officialSourceDocumentIds" :key="id" class="break-words">{{ labels[`official_document:${id}`]?.label ?? `文件 #${id}（名称暂不可读）` }}</li></ul></section>
        <section><h3 class="mb-1 font-medium">平台查询</h3><ul class="flex flex-col gap-1"><li v-for="id in scope.selection.queryIds" :key="id" class="break-words">{{ labels[`query:${id}`]?.label ?? `查询 #${id}（名称暂不可读）` }}</li></ul></section>
        <section v-if="scope.selection.exportBatchIds.length"><h3 class="mb-1 font-medium">导出版本</h3><ul class="flex flex-col gap-1"><li v-for="id in scope.selection.exportBatchIds" :key="id" class="break-words">{{ labels[`export_batch:${id}`]?.label ?? `导出 #${id}（名称暂不可读）` }}</li></ul></section>
      </div>
      <p class="text-muted-foreground">{{ description }}</p>
    </div>
  </details>
</template>
