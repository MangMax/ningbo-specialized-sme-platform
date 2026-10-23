<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ARCHIVE_CONFLICT_LABELS, type EventArchiveCandidate, type EventArchivePage } from '~~/lib/roster/event-archive-candidates'
import { CORRESPONDENCE_ROLES, eventDecisionText, type CorrespondenceDetail, type EventSource } from '~~/lib/roster/correspondence-view'
import { TITLES } from '~~/lib/labels'
import { refreshCorrespondenceViews } from '~/composables/useCorrespondenceReadback'
import SourceReader from './SourceReader.vue'
import OfficialEvidence from './OfficialEvidence.vue'
import TablePagination from '@/components/TablePagination.vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface Edge { type: string; eventId: number; relationId: number; role: string }
interface Existing { id: number; revision: number; status: string; requiresRevalidation?: boolean; type?: string; eventId?: number | null; relationId?: number | null; role?: string }
const props = defineProps<{ edge: Edge; existing?: Existing | null; event?: EventSource; candidate?: EventArchiveCandidate; back?: string }>()
const enabled = useState<boolean | null>('correspondence-browser-capability', () => null)
onMounted(async () => {
  if (enabled.value !== null) return
  try { enabled.value = (await $fetch<{ writeEnabled: boolean }>('/api/roster/evidence-review/browser-context')).writeEnabled === true }
  catch { enabled.value = false }
})
type Action = 'confirm' | 'reject' | 'unlink' | 'correct' | 'revalidate'
const action = ref<Action | null>(null)
const basis = ref('')
const point = ref<Existing | null>(null)
const pending = ref(false)
const attempted = ref(false)
const error = ref('')
const conflict = ref(false)
const receipt = ref<{ correspondenceIds: number[] } | null>(null)
const success = ref('')
const request = ref<{ idempotencyKey: string; basis: string; operations: Record<string, unknown>[] } | null>(null)
const plan = ref<{ planHash: string; impact: { created: number; unlinked: number; audit: number } } | null>(null)
const replacements = ref<EventArchivePage | null>(null)
const replacementFailed = ref(false)
const replacementPage = ref(1)
const selected = ref<string>('')
const target = computed(() => replacements.value?.rows.find(row => String(row.edge.relationId) === selected.value))
const available = computed(() => replacements.value?.rows.filter(row => row.edge.relationId !== props.edge.relationId && (!row.existingStatus || row.existingStatus === 'candidate')) ?? [])
const official = computed(() => point.value && 'event' in point.value ? (point.value as CorrespondenceDetail).event ?? props.event : props.event)
const candidate = computed(() => action.value === 'correct' ? target.value : props.candidate)
const supportRole = computed(() => action.value === 'correct' ? target.value?.edge.role : point.value?.role ?? props.edge.role)
const conflicts = computed(() => candidate.value?.conflicts?.map(code => ARCHIVE_CONFLICT_LABELS[code] ?? code).join('；'))
const title = computed(() => ({ confirm: '确认对应', reject: '不对应', unlink: '取消对应', correct: '改选记录', revalidate: '重新核验对应' })[action.value ?? 'confirm'])
let generation = 0
let previousAction: Action | null = null
onBeforeUnmount(() => { generation++ })
watch([() => props.edge.eventId, () => props.edge.relationId], () => { generation++; action.value = null; request.value = null; plan.value = null; receipt.value = null; success.value = ''; basis.value = '' })
watch([basis, selected], () => { if (!receipt.value && !attempted.value) { request.value = null; plan.value = null; conflict.value = false; error.value = '' } })
async function loadPoint() {
  point.value = props.existing ? await $fetch<CorrespondenceDetail>(`/api/roster/correspondences/${props.existing.id}`) : null
}
async function open(next: Action) {
  if (previousAction === next && !success.value) { action.value = next; return }
  attempted.value = false
  previousAction = next
  action.value = next; success.value = ''; error.value = ''; conflict.value = false; request.value = null; plan.value = null; receipt.value = null; basis.value = ''; selected.value = ''; replacements.value = null
  pending.value = true
  try { await loadPoint(); if (next === 'correct') await loadReplacements(1) }
  catch { error.value = '当前对应读取失败，请刷新后核对。'; conflict.value = true }
  finally { pending.value = false }
}
async function loadReplacements(page: number) {
  replacementPage.value = page; replacementFailed.value = false
  try { replacements.value = await $fetch<EventArchivePage>('/api/roster/correspondences/discover', { method: 'POST', body: { eventId: props.edge.eventId, page, pageSize: 50 } }) }
  catch { replacementFailed.value = true }
}
const statePermitsAction = computed(() => {
  if (!point.value) return !props.existing && ['confirm', 'reject'].includes(action.value ?? '')
  return ['confirm', 'reject'].includes(action.value ?? '') ? point.value.status === 'candidate' : point.value.status === 'confirmed'
})
const canPreflight = computed(() => statePermitsAction.value && !!basis.value.trim() && !pending.value && !receipt.value && !conflict.value && (action.value !== 'correct' || !!target.value))
async function preflight() {
  if (!canPreflight.value) return
  const token = generation
  pending.value = true; error.value = ''
  try {
    const existing = point.value
    let operation: Record<string, unknown>
    let replacementEdge = target.value?.edge
    if (action.value === 'correct' && target.value?.existingCorrespondenceId) {
      const registered = await $fetch<CorrespondenceDetail>(`/api/roster/correspondences/${target.value.existingCorrespondenceId}`)
      if (registered.status !== 'candidate' || registered.eventId !== props.edge.eventId || registered.relationId !== target.value.edge.relationId) throw new Error('state_changed')
      replacementEdge = { type: registered.type, eventId: registered.eventId, relationId: registered.relationId, role: registered.role }
    }
    if (action.value === 'correct' || action.value === 'revalidate') {
      if (!existing || existing.status !== 'confirmed') throw new Error('state_changed')
      operation = { action: 'correct', correspondenceId: existing.id, expectedRevision: existing.revision, edge: action.value === 'revalidate' ? { type: existing.type ?? props.edge.type, eventId: existing.eventId ?? props.edge.eventId, relationId: existing.relationId ?? props.edge.relationId, role: existing.role ?? props.edge.role } : replacementEdge! }
    } else if (existing) {
      operation = { action: 'decide', correspondenceId: existing.id, expectedRevision: existing.revision, status: action.value === 'confirm' ? 'confirmed' : action.value === 'reject' ? 'rejected' : 'unlinked' }
    } else {
      operation = { action: 'create', edge: props.edge, status: action.value === 'reject' ? 'rejected' : 'confirmed' }
    }
    request.value ??= { idempotencyKey: crypto.randomUUID(), basis: basis.value.trim(), operations: [operation] }
    const result = await $fetch<typeof plan.value>('/api/roster/correspondences/browser-preflight', { method: 'POST', body: request.value })
    if (token === generation) plan.value = result
  } catch (cause) { if (token === generation) showError(cause) }
  finally { if (token === generation) pending.value = false }
}
function showError(cause: unknown) {
  const failure = cause as { statusCode?: number; status?: number; data?: { error?: { code?: string; message?: string } } }
  const code = failure.data?.error?.code
  conflict.value = failure.statusCode === 409 || failure.status === 409 || ['ambiguous_candidate', 'state_changed'].includes(code ?? (cause instanceof Error ? cause.message : ''))
  error.value = conflict.value ? '对应或来源已变化，本次没有覆盖新决定。草稿保留；刷新后重新核对并预检。' : `提交未完成，草稿和预检保留，可重试。${code ? `（${code}）` : ''}`
}
async function readback() {
  if (!receipt.value) return
  const points = await Promise.all(receipt.value.correspondenceIds.map(async id => {
    const [edge, audit] = await Promise.all([$fetch<CorrespondenceDetail>(`/api/roster/correspondences/${id}`), $fetch<{ rows: { idempotencyKey: string }[] }>(`/api/roster/correspondences/${id}/audit`)])
    if (!audit.rows.some(row => row.idempotencyKey === request.value?.idempotencyKey)) throw new Error('audit_missing')
    return edge
  }))
  if (!points.length) throw new Error('receipt_empty')
  await refreshCorrespondenceViews()
  success.value = '已提交并读回对应与审计；详情、对比和原行按当前来源重新读取。'
  error.value = ''
}
async function commit() {
  if (!plan.value || !request.value || pending.value || conflict.value) return
  pending.value = true; error.value = ''
  try {
    attempted.value = true
    receipt.value ??= await $fetch<{ correspondenceIds: number[] }>('/api/roster/correspondences/browser-commit', { method: 'POST', body: { request: request.value, planHash: plan.value.planHash } })
    await readback()
  } catch (cause) {
    if (receipt.value) error.value = '决定已提交，但同步读回失败。请重试读回；不会重复提交。'
    else showError(cause)
  } finally { pending.value = false }
}
async function refreshConflict() {
  pending.value = true
  try { await loadPoint(); await refreshCorrespondenceViews(); request.value = null; plan.value = null; attempted.value = false; conflict.value = false; error.value = ''; if (action.value === 'correct') await loadReplacements(replacementPage.value) }
  catch { error.value = '刷新失败，草稿保留，请重试刷新。' }
  finally { pending.value = false }
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2" data-testid="event-correspondence-decision">
    <p v-if="enabled !== true" class="text-muted-foreground text-[13px]">此页面当前只读，提交能力未开启或未能确认。</p>
    <div v-else class="flex flex-wrap gap-2">
      <template v-if="!existing || existing.status === 'candidate'"><Button variant="outline" size="sm" @click="open('confirm')">确认对应</Button><Button variant="ghost" size="sm" @click="open('reject')">不对应</Button></template>
      <template v-else-if="existing.status === 'confirmed'"><Button variant="ghost" size="sm" @click="open('unlink')">取消对应</Button><Button variant="outline" size="sm" @click="open('correct')">改选记录</Button><Button v-if="existing.requiresRevalidation || point?.requiresRevalidation" variant="outline" size="sm" @click="open('revalidate')">重新核验对应</Button></template>
      <p v-else class="text-muted-foreground text-[13px]">{{ existing.status === 'rejected' ? '已否定候选' : '已取消对应' }}，保留历史决定；不自动重新推荐。</p>
    </div>
    <Dialog :open="action !== null" @update:open="value => { if (!value && !pending) action = null }">
      <DialogContent class="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-4xl">
        <DialogHeader><DialogTitle>{{ title }}</DialogTitle><DialogDescription>核对双方原行后提交对应决定。此操作独立于差异原因复核。由页面代理提交，未识别个人身份。</DialogDescription></DialogHeader>
        <p>公布事件 #{{ edge.eventId }} · 平台原行 #{{ edge.relationId }}</p>
        <p v-if="point && !statePermitsAction" role="status">当前决定已变化，本次操作已停用。草稿保留；请关闭后按当前状态选择操作。</p>
        <p v-if="point?.requiresRevalidation" role="status" class="text-warning">来源已变化，历史确认暂不算有效出处；确认必须重新核验。</p>
        <template v-if="action === 'correct'">
          <Label>改选平台记录</Label>
          <Select v-model="selected" :disabled="pending || !!receipt || attempted"><SelectTrigger class="w-full"><SelectValue placeholder="请选择已核对的新平台原行" /></SelectTrigger><SelectContent><SelectGroup><SelectItem v-for="row in available" :key="row.edge.relationId" :value="String(row.edge.relationId)">查询 #{{ row.evidence.source.queryId }} · 原行 {{ row.evidence.source.sequenceNo }} · #{{ row.edge.relationId }}</SelectItem></SelectGroup></SelectContent></Select>
          <p v-if="replacementFailed" role="alert">改选候选第 {{ replacementPage }} 页读取失败，保留已有结果。<Button variant="outline" size="sm" @click="loadReplacements(replacementPage)">重试候选</Button></p>
          <TablePagination v-if="replacements" :page="replacements.page" :page-size="replacements.pageSize" :total="replacements.total" unit="条候选" :loading="pending" @update:page="loadReplacements" />
        </template>
        <div class="grid min-w-0 gap-4 sm:grid-cols-2">
          <section v-if="official" class="flex min-w-0 flex-col gap-2 text-[13px] leading-5" aria-label="正式公布依据">
            <h3 class="font-medium">正式公布依据</h3>
            <p>{{ TITLES[official.record.titleCode] ?? official.record.titleCode }} · {{ eventDecisionText(official) }} · 第 {{ official.batchSeq ?? '未记录' }} 批</p>
            <p class="break-words [overflow-wrap:anywhere]">公布信用代码：{{ official.record.usccRaw ?? '未提供' }}</p>
            <OfficialEvidence v-for="(item, index) in official.evidence" :key="index" :evidence="item" :back="back ?? ''" />
            <p v-if="!official.evidence.length" class="text-muted-foreground">未记录正式文件出处。</p>
          </section>
          <section class="min-w-0" aria-label="待核平台原行">
            <h3 class="mb-2 text-[13px] font-medium">待核平台原行</h3>
            <SourceReader v-if="action !== 'correct' || target" :key="action === 'correct' ? target!.edge.relationId : edge.relationId" kind="relation" :id="action === 'correct' ? target!.edge.relationId : edge.relationId" :return-to="back" compact read-only />
          </section>
        </div>
        <p v-if="conflicts" class="text-[13px] leading-5">待核依据：{{ conflicts }}</p>
        <p v-if="supportRole" class="text-muted-foreground text-[13px] leading-5">对应范围：{{ CORRESPONDENCE_ROLES[supportRole] ?? supportRole }}。<template v-if="supportRole === 'context_only'">仅说明流程背景，不代表平台结论与公布一致。</template></p>
        <div class="flex flex-col gap-2"><Label :for="`correspondence-basis-${edge.eventId}-${edge.relationId}`">核对依据（必填）</Label><Textarea :id="`correspondence-basis-${edge.eventId}-${edge.relationId}`" v-model="basis" :disabled="pending || !!receipt || attempted" maxlength="4000" placeholder="说明双方原行、年份、批次及事项的核对依据" /></div>
        <p v-if="plan" role="status">预检：新增 {{ plan.impact.created }} 条，取消 {{ plan.impact.unlinked }} 条，追加审计 {{ plan.impact.audit }} 条。</p>
        <p v-if="error" role="alert">{{ error }}</p><p v-if="success" role="status">{{ success }}</p>
        <div class="flex flex-wrap gap-2">
          <Button v-if="!plan && !conflict && !success" :disabled="!canPreflight" @click="preflight">预检决定</Button>
          <Button v-if="plan && !conflict && !success" :disabled="pending" @click="commit">{{ receipt ? '重试读回' : error ? '重试提交' : '提交决定' }}</Button>
          <Button v-if="conflict" variant="outline" :disabled="pending" @click="refreshConflict">刷新后重新核对</Button>
          <Button variant="ghost" :disabled="pending" @click="action = null">{{ success ? '完成' : '保留草稿并关闭' }}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
