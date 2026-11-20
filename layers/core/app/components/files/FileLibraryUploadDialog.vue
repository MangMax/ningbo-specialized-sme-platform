<script setup lang="ts">
import FileRegistrationDialog from './FileRegistrationDialog.vue'
import FileUploadPanel from '#core/app/components/upload/FileUploadPanel.vue'
import { libraryUploadCategory, libraryUploadDirectory } from '#core/lib/core/library-uploads'
import { targetsEndpoint, type PreviousUpload } from '#core/lib/upload-transport'

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ registered: [] }>()

type LibraryMetadata = { filename: string; fileCategory: string }
const placement = {
  emptyBatchMeta: () => ({}),
  validateBatch: () => [],
  isBatchComplete: () => true,
  buildMetadata: (_batch: object, filename: string): LibraryMetadata => ({ filename, fileCategory: libraryUploadCategory }),
  landingPath: ({ filename }: LibraryMetadata) => `${libraryUploadDirectory}/${filename}`,
  metadataPayload: (metadata: LibraryMetadata) => metadata,
  resumeKey: (file: { name: string; size: number }, _batch: object, endpoint: string) =>
    JSON.stringify([libraryUploadCategory, endpoint, file.name, file.size]),
  matchPreviousUpload(history: PreviousUpload[], file: { size: number }, metadata: LibraryMetadata, endpoint: string) {
    return history.filter(candidate =>
      candidate.metadata?.fileCategory === metadata.fileCategory && candidate.metadata.filename === metadata.filename &&
      candidate.size === file.size && candidate.uploadUrl && targetsEndpoint(candidate.uploadUrl, endpoint, location.origin),
    ).sort((a, b) => Date.parse(b.creationTime) - Date.parse(a.creationTime))[0]
  },
}

function registrationBody(file: { name: string; relPath: string }) {
  return { fileCategory: libraryUploadCategory, relPath: file.relPath }
}
</script>

<template>
  <FileRegistrationDialog v-model:open="open" title="上传文件" description="选择或拖入文件，上传后会在文件管理中显示。"
    invalid-guidance="请核对文件名称后重新选择。" :registration-body="registrationBody" @registered="emit('registered')">
    <template #default="{ onUploaded, onUploadError }">
      <FileUploadPanel :placement="placement" @uploaded="onUploaded" @error="onUploadError" />
    </template>
  </FileRegistrationDialog>
</template>
