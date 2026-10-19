<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { useBoundedReviewPage } from '~/composables/useBoundedReviewPage'
import { impactClassificationLabels } from '~~/lib/roster/evidence-review-ui'
import { sourceKindLabel, reviewTimeLabel } from '~~/lib/roster/review-display'
import EvidenceRevisionEvents from './EvidenceRevisionEvents.vue'
import AssessmentStatusBadge from './AssessmentStatusBadge.vue'
import { Button } from '@/components/ui/button'
import TableFailureState from '@/components/TableFailureState.vue'

const props = defineProps<{ impactId: number; enterpriseId: number }>()
type Source = { revisionId: number; sourceKind: string; sourceKey: string; sourceVersion: string; classification: string; eventId: number | null; coverageChanged: boolean; factChanged: boolean; recordedAt?: string | null }
const { displayed, cursorExpired, loading, error, reload, restart, next, previous, canNext, canPrevious } = useBoundedReviewPage<Source>('evidence-impact-sources', () => `/api/roster/evidence-impacts/${props.impactId}/sources`, () => ({}))
const selectedRevision = shallowRef<number | null>(null)
const failureTarget = computed(() => `复核项 #${props.impactId} · 来源第 ${displayed.value?.pageNumber ?? 1} 页`)
</script>

<template>
  <section class="flex min-w-0 flex-col gap-2" aria-label="证据变化来源">
    <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h4 class="text-sm font-medium">证据变化来源</h4>
      <span class="text-muted-foreground text-[13px]">
        复核项 #{{ impactId }} · 来源第 {{ displayed?.pageNumber ?? 1 }} 页 · 每页最多 25 项
      </span>
    </div>

    <div v-if="loading" class="flex flex-col gap-1.5" role="status">
      <span class="bg-muted h-4 w-56 animate-pulse rounded-sm" />
      <span class="bg-muted h-4 w-44 animate-pulse rounded-sm" />
    </div>
    <TableFailureState
      v-if="error"
      title="证据变化来源读取失败"
      :description="`读取目标：${failureTarget}。上次成功的来源页仍保留；重试只读取当前目标页。`"
      :pending="loading"
      @retry="reload()"
    />
    <p v-if="cursorExpired" role="alert" class="text-[13px] leading-5">
      分页快照已过期或失效。上次成功页仍保留；请点击“重新读取来源”获取当前结果。
    </p>

    <p v-if="displayed && !displayed.rows.length" class="text-muted-foreground text-[13px] leading-5">
      本页没有可列出的来源。没有来源不等于没有证据变化。
    </p>

    <ul class="flex flex-col gap-2">
      <li
        v-for="source in displayed?.rows ?? []"
        :key="source.revisionId"
        class="bg-card flex min-w-0 flex-col gap-1.5 rounded-md border px-3 py-2.5"
      >
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-sm font-medium">{{ sourceKindLabel(source.sourceKind) }}</span>
          <AssessmentStatusBadge kind="impact" :value="source.classification" />
          <span class="text-muted-foreground text-[13px]">
            修订 #{{ source.revisionId }}
            <template v-if="source.recordedAt"> · {{ reviewTimeLabel(source.recordedAt) }}</template>
          </span>
        </div>
        <p class="text-[13px] leading-5">
          {{ impactClassificationLabels[source.classification] ?? '证据变化' }} ·
          查询范围{{ source.coverageChanged ? '有变化' : '无变化' }} ·
          平台事实{{ source.factChanged ? '有变化' : '无变化' }}
        </p>

        <div class="flex flex-wrap items-center gap-2">
          <NuxtLink
            v-if="source.eventId"
            :to="`/enterprises/${enterpriseId}?eventId=${source.eventId}`"
            class="text-primary text-[13px] leading-5 hover:underline"
          >
            定位正式事件
          </NuxtLink>
          <Button
            size="sm"
            variant="ghost"
            :aria-label="`查看修订 ${source.revisionId} 关联事件`"
            @click="selectedRevision = selectedRevision === source.revisionId ? null : source.revisionId"
          >
            {{ selectedRevision === source.revisionId ? '收起关联事件' : '查看关联事件' }}
          </Button>
        </div>

        <details class="text-muted-foreground text-[13px] leading-5">
          <summary class="cursor-pointer select-none">技术详情</summary>
          <dl class="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 break-words">
            <dt>修订</dt><dd>#{{ source.revisionId }}</dd>
            <dt>来源键</dt><dd>{{ source.sourceKey }}</dd>
            <dt>来源版本</dt><dd>{{ source.sourceVersion }}</dd>
            <dt>事件</dt><dd>{{ source.eventId == null ? '无' : `#${source.eventId}` }}</dd>
          </dl>
        </details>

        <EvidenceRevisionEvents
          v-if="selectedRevision === source.revisionId"
          :key="source.revisionId"
          :revision-id="source.revisionId"
          :enterprise-id="enterpriseId"
        />
      </li>
    </ul>

    <div class="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" :disabled="!canPrevious" @click="previous">上一页来源</Button>
      <Button size="sm" variant="outline" :disabled="!canNext" @click="next">下一页来源</Button>
      <Button size="sm" variant="ghost" :disabled="loading" @click="restart">重新读取来源</Button>
    </div>
  </section>
</template>
