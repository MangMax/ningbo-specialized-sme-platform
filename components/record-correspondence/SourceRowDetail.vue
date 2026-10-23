<script setup lang="ts">
import { computed } from 'vue'
import { PLATFORM_INTERFACES, PLATFORM_QUERY_STATUSES, PLATFORM_RDJBS, RELATION_DECLARE_KINDS, TITLES } from '~~/lib/labels'
import { platformBusinessFields } from '~~/lib/roster/platform-records'
import type { ExportRowSource, RelationSource } from '~~/lib/roster/correspondence-view'
import PlatformQueryProvenance from '@/components/PlatformQueryProvenance.vue'
import PlatformFieldConflicts from '@/components/PlatformFieldConflicts.vue'
import { Badge } from '@/components/ui/badge'

const props = defineProps<{ relation?: RelationSource | null; exportRow?: ExportRowSource | null }>()
const source = computed(() => props.relation?.query.interface ?? '')
const fields = computed(() => platformBusinessFields(props.relation?.rawFields ?? props.exportRow?.rawFields))
</script>

<template>
  <div class="min-w-0 rounded-sm border bg-card p-3 text-[13px] leading-5" data-testid="record-source-row">
    <template v-if="relation">
      <div class="flex flex-wrap items-center gap-2">
        <strong>{{ PLATFORM_INTERFACES[source] ?? '平台接口记录' }} · 原行 {{ relation.sequenceNo }}</strong>
        <Badge variant="outline">{{ PLATFORM_QUERY_STATUSES[relation.query.status] ?? '状态待核' }}</Badge>
      </div>
      <PlatformFieldConflicts :conflicts="relation.normalizationConflicts" />
      <dl class="mt-2 grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 break-words [overflow-wrap:anywhere] sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt class="text-muted-foreground">企业原名</dt><dd>{{ relation.nameRaw ?? '未提供' }}</dd>
        <dt class="text-muted-foreground">信用代码原值</dt><dd>{{ relation.usccRaw ?? '未提供' }}</dd>
        <dt class="text-muted-foreground">业务编号</dt><dd>{{ relation.relationKey ?? '未提供' }}</dd>
        <dt class="text-muted-foreground">来源称号</dt><dd>{{ PLATFORM_RDJBS[relation.sourceRdjb ?? relation.query.rdjb] ?? '未标注' }}</dd>
        <dt v-if="relation.declareKind" class="text-muted-foreground">申报类型</dt><dd v-if="relation.declareKind">{{ RELATION_DECLARE_KINDS[relation.declareKind] ?? relation.declareKind }}</dd>
        <dt v-if="relation.status" class="text-muted-foreground">原办理状态</dt><dd v-if="relation.status">{{ relation.status }}</dd>
        <dt v-if="relation.appliedAt" class="text-muted-foreground">原申报时间</dt><dd v-if="relation.appliedAt">{{ relation.appliedAt }}</dd>
        <dt v-if="relation.year != null" class="text-muted-foreground">平台年份原值</dt><dd v-if="relation.year != null">{{ relation.year }}</dd>
        <dt v-if="relation.batch" class="text-muted-foreground">维护批次原值</dt><dd v-if="relation.batch">{{ relation.batch }}</dd>
        <dt v-if="relation.awardBatchLabel" class="text-muted-foreground">认定批次原值</dt><dd v-if="relation.awardBatchLabel">{{ relation.awardBatchLabel }}</dd>
        <dt class="text-muted-foreground">来源定位</dt><dd>查询 #{{ relation.query.id }} · 行 {{ relation.sequenceNo }} · 页 {{ relation.sourcePage ?? '未知' }}</dd>
        <template v-for="field in fields" :key="field.key"><dt class="text-muted-foreground">{{ field.label }}（{{ field.key }}）</dt><dd>{{ field.value }}</dd></template>
      </dl>
      <PlatformQueryProvenance class="mt-2" :queries="[relation.query]" :source-label="PLATFORM_INTERFACES[source] ?? '平台接口'" />
    </template>
    <template v-else-if="exportRow">
      <div class="flex flex-wrap items-center gap-2"><strong>平台导出快照 · 源行 {{ exportRow.sourceRowNo }}</strong><Badge variant="outline">{{ TITLES[exportRow.batch.titleCode] ?? exportRow.batch.titleCode }}</Badge></div>
      <dl class="mt-2 grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 break-words [overflow-wrap:anywhere] sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt class="text-muted-foreground">企业原名</dt><dd>{{ exportRow.nameRaw ?? '未提供' }}</dd>
        <dt class="text-muted-foreground">信用代码原值</dt><dd>{{ exportRow.usccRaw ?? '未提供' }}</dd>
        <dt class="text-muted-foreground">属地原值</dt><dd>{{ exportRow.district ?? '未提供' }}</dd>
        <dt class="text-muted-foreground">登记状态原值</dt><dd>{{ exportRow.regStatus ?? '未提供' }}</dd>
        <dt class="text-muted-foreground">版本</dt><dd>{{ exportRow.batch.year }} 年 · {{ exportRow.batch.collectedOn }} 采集 · {{ exportRow.batch.originalFilename }}</dd>
        <dt class="text-muted-foreground">文件指纹</dt><dd class="font-mono text-xs break-all">{{ exportRow.batch.sha256 }}</dd>
        <template v-for="field in fields" :key="field.key"><dt class="text-muted-foreground">{{ field.label }}（{{ field.key }}）</dt><dd>{{ field.value }}</dd></template>
      </dl>
      <p class="text-muted-foreground mt-2">此行说明指定版本的当前快照，不代替正式公布结论。</p>
    </template>
  </div>
</template>
