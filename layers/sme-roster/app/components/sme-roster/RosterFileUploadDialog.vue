<script setup lang="ts">
import FileRegistrationDialog from '#core/app/components/files/FileRegistrationDialog.vue'
import RosterUploadPanel from '#sme-roster/app/components/upload/UploadPanel.vue'
import { toRegisterBody } from '#sme-roster/lib/upload-register'

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ registered: [] }>()
</script>

<template>
  <FileRegistrationDialog v-model:open="open" title="上传名单文件" description="选择文件并填写名单来源及类别。"
    invalid-guidance="请修正落位信息后重新加入队列。" :registration-body="toRegisterBody" @registered="emit('registered')">
    <template #default="{ onUploaded, onUploadError }">
      <RosterUploadPanel @uploaded="onUploaded" @error="onUploadError" />
    </template>
  </FileRegistrationDialog>
</template>
