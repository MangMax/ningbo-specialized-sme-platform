<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue'
import FileDisplayNameEditor from './FileDisplayNameEditor.vue'
import { Alert, AlertDescription } from '#core/app/components/ui/alert'
import { Button } from '#core/app/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#core/app/components/ui/dialog'
import type { FileRow } from '#core/server/utils/file-store'
import type { FileDetailDraft } from '#core/lib/core/file-categories'

const open = defineModel<boolean>('open', { default: false })
const props = withDefaults(defineProps<{
  file: FileRow | null
  panels: readonly { id: string; component: Component }[]
  pending?: boolean
  failure?: string
  namePending?: boolean
  nameFailure?: string
}>(), { pending: false, failure: '', namePending: false, nameFailure: '' })

const emit = defineEmits<{ save: [patch: Record<string, unknown>]; rename: [displayName: string] }>()
const drafts = ref<Record<string, FileDetailDraft>>({})
watch(open, value => { if (!value) drafts.value = {} })
const canSave = computed(() => !props.pending && props.panels.every(panel => drafts.value[panel.id]?.valid))
function save() {
  if (!canSave.value) return
  emit('save', Object.assign({}, ...props.panels.map(panel => drafts.value[panel.id]!.patch)))
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[90svh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>文件信息</DialogTitle>
        <DialogDescription class="break-all">
          {{ file?.filename }}
        </DialogDescription>
      </DialogHeader>

      <div class="flex min-h-0 flex-col gap-4 overflow-y-auto">
        <FileDisplayNameEditor :open="open" :file="file" :pending="namePending" :failure="nameFailure" @save="emit('rename', $event)" />
        <component
          :is="panel.component"
          v-for="panel in panels"
          :key="panel.id"
          :file="file"
          :open="open"
          :pending="pending"
          @draft="drafts[panel.id] = $event"
        />
        <!-- `!` 压过 alertVariants 给说明文字加的那层 /90(深色下只剩 4.25:1)。 -->
        <Alert v-if="failure" variant="destructive">
          <AlertDescription class="text-destructive! font-medium">{{ failure }}</AlertDescription>
        </Alert>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="pending" @click="open = false">取消</Button>
        <Button v-if="panels.length" :disabled="!canSave" @click="save">
          {{ pending ? '保存中…' : '保存' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
