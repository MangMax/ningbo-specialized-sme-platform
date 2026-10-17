<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ComparisonPlatformEvidence } from '~~/lib/comparison-platform'
import {
  PLATFORM_INTERFACES,
  PLATFORM_QUERY_STATUSES,
  PLATFORM_RDJBS,
  RELATION_DECLARE_KINDS,
  RELATION_MATCH_BASES,
  VERIFICATION_STATUSES,
} from '~~/lib/labels'
import { formatFetchTime } from '~~/lib/reconcile-time'
import { Badge } from '@/components/ui/badge'

/**
 * 比对行的**库内平台证据**(RL-03 的接缝,RL-15 补齐可展开的接口证据)。
 *
 * 让现名之外的**曾用名**(`enterprise_alias`)与**平台查询 / 原始关系**
 * (`platform_query` / `platform_relation`)在比对页就能看到,并能**跳转**到该企业的
 * 全部平台关系(`/platform-queries`)。
 *
 * ── 与「平台解释」列的分工 ────────────────────────────────────────────────
 * 那一列答「**为什么**这条是差异」(状态 / 原因 / 配对措施,取自 `difference_reason`);
 * 这一列给「**凭什么**」—— 查询时点、接口、以及逐条**原始关系原文**。
 * 两列都只读库,**没有任何二次推导**;缓存缺失与它们无关。
 *
 * 关系原文默认**收起**(表窄,撑开会把行高拉爆),点一下展开 —— 证据要能展开,
 * 但不该默认占满屏。
 */
const props = defineProps<{
  evidence: ComparisonPlatformEvidence
  enterpriseId: number
}>()

const aliases = computed(() => props.evidence.aliases)
const confirmedAliases = computed(() => aliases.value.filter((a) => a.verificationStatus === 'confirmed'))
const pendingAliases = computed(() => aliases.value.filter((a) => a.verificationStatus !== 'confirmed'))
const queries = computed(() => props.evidence.queries)
const relationCount = computed(() => props.evidence.relationCount)
const hasEvidence = computed(() => aliases.value.length > 0 || queries.value.length > 0)
const relationTotal = computed(() => queries.value.reduce((sum, query) => sum + query.relations.length, 0))

const showRelations = ref(false)
const link = computed(() => `/platform-queries?enterpriseId=${props.enterpriseId}`)

/** 查询摘要:「业务接口(businessList) · rdjb=2 专精特新中小企业 · 查询成功 · 2026-10-16 · 关系 2 条」。 */
function querySummary(query: ComparisonPlatformEvidence['queries'][number]): string {
  const parts = [
    PLATFORM_INTERFACES[query.interface] ?? query.interface,
    query.rdjb ? `rdjb=${query.rdjb} ${PLATFORM_RDJBS[query.rdjb] ?? ''}`.trim() : null,
    PLATFORM_QUERY_STATUSES[query.status] ?? query.status,
    formatFetchTime(query.queriedAt) ?? query.queriedAt,
    `关系 ${query.relationCount} 条`,
  ]
  return parts.filter((part): part is string => !!part).join(' · ')
}

/** 关系的可读原文;取不到的字段留空,**不猜填**。 */
function relationFields(relation: ComparisonPlatformEvidence['queries'][number]['relations'][number]): string[] {
  return [
    relation.nameRaw ? `企业名称 ${relation.nameRaw}` : null,
    relation.usccRaw ? `统一社会信用代码 ${relation.usccRaw}` : null,
    relation.province ? `省市 ${relation.province}` : null,
    relation.status ? `状态 ${relation.status}` : null,
    relation.batch ? `维护批次 ${relation.batch}` : null,
    relation.declareKind
      ? `申报类型 ${RELATION_DECLARE_KINDS[relation.declareKind] ?? relation.declareKind}`
      : null,
    relation.appliedAt ? `申报时间 ${relation.appliedAt}` : null,
    relation.year != null ? `申报记录年份 ${relation.year}` : null,
    relation.awardBatchLabel ? `认定批次 ${relation.awardBatchLabel}` : null,
    relation.aliasNameRaw ? `关系写出曾用名 ${relation.aliasNameRaw}` : null,
    relation.relationKey ? `关联主键 ${relation.relationKey}` : null,
  ].filter((part): part is string => !!part)
}
</script>

<template>
  <div v-if="hasEvidence" class="flex flex-col gap-1" data-testid="comparison-platform-evidence">
    <div v-if="confirmedAliases.length" class="flex flex-wrap items-center gap-1 text-xs">
      <span class="text-muted-foreground">曾用名</span>
      <Badge
        v-for="alias in confirmedAliases"
        :key="alias.id"
        variant="outline"
        class="font-normal"
        :title="alias.note ?? undefined"
        >{{ alias.name }}</Badge
      >
    </div>
    <div v-if="pendingAliases.length" class="flex flex-wrap items-center gap-1 text-xs">
      <span class="text-muted-foreground">待核别名</span>
      <Badge
        v-for="alias in pendingAliases"
        :key="alias.id"
        variant="quiet"
        class="font-normal"
        :title="VERIFICATION_STATUSES[alias.verificationStatus] ?? alias.verificationStatus"
        >{{ alias.name }}</Badge
      >
    </div>
    <ul v-if="queries.length" class="flex flex-col gap-0.5 text-xs">
      <li
        v-for="query in queries"
        :key="query.id"
        data-testid="platform-query-summary"
        class="text-muted-foreground"
      >
        {{ querySummary(query) }}
        <span v-if="query.failureReason" class="text-destructive"> — {{ query.failureReason }}</span>
      </li>
    </ul>
    <button
      v-if="relationTotal"
      type="button"
      data-testid="platform-evidence-toggle"
      class="text-primary w-fit text-xs hover:underline"
      :aria-expanded="showRelations"
      @click="showRelations = !showRelations"
    >
      {{ showRelations ? '收起原始关系' : `展开原始关系(${relationTotal} 条)` }}
    </button>
    <!-- 展开区自己滚:实测一个统代最多 6 条关系、逐条 9 个字段,
         不限高会把**一行**撑到 1000px 以上,把整张表读坏。 -->
    <ul v-if="showRelations" class="flex max-h-48 flex-col gap-1 overflow-auto pr-1">
      <template v-for="query in queries" :key="query.id">
        <li
          v-for="relation in query.relations"
          :key="relation.id"
          data-testid="platform-relation"
          class="bg-muted/40 flex flex-col gap-0.5 rounded-sm p-1.5 text-xs"
        >
          <span class="text-muted-foreground"
            >#{{ relation.sequenceNo }} · {{ PLATFORM_INTERFACES[query.interface] ?? query.interface }}</span
          >
          <span v-for="field in relationFields(relation)" :key="field">{{ field }}</span>
          <span class="text-muted-foreground"
            >匹配依据 {{ RELATION_MATCH_BASES[relation.matchBasis] ?? relation.matchBasis }} ·
            {{ VERIFICATION_STATUSES[relation.verificationStatus] ?? relation.verificationStatus }}</span
          >
        </li>
      </template>
    </ul>
    <NuxtLink
      v-if="relationCount"
      :to="link"
      class="text-primary text-xs hover:underline"
      data-testid="comparison-platform-link"
      >平台关系 {{ relationCount }} 条 · 查看</NuxtLink
    >
  </div>
  <span v-else class="text-muted-foreground text-xs">—</span>
</template>
