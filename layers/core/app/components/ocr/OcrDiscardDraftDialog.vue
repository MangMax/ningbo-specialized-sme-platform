<script setup lang="ts">
import { Button } from '#core/app/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '#core/app/components/ui/dialog'

defineProps<{ open: boolean; currentPage: number | null }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  keep: []
  discard: []
}>()
</script>

<template>
  <!-- Discarding a dirty draft is the only destructive exit from editing:
       without this dialog both 取消 and Esc used to drop the page silently. -->
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-md" @close-auto-focus.prevent>
      <div class="flex flex-col gap-1.5">
        <DialogTitle>放弃未保存的校对？</DialogTitle>
        <DialogDescription class="text-table leading-relaxed">
          第 {{ currentPage ?? 1 }} 页还有未保存的修改。放弃后这次编辑的内容会被丢弃，且无法撤销。
        </DialogDescription>
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <Button variant="outline" @click="emit('keep')">继续编辑</Button>
        <Button variant="destructive" @click="emit('discard')">放弃草稿</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
