<script setup lang="ts">
import type { PlatformNormalizationConflict } from '~~/lib/platform/normalization'
defineProps<{ conflicts?: PlatformNormalizationConflict[] }>()
const labels = { province: '省份', status: '办理状态', batch: '维护批次', declareKind: '申报事项', appliedAt: '申报时间', awardBatchLabel: '认定批次原值', year: '平台年份原值' }
</script>
<template>
  <div v-if="conflicts?.length" class="mt-2 text-sm break-words [overflow-wrap:anywhere]" role="note">
    <p>字段冲突，待核。相关字段暂不作为确定事实。</p>
    <ul class="mt-1 space-y-1">
      <li v-for="conflict in conflicts" :key="conflict.field">{{ labels[conflict.field] }} · 已存：{{ conflict.storedValue }} · 原档：{{ conflict.rawValue }}</li>
    </ul>
  </div>
</template>
