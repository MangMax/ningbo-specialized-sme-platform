<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { TITLES, TITLE_ORDER, EVENTS, EVENT_ORDER } from '~~/lib/labels'
import { describeFetchError } from '~~/lib/upload-register'
import type { getParse105, preflightParse310 } from '~~/server/utils/parse-maintenance-105'
import type { StoredFileRow } from '~~/server/utils/stored-files'
type State = ReturnType<typeof getParse105>
type Part = State['parts'][number]
type Draft = Omit<Part, 'year' | 'batch' | 'rowCount' | 'attachment'> & { year: string; batch: string; rowCount: string; attachment: string }
const props = defineProps<{ file: StoredFileRow | null; refreshList: () => Promise<unknown> }>()
const open = defineModel<boolean>('open', { default: false })
const state = ref<State | null>(null), drafts = ref<Draft[]>([])
const enabled = ref(false), pending = ref(false), failure = ref(''), notice = ref('')
const reason = ref('维护文件内容分段描述')
const derived = computed(() => state.value?.parts.filter(p => p.origin === 'derived') ?? [])
const locked = computed(() => pending.value || !enabled.value || !state.value)
type Submission = ReturnType<typeof preflightParse310> & { parts: object[]; parseState: string; idempotencyKey: string; reason: string }
let attempt: { fingerprint: string; body: Submission } | null = null
const url = () => `/api/files/${props.file!.id}/segments`
function toDraft(p: Part): Draft {
  return { ...p, year: p.year === null ? '' : String(p.year), batch: p.batch === null ? '' : String(p.batch), attachment: p.attachment ?? '', rowCount: String(p.rowCount) }
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
watch(open, value => { if (value) { state.value = null; enabled.value = false; drafts.value = []; attempt = null; void load() } })
function add() {
  drafts.value.push({ titleCode: 'specialized_sme', eventKind: 'award', year: '', batch: '', attachment: '', rowCount: '0', origin: 'agent', hasConflict: false })
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
      // Preserve additional contract fields (including ranges owned by #669).
      const { origin: _origin, hasConflict: _conflict, ...fields } = p
      return { ...fields, year: integer(p.year, '内容年份', 1900, 2100), batch: integer(p.batch, '批次', 1), rowCount: integer(p.rowCount, '行数', 0) ?? 0, attachment: p.attachment || null }
    })
    const fingerprint = JSON.stringify({ parts, reason: reason.value, version: state.value.version })
    if (!attempt || attempt.fingerprint !== fingerprint) {
      const plan = await $fetch<ReturnType<typeof preflightParse310> & { parseState: string }>(url() + '/preflight', { method: 'POST', body: { expectedVersion: state.value.version } })
      attempt = { fingerprint, body: { ...plan, parts, reason: reason.value, idempotencyKey: crypto.randomUUID() } }
    }
    await $fetch(url() + '/commit', { method: 'POST', body: attempt.body })
    // Always read current state; replayed receipts can describe an older state.
    const current = await $fetch<{ state: State; writeEnabled: boolean }>(url())
    state.value = current.state; enabled.value = current.writeEnabled
    drafts.value = current.state.parts.filter(p => p.origin !== 'derived').map(toDraft)
    attempt = null
    await props.refreshList()
    notice.value = '已保存并读回当前分段，列表已刷新。来源派生段不会因撤回声明而删除。'
  } catch (error) { failure.value = `${describeFetchError(error, error instanceof Error ? error.message : '操作失败')}。草稿保留；版本冲突请重新加载。结果不确定可原稿重试，修改草稿将使用新的提交。` }
  finally { pending.value = false }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex max-h-[90dvh] flex-col sm:max-w-3xl" :show-close-button="!pending" @interact-outside="pending && $event.preventDefault()" @escape-key-down="pending && $event.preventDefault()">
      <DialogHeader>
        <DialogTitle>编辑内容分段</DialogTitle>
        <DialogDescription class="break-all">{{ file?.displayName }} · 公布年份、公布批次仍是文件级单值，在原“编辑”中维护。</DialogDescription>
      </DialogHeader>
      <div class="flex min-h-0 flex-col gap-4 overflow-y-auto">
        <p class="text-sm">每行是一个明确年份—批次组合。复核的内容年份指原认定年；未知可留空。只维护描述，保存不会更改正式事件或企业资格。</p>
        <p class="text-muted-foreground text-sm">预检仅核实当前文件身份，不读取OCR，不证明历史段的来源已核实。解析状态保持原值。</p>
        <p v-if="!enabled && state" role="status">当前只读：部署未开启浏览器写能力，无需任务令牌。</p>
        <p v-if="failure" role="alert" class="text-destructive break-words">{{ failure }}</p>
        <p v-if="notice" role="status">{{ notice }}</p>
        <Button variant="outline" :disabled="pending" @click="load">重新加载（替换草稿）</Button>
        <h3 class="font-medium">手工登记 / 旧兼容声明 · {{ drafts.length }} 段</h3>
        <fieldset v-for="(part, i) in drafts" :key="i" :disabled="locked" class="grid min-w-0 gap-3 rounded-md border p-3 sm:grid-cols-2">
          <legend class="px-1 text-sm">分段 {{ i + 1 }}{{ part.origin === 'legacy' ? ' · 旧兼容声明' : '' }}</legend>
          <div class="min-w-0"><Label :for="`segment-title-${i}`">称号</Label><Select v-model="part.titleCode"><SelectTrigger :id="`segment-title-${i}`" class="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="t in TITLE_ORDER" :key="t" :value="t">{{ TITLES[t] }}</SelectItem></SelectContent></Select></div>
          <div><Label :for="`segment-event-${i}`">事件</Label><Select v-model="part.eventKind"><SelectTrigger :id="`segment-event-${i}`" class="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="e in EVENT_ORDER" :key="e" :value="e">{{ EVENTS[e] }}</SelectItem></SelectContent></Select></div>
          <div><Label :for="`segment-year-${i}`">内容年份</Label><Input :id="`segment-year-${i}`" v-model="part.year" inputmode="numeric" placeholder="未知" /></div>
          <div><Label :for="`segment-batch-${i}`">批次</Label><Input :id="`segment-batch-${i}`" v-model="part.batch" inputmode="numeric" placeholder="未知" /></div>
          <div><Label :for="`segment-attachment-${i}`">附件</Label><Input :id="`segment-attachment-${i}`" v-model="part.attachment" placeholder="未知" /></div>
          <div><Label :for="`segment-count-${i}`">行数</Label><Input :id="`segment-count-${i}`" v-model="part.rowCount" inputmode="numeric" placeholder="0 表示未知" /></div>
          <p v-if="part.hasConflict" role="status" class="text-sm sm:col-span-2">行数与正式出处派生值冲突，保留差异待核，不是资格结论。</p>
          <Button variant="outline" @click="drafts.splice(i, 1)">撤回分段 {{ i + 1 }}</Button>
        </fieldset>
        <Button variant="outline" :disabled="locked || drafts.length >= 1000" @click="add">新增分段</Button>
        <Label for="segments-reason">维护说明</Label><Input id="segments-reason" v-model="reason" :disabled="locked" />
        <h3 class="font-medium">来源派生段（只读） · {{ derived.length }} 段</h3>
        <p class="text-muted-foreground text-sm">来自已有正式出处及事件；须通过正式事实更正流程修正，撤回手工声明不会删除它们。</p>
        <p v-for="(part, i) in derived" :key="i" class="rounded-md border p-3 text-sm break-words">{{ TITLES[part.titleCode] }} · {{ EVENTS[part.eventKind] }} · {{ part.year ?? '年份未知' }} · {{ part.batch ?? '批次未知' }} · {{ part.attachment ?? '附件未知' }} · {{ part.rowCount }} 行</p>
      </div>
      <DialogFooter><Button variant="outline" :disabled="pending" @click="open = false">关闭</Button><Button :disabled="locked" @click="save">{{ pending ? '处理中…' : '保存分段' }}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
</template>
