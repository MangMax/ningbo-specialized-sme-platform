<script setup lang="ts">
import { shallowRef } from 'vue'
import { useBoundedReviewPage } from '~/composables/useBoundedReviewPage'
import { validityLabels } from '~~/lib/roster/evidence-review-ui'
import EvidenceRevisionEvents from './EvidenceRevisionEvents.vue'
import { Button } from '@/components/ui/button'
import TableFailureState from '@/components/TableFailureState.vue'
const props = defineProps<{ impactId: number; enterpriseId: number }>()
type Source = { revisionId: number; sourceKind: string; sourceKey: string; sourceVersion: string; classification: string; eventId: number | null; coverageChanged: boolean; factChanged: boolean }
const { displayed, cursorExpired, loading, error, reload, restart, next, previous, canNext, canPrevious } = useBoundedReviewPage<Source>('evidence-impact-sources', () => `/api/roster/evidence-impacts/${props.impactId}/sources`, () => ({}))
const selectedRevision = shallowRef<number | null>(null)
</script>
<template>
  <section class="flex min-w-0 flex-col gap-2" aria-label="证据变化来源">
    <h4 class="text-sm font-medium">证据变化来源</h4>
    <p v-if="loading" role="status">正在读取变化来源…</p>
    <TableFailureState v-if="error" title="变化来源读取失败" :pending="loading" @retry="reload()" />
    <p v-if="cursorExpired" role="alert">分页快照已过期或失效。上次成功页仍保留；请点击重新读取获取当前结果。</p>
    <p v-if="displayed" class="text-muted-foreground">复核项 #{{ displayed.request.url.split('/').at(-2) }} · 来源第 {{ displayed.pageNumber }} 页 · 每页最多25项</p>
    <p v-if="displayed && !displayed.rows.length">本页没有可列出的来源。</p>
    <ul class="flex flex-col gap-2"><li v-for="source in displayed?.rows ?? []" :key="source.revisionId" class="min-w-0 break-words border-l pl-2">
      <p>修订 #{{ source.revisionId }} · {{ source.sourceKind }} · {{ source.sourceKey }} · {{ source.sourceVersion }}</p>
      <p>{{ validityLabels[source.classification] ?? source.classification }} · {{ source.coverageChanged ? '查询覆盖变化' : '查询覆盖未变' }} · {{ source.factChanged ? '平台事实变化' : '平台事实未变' }}</p>
      <NuxtLink v-if="source.eventId" :to="`/enterprises/${enterpriseId}?eventId=${source.eventId}`" class="text-primary hover:underline">定位事件 #{{ source.eventId }}</NuxtLink>
      <Button size="sm" variant="ghost" :aria-label="`查看修订 ${source.revisionId} 关联事件`" @click="selectedRevision = selectedRevision === source.revisionId ? null : source.revisionId">查看关联事件</Button>
      <EvidenceRevisionEvents v-if="selectedRevision === source.revisionId" :key="source.revisionId" :revision-id="source.revisionId" :enterprise-id="enterpriseId" />
    </li></ul>
    <div class="flex flex-wrap gap-2"><Button size="sm" variant="outline" :disabled="!canPrevious" @click="previous">上一页来源</Button><Button size="sm" variant="outline" :disabled="!canNext" @click="next">下一页来源</Button><Button size="sm" variant="ghost" :disabled="loading" @click="restart">重新读取来源</Button></div>
  </section>
</template>
