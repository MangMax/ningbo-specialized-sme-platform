<script setup lang="ts">
import { shallowRef, watch } from 'vue'
import type { CuratedRow } from '~~/lib/curation'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'

const props = defineProps<{ row: CuratedRow; compact?: boolean }>()
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
  <div class="flex min-w-0 flex-col gap-1" :class="compact ? 'border-t border-border/50 pt-1' : ''">
    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <Switch :model-value="row.curated" :disabled="pending" :aria-label="`核实 ${row.name}`" class="shadow-none" @update:model-value="save($event)" />
      <span class="text-[13px] leading-5" :class="row.curated ? 'text-primary' : 'text-muted-foreground'">{{ row.curated ? '已核实' : '待核实' }}</span>
      <Dialog v-model:open="open">
        <DialogTrigger as-child>
          <Button variant="ghost" size="sm" class="h-7 px-2 text-[13px]" :disabled="pending" :aria-label="`编辑 ${row.name} 备注`">{{ row.note ? '编辑备注' : '备注' }}</Button>
        </DialogTrigger>
        <DialogContent class="shadow-none">
          <DialogHeader>
            <DialogTitle>核实备注</DialogTitle>
            <DialogDescription>{{ row.name }} · 保存备注同时标为已核实。</DialogDescription>
          </DialogHeader>
          <Label for="curation-note">备注</Label>
          <Textarea id="curation-note" v-model="note" :rows="3" class="resize-y shadow-none" :disabled="pending" @keydown.ctrl.enter.prevent="save(true, note)" @keydown.meta.enter.prevent="save(true, note)" />
          <Alert v-if="failure" variant="destructive"><AlertDescription>{{ failure }}</AlertDescription></Alert>
          <DialogFooter>
            <Button variant="outline" class="shadow-none" :disabled="pending" @click="open = false">取消</Button>
            <Button class="shadow-none" :disabled="pending" @click="save(true, note)">{{ pending ? '保存中…' : '保存并核实' }}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    <span v-if="row.note" class="text-muted-foreground line-clamp-2 break-words text-[13px] leading-5" :title="row.note">{{ row.note }}</span>
    <span v-if="failure && !open" role="alert" class="text-destructive text-[13px]">{{ failure }}</span>
  </div>
</template>
