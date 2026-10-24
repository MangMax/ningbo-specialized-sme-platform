<script setup lang="ts">
import { computed } from 'vue'
import { platformBusinessFields } from '~~/lib/roster/platform-records'
import type { PlatformRecord, PlatformRecordQuery } from '~~/lib/roster/platform-records'
import { PLATFORM_RDJBS } from '~~/lib/labels'
import { ChevronDown } from '@lucide/vue'
import PlatformFieldConflicts from './PlatformFieldConflicts.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
const props = defineProps<{ record: PlatformRecord; query?: PlatformRecordQuery }>()
const fields = computed(() => platformBusinessFields(props.record.rawFields))
</script>
<template>
  <Dialog>
    <DialogTrigger as-child><Button variant="ghost" size="sm" data-testid="platform-row-details-toggle"><ChevronDown data-icon="inline-start" />行 #{{ record.id }} · 查看详情</Button></DialogTrigger>
    <DialogContent class="max-h-[85dvh] overflow-y-auto" data-testid="platform-row-details" @escape-key-down.stop>
      <DialogHeader>
        <DialogTitle>行 #{{ record.id }} · 原始记录</DialogTitle>
        <DialogDescription class="break-words [overflow-wrap:anywhere]">{{ record.nameRaw ?? '企业名称未提供' }}</DialogDescription>
      </DialogHeader>
    <PlatformFieldConflicts :conflicts="record.normalizationConflicts" />
    <dl class="text-sm mt-2 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1 break-words [overflow-wrap:anywhere]">
      <dt class="text-muted-foreground">查询引用</dt><dd>#{{ record.queryId }}</dd>
      <dt class="text-muted-foreground">主体归属</dt><dd>{{ record.enterpriseId === undefined ? '未提供' : record.enterpriseId === null ? '未匹配主体' : `已关联主档 #${record.enterpriseId}` }}</dd>
      <dt class="text-muted-foreground">原行序号</dt><dd>{{ record.sequenceNo }}</dd>
      <dt class="text-muted-foreground">来源页</dt><dd>{{ record.sourcePage ?? '未提供' }}</dd>
      <dt class="text-muted-foreground">来源称号</dt><dd>{{ PLATFORM_RDJBS[record.sourceRdjb ?? query?.rdjb ?? ''] ?? '未标注' }}</dd>
      <template v-for="field in fields" :key="field.key"><dt class="text-muted-foreground">{{ field.label }}（{{ field.key }}）</dt><dd>{{ field.value }}</dd></template>
    </dl>
    <p v-if="!fields.length" class="text-muted-foreground mt-2">旧记录未保留原始业务字段。</p>
  </DialogContent>
  </Dialog>
</template>
