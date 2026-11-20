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

// A completed transfer returns the actual collision-safe path. Retain that request for registration retries.
const props = defineProps<{
  title: string
  description: string
  invalidGuidance: string
  registrationBody: (file: Uploaded) => object
}>()
const open = defineModel<boolean>('open', { default: false })
const feedback = useToastFeedback()

const emit = defineEmits<{
  /** 一份文件已登记进库 —— 调用方据此刷新列表。 */
  (e: 'registered'): void
}>()

/** 登记失败的说明;非空时显示。一份传完但没登记上的文件,必须说清它现在在哪。 */
const failure = ref('')
/** 已经因登记失败而滞留的落位路径(它们停在磁盘上,库里还没有)。 */
const retryFiles = shallowReactive(new Map<string, Uploaded>())
const registering = ref<string[]>([])

watch(open, (value) => {
  if (!value) {
    failure.value = ''
    // Failed registration snapshots remain available when the dialog reopens.
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
    // 文件已落盘、库里没有 —— 不能假装成功,也不能把它藏起来。
    retryFiles.set(file.relPath, file)
    failure.value = describeFetchError(error, '登记失败,请重试。')
    feedback.fail('登记', `文件「${file.name}」`, failure.value, () => onUploaded(file))
  } finally { registering.value = registering.value.filter(path => path !== file.relPath) }
}

/**
 * 传字节阶段失败:队列行里已有「重试」按钮(断点续传),toast 只负责告知并指回那一行,
 * 不在 toast 上再放第二个重试入口 —— 两处重试跑同一条任务,重复点击会双倍入队。
 * `invalid`(落位信息被拒)不能续传,指引用户改声明;其余失败都能从断点续。
 */
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
