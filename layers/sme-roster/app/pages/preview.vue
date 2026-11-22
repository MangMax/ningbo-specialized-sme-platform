<script setup lang="ts">
import { computed } from 'vue'
import { ROSTER_FILES_PATH, ROSTER_LEDGER_PATH } from '#sme-roster/lib/sme-roster/routes'
import { ENTERPRISE_LIST_TITLE } from '#sme-roster/lib/labels'
import { FileDown } from '@lucide/vue'
import { describeUnsupported, fileNameOf, fileUrl, isPreviewable, resolvePreviewKind } from '#core/lib/preview'
import { isPageCapable } from '#sme-roster/lib/roster/evidence-page'
import FilePreview from '#core/app/components/preview/FilePreview.vue'
import { useSourcePdfRoute } from '#core/app/composables/useSourcePdfRoute'
import SourcePdfPreview from '#core/app/components/preview/SourcePdfPreview.vue'
import { Alert, AlertDescription, AlertTitle } from '#core/app/components/ui/alert'
import { Button } from '#core/app/components/ui/button'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '#core/app/components/ui/breadcrumb'

const route = useRoute()
const router = useRouter()
const { parsed, sourcePage, target, invalid, visible, changeView } = useSourcePdfRoute()
const file = computed(() => parsed.value.file)
const backTo = computed(() => {
  const back = parsed.value.back
  return back && router.resolve(back).matched.length ? back : ROSTER_LEDGER_PATH
})
const backLabel = computed(() => {
  const path = new URL(backTo.value, 'http://app.invalid').pathname
  if (/^\/enterprises\/\d+\/?$/.test(path)) return '企业详情'
  const names: Record<string, string> = {
    '/': ENTERPRISE_LIST_TITLE,
    '/files': '文件管理',
    [ROSTER_FILES_PATH]: '名单文件',
    [ROSTER_LEDGER_PATH]: ENTERPRISE_LIST_TITLE,
    '/ocr': '识别校对',
    '/platform-queries': '平台查询历史',
  }
  return names[path] ?? '上一页'
})
const name = computed(() => file.value ? fileNameOf(file.value) : '')
const text = computed(() => ['markdown', 'text'].includes(resolvePreviewKind(file.value)?.kind ?? ''))
const pdf = computed(() => isPageCapable(file.value))
const previewable = computed(() => file.value ? isPreviewable(file.value) : false)

useHead({ title: computed(() => (name.value ? `${name.value} · 来源预览` : '来源预览')) })
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <PageHeader class="rise-in [&_h1]:wrap-anywhere" :title="file ? name : '来源预览'">
      <template #breadcrumb>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink as-child><NuxtLink :to="backTo">{{ backLabel }}</NuxtLink></BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem><BreadcrumbPage>来源预览</BreadcrumbPage></BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </template>
      <template v-if="file && file !== name" #description>
        <span class="inline-block font-mono wrap-anywhere">{{ file }}</span>
      </template>
      <template v-if="file && previewable && !text" #actions>
        <Button as-child variant="outline" size="sm">
          <a :href="fileUrl(file)" download><FileDown aria-hidden="true" />下载原文</a>
        </Button>
      </template>
    </PageHeader>

    <Alert v-if="!file">
      <AlertTitle>未选择来源文件</AlertTitle>
      <AlertDescription>请从{{ backLabel === '上一页' ? '原页面' : backLabel }}重新打开文件。</AlertDescription>
    </Alert>

    <Alert v-else-if="!previewable">
      <AlertTitle>这份来源不支持在线预览</AlertTitle>
      <AlertDescription>{{ describeUnsupported(file) }}</AlertDescription>
    </Alert>

    <template v-else>
      <SourcePdfPreview v-if="pdf" :key="file" :file="file" :name="name" :source-page="sourcePage" :target="target" :invalid="invalid" @visible="visible" @view-change="changeView" :view="route.query.view === 'pages' ? 'pages' : 'pdf'" />
      <FilePreview v-else :hide-text-name="text" class="min-h-[60vh]" :src="fileUrl(file)" :name="name" />
    </template>
  </div>
</template>
