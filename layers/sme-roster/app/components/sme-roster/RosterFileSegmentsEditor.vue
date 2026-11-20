<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import type { infer as Infer } from 'zod'
import { Button } from '#core/app/components/ui/button'
import { Input } from '#core/app/components/ui/input'
import { Label } from '#core/app/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '#core/app/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '#core/app/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#core/app/components/ui/table'
import DisclosurePanel from '#core/app/components/DisclosurePanel.vue'
import RosterFileEventSync from '#sme-roster/app/components/files/FileEventSync.vue'
import { TITLES, TITLE_ORDER, EVENTS, EVENT_ORDER } from '#sme-roster/lib/labels'
import { describeFetchError } from '../../../../core/lib/file-content-status'
import type {
  getParse105,
  preflightParse310,
  parsePart105,
} from '#sme-roster/server/utils/parse-maintenance-105'
import type { StoredFileRow } from '#core/server/utils/stored-files'
import type { RosterFileFields } from '#sme-roster/server/modules/sme-roster/files'
type State = ReturnType<typeof getParse105>
type Declaration = State['declarations'][number]
type Draft = {
  declarationId?: string
  titleCode: string
  eventKind: string
  year: string
  batch: string
  attachment: string
  rowCount: string
  ranges: { start: string; end: string }[]
  rangesEdited: boolean
}
const props = defineProps<{
  file: (StoredFileRow & Partial<RosterFileFields>) | null
  refreshList: () => Promise<unknown>
}>()
const open = defineModel<boolean>('open', { default: false })
const state = ref<State | null>(null),
  drafts = ref<Draft[]>([])
const enabled = ref(false),
  pending = ref(false),
  failure = ref(''),
  notice = ref('')
const editing = ref<number | null>(null),
  deleting = ref(false),
  committed = ref(false),
  syncing = ref(false)
const stale = ref(false)
let snapshot: Draft | null = null
const active = computed(
  () =>
    editing.value !== null || pending.value || committed.value || syncing.value,
)
const locked = computed(
  () =>
    pending.value ||
    committed.value ||
    stale.value ||
    syncing.value ||
    !enabled.value ||
    !state.value,
)
type Submission = ReturnType<typeof preflightParse310> & {
  parts: Infer<typeof parsePart105>[]
  parseState: string
  idempotencyKey: string
  reason: string
}
let attempt: { fingerprint: string; body: Submission } | null = null
const url = () => `/api/files/${props.file!.id}/segments`
function toDraft(d: Declaration): Draft {
  const p = d.part
  return {
    declarationId: d.declarationId,
    titleCode: p.titleCode,
    eventKind: p.eventKind,
    year: p.year === null ? '' : String(p.year),
    batch: p.batch === null ? '' : String(p.batch),
    attachment: p.attachment ?? '',
    rowCount: String(p.rowCount),
    ranges: (d.pageRanges ?? []).map((r) => ({
      start: String(r.start),
      end: String(r.end),
    })),
    rangesEdited: false,
  }
}
function accept(result: { state: State; writeEnabled: boolean }) {
  state.value = result.state
  enabled.value = result.writeEnabled
  drafts.value = [...result.state.declarations]
    .sort(
      (a, b) =>
        a.displaySequence - b.displaySequence ||
        a.declarationId.localeCompare(b.declarationId),
    )
    .map(toDraft)
  editing.value = null
  deleting.value = false
  snapshot = null
  attempt = null
  committed.value = false
  stale.value = false
}
async function load() {
  pending.value = true
  failure.value = ''
  try {
    accept(await $fetch<{ state: State; writeEnabled: boolean }>(url()))
  } catch (error) {
    failure.value = `读取失败，当前内容保留。${describeFetchError(error, '读取失败')}`
  } finally {
    pending.value = false
  }
}
watch(
  open,
  (value) => {
    if (value && !state.value) void load()
  },
  { immediate: true },
)
function begin(i: number, remove = false) {
  if (active.value || locked.value) return
  const draft = drafts.value[i]!
  editing.value = i
  deleting.value = remove
  snapshot = { ...draft, ranges: draft.ranges.map((range) => ({ ...range })) }
  failure.value = ''
  notice.value = ''
}
function add() {
  if (active.value || locked.value) return
  drafts.value.push({
    titleCode: '',
    eventKind: '',
    year: '',
    batch: '',
    attachment: '',
    rowCount: '0',
    ranges: [],
    rangesEdited: false,
  })
  editing.value = drafts.value.length - 1
  snapshot = null
  failure.value = ''
  notice.value = ''
}
function cancel() {
  if (pending.value || committed.value) return
  if (editing.value !== null) {
    if (snapshot) drafts.value[editing.value] = snapshot
    else drafts.value.splice(editing.value, 1)
  }
  editing.value = null
  deleting.value = false
  snapshot = null
  attempt = null
  failure.value = ''
  stale.value = false
}
function integer(
  text: string,
  name: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number | null {
  if (!text.trim()) return null
  const value = Number(text)
  if (
    !/^\d+$/.test(text.trim()) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw Error(`${name}必须为 ${min}–${max} 的整数；未知请留空`)
  return value
}
const draftFingerprint = computed(() => JSON.stringify(drafts.value))
watch(draftFingerprint, () => {
  if (!pending.value && !committed.value && !stale.value) {
    failure.value = ''
    attempt = null
  }
})
async function readCommitted() {
  pending.value = true
  failure.value = ''
  try {
    const result = await $fetch<{ state: State; writeEnabled: boolean }>(url())
    accept(result)
    notice.value = '已保存并读回当前分段。'
    try {
      await props.refreshList()
    } catch {
      notice.value += '列表刷新失败，请重试刷新列表。'
    }
  } catch (error) {
    failure.value = `提交已确认，读取最新内容失败。${describeFetchError(error, '读取失败')}`
  } finally {
    pending.value = false
  }
}
async function readLatest() {
  if (editing.value === null) return
  const draft = drafts.value[editing.value]!
  const removing = deleting.value
  pending.value = true
  try {
    const result = await $fetch<{ state: State; writeEnabled: boolean }>(url())
    const declarations = result.state.declarations
    const current = declarations.find(
      (d) => d.declarationId === draft.declarationId,
    )
    if (draft.declarationId && !current)
      throw Error('此分段已被撤回，不能覆盖；请取消当前修改')
    accept(result)
    deleting.value = removing
    if (current) {
      editing.value = drafts.value.findIndex(
        (d) => d.declarationId === draft.declarationId,
      )
      snapshot = toDraft(current)
      drafts.value[editing.value] = draft
    } else {
      drafts.value.push(draft)
      editing.value = drafts.value.length - 1
    }
    failure.value = ''
    notice.value = '已读取最新版本并保留草稿，请核对后重新保存。'
  } catch (error) {
    failure.value = describeFetchError(
      error,
      error instanceof Error ? error.message : '读取失败',
    )
  } finally {
    pending.value = false
  }
}
async function save() {
  if (locked.value || editing.value === null || !state.value) return false
  pending.value = true
  failure.value = ''
  notice.value = ''
  try {
    const target = drafts.value[editing.value]!
    const parts: Submission['parts'] = state.value.declarations.map((d) => ({
      ...d.part,
      declarationId: d.declarationId,
    }))
    const index = target.declarationId
      ? state.value.declarations.findIndex(
          (d) => d.declarationId === target.declarationId,
        )
      : -1
    if (target.declarationId && index < 0)
      throw Error('声明身份不存在，草稿保留，请查看最新内容')
    if (deleting.value) parts.splice(index, 1)
    else {
      if (!target.titleCode || !target.eventKind)
        throw Error('请选择称号和事件')
      const pageRanges = target.ranges.map((r) => {
        const start = integer(r.start, '起页', 1),
          end = integer(r.end, '止页', 1)
        if (start === null || end === null || end < start)
          throw Error('请填写完整起止页，止页不得小于起页')
        return { start, end }
      })
      const part = {
        titleCode: target.titleCode,
        eventKind: target.eventKind,
        year: integer(target.year, '内容年份', 1900, 2100),
        batch: integer(target.batch, '批次', 1),
        attachment: target.attachment || null,
        rowCount: integer(target.rowCount, '行数', 0) ?? 0,
        ...(target.declarationId
          ? { declarationId: target.declarationId }
          : {}),
        ...(target.rangesEdited ? { pageRanges } : {}),
      }
      if (index < 0) parts.push(part)
      else parts[index] = part
    }
    const fingerprint = JSON.stringify({ parts, version: state.value.version })
    if (!attempt || attempt.fingerprint !== fingerprint) {
      const plan = await $fetch<
        ReturnType<typeof preflightParse310> & { parseState: string }
      >(url() + '/preflight', {
        method: 'POST',
        body: {
          expectedVersion: state.value.version,
          ...(!deleting.value && target.rangesEdited && target.ranges.length
            ? { verifyPhysicalPages: true }
            : {}),
        },
      })
      attempt = {
        fingerprint,
        body: {
          ...plan,
          parts,
          reason: '维护文件内容分段描述',
          idempotencyKey: crypto.randomUUID(),
        },
      }
    }
    await $fetch(url() + '/commit', { method: 'POST', body: attempt.body })
    committed.value = true
    await readCommitted()
    return !committed.value
  } catch (error) {
    stale.value =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      error.statusCode === 409
    failure.value = stale.value
      ? '保存版本已过期，草稿保留。请读取最新版本后核对。'
      : `${describeFetchError(error, error instanceof Error ? error.message : '操作失败')}。当前草稿保留；结果不确定可原稿重试，修改草稿将作为新提交。`
    return false
  } finally {
    pending.value = false
  }
}
const leaveOpen = ref(false)
let leaveRequest: Promise<boolean> | null = null
let resolveLeave: ((value: boolean) => void) | null = null
function requestLeave(): Promise<boolean> {
  if (!active.value) return Promise.resolve(true)
  if (leaveRequest) return leaveRequest
  leaveOpen.value = true
  leaveRequest = new Promise((resolve) => {
    resolveLeave = resolve
  })
  return leaveRequest
}
async function leave(action: 'save' | 'discard' | 'stay') {
  let allowed = false
  if (action === 'save')
    allowed = committed.value
      ? (await readCommitted(), !committed.value)
      : await save()
  if (
    action === 'discard' &&
    !pending.value &&
    !committed.value &&
    !syncing.value
  ) {
    cancel()
    allowed = true
  }
  leaveOpen.value = false
  resolveLeave?.(allowed)
  resolveLeave = null
  leaveRequest = null
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (active.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
defineExpose({ requestLeave })
</script>
<template>
  <section
    v-if="open"
    class="min-w-0 space-y-4 text-sm"
    aria-label="文件内容分段"
  >
    <header class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 class="font-medium">
          文件内容分段 · {{ state?.registeredSummary.count ?? '…' }} 段已登记
        </h3>
        <p class="text-muted-foreground text-sm">
          文件发布：{{ file?.year ?? '年份未知' }} /
          {{ file?.batch ?? '批次未知' }}。下方登记名单内容。
        </p>
      </div>
      <Button
        variant="outline"
        :disabled="locked || active || drafts.length >= 1000"
        @click="add"
        >新增分段</Button
      >
    </header>
    <p v-if="!state && pending" role="status">正在加载分段…</p>
    <p v-if="!enabled && state" role="status">当前实例只读，未开放修改。</p>
    <p
      v-if="active && !pending && !committed"
      role="status"
      class="text-muted-foreground text-sm"
    >
      先保存或取消当前操作，再修改其他分段或同步。
    </p>
    <div
      v-if="failure"
      role="alert"
      class="text-destructive break-words text-sm"
    >
      {{ failure }}
      <Button
        v-if="committed"
        variant="outline"
        :disabled="pending"
        @click="readCommitted"
        >重试读取</Button
      >
      <Button
        v-else-if="stale"
        variant="outline"
        :disabled="pending"
        @click="readLatest"
        >读取最新版本并保留草稿</Button
      >
      <Button
        v-else-if="!state"
        variant="outline"
        :disabled="pending"
        @click="load"
        >重试读取</Button
      >
    </div>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div
      v-for="(part, i) in drafts"
      :key="part.declarationId ?? 'new-draft'"
      class="min-w-0 rounded-md border bg-background"
    >
      <div class="flex flex-wrap items-center justify-between gap-2 p-3">
        <div class="min-w-0 break-words">
          <p class="font-medium">
            {{
              part.declarationId
                ? (EVENTS[part.eventKind] ?? '事件待选')
                : '新分段'
            }}
            · {{ TITLES[part.titleCode] ?? '称号待选' }}
          </p>
          <p>
            内容年份 {{ part.year || '未知' }} · 批次 {{ part.batch || '未知' }}
          </p>
          <p class="text-muted-foreground text-sm">
            {{ part.attachment || '附件未填' }} · {{ part.rowCount }} 行 ·
            {{
              part.ranges.map((r) => `第${r.start}–${r.end}页`).join('、') ||
              '页码未登记'
            }}
          </p>
        </div>
        <div v-if="editing !== i" class="flex flex-wrap gap-2">
          <Button
            variant="outline"
            :disabled="locked || active"
            @click="begin(i)"
            >修改</Button
          ><Button
            variant="ghost"
            :disabled="locked || active"
            @click="begin(i, true)"
            >删除分段</Button
          >
        </div>
      </div>
      <div v-if="editing === i && deleting" class="space-y-3 border-t p-3">
        <p>从文件内容分段中删除？已入库企业记录不会删除。</p>
        <div class="flex gap-2">
          <Button variant="destructive" :disabled="locked" @click="save"
            >确认删除</Button
          ><Button
            variant="outline"
            :disabled="pending || committed"
            @click="cancel"
            >取消</Button
          >
        </div>
      </div>
      <fieldset
        v-if="editing === i && !deleting"
        :disabled="locked"
        class="grid min-w-0 gap-3 border-t p-3 sm:grid-cols-2"
      >
        <div class="min-w-0">
          <Label :for="`segment-title-${file?.id}-${i}`">称号</Label
          ><Select v-model="part.titleCode"
            ><SelectTrigger
              :id="`segment-title-${file?.id}-${i}`"
              class="w-full"
              ><SelectValue placeholder="请选择" /></SelectTrigger
            ><SelectContent
              ><SelectItem v-for="t in TITLE_ORDER" :key="t" :value="t">{{
                TITLES[t]
              }}</SelectItem></SelectContent
            ></Select
          >
        </div>
        <div>
          <Label :for="`segment-event-${file?.id}-${i}`">事件</Label
          ><Select v-model="part.eventKind"
            ><SelectTrigger
              :id="`segment-event-${file?.id}-${i}`"
              class="w-full"
              ><SelectValue placeholder="请选择" /></SelectTrigger
            ><SelectContent
              ><SelectItem v-for="e in EVENT_ORDER" :key="e" :value="e">{{
                EVENTS[e]
              }}</SelectItem></SelectContent
            ></Select
          >
        </div>
        <div class="grid min-w-0 grid-cols-2 gap-3 sm:col-span-2">
          <p class="col-span-2 font-medium">名单内容年份与批次（各自可未知）</p>
          <div>
            <Label :for="`segment-year-${file?.id}-${i}`">内容年份</Label
            ><Input
              :id="`segment-year-${file?.id}-${i}`"
              v-model="part.year"
              inputmode="numeric"
              placeholder="未知"
            />
          </div>
          <div>
            <Label :for="`segment-batch-${file?.id}-${i}`">内容批次</Label
            ><Input
              :id="`segment-batch-${file?.id}-${i}`"
              v-model="part.batch"
              inputmode="numeric"
              placeholder="未知"
            />
          </div>
        </div>
        <div>
          <Label :for="`segment-attachment-${file?.id}-${i}`">附件</Label
          ><Input
            :id="`segment-attachment-${file?.id}-${i}`"
            v-model="part.attachment"
            placeholder="未知"
          />
        </div>
        <div>
          <Label :for="`segment-count-${file?.id}-${i}`">行数</Label
          ><Input
            :id="`segment-count-${file?.id}-${i}`"
            v-model="part.rowCount"
            inputmode="numeric"
            placeholder="0 表示未知"
          />
        </div>
        <div class="min-w-0 space-y-2 sm:col-span-2">
          <p class="text-sm">
            物理页码范围 ·
            {{
              part.ranges.length
                ? ''
                : part.rangesEdited
                  ? '将显式清空'
                  : '未登记或已清空'
            }}
          </p>
          <div
            v-for="(range, j) in part.ranges"
            :key="j"
            class="grid min-w-0 grid-cols-2 gap-2"
          >
            <div>
              <Label :for="`range-start-${file?.id}-${i}-${j}`"
                >起页 {{ j + 1 }}</Label
              ><Input
                :id="`range-start-${file?.id}-${i}-${j}`"
                v-model="range.start"
                inputmode="numeric"
                @update:model-value="part.rangesEdited = true"
              />
            </div>
            <div>
              <Label :for="`range-end-${file?.id}-${i}-${j}`"
                >止页 {{ j + 1 }}</Label
              ><Input
                :id="`range-end-${file?.id}-${i}-${j}`"
                v-model="range.end"
                inputmode="numeric"
                @update:model-value="part.rangesEdited = true"
              />
            </div>
            <Button
              variant="outline"
              @click="
                () => {
                  part.ranges.splice(j, 1)
                  part.rangesEdited = true
                }
              "
              >移除范围 {{ j + 1 }}</Button
            >
          </div>
          <div class="flex flex-wrap gap-2">
            <Button
              variant="outline"
              :disabled="part.ranges.length >= 1000"
              @click="
                () => {
                  part.ranges.push({ start: '', end: '' })
                  part.rangesEdited = true
                }
              "
              >新增页码范围</Button
            ><Button
              variant="outline"
              @click="
                () => {
                  part.ranges = []
                  part.rangesEdited = true
                }
              "
              >清空页码范围</Button
            >
          </div>
        </div>
      </fieldset>

      <div
        v-if="editing === i && !deleting"
        class="flex flex-wrap gap-2 border-t p-3"
      >
        <Button :disabled="locked" @click="save">{{
          pending
            ? '正在保存…'
            : failure && attempt
              ? '重试保存'
              : part.declarationId
                ? '保存修改'
                : '保存分段'
        }}</Button
        ><Button
          variant="outline"
          :disabled="pending || committed"
          @click="cancel"
          >{{ part.declarationId ? '取消' : '取消新增' }}</Button
        >
      </div>
    </div>
    <p v-if="state && !drafts.length" class="py-4 text-muted-foreground">
      尚未登记文件内容分段
    </p>
    <DisclosurePanel
      v-if="state"
      title="入库情况统计"
      :description="`${state.ingestionStatistics.rowCount} 条企业记录`"
    >
      <p class="mb-3 text-muted-foreground">
        这反映企业记录的填写情况，不表示文件有几个名单段。
      </p>
      <div class="data-table-scroll" role="region" aria-label="企业记录内容分布" tabindex="0">
        <Table class="data-table"
          ><TableHeader
            ><TableRow
              ><TableHead>企业记录内容分布</TableHead
              ><TableHead>记录数</TableHead></TableRow
            ></TableHeader
          ><TableBody
            ><TableRow
              v-for="(part, i) in state.ingestionStatistics.parts"
              :key="i"
              ><TableCell class="whitespace-normal"
                >{{ TITLES[part.titleCode] }} · {{ EVENTS[part.eventKind] }} ·
                {{ part.year ?? '年份未知' }} /
                {{ part.batch ?? '批次未知' }}</TableCell
              ><TableCell>{{ part.rowCount }}</TableCell></TableRow
            ></TableBody
          ></Table
        >
      </div>
    </DisclosurePanel>
    <footer v-if="state" class="space-y-2 border-t pt-3">
      <p class="text-muted-foreground text-sm">
        保存描述不会自动修改已入库企业记录。
      </p>
      <RosterFileEventSync
        v-if="state.declarations.length"
        :file-id="file!.id"
        :disabled="active"
        @active="syncing = $event"
        @synced="refreshList()"
      />
      <p v-else class="text-muted-foreground">没有已保存分段可同步。</p>
    </footer>
    <Dialog
      :open="leaveOpen"
      @update:open="
        (value) => {
          if (!value) void leave('stay')
        }
      "
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>当前分段操作尚未完成</DialogTitle
          ><DialogDescription
            >保存后离开、放弃本次修改，或留在当前继续。提交已确认时只能重试读取。</DialogDescription
          ></DialogHeader
        ><DialogFooter
          ><Button :disabled="pending || syncing" @click="leave('save')">{{
            committed ? '重试读取后离开' : '保存后离开'
          }}</Button
          ><Button
            variant="outline"
            :disabled="pending || committed || syncing"
            @click="leave('discard')"
            >放弃修改并离开</Button
          ><Button variant="outline" @click="leave('stay')"
            >留在当前</Button
          ></DialogFooter
        ></DialogContent
      ></Dialog
    >
  </section>
</template>
