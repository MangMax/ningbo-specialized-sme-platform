<script setup lang="ts">
import { ref, watch } from 'vue'
import { Button } from '#core/app/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#core/app/components/ui/dialog'
import { Input } from '#core/app/components/ui/input'
import { Label } from '#core/app/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { describeFetchError } from '#core/lib/file-content-status'
import type { LeadRow } from '../../lib/contracts'

const props = defineProps<{ row: LeadRow | null; versionId?: number }>()
const emit = defineEmits<{ close: []; saved: [] }>()
type Enterprise = { id: number; name: string; uscc: string | null; revision: number }

const action = ref('attach'), query = ref(''), existing = ref<Enterprise[]>([]), enterpriseId = ref('')
const name = ref(''), uscc = ref(''), actor = ref(''), basis = ref(''), token = ref('')
const searching = ref(false), saving = ref(false), error = ref('')

watch(() => props.row, row => {
  action.value = 'attach'
  name.value = query.value = row?.name ?? ''
  uscc.value = row?.uscc ?? ''
  enterpriseId.value = basis.value = token.value = error.value = ''
  existing.value = []
})
async function find() {
  if (!props.row || searching.value) return
  const snapshot = props.row.id
  searching.value = true
  error.value = ''
  try {
    const response = await $fetch<{ rows: Enterprise[] }>('/api/core/enterprises', { query: { name: query.value, limit: 25 } })
    if (props.row?.id !== snapshot) return
    existing.value = response.rows
    enterpriseId.value = ''
    if (!response.rows.length) error.value = '没有匹配的在库企业。'
  } catch (cause) {
    error.value = describeFetchError(cause)
  } finally { searching.value = false }
}
async function save() {
  if (saving.value || !props.row || !props.versionId) return
  const selected = existing.value.find(item => String(item.id) === enterpriseId.value)
  const decision = action.value === 'create'
    ? { action: 'create', rowId: props.row.id, fields: { name: name.value, uscc: uscc.value.trim() || undefined } }
    : selected && { action: 'attach', rowId: props.row.id, enterpriseId: selected.id, expectedRevision: selected.revision }
  if (!decision) { error.value = '请先查询并选择已核对的企业。'; return }
  error.value = ''
  saving.value = true
  try {
    await $fetch(`/api/lead-lists/versions/${props.versionId}/supplement`, {
      method: 'POST', headers: { authorization: `Bearer ${token.value.trim()}` },
      body: { actor: { id: actor.value, type: 'user' }, basis: basis.value, decisions: [decision] },
    })
    emit('saved')
  } catch (cause) {
    error.value = describeFetchError(cause)
  } finally { saving.value = false }
}
</script>

<template>
  <Dialog :open="Boolean(row)" @update:open="value => { if (!value && !saving && !searching) emit('close') }">
    <DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>补充企业基础库</DialogTitle>
        <DialogDescription>{{ row?.name }}</DialogDescription>
      </DialogHeader>
      <form class="space-y-4" @submit.prevent="save">
        <div class="space-y-1.5"><Label for="lead-review-action">处理方式</Label>
          <Select v-model="action"><SelectTrigger id="lead-review-action" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="attach">关联已在库企业</SelectItem><SelectItem value="create">新建企业</SelectItem></SelectContent>
          </Select>
        </div>
        <div v-if="action === 'attach'" class="space-y-1.5">
          <Label for="lead-enterprise-query">企业名称</Label>
          <div class="flex items-center gap-2"><Input id="lead-enterprise-query" v-model="query" @update:model-value="enterpriseId = ''; existing = []" /><Button type="button" variant="outline" :disabled="!query.trim() || searching" @click="find">查询</Button></div>
          <Select v-model="enterpriseId">
            <SelectTrigger class="w-full" aria-label="已核对的企业"><SelectValue placeholder="选择已核对的企业" /></SelectTrigger>
            <SelectContent><SelectItem v-for="item in existing" :key="item.id" :value="String(item.id)">{{ item.name }} · {{ item.uscc || '无信用代码' }} · {{ item.id }}</SelectItem></SelectContent>
          </Select>
        </div>
        <template v-else>
          <div class="space-y-1.5"><Label for="lead-enterprise-name">企业现用名称</Label><Input id="lead-enterprise-name" v-model="name" required /></div>
          <div class="space-y-1.5"><Label for="lead-enterprise-uscc">统一社会信用代码</Label><Input id="lead-enterprise-uscc" v-model="uscc" /></div>
        </template>
        <div class="space-y-1.5"><Label for="lead-reviewer">核对人</Label><Input id="lead-reviewer" v-model="actor" required /></div>
        <div class="space-y-1.5"><Label for="lead-basis">核对依据</Label><Input id="lead-basis" v-model="basis" required /></div>
        <div class="space-y-1.5"><Label for="lead-review-token">写入令牌</Label><Input id="lead-review-token" v-model="token" type="password" autocomplete="off" required /></div>
        <p v-if="error" role="alert" class="text-destructive text-sm">{{ error }}</p>
        <DialogFooter><Button type="submit" :disabled="saving || searching">{{ saving ? '正在补充…' : '确认补充' }}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
