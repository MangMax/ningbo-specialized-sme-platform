<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import TableFailureState from '@/components/TableFailureState.vue'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Building2, Plus, RefreshCw } from '@lucide/vue'
interface Point { precision: string; value: string | null }
interface Fact { kind: string; source: { reference: string; statement: string }; observed: Point; effective: Point; city: string | null }
interface Row { id: number; factId: number; status: string; action: string; fact: Fact; basis: string; createdAt: string; actor: { id: string } }
const props = defineProps<{ enterpriseId: number }>()
const emit = defineEmits<{ saved: [] }>()
const data = ref<{ facts: Row[]; history: Row[]; version: string } | null>(null)
const loading = ref(false), failed = ref(false)
const labels: Record<string, string> = { moved_in: '迁入宁波', moved_out: '迁出宁波', cancelled: '注销', registration_status: '登记状态' }
const statuses: Record<string, string> = { pending: '待确认', confirmed: '已确认事实', replaced: '已更正', withdrawn: '已撤回' }
function time(point: Point) { return point.precision === 'unknown' ? '未知' : `${point.value}（${({ year: '年', month: '月', day: '日', instant: '时刻' } as Record<string, string>)[point.precision] ?? '未知精度'}）` }
let readGeneration = 0
onUnmounted(() => { readGeneration++ })
async function load() {
  const generation = ++readGeneration
  loading.value = true; failed.value = false
  try {
    const result = await $fetch<NonNullable<typeof data.value>>(`/api/roster/enterprises/${props.enterpriseId}/facts`)
    if (!result || !Array.isArray(result.facts) || !Array.isArray(result.history) || typeof result.version !== 'string') throw new Error('Invalid fact readback')
    if (generation === readGeneration) data.value = result
  }
  catch { if (generation === readGeneration) failed.value = true }
  finally { if (generation === readGeneration) loading.value = false }
}
const enabled = ref(false), saving = ref(false), message = ref('')
const action = ref<'assert' | 'confirm' | 'replace' | 'withdraw' | null>(null)
const target = ref<number | null>(null)
const draft = ref<Fact>({ kind: 'moved_in', source: { reference: '', statement: '' }, city: null, observed: { precision: 'unknown', value: null }, effective: { precision: 'unknown', value: null } })
const basis = ref('')
// Keep the exact request after an uncertain response so a retry cannot double-apply.
let attempt: { signature: string; request: Record<string, unknown> } | null = null
function edit(next: typeof action.value, row?: Row) {
  action.value = next; target.value = row?.factId ?? null; basis.value = ''; message.value = ''; attempt = null
  draft.value = row ? JSON.parse(JSON.stringify(row.fact)) : { kind: 'moved_in', source: { reference: '', statement: '' }, city: null, observed: { precision: 'unknown', value: null }, effective: { precision: 'unknown', value: null } }
}
async function save() {
  if (!data.value || !action.value || saving.value) return
  readGeneration++; loading.value = false
  saving.value = true; message.value = ''
  const business = { action: action.value, basis: basis.value, ...(action.value !== 'assert' ? { factId: target.value } : {}), ...(['assert', 'replace'].includes(action.value) ? { fact: draft.value } : {}) }
  const signature = JSON.stringify(business)
  if (!attempt || attempt.signature !== signature) attempt = { signature, request: JSON.parse(JSON.stringify({ ...business, expectedVersion: data.value.version, idempotencyKey: crypto.randomUUID() })) }
  try {
    const plan = await $fetch<{ planHash: string }>(`/api/roster/enterprises/${props.enterpriseId}/facts/browser-preflight`, { method: 'POST', body: attempt.request })
    await $fetch(`/api/roster/enterprises/${props.enterpriseId}/facts/browser-commit`, { method: 'POST', body: { request: attempt.request, planHash: plan.planHash } })
    action.value = null; attempt = null; message.value = '事实操作已记录。'; await load(); emit('saved')
  } catch (error) {
    const code = (error as { data?: { error?: { code?: string } } }).data?.error?.code
    if (code === 'version_conflict' || code === 'fact_conflict') {
      attempt = null; await load(); message.value = '记录已变化，已刷新；草稿已保留，请核对后重新提交。'
    } else message.value = '提交未完成，草稿已保留。可重试相同操作。'
  } finally { saving.value = false }
}
onMounted(async () => {
  await load()
  try { enabled.value = (await $fetch<{ writeEnabled: boolean }>('/api/roster/evidence-review/browser-context')).writeEnabled === true } catch { enabled.value = false }
})
</script>

<template>
  <section class="bg-card min-w-0 overflow-hidden rounded-lg border" aria-label="主体事实记录">
    <header class="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
      <div class="flex items-center gap-2"><Building2 class="text-muted-foreground size-4" aria-hidden="true" /><h2 class="text-sm font-semibold">主体事实记录</h2><span v-if="data" class="text-muted-foreground text-sm tabular-nums">{{ data.facts.length }} 条</span></div>
      <div class="flex flex-wrap gap-2">
        <Button data-testid="facts-refresh" variant="ghost" size="sm" :disabled="loading" @click="load"><RefreshCw class="size-4" aria-hidden="true" />刷新记录</Button>
        <Button v-if="enabled && data" data-testid="fact-new" variant="outline" size="sm" :disabled="saving" @click="edit('assert')"><Plus class="size-4" aria-hidden="true" />记录事实</Button>
      </div>
    </header>
    <div class="flex min-w-0 flex-col gap-4 p-4 text-base leading-6">
    <p class="text-muted-foreground text-sm leading-6">迁入、迁出、注销与登记状态按来源分别记录。确认事实后，资格仍需结合生效时间与既有证据判断。</p>
    <TableFailureState v-if="failed" title="事实记录加载失败" :description="data ? '保留上次读取的事实及历史，可以重试。' : '尚未读取事实；这不代表没有记录。'" :pending="loading" @retry="load" />
    <p v-if="loading" role="status">正在读取事实记录…</p>
    <p v-if="!enabled" class="text-muted-foreground">事实维护暂为只读：尚未确认页面提交能力。</p>
    <p v-if="message" role="status">{{ message }}</p>
    <form v-if="action" class="bg-muted/25 flex min-w-0 flex-col gap-4 rounded-md border p-4" @submit.prevent="save">
      <h3 class="font-semibold">{{ ({ assert: '记录事实', confirm: '确认事实', replace: '更正事实', withdraw: '撤回事实' })[action] }}</h3>
      <fieldset :disabled="saving" class="grid min-w-0 gap-4 md:grid-cols-2 [&_label]:flex [&_label]:min-w-0 [&_label]:flex-col [&_label]:gap-2 [&_label]:text-sm">
        <template v-if="action === 'assert' || action === 'replace'">
          <label>事实类型
            <Select v-model="draft.kind"><SelectTrigger class="w-full" aria-label="事实类型"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem v-for="(label, key) in labels" :key="key" :value="key">{{ label }}</SelectItem></SelectGroup></SelectContent></Select>
          </label>
          <label>来源引用<Input v-model="draft.source.reference" aria-label="来源引用" required maxlength="2000" /></label>
          <label>来源原文<Textarea v-model="draft.source.statement" aria-label="来源原文" required maxlength="4000" /></label>
          <label>{{ draft.kind === 'moved_in' ? '来源地' : draft.kind === 'moved_out' ? '目的地' : '城市' }}（可未知）<Input :model-value="draft.city ?? ''" aria-label="城市" maxlength="100" @update:model-value="draft.city = String($event).trim() || null" /></label>
          <div v-for="key in (['observed', 'effective'] as const)" :key="key" class="flex flex-col gap-2">
            <label>{{ key === 'observed' ? '观察时间' : '生效时间' }}精度
              <Select :model-value="draft[key].precision" @update:model-value="draft[key] = { precision: String($event), value: $event === 'unknown' ? null : '' }"><SelectTrigger class="w-full" :aria-label="`${key}时间精度`"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem v-for="(label, precision) in { unknown: '未知', year: '年', month: '月', day: '日', instant: '时刻' }" :key="precision" :value="precision">{{ label }}</SelectItem></SelectGroup></SelectContent></Select>
            </label>
            <label v-if="draft[key].precision !== 'unknown'">{{ key === 'observed' ? '观察时间' : '生效时间' }}原值<Input :model-value="draft[key].value ?? ''" @update:model-value="draft[key].value = String($event)" required :placeholder="({ year: '2025', month: '2025-01', day: '2025-01-01', instant: '2025-01-01T00:00:00Z' } as Record<string, string>)[draft[key].precision]" /></label>
          </div>
        </template>
        <label>操作依据<Textarea v-model="basis" aria-label="操作依据" required maxlength="2000" /></label>
      </fieldset>
      <div class="flex flex-wrap gap-2"><Button type="submit" :disabled="saving || !basis.trim()">{{ saving ? '正在提交…' : '提交事实记录' }}</Button><Button type="button" variant="outline" :disabled="saving" @click="action = null">取消</Button></div>
    </form>
    <template v-if="data">
      <div v-if="!data.facts.length && !action" class="bg-muted/25 flex items-start gap-3 rounded-md border border-dashed p-5">
        <Building2 class="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div><p class="font-medium">暂无主体事实记录。</p><p class="text-muted-foreground mt-1 text-sm">有迁移、注销或登记状态的来源依据时，可在此记录。</p></div>
      </div>
      <article v-for="row in data.facts" :key="row.factId" class="flex min-w-0 flex-col gap-2 border-t pt-4 break-words">
        <h3 class="flex flex-wrap items-center gap-2 font-medium">{{ labels[row.fact.kind] ?? '未知事实类型' }}<span class="bg-muted text-muted-foreground rounded px-2 py-0.5 text-sm font-normal">{{ statuses[row.status] ?? '未知状态' }}</span></h3>
        <p>来源：{{ row.fact.source.reference }}</p>
        <p class="whitespace-pre-wrap">{{ row.fact.source.statement }}</p>
        <p>{{ row.fact.kind === 'moved_in' ? '来源地' : row.fact.kind === 'moved_out' ? '目的地' : '城市' }}：{{ row.fact.city ?? '未知' }}</p>
        <p>观察时间：{{ time(row.fact.observed) }}；生效时间：{{ time(row.fact.effective) }}</p>
        <p>记录依据：{{ row.basis }}</p>
        <div v-if="enabled && (row.status === 'pending' || row.status === 'confirmed')" class="flex flex-wrap gap-2">
          <Button v-if="row.status === 'pending'" variant="outline" :disabled="saving" @click="edit('confirm', row)">确认事实</Button>
          <Button variant="outline" :disabled="saving" @click="edit('replace', row)">更正事实</Button>
          <Button variant="outline" :disabled="saving" @click="edit('withdraw', row)">撤回事实</Button>
        </div>
      </article>
      <DisclosurePanel v-if="data.history.length" title="事实历史" class="border-t">
        <ol class="flex flex-col gap-3">
          <li v-for="row in data.history" :key="row.id" class="border-t pt-3 break-words">
            <p>{{ labels[row.fact.kind] ?? '未知事实类型' }} · {{ statuses[row.status] ?? '未知状态' }} · {{ row.createdAt }}</p>
            <p>操作：{{ ({ assert: '记录', confirm: '确认', replace: '更正', withdraw: '撤回' } as Record<string, string>)[row.action] ?? '未记录' }}</p>
            <p>来源：{{ row.fact.source.reference }} · {{ row.fact.source.statement }}</p>
            <p>{{ row.fact.kind === 'moved_in' ? '来源地' : row.fact.kind === 'moved_out' ? '目的地' : '城市' }}：{{ row.fact.city ?? '未知' }}</p>
            <p>观察时间：{{ time(row.fact.observed) }}；生效时间：{{ time(row.fact.effective) }}</p>
            <p>记录依据：{{ row.basis }} · 记录主体：{{ row.actor?.id ?? '未记录' }}</p>
          </li>
        </ol>
      </DisclosurePanel>
    </template>
    </div>
  </section>
</template>
