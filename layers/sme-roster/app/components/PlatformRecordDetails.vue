<script setup lang="ts">
import { computed, ref } from 'vue'
import { platformRowTitle } from '#sme-roster/lib/platform/row-title'
import DisclosurePanel from '../../../core/app/components/DisclosurePanel.vue'
import ModalDialog from '../../../core/app/components/ModalDialog.vue'
import { platformBusinessFields } from '#sme-roster/lib/roster/platform-records'
import type { PlatformRecord, PlatformRecordQuery } from '#sme-roster/lib/roster/platform-records'
import { PLATFORM_RDJBS } from '#sme-roster/lib/labels'
import { ChevronDown } from '@lucide/vue'
import RosterPlatformFieldConflicts from './PlatformFieldConflicts.vue'
import { Button } from '#core/app/components/ui/button'
const props = defineProps<{ record: PlatformRecord; query?: PlatformRecordQuery }>()
const open = ref(false)
const allFields = computed(() => platformBusinessFields(props.record.rawFields))
const isEmpty = (key: string) => {
  const value = props.record.rawFields?.[key]
  return value == null || typeof value === 'string' && value.trim() === ''
}
const fields = computed(() => allFields.value.filter(field => !isEmpty(field.key)))
const emptyFields = computed(() => allFields.value.filter(field => isEmpty(field.key)))
const emptyValue = (key: string) => props.record.rawFields?.[key] === null ? 'null（原值）' : JSON.stringify(props.record.rawFields?.[key]) + '（空字符串）'
const sourceTitle = computed(() => props.record.sourceRdjb ?? platformRowTitle(props.query?.rdjb, props.record.rawFields))
</script>
<template>
  <Button variant="ghost" size="sm" data-testid="platform-row-details-toggle" @click="open = true">
    <ChevronDown data-icon="inline-start" />行 #{{ record.id }} · 查看详情
  </Button>
  <ModalDialog
    v-model:open="open"
    :title="`行 #${record.id} · 原始记录`"
    :description="record.nameRaw ?? '企业名称未提供'"
    size="md"
    stop-escape-propagation
    content-test-id="platform-row-details"
    body-class="space-y-3"
  >
    <RosterPlatformFieldConflicts :conflicts="record.normalizationConflicts" />
    <dl class="text-table grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1.5 break-words [overflow-wrap:anywhere]">
      <dt class="text-muted-foreground">查询引用</dt><dd>#{{ record.queryId }}</dd>
      <dt class="text-muted-foreground">主体归属</dt><dd>{{ record.enterpriseId === undefined ? '未提供' : record.enterpriseId === null ? '未匹配主体' : `已关联主档 #${record.enterpriseId}` }}</dd>
      <dt class="text-muted-foreground">原行序号</dt><dd>{{ record.sequenceNo }}</dd>
      <dt class="text-muted-foreground">来源页</dt><dd>{{ record.sourcePage ?? '未提供' }}</dd>
      <dt class="text-muted-foreground">来源称号</dt><dd>{{ PLATFORM_RDJBS[sourceTitle] ?? '未标注' }}</dd>
      <template v-for="field in fields" :key="field.key"><dt class="text-muted-foreground">{{ field.label }}（{{ field.key }}）</dt><dd>{{ field.value }}</dd></template>
    </dl>
    <DisclosurePanel v-if="emptyFields.length" compact :title="`平台返回的空字段 · ${emptyFields.length} 项`" data-testid="platform-empty-fields">
      <dl class="text-xs grid grid-cols-1 sm:grid-cols-2 gap-2 break-words">
        <template v-for="field in emptyFields" :key="field.key"><dt class="text-muted-foreground">{{ field.label }}（{{ field.key }}）</dt><dd>{{ emptyValue(field.key) }}</dd></template>
      </dl>
    </DisclosurePanel>
    <p v-if="!allFields.length" class="text-muted-foreground text-table">旧记录未保留原始业务字段。</p>
  </ModalDialog>
</template>
