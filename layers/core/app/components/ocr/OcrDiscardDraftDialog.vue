<script setup lang="ts">
import { Button } from '#core/app/components/ui/button'
import ModalDialog from '#core/app/components/ModalDialog.vue'

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
  <ModalDialog
    :open="open"
    title="放弃未保存的校对？"
    :description="`第 ${currentPage ?? 1} 页还有未保存的修改。放弃后这次编辑的内容会被丢弃，且无法撤销。`"
    size="sm"
    @update:open="emit('update:open', $event)"
    @close-auto-focus.prevent
  >
    <template #footer>
      <Button variant="outline" @click="emit('keep')">继续编辑</Button>
      <Button variant="destructive" @click="emit('discard')">放弃草稿</Button>
    </template>
  </ModalDialog>
</template>
