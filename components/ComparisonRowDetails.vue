<script setup lang="ts">
import { TITLES, COMPARISON_LABELS } from '~~/lib/labels'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import type { ComparisonSummaryRow } from '~~/lib/comparison-summary'
import type { ComparisonPlatformEvidence } from '~~/lib/comparison-platform'
import type { CuratedRow } from '~~/lib/curation'
import type { ReconcileEntry } from '~~/lib/reconcile'
import ComparisonExplanation from './evidence-review/ComparisonExplanation.vue'
import ComparisonReconcile from './ComparisonReconcile.vue'
import ComparisonPlatformEvidenceView from './ComparisonPlatformEvidence.vue'
import ComparisonQueryOriginals from './ComparisonQueryOriginals.vue'
import ComparisonCuration from './ComparisonCuration.vue'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

const props = defineProps<{ row: ComparisonSummaryRow | null; returnTo: string }>()
const emit = defineEmits<{ close: []; saved: []; navigate: [] }>()
type FullRow = CuratedRow & { explanation: ReconcileEntry | null; platform: ComparisonPlatformEvidence }
const detail = shallowRef<FullRow | null>(null)
const loading = shallowRef(false)
const failure = shallowRef('')
let generation = 0
let controller: AbortController | undefined
const coordinate = computed(() => props.row ? `${props.row.enterpriseId}|${props.row.titleCode}|${props.row.direction}|${props.row.detailUrl}` : '')
async function load() {
  const row = props.row
  const ownGeneration = ++generation
  controller?.abort()
  if (!row) return
  const signal = (controller = new AbortController()).signal
  failure.value = ''
  loading.value = true
  try {
    const response = await $fetch<{ rows: FullRow[] }>(row.detailUrl, { signal })
    if (ownGeneration !== generation) return
    const match = response.rows.find(value => value.enterpriseId === row.enterpriseId && value.titleCode === row.titleCode && value.direction === row.direction)
    if (!match) throw new Error('coordinate_missing')
    detail.value = match
  } catch (error) {
    if (ownGeneration !== generation) return
    failure.value = error instanceof Error && error.message === 'coordinate_missing'
      ? '该企业、称号与方向已不在当前比对结果中，请刷新列表后重试。'
      : '完整原因与证据读取失败，请重试。'
  } finally {
    if (ownGeneration === generation) loading.value = false
  }
}
watch(coordinate, () => { detail.value = null; failure.value = ''; void load() }, { immediate: true })
onScopeDispose(() => { ++generation; controller?.abort() })
const coordinateLabel = computed(() => props.row ? `${props.row.name} · ${TITLES[props.row.titleCode] ?? props.row.titleCode} · ${COMPARISON_LABELS[props.row.direction]}` : '')
const enterpriseLink = computed(() => props.row ? `/enterprises/${props.row.enterpriseId}?returnTo=${encodeURIComponent(props.returnTo)}` : '')
async function saved() {
  emit('saved')
  await load()
}
</script>
<template>
  <Dialog :open="row !== null" @update:open="value => { if (!value) emit('close') }">
    <DialogContent v-if="row" class="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-[calc(100%-2rem)] flex-col overflow-hidden p-4 sm:max-w-4xl" data-testid="comparison-row-details">
      <DialogHeader>
        <DialogTitle>原因、平台记录与核实备注</DialogTitle>
        <DialogDescription>{{ row.name }}</DialogDescription>
      </DialogHeader>
      <div class="flex min-h-0 flex-col gap-3 overflow-y-auto" :aria-busy="loading">
        <p v-if="loading" role="status">正在读取完整原因与证据…</p>
        <div v-if="failure" role="alert" class="flex flex-col items-start gap-2">
          <p>{{ failure }}读取目标：{{ coordinateLabel }}。</p>
          <Button variant="outline" size="sm" :disabled="loading" @click="load">重试读取详情</Button>
        </div>
        <template v-if="detail">
          <p class="text-muted-foreground text-[13px]">保留上次成功详情：{{ coordinateLabel }}。</p>
          <p v-if="detail.evidence.currentCity || detail.evidence.regStatus" class="text-muted-foreground text-[13px]">{{ detail.evidence.currentCity }} · {{ detail.evidence.regStatus }}</p>
          <ComparisonReconcile :disposition="detail.platform.disposition" :explanation="detail.explanation" />
          <ComparisonExplanation :enterprise-id="detail.enterpriseId" :title-code="detail.titleCode" :direction="detail.direction" :return-to="returnTo" @navigate="emit('navigate')" />
          <ComparisonPlatformEvidenceView :evidence="detail.platform" :enterprise-id="detail.enterpriseId" :current-name="detail.name" :return-to="returnTo" />
          <ComparisonQueryOriginals v-for="query in detail.platform.queries" :key="query.id" :query-id="query.id" />
          <ComparisonCuration :row="detail" @saved="saved" />
        </template>
        <NuxtLink :to="enterpriseLink" @click="emit('navigate')" class="text-primary text-[13px] hover:underline">查看认定信息与公布出处</NuxtLink>
      </div>
    </DialogContent>
  </Dialog>
</template>
