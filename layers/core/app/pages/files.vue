<script setup lang="ts">
import FileLibrary from '#core/app/components/files/FileLibrary.vue'
import FileLibraryUploadDialog from '#core/app/components/files/FileLibraryUploadDialog.vue'

useHead({ title: '文件管理' })
</script>

<template>
  <FileLibrary title="文件管理" endpoint="/api/file-library" :upload-dialog="FileLibraryUploadDialog" allow-removal />
</template>
