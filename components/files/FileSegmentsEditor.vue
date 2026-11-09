<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Plus, Minus, Pencil } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { partKey } from '~~/lib/file-parts'
import { TITLES, TITLE_ORDER, EVENTS, EVENT_ORDER } from '~~/lib/labels'
import { describeFetchError } from '~~/lib/upload-register'
import type { getParse105, preflightParse310 } from '~~/server/utils/parse-maintenance-105'
import type { StoredFileRow } from '~~/server/utils/stored-files'
type State = ReturnType<typeof getParse105>
type Part = State['parts'][number]
type Draft = { declarationId?: string; ranges: { start: string; end: string }[]; rangesEdited: boolean } & Omit<Part, 'year' | 'batch' | 'rowCount' | 'attachment'> & { year: string; batch: string; rowCount: string; attachment: string }
const props = defineProps<{ file: StoredFileRow | null; refreshList: () => Promise<unknown> }>()
const open = defineModel<boolean>('open', { default: false })
const state = ref<State | null>(null), drafts = ref<Draft[]>([])
const enabled = ref(false), pending = ref(false), failure = ref(''), notice = ref('')
const reason = ref('维护文件内容分段描述')
const editing = ref<number | null>(null)
const derived = computed(() => state.value?.parts.filter(p => p.origin === 'derived') ?? [])
const locked = computed(() => pending.value || !enabled.value || !state.value)
type Submission = ReturnType<typeof preflightParse310> & { parts: object[]; parseState: string; idempotencyKey: string; reason: string }
let attempt: { fingerprint: string; body: Submission } | null = null
const url = () => `/api/files/${props.file!.id}/segments`
function toDraft(p: Part): Draft {
  const declaration = state.value?.declarations?.find(d => partKey(d.part) === partKey(p))
  return { ...p, ranges: (declaration?.pageRanges ?? []).map(r => ({ start: String(r.start), end: String(r.end) })), rangesEdited: false, ...(declaration ? { declarationId: declaration.declarationId } : {}), year: p.year === null ? '' : String(p.year), batch: p.batch === null ? '' : String(p.batch), attachment: p.attachment ?? '', rowCount: String(p.rowCount) }
}
async function load() {
  pending.value = true; failure.value = ''; notice.value = ''
  try {
    const result = await $fetch<{ state: State; writeEnabled: boolean }>(url())
    state.value = result.state; enabled.value = result.writeEnabled
    drafts.value = result.state.parts.filter(p => p.origin !== 'derived').map(toDraft)
    attempt = null
  } catch (error) { failure.value = `读取失败，草稿保留。${describeFetchError(error, error instanceof Error ? error.message : '操作失败')}` }
  finally { pending.value = false }
}
watch(open, value => { if (value) { state.value = null; enabled.value = false; drafts.value = []; attempt = null; void load() } }, { immediate: true })
function add(source?: Part) {
  if (source) { drafts.value.push({ ...toDraft(source), origin: 'agent', hasConflict: false }); editing.value = drafts.value.length - 1; return }
  drafts.value.push({ ranges: [], rangesEdited: false, titleCode: 'specialized_sme', eventKind: 'award', year: '', batch: '', attachment: '', rowCount: '0', origin: 'agent', hasConflict: false })
  editing.value = drafts.value.length - 1
}
function integer(text: string, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
  if (!text.trim()) return null
  const value = Number(text)
  if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(value) || value < min || value > max) throw Error(`${name}必须为 ${min}–${max} 的整数；未知请留空`)
  return value
}
async function save() {
  if (locked.value || !state.value) return
  pending.value = true; failure.value = ''; notice.value = ''
  try {
    if (drafts.value.length > 1000) throw Error('最多登记1000段，不会截断保存')
    const parts = drafts.value.map(p => {
      const { origin: _origin, hasConflict: _conflict, ranges, rangesEdited, ...fields } = p
      const pageRanges = ranges.map(r => {
        const start = integer(r.start, '起页', 1), end = integer(r.end, '止页', 1)
        if (start === null || end === null || end < start) throw Error('请填写完整起止页，止页不得小于起页')
        return { start, end }
      })
      return { ...fields, ...(rangesEdited ? { pageRanges } : {}), year: integer(p.year, '内容年份', 1900, 2100), batch: integer(p.batch, '批次', 1), rowCount: integer(p.rowCount, '行数', 0) ?? 0, attachment: p.attachment || null }
    })
    const fingerprint = JSON.stringify({ parts, reason: reason.value, version: state.value.version })
    if (!attempt || attempt.fingerprint !== fingerprint) {
      const plan = await $fetch<ReturnType<typeof preflightParse310> & { parseState: string }>(url() + '/preflight', { method: 'POST', body: { expectedVersion: state.value.version, ...(parts.some(p => p.pageRanges?.length) ? { verifyPhysicalPages: true } : {}) } })
      attempt = { fingerprint, body: { ...plan, parts, reason: reason.value, idempotencyKey: crypto.randomUUID() } }
    }
    await $fetch(url() + '/commit', { method: 'POST', body: attempt.body })
    // Always read current state; replayed receipts can describe an older state.
    const current = await $fetch<{ state: State; writeEnabled: boolean }>(url())
    state.value = current.state; enabled.value = current.writeEnabled
    drafts.value = current.state.parts.filter(p => p.origin !== 'derived').map(toDraft)
    attempt = null
    await props.refreshList()
    editing.value = null
    notice.value = '已保存并读回当前分段，列表已刷新。'
  } catch (error) { failure.value = `${describeFetchError(error, error instanceof Error ? error.message : '操作失败')}。草稿保留；版本冲突请重新加载。结果不确定可原稿重试，修改草稿将使用新的提交。` }
  finally { pending.value = false }
}
</script>

<template>
  <section v-if="open" class="min-w-0 space-y-4" aria-label="内容分段管理">
    <header class="flex flex-wrap items-center justify-between gap-2">
      <div><h3 class="font-medium">内容分段</h3><p class="text-muted-foreground text-xs">每段对应一组认定或复核年份与批次。</p></div>
      <Button variant="outline" size="sm" :disabled="locked || drafts.length >= 1000" @click="add()"><Plus class="mr-1 size-4" />新增分段</Button>
    </header>
    <p v-if="!state && pending" role="status" class="text-muted-foreground text-sm">正在加载分段…</p>
    <p v-if="!enabled && state" role="status" class="text-sm">当前实例未开放修改，请联系管理员开启浏览器写入。</p>
    <p v-if="failure" role="alert" class="text-destructive break-words text-sm">{{ failure }} <Button variant="link" size="sm" :disabled="pending" @click="load">重新加载（替换草稿）</Button></p>
    <p v-if="notice" role="status" class="text-sm">{{ notice }}</p>
    <div v-for="(part, i) in drafts" :key="i" class="min-w-0 rounded-md border bg-background">
      <div class="flex flex-wrap items-center justify-between gap-2 p-3">
        <div class="min-w-0 text-sm"><span class="font-medium">{{ TITLES[part.titleCode] }} · {{ EVENTS[part.eventKind] }}</span><span class="ml-2">{{ part.year || '年份未知' }} / {{ part.batch || '批次未知' }}</span><span class="text-muted-foreground ml-2">{{ part.attachment || '附件未填' }}</span></div>
        <div class="flex shrink-0 gap-1"><Button variant="ghost" size="sm" :disabled="locked" @click="editing = editing === i ? null : i"><Pencil class="mr-1 size-3.5" />{{ editing === i ? '收起' : '修改' }}</Button><Button variant="ghost" size="icon" :disabled="locked" :aria-label="`撤回分段 ${i + 1}`" @click="drafts.splice(i, 1); editing = null"><Minus class="size-4" /></Button></div>
      </div>
      <fieldset v-if="editing === i" :disabled="locked" class="grid min-w-0 gap-3 border-t p-3 sm:grid-cols-3">
          <div class="min-w-0"><Label :for="`segment-title-${file?.id}-${i}`">称号</Label><Select v-model="part.titleCode"><SelectTrigger :id="`segment-title-${file?.id}-${i}`" class="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="t in TITLE_ORDER" :key="t" :value="t">{{ TITLES[t] }}</SelectItem></SelectContent></Select></div>
          <div><Label :for="`segment-event-${file?.id}-${i}`">事件</Label><Select v-model="part.eventKind"><SelectTrigger :id="`segment-event-${file?.id}-${i}`" class="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="e in EVENT_ORDER" :key="e" :value="e">{{ EVENTS[e] }}</SelectItem></SelectContent></Select></div>
          <div><Label :for="`segment-year-${file?.id}-${i}`">内容年份</Label><Input :id="`segment-year-${file?.id}-${i}`" v-model="part.year" inputmode="numeric" placeholder="未知" /></div>
          <div><Label :for="`segment-batch-${file?.id}-${i}`">内容批次</Label><Input :id="`segment-batch-${file?.id}-${i}`" v-model="part.batch" inputmode="numeric" placeholder="未知" /></div>
          <div><Label :for="`segment-attachment-${file?.id}-${i}`">附件</Label><Input :id="`segment-attachment-${file?.id}-${i}`" v-model="part.attachment" placeholder="未知" /></div>
          <div><Label :for="`segment-count-${file?.id}-${i}`">行数</Label><Input :id="`segment-count-${file?.id}-${i}`" v-model="part.rowCount" inputmode="numeric" placeholder="0 表示未知" /></div>
          <div class="min-w-0 space-y-2 sm:col-span-2">
            <p class="text-sm">物理页码范围 · {{ part.ranges.length ? '' : (part.rangesEdited ? '将显式清空' : '未登记或已清空') }}</p>
            <div v-for="(range, j) in part.ranges" :key="j" class="grid min-w-0 grid-cols-2 gap-2">
              <div><Label :for="`range-start-${file?.id}-${i}-${j}`">起页 {{ j + 1 }}</Label><Input :id="`range-start-${file?.id}-${i}-${j}`" v-model="range.start" inputmode="numeric" @update:model-value="part.rangesEdited = true" /></div>
              <div><Label :for="`range-end-${file?.id}-${i}-${j}`">止页 {{ j + 1 }}</Label><Input :id="`range-end-${file?.id}-${i}-${j}`" v-model="range.end" inputmode="numeric" @update:model-value="part.rangesEdited = true" /></div>
              <Button variant="outline" @click="part.ranges.splice(j, 1); part.rangesEdited = true">移除范围 {{ j + 1 }}</Button>
            </div>
            <div class="flex flex-wrap gap-2"><Button variant="outline" :disabled="part.ranges.length >= 1000" @click="part.ranges.push({ start: '', end: '' }); part.rangesEdited = true">新增页码范围</Button><Button variant="outline" @click="part.ranges = []; part.rangesEdited = true">清空页码范围</Button></div>
          </div>
          <p v-if="part.hasConflict" role="status" class="text-sm sm:col-span-2">行数与正式出处派生值冲突，保留差异待核，不是资格结论。</p>
      </fieldset>
    </div>
    <div v-if="derived.length" class="space-y-2">
      <p class="text-muted-foreground text-xs">已入库记录中的分段</p>
      <div v-for="(part, i) in derived" :key="i" class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-3 text-sm">
        <div class="min-w-0"><span class="font-medium">{{ TITLES[part.titleCode] }} · {{ EVENTS[part.eventKind] }}</span><span class="ml-2">{{ part.year ?? '年份未知' }} / {{ part.batch ?? '批次未知' }}</span><span class="text-muted-foreground ml-2">{{ part.attachment ?? '附件未知' }} · {{ part.rowCount }} 行</span></div>
        <Button variant="outline" size="sm" :disabled="locked" @click="add(part)">修改描述</Button>
      </div>
    </div>
    <p v-if="state && !drafts.length && !derived.length" class="text-muted-foreground py-4 text-center text-sm">还没有分段，点击「新增分段」填写年份和批次。</p>
    <details class="text-muted-foreground text-xs"><summary class="cursor-pointer">页码与修改说明</summary><p class="mt-2">页码使用文件预览中的物理页码。修改描述不会自动修改已入库企业；保存后可用「同步到企业」补齐未知年份、批次，已有不同值须另行核实。</p></details>
    <footer v-if="state && enabled" class="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
      <p class="text-muted-foreground text-xs">同一文件可有多个年份、多个批次；按分段逐条登记。</p>
      <div class="flex gap-2"><Button variant="outline" :disabled="pending" @click="load">取消修改</Button><Button :disabled="locked" @click="save">{{ pending ? '正在保存…' : '保存分段' }}</Button></div>
    </footer>
  </section>
</template>
