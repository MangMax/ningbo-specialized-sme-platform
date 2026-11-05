<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import type { EnterpriseFactReference } from '~~/lib/roster/evidence-review-ui'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import DisclosurePanel from '@/components/DisclosurePanel.vue'

interface FactSnapshot {
  factId: number; revision: number; status: string
  fact: { kind: string; source: { reference: string; statement: string }; effective: { precision: string; value: string | null } }
}
const props = defineProps<{ enterpriseId: number; modelValue: EnterpriseFactReference[]; editable?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [EnterpriseFactReference[]]; validity: [boolean] }>()
const data = shallowRef<{ facts: FactSnapshot[]; history: FactSnapshot[] } | null>(null)
const loading = shallowRef(false), failed = shallowRef(false)
const labels: Record<string, string> = { moved_in: '迁入宁波', moved_out: '迁出宁波', cancelled: '注销', registration_status: '登记状态' }
const key = (r: EnterpriseFactReference) => `${r.enterpriseId}:${r.factId}:${r.revision}:${r.kind}`
const reference = (row: FactSnapshot): EnterpriseFactReference => ({ enterpriseId: props.enterpriseId, factId: row.factId, revision: row.revision, kind: row.fact.kind })
const options = computed(() => data.value?.facts.filter(row => row.status === 'confirmed').map(reference) ?? [])
const same = (a: EnterpriseFactReference, b: EnterpriseFactReference) => key(a) === key(b)
const selected = (r: EnterpriseFactReference) => props.modelValue.some(value => same(value, r))
const stale = computed(() => props.modelValue.filter(r => !options.value.some(option => same(option, r))))
const valid = computed(() => !props.editable || !props.modelValue.length || !loading.value && !failed.value && !stale.value.length)
watch(valid, value => emit('validity', value), { immediate: true })
function snapshot(r: EnterpriseFactReference) {
  if (r.enterpriseId !== props.enterpriseId) return
  return data.value?.history.find(row => row.factId === r.factId && row.revision === r.revision && row.fact.kind === r.kind)
    ?? data.value?.facts.find(row => row.factId === r.factId && row.revision === r.revision && row.fact.kind === r.kind)
}
function toggle(r: EnterpriseFactReference, checked: boolean | 'indeterminate') {
  emit('update:modelValue', checked === true ? [...props.modelValue, r] : props.modelValue.filter(value => !same(value, r)))
}
let generation = 0
async function load() {
  const attempt = ++generation
  loading.value = true; failed.value = false
  try {
    const result = await $fetch<{ facts: FactSnapshot[]; history: FactSnapshot[] }>(`/api/roster/enterprises/${props.enterpriseId}/facts`)
    if (!Array.isArray(result?.facts) || !Array.isArray(result?.history)) throw new Error('Invalid fact readback')
    if (attempt === generation) data.value = result
  } catch { if (attempt === generation) failed.value = true }
  finally { if (attempt === generation) loading.value = false }
}
watch(() => props.enterpriseId, () => { data.value = null; void load() }, { immediate: true })
onBeforeUnmount(() => { generation++ })
</script>

<template>
  <fieldset class="flex min-w-0 flex-col gap-3" data-testid="enterprise-fact-references">
    <legend class="font-medium">{{ editable ? '关联主体事实（可选）' : '关联的主体事实' }}</legend>
    <p v-if="loading" role="status" class="text-muted-foreground">正在读取主体事实…</p>
    <div v-if="failed" role="status" class="flex flex-wrap items-center gap-2">
      <p>主体事实读取失败，已选引用保留。</p>
      <Button type="button" variant="outline" data-testid="fact-references-retry" :disabled="loading" @click="load">重试读取事实</Button>
    </div>
    <template v-if="editable">
      <Button type="button" variant="outline" :disabled="loading" @click="load">刷新可关联事实</Button>
      <p class="text-muted-foreground">选择作为本次解释依据的已确认事实，不会自动改判原因。</p>
      <p v-if="!loading && !failed && !options.length" class="text-muted-foreground">暂无可关联的已确认事实。</p>
      <label v-for="r in options" :key="key(r)" class="flex min-w-0 items-start gap-2 break-words">
        <Checkbox :model-value="selected(r)" :disabled="loading || failed" :aria-label="`关联${labels[r.kind] ?? r.kind}事实 ${r.factId}`" @update:model-value="toggle(r, $event)" />
        <span class="min-w-0">
          <span class="block">{{ labels[r.kind] ?? r.kind }} · {{ snapshot(r)?.fact.source.reference }}</span>
          <span class="block whitespace-pre-wrap">{{ snapshot(r)?.fact.source.statement }}</span>
          <span class="text-muted-foreground">生效时间：{{ snapshot(r)?.fact.effective.value ?? '未知' }}</span>
        </span>
      </label>
      <div v-if="!loading && stale.length" class="flex flex-col gap-2">
        <p>已有引用已变化或无法核实；请移除旧引用或改选当前已确认事实。历史引用仍保留。</p>
        <label v-for="r in stale" :key="key(r)" class="flex min-w-0 items-start gap-2 break-words">
          <Checkbox :model-value="true" :aria-label="`移除旧${labels[r.kind] ?? r.kind}事实引用 ${r.factId}`" @update:model-value="toggle(r, $event)" />
          <span>{{ labels[r.kind] ?? r.kind }} · {{ snapshot(r)?.fact.source.statement ?? '来源暂不可读' }}</span>
        </label>
      </div>
    </template>
    <ul v-else class="flex flex-col gap-2">
      <li v-for="r in modelValue" :key="key(r)" class="min-w-0 break-words">
        <p>{{ labels[r.kind] ?? r.kind }} · {{ snapshot(r)?.fact.source.reference ?? '来源暂不可读' }}</p>
        <p class="whitespace-pre-wrap">{{ snapshot(r)?.fact.source.statement }}</p>
        <p class="text-muted-foreground">生效时间：{{ snapshot(r)?.fact.effective.value ?? '未知' }}</p>
      </li>
    </ul>
    <DisclosurePanel v-if="modelValue.length" compact title="引用定位">
      <p v-for="r in modelValue" :key="key(r)">企业 {{ r.enterpriseId }} · 事实 {{ r.factId }} · 第 {{ r.revision }} 版 · {{ r.kind }}</p>
    </DisclosurePanel>
  </fieldset>
</template>
