<script setup lang="ts">
import FileLibrary from '#core/app/components/files/FileLibrary.vue'
import { rosterFileCategoryUi } from '#sme-roster/lib/sme-roster/file-category-ui'

import { Button } from '#core/app/components/ui/button'
import { ROSTER_ANNOUNCEMENT_INTAKES_PATH } from '#sme-roster/lib/sme-roster/routes'

useHead({ title: '名单文件' })
</script>

<template>
  <FileLibrary title="名单文件" endpoint="/api/sme-roster/files" :category="rosterFileCategoryUi"
    :upload-dialog="rosterFileCategoryUi.uploadDialog" upload-label="上传名单文件" details-label="名单信息"
    :show-size="false">
    <template #toolbar-actions>
      <Button as-child variant="outline" size="sm">
        <NuxtLink :to="ROSTER_ANNOUNCEMENT_INTAKES_PATH">公布名单入库</NuxtLink>
      </Button>
    </template>
  </FileLibrary>
</template>
