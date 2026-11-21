<script setup lang="ts" generic="Uploaded extends { name: string; relPath: string }">
import { ref, shallowReactive, watch } from 'vue'
import { Alert, AlertDescription } from '#core/app/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#core/app/components/ui/dialog'
import { Button } from '#core/app/components/ui/button'
import { describeFetchError } from '#core/lib/file-content-status'
import type { UploadFailure } from '#core/lib/upload-transport'
import { useToastFeedback } from '#core/app/composables/useToastFeedback'

const props = defineProps<{
  title: string
  description: string
  invalidGuidance: string
  registrationBody: (file: Uploaded) => object
}>()
const open = defineModel<boolean>('open', { default: false })
const feedback = useToastFeedback()

const emit = defineEmits<{
  (e: 'registered'): void
}>()

const failure = ref('')
const retryFiles = shallowReactive(new Map<string, Uploaded>())
const registering = ref<string[]>([])

watch(open, (value) => {
  if (!value) {
    failure.value = ''
  }
})

async function onUploaded(file: Uploaded) {
  if (registering.value.includes(file.relPath)) return
  registering.value.push(file.relPath)
  failure.value = ''
  try {
    await $fetch('/api/files/register', { method: 'POST', body: props.registrationBody(file) })
    retryFiles.delete(file.relPath)
    feedback.succeed('上传', `文件「${file.name}」`)
    emit('registered')
  } catch (error) {
    retryFiles.set(file.relPath, file)
    failure.value = describeFetchError(error, '登记失败,请重试。')
    feedback.fail('登记', `文件「${file.name}」`, failure.value, () => onUploaded(file))
  } finally { registering.value = registering.value.filter(path => path !== file.relPath) }
}

function onUploadError({ name, failure: uploadFailure }: { name: string; failure: UploadFailure }) {
  const guidance = uploadFailure.kind === 'invalid'
    ? props.invalidGuidance
    : '可在下方队列中点「重试」从断点续传。'
  feedback.fail('上传', `文件「${name}」`, `${uploadFailure.message}${guidance}`)
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription class="sr-only">{{ description }}</DialogDescription>
      </DialogHeader>

      <Alert v-if="failure" variant="destructive">
        <AlertDescription>{{ failure }}</AlertDescription>
      </Alert>
      <Button v-for="file in retryFiles.values()" :key="file.relPath" variant="outline"
        class="h-auto justify-start whitespace-normal wrap-anywhere"
        :disabled="registering.includes(file.relPath)" @click="onUploaded(file)">
        重试登记 {{ file.name }}
      </Button>
      <slot :on-uploaded="onUploaded" :on-upload-error="onUploadError" />
    </DialogContent>
  </Dialog>
</template>
