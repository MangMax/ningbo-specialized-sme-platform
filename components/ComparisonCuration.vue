<script setup lang="ts">
import { shallowRef, watch } from 'vue'
import type { CuratedRow } from '~~/lib/curation'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'

const props = defineProps<{ row: CuratedRow }>()
const emit = defineEmits<{ saved: [] }>()
const open = shallowRef(false)
const note = shallowRef('')
const pending = shallowRef(false)
const failure = shallowRef('')
watch(open, value => {
  if (value) { note.value = props.row.note ?? ''; failure.value = '' }
})
async function save(curated: boolean, editedNote?: string) {
  pending.value = true
  failure.value = ''
  try {
    await $fetch('/api/comparison/curated', {
      method: 'PATCH',
      body: { uscc: props.row.uscc ?? undefined, nameNorm: props.row.nameNorm,
        titleCode: props.row.titleCode, direction: props.row.direction, curated,
        ...(editedNote !== undefined ? { note: editedNote } : {}) },
    })
    open.value = false
    emit('saved')
  } catch {
    failure.value = '标注保存失败,请重试。'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="flex items-center gap-2">
      <Switch :model-value="row.curated" :disabled="pending" :aria-label="`核实 ${row.name}`" @update:model-value="save($event)" />
      <span v-if="row.curated" class="text-muted-foreground text-xs">已核实</span>
      <Dialog v-model:open="open">
        <DialogTrigger as-child>
          <Button variant="ghost" size="sm" :disabled="pending" :aria-label="`编辑 ${row.name} 备注`">{{ row.note ? '编辑备注' : '添加备注' }}</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>核实备注</DialogTitle>
            <DialogDescription>{{ row.name }} · 保存备注同时标为已核实。</DialogDescription>
          </DialogHeader>
          <Label for="curation-note">备注</Label>
          <Input id="curation-note" v-model="note" :disabled="pending" @keydown.enter.prevent="save(true, note)" />
          <Alert v-if="failure" variant="destructive"><AlertDescription>{{ failure }}</AlertDescription></Alert>
          <DialogFooter>
            <Button variant="outline" :disabled="pending" @click="open = false">取消</Button>
            <Button :disabled="pending" @click="save(true, note)">{{ pending ? '保存中…' : '保存并核实' }}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    <span v-if="row.note" class="text-xs break-words">{{ row.note }}</span>
    <span v-if="failure && !open" role="alert" class="text-destructive text-xs">{{ failure }}</span>
  </div>
</template>
