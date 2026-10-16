<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed, ref, watch } from 'vue'
import { ChevronLeft, FileDown } from '@lucide/vue'
import { describeUnsupported, fileNameOf, fileUrl, isPreviewable } from '~~/lib/preview'
import {
  EVIDENCE_PAGE_WORDS,
  evidencePageState,
  isPageCapable,
  parseEvidencePreviewQuery,
} from '~~/lib/roster/evidence-page'
import FilePreview from '@/components/preview/FilePreview.vue'
import PageImageGallery from '@/components/preview/PageImageGallery.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import type { PdfPagesState } from '~~/server/utils/pdf-pages'

/**
 * `/preview?file=<相对路径>[&page=N][&back=<台账筛选串>]` —— **来源预览(RL-10 的跳转落点)**。
 *
 * ── 为什么是**页面**而不是弹窗 ──────────────────────────────────────────
 *
 * 票面要求「从名录记录打开对应来源预览并跳转到实际页」,并且「**返回**后保留原筛选与查看位置」。
 * 有「返回」就意味着**去过别处** —— 所以跳转是一次真导航:地址栏里带着 `file` 与 `page`,
 * 可分享、可收藏、可前进后退;`back` 带着台账那份完整筛选串(含 `view` / 各筛选 / 页码 / `expand`),
 * 返回时原样落回,而不是丢回一个没筛过的第一页。
 *
 * ── 页码是**PDF 实际页序**,不是序号 ────────────────────────────────────
 *
 * 定点落在 `page` 指定的那一页上(页图,由 `/api/pdf-pages` 按页给出)。**`page` 为空时
 * 不写 `page` 参数、也不回落成第 1 页** —— 序号与页码是两回事,拿序号凑一个页码,
 * 在「序号各自从 1 起算」的分节名单里会指向完全不同的企业。
 *
 * 页图**要先渲染**才取得到。没渲染时页图库会照常铺出网格并给出渲染入口(那是它本来的
 * 空态),本页在上面补一句说明,让「为什么没定位到第 N 页」当场有答案,而不是静默降级；
 * 如果目标页超过 PDF 实际页数,则明确提示页码不存在。
 */
const route = useRoute()
const applicationOrigin = useRequestURL().origin

const parsed = computed(() => parseEvidencePreviewQuery(route.query, applicationOrigin))
const file = computed(() => parsed.value.file)
const page = computed(() => parsed.value.page)
/** 返回目标:台账(或企业详情)。没有 / 不合法就回台账首页 —— 绝不把来路不明的串当路径用。 */
const backTo = computed(() => parsed.value.back || '/')

const name = computed(() => (file.value ? fileNameOf(file.value) : ''))
const pdf = computed(() => isPageCapable(file.value))
const previewable = computed(() => (file.value ? isPreviewable(file.value) : false))
/** 三态:有页码 / 页码待核(PDF 未定)/ 本来就没有页(Word、Excel)。 */
const pageState = computed(() => evidencePageState(file.value, page.value))

/**
 * 页图现状 —— 只为了回答一个问题:**要定位的那一页,磁盘上有没有**。
 * 有 ⇒ 页图库会直接落在单页视图;没有 ⇒ 它会铺网格并给出渲染入口,本页据此说明。
 *
 * 非 PDF 或没有 `page` 时**不发这个请求**(`enabled`),省掉一次无意义的往返。
 */
const apiGet = $fetch as unknown as <T>(url: string, opts?: { query?: Record<string, unknown> }) => Promise<T>
const { data: pagesState } = useQuery({
  key: () => ['preview-pages', file.value],
  query: () => apiGet<PdfPagesState>('/api/pdf-pages', { query: { file: file.value } }),
  enabled: () => pdf.value,
})

/** 页图库已读到的现状；同一份状态同时决定页图定位和页数提示。 */
const galleryPageState = ref<PdfPagesState | null>(null)
watch(file, () => {
  galleryPageState.value = null
})

function onPagesState(state: PdfPagesState) {
  if (state.file !== file.value) return
  galleryPageState.value = state
}

const currentPdfPageState = computed(() => {
  const galleryState = galleryPageState.value
  if (galleryState?.file === file.value) return galleryState
  const queryState = pagesState.value
  return queryState?.file === file.value ? queryState : null
})

const currentPdfPageCount = computed(() => currentPdfPageState.value?.pageCount ?? null)

const requestedPageOutOfRange = computed(
  () =>
    page.value !== null && currentPdfPageCount.value !== null && page.value > currentPdfPageCount.value,
)

const requestedPageRendered = computed(() => {
  if (page.value === null) return false
  return currentPdfPageState.value?.pages.some((p) => p.page === page.value) ?? false
})

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
          <Badge v-if="pageState === 'assigned'" variant="secondary" class="tabular-nums">
            第 {{ page }} 页
          </Badge>
          <span v-else-if="pageState === 'pending'" class="text-muted-foreground text-xs">
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
            <ChevronLeft class="size-3.5" />返回
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
      <!-- 要定位的那一页还没渲染:**说清为什么**,再让页图库给出渲染入口。不静默降级成「打开就是第一页」。 -->
      <Alert v-if="page !== null && !requestedPageRendered && currentPdfPageState">
        <AlertTitle v-if="requestedPageOutOfRange">第 {{ page }} 页不存在</AlertTitle>
        <AlertTitle v-else>第 {{ page }} 页的页图还没有渲染</AlertTitle>
        <AlertDescription v-if="requestedPageOutOfRange">
          该 PDF 共 {{ currentPdfPageCount }} 页，请检查来源页码。
        </AlertDescription>
        <AlertDescription v-else>先渲染页图；如果 PDF 中存在这一页，渲染后会自动定位。</AlertDescription>
      </Alert>

      <PageImageGallery
        v-if="pdf"
        class="min-h-[60vh]"
        :file="file"
        :page="page"
        @pages-state="onPagesState"
      />
      <FilePreview v-else class="min-h-[60vh]" :src="fileUrl(file)" :name="name" />
    </template>
  </div>
</template>
