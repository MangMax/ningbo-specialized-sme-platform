<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { describeFetchError } from '~~/lib/upload-register'

const open = defineModel<boolean>('open', { default: false })
const props = withDefaults(defineProps<{
  fileId?: number
  filename: string
  relPath: string
  referenceCount?: number
  pending?: boolean
  failure?: string
}>(), { referenceCount: 0, pending: false, failure: '' })
const dialogOpen = computed({ get: () => open.value, set: value => { if (!busy.value) open.value = value } })
const emit = defineEmits<{ confirm: [deleteDisk: boolean]; changed: [] }>()
type Physical = { intent: { id: string; fileId: number; relPath: string; state: 'pending' | 'quarantined' | 'recovering' | 'recovered' } }
type Envelope = { expectedRevision: number; idempotencyKey: string; actor: string; basis: string; intentId?: string }
const deleteDisk = ref(false)
const lookupId = ref('')
const actor = ref('')
const basis = ref('')
const credential = ref('')
const busy = ref(false)
const reading = ref(false)
const error = ref('')
const physical = ref<Physical | null>(null)
const revision = ref<number | null>(null)
const ready = ref(false)
// Retain immutable commands across closing/reopening and failed reads. Credentials stay in memory only.
const commands = new Map<string, { action: 'quarantine' | 'recover'; body: Envelope }>()
const command = ref<{ action: 'quarantine' | 'recover'; body: Envelope } | null>(null)
let sequence = 0
const id = computed(() => props.fileId ?? Number(lookupId.value))
const locked = computed(() => busy.value || props.pending || reading.value)
const stateText = computed(() => physical.value ? ({ pending: '隔离待处理', quarantined: '已隔离', recovering: '恢复待处理', recovered: '已恢复' })[physical.value.intent.state] : '')
const canRecover = computed(() => physical.value && ['pending', 'quarantined'].includes(physical.value.intent.state))
const canQuarantine = computed(() => !physical.value || physical.value.intent.state === 'recovered')
const valid = computed(() => ready.value && revision.value !== null && !!actor.value.trim() && !!basis.value.trim() && !!credential.value.trim())
const requestKey = (action: string) => `${id.value}:${action}`

async function readLatest() {
  if (busy.value || !Number.isSafeInteger(id.value) || id.value <= 0) return
  const turn = ++sequence, target = id.value
  reading.value = true; ready.value = false; error.value = ''
  try {
    const maintenance = await $fetch<{ revision: number }>(`/api/files/${target}/maintenance`)
    let latest: Physical | null = null
    try { latest = await $fetch<Physical>(`/api/files/${target}/physical-recovery`) }
    catch (cause) {
      if ((cause as { statusCode?: number; status?: number }).statusCode !== 404 && (cause as { status?: number }).status !== 404) throw cause
    }
    if (turn !== sequence || target !== id.value || !open.value) return
    revision.value = maintenance.revision; physical.value = latest; ready.value = true
    const action = latest?.intent.state === 'recovering' ? 'recover' : latest?.intent.state === 'pending' ? 'quarantine' : null
    command.value = action ? commands.get(requestKey(action)) ?? null : null
  } catch (cause) {
    if (turn === sequence) error.value = `状态读取失败：${describeFetchError(cause)}。保留上次结果，请重新读取。`
  } finally { if (turn === sequence) reading.value = false }
}
watch([open, id], () => {
  ++sequence; ready.value = false; reading.value = false; physical.value = null; revision.value = null
  command.value = commands.get(requestKey('recover')) ?? commands.get(requestKey('quarantine')) ?? null
  if (open.value) { deleteDisk.value = false; void readLatest() }
  else credential.value = ''
}, { immediate: true })

async function execute(action: 'quarantine' | 'recover', retry = false) {
  if (locked.value || (!retry && !valid.value)) return
  const target = id.value
  if (!retry) {
    if (action === 'recover' && !canRecover.value) return
    if (action === 'quarantine' && (!canQuarantine.value || props.referenceCount > 0)) return
    command.value = { action, body: { expectedRevision: revision.value!, idempotencyKey: crypto.randomUUID(), actor: actor.value.trim(), basis: basis.value.trim(), ...(action === 'recover' ? { intentId: physical.value!.intent.id } : {}) } }
    commands.set(requestKey(action), command.value)
  }
  const held = command.value
  if (!held || !credential.value.trim()) return
  busy.value = true; error.value = ''; ++sequence
  try {
    await $fetch(`/api/files/${target}${held.action === 'recover' ? '/physical-recovery' : ''}`, {
      method: held.action === 'recover' ? 'POST' : 'DELETE',
      ...(held.action === 'quarantine' ? { query: { deleteDisk: '1' } } : {}),
      headers: { 'x-api-token': credential.value.trim() }, body: { ...held.body },
    })
    commands.delete(`${target}:${held.action}`)
    if (held.action === 'recover') commands.delete(`${target}:quarantine`)
    command.value = null
    emit('changed')
  } catch (cause) {
    error.value = `操作结果尚未确认：${describeFetchError(cause)}。文件可能已移动；数据库失败不会自动还原字节。请读取状态或重试原请求。`
  } finally { busy.value = false }
  const failure = error.value
  await readLatest()
  if (failure) error.value = failure + (error.value ? ` ${error.value}` : '')
  // readLatest must not discard the exact request after an uncertain response.
  command.value = commands.get(`${target}:${held.action}`) ?? command.value
}
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-md max-h-[90dvh] overflow-y-auto" @interact-outside="busy && $event.preventDefault()" @escape-key-down="busy && $event.preventDefault()">
      <DialogHeader>
        <DialogTitle>移出与恢复文件</DialogTitle>
        <DialogDescription class="break-all">{{ filename || '按原文件编号读取隔离状态并恢复同一文件。' }}</DialogDescription>
      </DialogHeader>
      <div class="flex flex-col gap-3">
        <template v-if="!fileId">
          <Label for="recovery-file">原文件编号</Label>
          <Input id="recovery-file" v-model="lookupId" :disabled="locked" inputmode="numeric" />
        </template>
        <p class="text-sm">默认只移出文件库，磁盘字节和正式出处保留。隔离会移走原路径的字节，不永久擦除；恢复须核验原字节，且不能覆盖已有路径。</p>
        <p class="break-all text-sm">{{ physical?.intent.relPath || relPath }}</p>
        <p v-if="referenceCount > 0" class="text-sm">有 {{ referenceCount }} 条正式出处引用，禁止隔离；软移出仍保留出处。</p>
        <Button variant="outline" :disabled="locked" @click="readLatest">{{ reading ? '读取中…' : '读取最新状态' }}</Button>
        <p v-if="stateText" role="status">{{ stateText }}</p>
        <p v-if="physical?.intent.state === 'pending' || physical?.intent.state === 'recovering'" class="text-sm">操作尚未完成，不能推断原路径可用。可重试保留的原请求；恢复待处理若没有原请求，请由原操作端继续处理。</p>
        <div v-if="fileId && canQuarantine" class="flex items-start gap-2">
          <Checkbox id="delete-disk" :model-value="deleteDisk" :disabled="locked || !!command || referenceCount > 0" @update:model-value="v => deleteDisk = v === true" />
          <Label for="delete-disk">同时隔离磁盘文件（可显式申请恢复）</Label>
        </div>
        <template v-if="deleteDisk || physical || command">
          <Label for="physical-actor">操作人</Label><Input id="physical-actor" v-model="actor" :disabled="locked || !!command" maxlength="200" />
          <Label for="physical-basis">操作依据</Label><Input id="physical-basis" v-model="basis" :disabled="locked || !!command" maxlength="2000" />
          <Label for="physical-token">本次操作凭证</Label><Input id="physical-token" v-model="credential" :disabled="locked" type="password" autocomplete="off" />
          <p class="text-sm text-muted-foreground">凭证只用于当前请求，不保存到浏览器存储。失败后保留原请求，重试不会新建操作。</p>
        </template>
        <Alert v-if="error || failure" variant="destructive"><AlertDescription>{{ error || failure }}</AlertDescription></Alert>
      </div>
      <DialogFooter class="flex-wrap">
        <Button variant="outline" :disabled="locked" @click="open = false">关闭</Button>
        <Button v-if="fileId && !deleteDisk && !physical && !command" :disabled="locked" @click="emit('confirm', false)">移出文件库</Button>
        <Button v-if="deleteDisk && canQuarantine && !command" variant="destructive" :disabled="locked || !valid || referenceCount > 0" @click="execute('quarantine')">确认移出并隔离</Button>
        <Button v-if="canRecover && command?.action !== 'recover'" :disabled="locked || !valid" @click="execute('recover')">确认恢复原文件</Button>
        <Button v-if="command" :disabled="locked || !credential.trim()" @click="execute(command.action, true)">重试原请求</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
