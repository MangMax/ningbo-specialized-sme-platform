<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { EventArchiveCandidate, EventArchivePage } from '~~/lib/roster/event-archive-candidates'
import { CORRESPONDENCE_ROLES, eventDecisionText, type CorrespondenceDetail, type EventSource } from '~~/lib/roster/correspondence-view'
import { TITLES } from '#sme-roster/lib/labels'
import { REVIEW_DRAFTS_KEY } from '~/composables/useReviewDrafts'
import { refreshCorrespondenceViews } from '~/composables/useCorrespondenceReadback'
import { DECISION_EFFECTS, platformDecisionSummary, replacementDecisionOptions } from './event-correspondence-presentation'
import SourceReader from './SourceReader.vue'
import EventCandidateComparison from './EventCandidateComparison.vue'
import OfficialEvidence from './OfficialEvidence.vue'
import TablePagination from '#core/app/components/TablePagination.vue'
import { Button } from '#core/app/components/ui/button'
import { Label } from '#core/app/components/ui/label'
import { Textarea } from '#core/app/components/ui/textarea'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#core/app/components/ui/dialog'

interface Edge { type: string; eventId: number; relationId: number; role: string }
interface Existing { id: number; revision: number; status: string; requiresRevalidation?: boolean; type?: string; eventId?: number | null; relationId?: number | null; role?: string }
const props = defineProps<{ edge: Edge; existing?: Existing | null; event?: EventSource; candidate?: EventArchiveCandidate; back?: string; checkRevalidation?: boolean }>()
const emit = defineEmits<{ protected: [value: boolean] }>()
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
const pointLoaded = ref(false)
const revalidationRequired = ref(false)
const revalidationFailed = ref(false)
const revalidationAttempt = ref(0)
// Discovery exposes only stored status/revision. Validity belongs to the existing detail GET.
onMounted(() => watch([() => props.existing?.id, () => props.existing?.revision, revalidationAttempt], async ([id], _old, onCleanup) => {
  let current = true
  onCleanup(() => { current = false })
  revalidationRequired.value = false; revalidationFailed.value = false
  if (!props.checkRevalidation || !id || !['confirmed', 'candidate'].includes(props.existing?.status ?? '')) return
  try {
    const detail = await $fetch<CorrespondenceDetail>(`/api/roster/correspondences/${id}`)
    if (current) revalidationRequired.value = ['confirmed', 'candidate'].includes(detail.status) && detail.requiresRevalidation === true
  } catch { if (current) revalidationFailed.value = true }
}, { immediate: true }))
const choicesLoaded = ref(false)
const pending = ref(false)
const attempted = ref(false)
const error = ref('')
const conflict = ref(false)
const blockedCandidateRevision = ref<number | null>(null)
const candidateSourceBlocked = computed(() => point.value?.status === 'candidate' && point.value.revision === blockedCandidateRevision.value)
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
const replacementOptions = computed(() => replacementDecisionOptions(available.value))
const currentSummary = computed(() => platformDecisionSummary(props.candidate, (point.value as CorrespondenceDetail | null)?.relation))
const official = computed(() => point.value && 'event' in point.value ? (point.value as CorrespondenceDetail).event ?? props.event : props.event)
const candidate = computed(() => action.value === 'correct' ? target.value : props.candidate)
const supportRole = computed(() => action.value === 'correct' ? target.value?.edge.role : point.value?.role ?? props.edge.role)
const title = computed(() => ({ confirm: '确认对应', reject: '不对应', unlink: '取消对应', correct: '改选记录', revalidate: '重新核验对应' })[action.value ?? 'confirm'])
const draftStore = inject(REVIEW_DRAFTS_KEY, null)
const protectedDraft = computed(() => !success.value && (!!basis.value.trim() || !!selected.value || pending.value || attempted.value))
watch(protectedDraft, value => emit('protected', value), { immediate: true, flush: 'sync' })
const unregisterDraft = draftStore?.register({
  dirty: () => protectedDraft.value,
  locked: () => pending.value || (attempted.value && !success.value),
  discard: () => { basis.value = ''; selected.value = ''; plan.value = null; request.value = null; action.value = null; previousAction = null },
})
onBeforeUnmount(() => unregisterDraft?.())
let generation = 0
let previousAction: Action | null = null
onBeforeUnmount(() => { generation++ })
// Keep unresolved requests with their business object for this mounted session.
// Switching objects never reuses another object's key, receipt or loading state.
function captureContext() {
  return { blockedCandidateRevision: blockedCandidateRevision.value, previousAction, pointLoaded: pointLoaded.value, choicesLoaded: choicesLoaded.value, basis: basis.value, point: point.value, attempted: attempted.value, error: error.value, conflict: conflict.value, receipt: receipt.value, success: success.value, request: request.value, plan: plan.value, replacements: replacements.value, replacementFailed: replacementFailed.value, replacementPage: replacementPage.value, selected: selected.value }
}
let restoringContext = false
const contexts = new Map<string, ReturnType<typeof captureContext>>()
watch(() => `${props.edge.type}:${props.edge.eventId}:${props.edge.relationId}`, (key, previousKey) => {
  contexts.set(previousKey, captureContext())
  generation++; action.value = null; pending.value = false
  const saved = contexts.get(key)
  restoringContext = true
  blockedCandidateRevision.value = saved?.blockedCandidateRevision ?? null
  previousAction = saved?.previousAction ?? null
  pointLoaded.value = saved?.pointLoaded ?? false; choicesLoaded.value = saved?.choicesLoaded ?? false
  basis.value = saved?.basis ?? ''; point.value = saved?.point ?? null; attempted.value = saved?.attempted ?? false
  error.value = saved?.error ?? ''; conflict.value = saved?.conflict ?? false; receipt.value = saved?.receipt ?? null
  success.value = saved?.success ?? ''; request.value = saved?.request ?? null; plan.value = saved?.plan ?? null
  replacements.value = saved?.replacements ?? null; replacementFailed.value = saved?.replacementFailed ?? false
  replacementPage.value = saved?.replacementPage ?? 1; selected.value = saved?.selected ?? ''
  restoringContext = false
})
watch([basis, selected], () => { if (!restoringContext && !receipt.value && !attempted.value) { request.value = null; plan.value = null; conflict.value = false; error.value = '' } }, { flush: 'sync' })
async function loadPoint(token = generation) {
  pointLoaded.value = false
  const result = props.existing ? await $fetch<CorrespondenceDetail>(`/api/roster/correspondences/${props.existing.id}`) : null
  if (token === generation) { point.value = result; pointLoaded.value = true }
}
async function open(next: Action) {
  if (attempted.value && !success.value) { action.value = previousAction; return }
  if (previousAction === next && !success.value) {
    action.value = next
    if (!pointLoaded.value || (next === 'correct' && !choicesLoaded.value)) await loadOpening(next)
    return
  }
  attempted.value = false
  previousAction = next
  action.value = next; success.value = ''; error.value = ''; conflict.value = false; request.value = null; plan.value = null; receipt.value = null; basis.value = ''; selected.value = ''; replacements.value = null
  pointLoaded.value = false; choicesLoaded.value = false; replacementPage.value = 1
  await loadOpening(next)
}
// Resume only unfinished reads; editable drafts and bound writes are retained by open().
async function loadOpening(next: Action) {
  if (pending.value) return
  const token = generation
  pending.value = true
  try {
    if (!pointLoaded.value) await loadPoint(token)
    if (token !== generation) return
    error.value = ''; conflict.value = false
    if (next === 'correct' && !choicesLoaded.value) await loadReplacements(replacementPage.value)
  }
  catch { if (token === generation) { error.value = '当前对应读取失败，请刷新后核对。'; conflict.value = true } }
  finally { if (token === generation) pending.value = false }
}
async function loadReplacements(page: number) {
  const token = generation
  replacementPage.value = page; replacementFailed.value = false; choicesLoaded.value = false
  try {
    const result = await $fetch<EventArchivePage>('/api/roster/correspondences/discover', { method: 'POST', body: { eventId: props.edge.eventId, page, pageSize: 50 } })
    if (token === generation) { replacements.value = result; choicesLoaded.value = true }
  } catch { if (token === generation) replacementFailed.value = true }
}
const statePermitsAction = computed(() => {
  if (!pointLoaded.value) return false
  if (!point.value) return !props.existing && ['confirm', 'reject'].includes(action.value ?? '')
  if (action.value === 'revalidate') return ['candidate', 'confirmed'].includes(point.value.status)
  return ['confirm', 'reject'].includes(action.value ?? '') ? point.value.status === 'candidate' : point.value.status === 'confirmed'
})
const canPreflight = computed(() => (!candidateSourceBlocked.value || action.value === 'revalidate') && statePermitsAction.value && !!basis.value.trim() && !pending.value && !attempted.value && !receipt.value && !conflict.value && (action.value !== 'correct' || !!target.value))
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
    if (action.value === 'revalidate' && existing?.status === 'candidate') {
      operation = { action: 'revalidate', correspondenceId: existing.id, expectedRevision: existing.revision }
    } else if (action.value === 'correct' || action.value === 'revalidate') {
      if (!existing || existing.status !== 'confirmed') throw new Error('state_changed')
      operation = { action: 'correct', correspondenceId: existing.id, expectedRevision: existing.revision, edge: action.value === 'revalidate' ? { type: existing.type ?? props.edge.type, eventId: existing.eventId ?? props.edge.eventId, relationId: existing.relationId ?? props.edge.relationId, role: existing.role ?? props.edge.role } : replacementEdge! }
    } else if (existing) {
      operation = { action: 'decide', correspondenceId: existing.id, expectedRevision: existing.revision, status: action.value === 'confirm' ? 'confirmed' : action.value === 'reject' ? 'rejected' : 'unlinked' }
    } else {
      operation = { action: 'create', edge: { ...props.edge }, status: action.value === 'reject' ? 'rejected' : 'confirmed' }
    }
    if (token !== generation) return
    request.value ??= { idempotencyKey: crypto.randomUUID(), basis: basis.value.trim(), operations: [operation] }
    const result = await $fetch<typeof plan.value>('/api/roster/correspondences/browser-preflight', { method: 'POST', body: request.value })
    if (token === generation) { plan.value = result; return true }
  } catch (cause) { if (token === generation) showError(cause) }
  finally { if (token === generation) pending.value = false }
}
function showError(cause: unknown) {
  const failure = cause as { statusCode?: number; status?: number; data?: { error?: { code?: string; message?: string } } }
  const code = failure.data?.error?.code
  if ((failure.statusCode === 409 || failure.status === 409) && point.value?.status === 'candidate' && code === 'plan_mismatch' && failure.data?.error?.message === 'Source row changed since correspondence decision') {
    // This explicit rejection occurs before writes. Unknown transport failures
    // keep their frozen request so retry cannot create a second decision.
    attempted.value = false
    request.value = null
    plan.value = null
    blockedCandidateRevision.value = point.value.revision
    conflict.value = true
    error.value = ''
    return
  }
  conflict.value = failure.statusCode === 409 || failure.status === 409 || ['ambiguous_candidate', 'state_changed'].includes(code ?? (cause instanceof Error ? cause.message : ''))
  error.value = conflict.value ? '对应或来源已变化，本次没有覆盖新决定。草稿保留；刷新后重新核对并提交。' : `提交未完成，草稿和预检保留，可重试。${code ? `（${code}）` : ''}`
}
async function readback(token: number, committed: { correspondenceIds: number[] }, key: string) {
  const points = await Promise.all(committed.correspondenceIds.map(async id => {
    const edge = await $fetch<CorrespondenceDetail>(`/api/roster/correspondences/${id}`)
    const pageSize = 50
    let lastPage: number | undefined
    for (let page = 1; ; page++) {
      if (token !== generation) return
      const audit = await $fetch<{ rows: { idempotencyKey: string }[]; total: number; page: number; pageSize: number }>(`/api/roster/correspondences/${id}/audit`, { query: { page, pageSize } })
      if (token !== generation) return
      if (audit.page !== page || audit.pageSize !== pageSize || !Number.isSafeInteger(audit.total) || audit.total < 0 || audit.rows.length !== Math.min(pageSize, Math.max(0, audit.total - (page - 1) * pageSize))) throw new Error('audit_page_invalid')
      // Audit is append-only. Bound this attempt to the first response's total;
      // later decisions cannot turn a missing key into an unending traversal.
      lastPage ??= Math.ceil(audit.total / pageSize)
      if (audit.rows.some(row => row.idempotencyKey === key)) break
      if (page >= lastPage) throw new Error('audit_missing')
    }
    return edge
  }))
  if (!points.length) throw new Error('receipt_empty')
  if (token !== generation) return
  await refreshCorrespondenceViews()
  if (token !== generation) return
  if (action.value === 'revalidate' && points[0]?.status === 'candidate') { point.value = points[0]; blockedCandidateRevision.value = null; revalidationRequired.value = false }
  success.value = (action.value === 'revalidate' && points[0]?.status === 'candidate' ? '候选来源已重新核验，仍待确认；请关闭后选择确认对应或不对应。' : '') + '已保存平台对应决定。已提交并读回对应与审计；详情、对比和原行按当前来源重新读取。年度最终结果与来源变化处理仍需分别核对。'
  error.value = ''
}
async function submit() {
  if (pending.value || conflict.value || success.value) return
  const token = generation
  if (!attempted.value && !receipt.value) {
    if (!await preflight() || token !== generation) return
  }
  await commit()
}
async function commit() {
  if (!plan.value || !request.value || pending.value || conflict.value) return
  const token = generation, submitted = request.value, submittedPlan = plan.value
  pending.value = true; error.value = ''
  try {
    attempted.value = true
    const committed = receipt.value ?? await $fetch<{ correspondenceIds: number[] }>('/api/roster/correspondences/browser-commit', { method: 'POST', body: { request: submitted, planHash: submittedPlan.planHash } })
    if (token !== generation) return
    receipt.value = committed
    await readback(token, committed, submitted.idempotencyKey)
  } catch (cause) {
    if (token !== generation) return
    if (receipt.value) error.value = '决定已提交，但同步读回失败。请重试读回；不会重复提交。'
    else showError(cause)
  } finally { if (token === generation) pending.value = false }
}
async function revalidateCandidate() {
  if (pending.value || attempted.value) return
  const draft = basis.value
  await open('revalidate')
  basis.value = draft
}
async function refreshConflict() {
  const token = generation
  pending.value = true
  try { await loadPoint(token); if (token !== generation) return; await refreshCorrespondenceViews(); if (token !== generation) return; request.value = null; plan.value = null; attempted.value = false; conflict.value = false; error.value = ''; if (action.value === 'correct') await loadReplacements(replacementPage.value) }
  catch { if (token === generation) error.value = '刷新失败，草稿保留，请重试刷新。' }
  finally { if (token === generation) pending.value = false }
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2" data-testid="event-correspondence-decision">
    <p v-if="enabled !== true" class="text-muted-foreground text-base">此页面当前只读，提交能力未开启或未能确认。</p>
    <div v-else class="flex flex-wrap gap-2">
      <template v-if="!existing || existing.status === 'candidate'"><Button variant="outline" size="sm" @click="open('confirm')">确认对应</Button><Button variant="ghost" size="sm" @click="open('reject')">不对应</Button><Button v-if="existing && (existing.requiresRevalidation || revalidationRequired || point?.requiresRevalidation)" variant="outline" size="sm" @click="open('revalidate')">重新核验候选</Button></template>
      <template v-else-if="existing.status === 'confirmed'"><Button variant="ghost" size="sm" @click="open('unlink')">取消对应</Button><Button variant="outline" size="sm" @click="open('correct')">改选记录</Button><Button v-if="existing.requiresRevalidation || revalidationRequired || point?.requiresRevalidation" variant="outline" size="sm" @click="open('revalidate')">重新核验对应</Button></template>
      <p v-else class="text-muted-foreground text-base">{{ existing.status === 'rejected' ? '已否定候选' : '已取消对应' }}，保留历史决定；不自动重新推荐。</p>
    </div>
    <p v-if="revalidationFailed" role="status">对应有效性读取失败。<Button variant="outline" size="sm" @click="revalidationAttempt++">重新读取对应有效性</Button></p>
    <Dialog :open="action !== null" @update:open="value => { if (!value && !pending) action = null }">
      <DialogContent class="flex max-h-[85dvh] min-w-0 flex-col overflow-hidden sm:max-w-4xl">
        <DialogHeader><DialogTitle>{{ title }}</DialogTitle><DialogDescription>核对正式事项与平台记录，填写依据后提交决定。系统会先检查来源与当前决定，保存后核实结果。</DialogDescription></DialogHeader>
        <div class="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto">
        <section class="flex min-w-0 flex-col gap-2 text-base leading-6 [overflow-wrap:anywhere]" aria-label="本次操作与影响">
          <p><span class="font-medium">本次正式事项：</span>{{ official ? `${TITLES[official.record.titleCode] ?? official.record.titleCode} · ${eventDecisionText(official)}` : '事项信息未记录，请核对正式公布依据' }}</p>
          <p><span class="font-medium">{{ action === 'correct' ? '当前对应记录' : '本次平台记录' }}：</span>{{ currentSummary }}</p>
          <p>{{ action === 'revalidate' && point?.status === 'candidate' ? '绑定当前来源并保留旧依据与历史。重核后仍是待确认候选，请再明确确认对应或标记不对应。' : DECISION_EFFECTS[action ?? 'confirm'] }}</p>
          <p class="text-muted-foreground">对应关系不等于平台结果通过，也不直接确定最终资格。最终资格仍按正式公布、来源有效性及业务规则判断；此操作独立于差异原因复核。</p>
          <p v-if="action === 'confirm' || action === 'correct' || action === 'revalidate'" class="text-muted-foreground">人工决定会保留，自动处理不会覆盖；来源变化后仍需重新核验。</p>
        </section>
        <p v-if="pointLoaded && point && !statePermitsAction" role="status">当前决定已变化，本次操作已停用。草稿保留；请关闭后按当前状态选择操作。</p>
        <p v-if="point?.requiresRevalidation" role="status" class="text-warning">{{ point.status === 'confirmed' ? '来源已变化，历史确认暂不算有效出处；确认必须重新核验。' : '来源已变化，旧依据保留；请先重新核验当前来源。' }}</p>
        <template v-if="action === 'correct'">
          <Label for="replacement-record">选择新的对应记录</Label>
          <Select v-model="selected" :disabled="pending || !!receipt || attempted || !available.length"><SelectTrigger id="replacement-record" style="height: auto" class="min-h-9 w-full shrink-0 whitespace-normal text-left"><SelectValue class="block! line-clamp-none! whitespace-normal! [overflow-wrap:anywhere]" placeholder="请选择已核对的新平台记录" /></SelectTrigger><SelectContent class="max-w-[calc(100vw-3rem)]"><SelectGroup><SelectItem v-for="option in replacementOptions" :key="option.id" :value="option.id" class="whitespace-normal [overflow-wrap:anywhere]">{{ option.label }}</SelectItem></SelectGroup></SelectContent></Select>
          <p v-if="replacements && !available.length && !replacementFailed" role="status">本页无可改选记录：当前记录不能改选为自身；已确认、不对应或已解除的记录保留已有人工决定，不参与改选。<template v-if="replacements.total > replacements.pageSize">可继续查看其他归档页。</template></p>
          <p v-if="replacements" class="text-muted-foreground text-sm">本页 {{ replacements.rows.length }} 条归档记录中，{{ available.length }} 条可改选；分页总数包含当前记录和已有决定。</p>
          <p v-if="replacementFailed" role="alert">改选候选第 {{ replacementPage }} 页读取失败，保留已有结果。<Button variant="outline" size="sm" @click="loadReplacements(replacementPage)">重试候选</Button></p>
          <TablePagination v-if="replacements" :page="replacements.page" :page-size="replacements.pageSize" :total="replacements.total" unit="条归档记录" :loading="pending" @update:page="loadReplacements" />
        </template>
        <EventCandidateComparison v-if="candidate?.evidence?.identity && candidate.evidence.temporal" :candidate="candidate" />
        <div class="grid min-w-0 gap-4 sm:grid-cols-2">
          <section v-if="official" class="flex min-w-0 flex-col gap-2 text-base leading-6" aria-label="正式公布依据">
            <h3 class="font-medium">正式公布依据</h3>
            <p>{{ TITLES[official.record.titleCode] ?? official.record.titleCode }} · {{ eventDecisionText(official) }} · 第 {{ official.batchSeq ?? '未记录' }} 批</p>
            <p class="break-words [overflow-wrap:anywhere]">公布信用代码：{{ official.record.usccRaw ?? '未提供' }}</p>
            <OfficialEvidence v-for="(item, index) in official.evidence" :key="index" :evidence="item" :back="back ?? ''" />
            <p v-if="!official.evidence.length" class="text-muted-foreground">未记录正式文件出处。</p>
          </section>
          <section class="min-w-0" aria-label="待核平台原行">
            <h3 class="mb-2 text-base font-medium">待核平台原行</h3>
            <SourceReader v-if="action !== 'correct' || target" :key="action === 'correct' ? target!.edge.relationId : edge.relationId" kind="relation" :id="action === 'correct' ? target!.edge.relationId : edge.relationId" :return-to="back" presentation="business" compact read-only />
          </section>
        </div>
        <p v-if="supportRole" class="text-muted-foreground text-base leading-6">对应范围：{{ CORRESPONDENCE_ROLES[supportRole] ?? supportRole }}。<template v-if="supportRole === 'context_only'">仅说明流程背景，不代表平台结论与公布一致。</template></p>
        </div>
        <div class="flex shrink-0 flex-col gap-2 border-t pt-3 text-sm [overflow-wrap:anywhere]" data-testid="decision-footer">
        <div class="flex flex-col gap-2"><Label :for="`correspondence-basis-${edge.eventId}-${edge.relationId}`">核对依据（必填）</Label><Textarea class="max-h-24 overflow-y-auto resize-none" :id="`correspondence-basis-${edge.eventId}-${edge.relationId}`" v-model="basis" :disabled="pending || !!receipt || attempted" maxlength="4000" placeholder="说明双方原行、年份、批次及事项的核对依据" /></div>
        <p v-if="attempted && !receipt && !pending && !success" role="status">提交结果尚待确认，请使用原请求重试。</p>
        <p v-if="error" role="alert">{{ error }}</p><p v-if="success" role="status">{{ success }}</p>
        <div class="flex flex-wrap gap-2">
          <p v-if="candidateSourceBlocked && action !== 'revalidate'" role="alert" class="text-base">候选来源已变化，请先重新核验当前来源。原值、决定历史与本次草稿保留；重核不会自动确认。</p>
          <Button v-if="candidateSourceBlocked && action !== 'revalidate'" variant="outline" :disabled="pending || attempted" @click="revalidateCandidate">重新核验候选</Button>
          <Button v-if="(!candidateSourceBlocked || action === 'revalidate') && !conflict && !success" :disabled="pending || (!attempted && !receipt && !canPreflight)" @click="submit">{{ pending ? '正在保存…' : receipt ? '重试读回' : attempted ? '重试提交' : '提交决定' }}</Button>
          <Button v-if="conflict && (!candidateSourceBlocked || action === 'revalidate')" variant="outline" :disabled="pending" @click="refreshConflict">刷新后重新核对</Button>
          <Button variant="ghost" :disabled="pending" @click="action = null">{{ success ? '完成' : '保留草稿并关闭' }}</Button>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
