<script setup lang="ts">
import { computed } from 'vue'
import { ChevronLeft, FileDown } from '@lucide/vue'
import { describeUnsupported, fileNameOf, fileUrl, isPreviewable } from '~~/lib/preview'
import {
  EVIDENCE_PAGE_WORDS,
  evidencePageState,
  isPageCapable,
} from '~~/lib/roster/evidence-page'
import FilePreview from '@/components/preview/FilePreview.vue'
import { useSourcePdfRoute } from '@/composables/useSourcePdfRoute'
import SourcePdfPreview from '@/components/preview/SourcePdfPreview.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'

const route = useRoute()
const { parsed, sourcePage, target, invalid, visible, changeView } = useSourcePdfRoute()
const file = computed(() => parsed.value.file)
const page = sourcePage
const backTo = computed(() => parsed.value.back || '/')
const backLabel = computed(() => {
  const path = new URL(backTo.value, 'http://app.invalid').pathname
  if (/^\/enterprises\/\d+\/?$/.test(path)) return '返回企业详情'
  const names: Record<string, string> = { '/': '企业列表', '/files': '文件库', '/roster': '名录记录', '/quality': '质量检查', '/stats': '统计分析', '/comparison': '企业对比', '/ocr': 'OCR 工作台', '/platform-queries': '平台查询' }
  return `返回${names[path] ?? ` ${path}`}`
})
const name = computed(() => file.value ? fileNameOf(file.value) : '')
const pdf = computed(() => isPageCapable(file.value))
const previewable = computed(() => file.value ? isPreviewable(file.value) : false)
const pageState = computed(() => evidencePageState(file.value, page.value))

useHead({ title: computed(() => (name.value ? `${name.value} · 来源预览` : '来源预览')) })
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <PageHeader class="rise-in" :title="file ? name : '来源预览'">
      <template #breadcrumb>
        <NuxtLink :to="backTo" class="hover:text-foreground hover:underline">名录台账</NuxtLink>
        <span class="mx-1.5">/</span><span>来源预览</span>
      </template>
      <template #description>
        <span class="inline-block font-mono break-all">{{ file || '(缺 file 参数)' }}</span>
      </template>
      <template #actions>
        <div class="flex items-center gap-3">
          <!-- 页码三态就在这儿说清楚:有页码 / 待核 / 这类文件本来就没有页。 -->
          <Badge v-if="!pdf && pageState === 'assigned'" variant="secondary" class="tabular-nums">
            来源第 {{ page }} 页
          </Badge>
          <span v-else-if="!pdf && pageState === 'pending'" class="text-muted-foreground text-xs">
            {{ EVIDENCE_PAGE_WORDS.pending }}
          </span>
          <a
            v-if="file && previewable"
            :href="fileUrl(file)"
            class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
            target="_blank"
            rel="noopener"
            download
          >
            <FileDown class="size-3.5" />下载原文
          </a>
          <NuxtLink
            :to="backTo"
            class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
          >
            <ChevronLeft class="size-3.5" />{{ backLabel }}
          </NuxtLink>
        </div>
      </template>
    </PageHeader>

    <Alert v-if="!file">
      <AlertTitle>缺少 file 参数</AlertTitle>
      <AlertDescription>请给来源文件路径,例如 /preview?file=…&amp;page=8。</AlertDescription>
    </Alert>

    <Alert v-else-if="!previewable">
      <AlertTitle>这份来源不支持在线预览</AlertTitle>
      <AlertDescription>{{ describeUnsupported(file) }}</AlertDescription>
    </Alert>

    <template v-else>
      <SourcePdfPreview v-if="pdf" :key="file" :file="file" :name="name" :source-page="sourcePage" :target="target" :invalid="invalid" @visible="visible" @view-change="changeView" :view="route.query.view === 'pages' ? 'pages' : 'pdf'" />
      <FilePreview v-else class="min-h-[60vh]" :src="fileUrl(file)" :name="name" />
    </template>
  </div>
</template>
