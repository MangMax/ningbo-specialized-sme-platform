<script setup lang="ts">
import { computed } from 'vue'
import { platformBusinessFields } from '~~/lib/roster/platform-records'
import type { PlatformRecord, PlatformRecordQuery } from '~~/lib/roster/platform-records'
import { PLATFORM_RDJBS } from '~~/lib/labels'
const props = defineProps<{ record: PlatformRecord; query?: PlatformRecordQuery }>()
const fields = computed(() => platformBusinessFields(props.record.rawFields))
</script>
<template>
  <details class="max-w-sm whitespace-normal" data-testid="platform-row-details">
    <summary class="cursor-pointer whitespace-nowrap text-primary focus-visible:outline-2 focus-visible:outline-ring">行 #{{ record.id }} · 查看详情</summary>
    <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-words [overflow-wrap:anywhere]">
      <dt class="text-muted-foreground">查询引用</dt><dd>#{{ record.queryId }}</dd>
      <dt class="text-muted-foreground">原行序号</dt><dd>{{ record.sequenceNo }}</dd>
      <dt class="text-muted-foreground">来源页</dt><dd>{{ record.sourcePage ?? '未提供' }}</dd>
      <dt class="text-muted-foreground">来源称号</dt><dd>{{ PLATFORM_RDJBS[record.sourceRdjb ?? query?.rdjb ?? ''] ?? '未标注' }}</dd>
      <template v-for="field in fields" :key="field.key"><dt class="text-muted-foreground">{{ field.label }}（{{ field.key }}）</dt><dd>{{ field.value }}</dd></template>
    </dl>
    <p v-if="!fields.length" class="text-muted-foreground mt-2">旧记录未保留原始业务字段。</p>
  </details>
</template>
