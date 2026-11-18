<script setup lang="ts">
import { ref } from 'vue'
import FileUploadPanel from '#core/app/components/upload/FileUploadPanel.vue'
import MetadataFields from './MetadataFields.vue'
import { buildMetadata, emptyBatchMeta, isBatchComplete, landingPath, matchPreviousUpload, metadataPayload, resumeKey, validateBatch } from '../../lib/upload'
import type { UploadFailure } from '../../layers/core/lib/upload-transport'
import type { UploadedFile } from '../../lib/upload-register'

defineProps<{ disabled?: boolean; endpoint?: string }>()
const emit = defineEmits<{
  uploaded: [file: UploadedFile]
  error: [failure: { name: string; failure: UploadFailure }]
}>()

const placement = { buildMetadata, emptyBatchMeta, isBatchComplete, landingPath, matchPreviousUpload, metadataPayload, resumeKey, validateBatch }
const panel = ref<{ addFiles(files: File[]): void }>()
defineExpose({ addFiles: (files: File[]) => panel.value?.addFiles(files) })
</script>

<template>
  <FileUploadPanel ref="panel" :disabled="disabled" :endpoint="endpoint" :metadata-fields="MetadataFields" :placement="placement"
    @uploaded="emit('uploaded', $event)" @error="emit('error', $event)" />
</template>
