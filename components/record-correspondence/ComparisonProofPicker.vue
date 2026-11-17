<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TITLES } from '~~/lib/labels'
import type { ComparisonProof, ComparisonProofAudit, ComparisonProofCatalog, ComparisonSelection } from '~~/lib/roster/record-comparison-view'
import { humanRecordTime } from '~~/lib/roster/record-ledger'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

const props = defineProps<{ selection: ComparisonSelection; asOf: string }>()
const emit = defineEmits<{ change: [proofIds: number[]]; settled: [scopeKey: string, ready: boolean] }>()
const page = ref(1)
const pageSize = ref(25)
const displayed = ref<ComparisonProofCatalog | null>(null)
const loading = ref(false)
const error = ref(false)
const cache = ref<Record<number, ComparisonProof>>({})
const basis = ref<Record<number, string>>({})
const selectedReadFailed = ref(false)
let requestId = 0
let hydrationId = 0
const scopeKey = computed(() => JSON.stringify([props.selection, props.asOf]))
const hydratedKey = ref<string | null>(null)
const pendingBasis = new Map<number, Promise<void>>()

function sourceMatches(proof: ComparisonProof): boolean {
  if (proof.kind === 'official_coverage') return !!proof.evidence.sourceDocuments?.length && proof.evidence.sourceDocuments.every(row => props.selection.officialSourceDocumentIds.includes(row.id))
  return proof.evidence.queryId != null && proof.evidence.exportBatchId != null && props.selection.queryIds.includes(proof.evidence.queryId) && props.selection.exportBatchIds.includes(proof.evidence.exportBatchId)
}
function eligible(proof: ComparisonProof): boolean {
  return proof.status === 'confirmed' && proof.valid && sourceMatches(proof) && (!props.asOf || !proof.decidedAt || Date.parse(proof.decidedAt) <= Date.parse(props.asOf))
}
const choices = computed(() => displayed.value?.rows.filter(eligible) ?? [])
const selectedItems = computed(() => props.selection.proofIds.map(id => cache.value[id]).filter((item): item is ComparisonProof => !!item && eligible(item)))
const title = (proof: ComparisonProof) => TITLES[proof.evidence.titleCode] ?? '称号未标注'
const kindText = (proof: ComparisonProof) => proof.kind === 'official_coverage' ? '正式覆盖范围依据' : '接口与导出同范围同版本依据'
function scopeText(proof: ComparisonProof): string {
  if (proof.kind === 'official_coverage') return `${proof.evidence.fromYear ?? '年份待核'}–${proof.evidence.throughYear ?? '年份待核'} · ${proof.evidence.sourceDocuments?.length ?? 0} 份正式文件${proof.evidence.enterpriseIds ? ` · ${proof.evidence.enterpriseIds.length} 家企业范围` : ' · 称号全年范围'}`
  const scope = proof.evidence.scope
  return `${humanRecordTime(scope?.windowStart)} 至 ${humanRecordTime(scope?.windowEnd)} · ${scope?.platformVersion ?? '版本未记录'}`
}
function toggle(proof: ComparisonProof, checked: boolean) {
  if (!eligible(proof)) return
  const next = new Set(props.selection.proofIds)
  if (checked) next.add(proof.id)
  else next.delete(proof.id)
  emit('change', [...next].sort((a, b) => a - b))
}
function readBasis(proof: ComparisonProof): Promise<void> {
  if (basis.value[proof.id]) return Promise.resolve()
  const pending = pendingBasis.get(proof.id)
  if (pending) return pending
  const request = fetchBasis(proof).finally(() => pendingBasis.delete(proof.id))
  pendingBasis.set(proof.id, request)
  return request
}
async function fetchBasis(proof: ComparisonProof) {
  try {
    const first = await $fetch<ComparisonProofAudit>(`/api/roster/comparison-scope-proofs/${proof.id}/audit`, { query: { page: 1, pageSize: 200 } })
    const lastPage = Math.ceil(first.total / first.pageSize)
    const audit = lastPage > 1 ? await $fetch<ComparisonProofAudit>(`/api/roster/comparison-scope-proofs/${proof.id}/audit`, { query: { page: lastPage, pageSize: 200 } }) : first
    basis.value[proof.id] = audit.rows.at(-1)?.basis ?? '登记说明未提供'
  } catch { basis.value[proof.id] = '登记说明暂不可读' }
}
async function load() {
  const current = ++requestId
  loading.value = true
  error.value = false
  try {
    const result = await $fetch<ComparisonProofCatalog>('/api/roster/comparison-scope-proofs', { query: { status: 'confirmed', page: page.value, pageSize: pageSize.value } })
    if (current !== requestId) return
    displayed.value = result
    for (const item of result.rows) cache.value[item.id] = item
    void Promise.allSettled(result.rows.filter(eligible).map(readBasis))
  } catch {
    if (current === requestId) error.value = true
  } finally {
    if (current === requestId) loading.value = false
  }
}
async function hydrateSelected() {
  const current = ++hydrationId
  const key = scopeKey.value
  const ids = [...props.selection.proofIds]
  hydratedKey.value = null
  selectedReadFailed.value = false
  for (const id of ids) {
    if (cache.value[id]) continue
    try {
      const proof = await $fetch<ComparisonProof>(`/api/roster/comparison-scope-proofs/${id}`)
      if (current !== hydrationId) return
      cache.value[id] = proof
    } catch {
      if (current !== hydrationId) return
      selectedReadFailed.value = true
    }
  }
  if (current !== hydrationId) return
  const usable = ids.filter(id => !cache.value[id] || eligible(cache.value[id]!))
  if (usable.length !== ids.length) emit('change', usable)
  await Promise.allSettled(usable.flatMap(id => cache.value[id] ? [readBasis(cache.value[id]!)] : []))
  if (current === hydrationId) hydratedKey.value = key
}
watch([page, pageSize], () => { void load() }, { immediate: true })
watch(scopeKey, () => { void hydrateSelected() }, { immediate: true, flush: 'sync' })
watch(choices, (proofs) => { void Promise.allSettled(proofs.map(readBasis)) })
const layoutReady = computed(() => !loading.value && hydratedKey.value === scopeKey.value && choices.value.every(proof => basis.value[proof.id] !== undefined))
watch([scopeKey, layoutReady], ([key, ready]) => emit('settled', key, ready), { immediate: true, flush: 'post' })
</script>

<template>
  <section class="flex min-w-0 flex-col gap-2 rounded-sm border p-3" data-testid="comparison-proof-picker" aria-label="已确认范围依据">
    <div class="flex flex-wrap items-baseline justify-between gap-2"><h3 class="text-sm font-medium">已确认范围依据（可选）</h3><span class="text-muted-foreground text-xs">仅显示已确认且当前来源有效的依据</span></div>
    <p class="text-muted-foreground text-table">证明必须覆盖本次所选正式文件或接口与导出版本。可用依据需明确勾选；未选择时范围或版本资格继续待核。</p>
    <p v-if="selectedReadFailed" class="text-destructive text-table">部分已选依据暂不可读；保留选择，比较服务会再次核验。</p>
    <TableLoadingStatus kind="comparison" :loading="loading" label="正在读取已登记范围依据…" />
    <TableFailureState v-if="error" title="范围依据目录读取失败" :compact="!!displayed" :pending="loading" :description="displayed ? '保留上次成功的目录页；请重试当前目标。' : '仍可不选依据进行对比，范围资格会保持待核。'" @retry="load" />
    <p v-if="displayed && displayed.page !== page" class="text-muted-foreground text-table">目标目录尚未加载，下面保留上次成功的范围依据页。</p>
    <ul v-if="choices.length" class="flex min-w-0 flex-col gap-1.5">
      <li v-for="proof in choices" :key="proof.id" class="flex min-w-0 items-start gap-3 rounded-sm border p-2.5">
        <Checkbox :id="`proof-${proof.id}`" :model-value="selection.proofIds.includes(proof.id)" class="mt-0.5" :aria-label="`选择${title(proof)} · ${scopeText(proof)} · ${kindText(proof)}`" @update:model-value="toggle(proof, $event === true)" />
        <label :for="`proof-${proof.id}`" class="min-w-0 flex-1 cursor-pointer break-words [overflow-wrap:anywhere]"><span class="block text-table font-medium">{{ title(proof) }} · {{ kindText(proof) }}</span><span class="text-muted-foreground block text-xs">{{ scopeText(proof) }} · 确认于 {{ humanRecordTime(proof.decidedAt) }}</span><span class="text-muted-foreground block text-xs">登记依据：{{ basis[proof.id] ?? '正在读取…' }}</span></label>
        <Badge variant="outline">已确认有效</Badge>
      </li>
    </ul>
    <p v-else-if="!loading && !error" class="text-muted-foreground text-table">本页没有与所选来源、截止时点相符的有效依据；可继续翻页或调整来源。</p>
    <TablePagination v-if="displayed" :page="displayed.page" :page-size="displayed.pageSize" :total="displayed.total" unit="项依据" :loading="loading || error" @update:page="page = $event" @update:page-size="pageSize = $event; page = 1" />
    <div v-if="selectedItems.length" class="flex flex-wrap gap-1.5" aria-label="已选范围依据"><Button v-for="proof in selectedItems" :key="proof.id" variant="secondary" size="sm" class="h-auto max-w-full whitespace-normal text-left text-xs" @click="toggle(proof, false)">{{ title(proof) }} · {{ kindText(proof) }} · 移除</Button></div>
  </section>
</template>
