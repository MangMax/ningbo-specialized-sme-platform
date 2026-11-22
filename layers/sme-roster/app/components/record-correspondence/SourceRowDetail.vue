<script setup lang="ts">
import { computed } from 'vue'
import { platformRowTitle } from '#sme-roster/lib/platform/row-title'
import { PLATFORM_INTERFACES, PLATFORM_QUERY_STATUSES, PLATFORM_RDJBS, RELATION_DECLARE_KINDS, TITLES } from '#sme-roster/lib/labels'
import { platformBusinessFields, platformPresentationFields } from '#sme-roster/lib/roster/platform-records'
import { formatFetchTime } from '#sme-roster/lib/reconcile-time'
import type { ExportRowSource, RelationSource } from '#sme-roster/lib/roster/correspondence-view'
import RosterPlatformQueryProvenance from '#sme-roster/app/components/PlatformQueryProvenance.vue'
import DisclosurePanel from '#core/app/components/DisclosurePanel.vue'
import RosterPlatformFieldConflicts from '#sme-roster/app/components/PlatformFieldConflicts.vue'
import { Badge } from '#core/app/components/ui/badge'

const props = defineProps<{ relation?: RelationSource | null; exportRow?: ExportRowSource | null; compact?: boolean; presentation?: 'source' | 'business' }>()
const source = computed(() => props.relation?.query.interface ?? '')
const exportFields = computed(() => platformBusinessFields(props.exportRow?.rawFields))
const sourceTitle = computed(() => PLATFORM_RDJBS[props.relation?.sourceRdjb ?? platformRowTitle(props.relation?.query.rdjb, props.relation?.rawFields)] ?? '未标注')
const providedBusinessFields = computed(() => platformPresentationFields(props.relation?.rawFields))
const hasVerifiedBusinessFields = computed(() => providedBusinessFields.value.some(field => field.key !== 'rdjb' || Boolean(PLATFORM_RDJBS[field.value])))
const businessFields = computed(() => providedBusinessFields.value.flatMap(field => {
  if (field.key !== 'rdjb') return [field]
  const title = PLATFORM_RDJBS[field.value]
  if (!title || title === sourceTitle.value) return []
  return [{ ...field, label: '平台称号', value: title }]
}))
</script>

<template>
  <div class="min-w-0 rounded-sm border bg-card p-3" :class="presentation === 'business' && relation ? 'text-base leading-6' : 'text-table leading-5'" data-testid="record-source-row">
    <template v-if="relation && presentation === 'business'">
      <h4 class="text-sm font-medium">{{ PLATFORM_INTERFACES[source] ?? '平台接口记录' }}</h4>
      <p class="text-muted-foreground mt-1 text-sm">采集时间：{{ formatFetchTime(relation.query.queriedAt) ?? relation.query.queriedAt }} · {{ PLATFORM_QUERY_STATUSES[relation.query.status] ?? '状态待核' }}</p>
      <RosterPlatformFieldConflicts :conflicts="relation.normalizationConflicts" />
      <dl class="mt-3 grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 break-words [overflow-wrap:anywhere] sm:grid-cols-[auto_minmax(0,1fr)]" data-testid="platform-business-facts">
        <template v-if="!businessFields.some(field => field.key === 'qymc')"><dt class="text-muted-foreground">企业原名</dt><dd>{{ relation.nameRaw || '未提供' }}</dd></template>
        <template v-if="!businessFields.some(field => field.key === 'tyshxydm') && relation.usccRaw"><dt class="text-muted-foreground">信用代码原值</dt><dd>{{ relation.usccRaw }}</dd></template>
        <dt class="text-muted-foreground">来源称号</dt><dd>{{ sourceTitle }}</dd>
        <template v-for="field in businessFields" :key="field.key"><dt class="text-muted-foreground">{{ field.label }}</dt><dd class="whitespace-pre-wrap">{{ field.value }}</dd></template>
      </dl>
      <p v-if="!hasVerifiedBusinessFields" class="text-muted-foreground mt-3">此次查询未记录可展示的业务字段。</p>
      <DisclosurePanel :key="relation.id" compact title="来源定位" class="mt-3 border-t">
        <dl class="mt-2 grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 break-words [overflow-wrap:anywhere] sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt class="text-muted-foreground">业务编号原值</dt><dd>{{ relation.relationKey ?? '未提供' }}</dd>
          <dt class="text-muted-foreground">来源定位</dt><dd>查询 #{{ relation.query.id }} · 原行 {{ relation.sequenceNo }} · 页 {{ relation.sourcePage ?? '未知' }}</dd>
        </dl>
        <RosterPlatformQueryProvenance class="mt-2" :queries="[relation.query]" :source-label="PLATFORM_INTERFACES[source] ?? '平台接口'" />
      </DisclosurePanel>
    </template>
    <template v-else-if="relation">
      <div class="flex flex-wrap items-center gap-2">
        <strong>{{ PLATFORM_INTERFACES[source] ?? '平台接口记录' }} · 原行 {{ relation.sequenceNo }}</strong>
        <Badge variant="outline">{{ PLATFORM_QUERY_STATUSES[relation.query.status] ?? '状态待核' }}</Badge>
      </div>
      <RosterPlatformFieldConflicts :conflicts="relation.normalizationConflicts" />
      <dl class="mt-2 grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 break-words [overflow-wrap:anywhere] sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt class="text-muted-foreground">企业原名</dt><dd>{{ relation.nameRaw ?? '未提供' }}</dd>
        <dt class="text-muted-foreground">信用代码原值</dt><dd>{{ relation.usccRaw ?? '未提供' }}</dd>
        <dt class="text-muted-foreground">业务编号</dt><dd>{{ relation.relationKey ?? '未提供' }}</dd>
        <dt class="text-muted-foreground">来源称号</dt><dd>{{ sourceTitle }}</dd>
        <dt v-if="relation.declareKind" class="text-muted-foreground">申报类型</dt><dd v-if="relation.declareKind">{{ RELATION_DECLARE_KINDS[relation.declareKind] ?? relation.declareKind }}</dd>
        <dt v-if="relation.status" class="text-muted-foreground">原办理状态</dt><dd v-if="relation.status">{{ relation.status }}</dd>
        <dt v-if="relation.appliedAt" class="text-muted-foreground">原申报时间</dt><dd v-if="relation.appliedAt">{{ relation.appliedAt }}</dd>
        <dt v-if="relation.year != null" class="text-muted-foreground">平台年份原值</dt><dd v-if="relation.year != null">{{ relation.year }}</dd>
        <dt v-if="relation.batch" class="text-muted-foreground">维护批次原值</dt><dd v-if="relation.batch">{{ relation.batch }}</dd>
        <dt v-if="relation.awardBatchLabel" class="text-muted-foreground">认定批次原值</dt><dd v-if="relation.awardBatchLabel">{{ relation.awardBatchLabel }}</dd>
        <dt class="text-muted-foreground">来源定位</dt><dd>查询 #{{ relation.query.id }} · 行 {{ relation.sequenceNo }} · 页 {{ relation.sourcePage ?? '未知' }}</dd>
        <template v-for="field in compact ? [] : businessFields" :key="field.key"><dt class="text-muted-foreground">{{ field.label }}</dt><dd>{{ field.value }}</dd></template>
      </dl>
      <DisclosurePanel v-if="compact && businessFields.length" compact title="补充业务字段">
        <dl class="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 break-words [overflow-wrap:anywhere] sm:grid-cols-[auto_minmax(0,1fr)]">
          <template v-for="field in businessFields" :key="field.key"><dt class="text-muted-foreground">{{ field.label }}</dt><dd>{{ field.value }}</dd></template>
        </dl>
      </DisclosurePanel>
      <RosterPlatformQueryProvenance class="mt-2" :queries="[relation.query]" :source-label="PLATFORM_INTERFACES[source] ?? '平台接口'" />
    </template>
    <template v-else-if="exportRow">
      <div class="flex flex-wrap items-center gap-2"><strong>平台导出快照 · 源行 {{ exportRow.sourceRowNo }}</strong><Badge variant="outline">{{ TITLES[exportRow.batch.titleCode] ?? exportRow.batch.titleCode }}</Badge></div>
      <dl class="mt-2 grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 break-words [overflow-wrap:anywhere] sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt class="text-muted-foreground">企业原名</dt><dd>{{ exportRow.nameRaw ?? '未提供' }}</dd>
        <dt class="text-muted-foreground">信用代码原值</dt><dd>{{ exportRow.usccRaw ?? '未提供' }}</dd>
        <dt class="text-muted-foreground">属地原值</dt><dd>{{ exportRow.district ?? '未提供' }}</dd>
        <dt class="text-muted-foreground">平台审核状态原值</dt><dd>{{ exportRow.regStatus ?? '未提供' }}</dd>
        <dt class="text-muted-foreground">版本</dt><dd>{{ exportRow.batch.year }} 年 · {{ exportRow.batch.collectedOn }} 采集 · {{ exportRow.batch.originalFilename }}</dd>
        <dt class="text-muted-foreground">文件指纹</dt><dd class="font-mono text-xs break-all">{{ exportRow.batch.sha256 }}</dd>
        <template v-for="field in exportFields" :key="field.key"><dt class="text-muted-foreground">{{ field.label }}（{{ field.key }}）</dt><dd>{{ field.value }}</dd></template>
      </dl>
      <p class="text-muted-foreground mt-2">此行说明指定版本的当前快照，不代替正式公布结论。</p>
    </template>
  </div>
</template>
