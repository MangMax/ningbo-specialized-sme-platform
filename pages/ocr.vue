<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { FileText, Images, Loader2, RefreshCw, Search, Upload } from '@lucide/vue'
import OcrImportDialog from '@/components/ocr/OcrImportDialog.vue'
import OcrPageRow from '@/components/ocr/OcrPageRow.vue'
import ImagePreview from '@/components/preview/ImagePreview.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { splitMarkdown } from '~~/lib/ocr-markdown'
import {
  buildWorkbenchRows,
  confirmWrittenPage,
  pageReviewState,
  pendingLabel,
  reviewBreakdown,
  workbenchCounts,
  type WorkbenchRow,
} from '~~/lib/ocr-workbench'
import { OCR_CHANNELS } from '~~/lib/labels'
import { PAGE_IMAGE_ZOOM_MIN, pageLabel } from '~~/lib/page-gallery'
import { describeFetchError } from '~~/lib/upload-register'
import type { OcrResultRow } from '~~/server/utils/ocr-result'
import type { PdfPagesState, RenderOutcome } from '~~/server/utils/pdf-pages'
import type { StoredFileRow } from '~~/server/utils/stored-files'

/**
 * **识别校对**(2026-10-15)。一份扫描 PDF 的逐页页图 ↔ 逐页 OCR 文本,
 * 在同一个屏幕上对着看、改、删、导入。
 *
 * ── 这一页解决什么 ──────────────────────────────────────────────────────
 * 票 13 把 PDF 渲染成了逐页 PNG,票 14 把识别结果按页存进了 `ocr_result`,三条通路都会写。
 * 但**人没有地方校对**:结果要么是一份几百 KB 的整份 markdown(按页标记切),
 * 要么只在 MCP / curl 那侧看得见。而「这一页识别错了」是需要**逐页**处理的活 ——
 * 所以要页面,而且要逐页。
 *
 * ── 页码只来自文件页码 / 页图清单 ────────────────────────────────────────
 * 每一行由 `buildWorkbenchRows` 合成:页号来自**源 PDF 的页数**与**票 13 的页图清单**,
 * OCR 结果只是按页号挂上去的。**不从识别出的正文里找「第 N 页」** —— 猜错一个页码,
 * 下游 `record_evidence.page` 就会静默写错,而那是「看起来确定却错」的值。
 *
 * ── 这一页改什么、不改什么 ──────────────────────────────────────────────
 * 改的只有 `ocr_result`:逐页的 markdown(含**空结果** —— 空白页也要占住页号)与
 * 按页删除。**不改**文件分类、不动页图、不删文件、不碰台账。删除只删**一页**,
 * 不给整份清空留后门(见 `server/api/ocr-results/index.delete.ts`)。
 *
 * ── 不触发外部 OCR ──────────────────────────────────────────────────────
 * 页面上没有「在线识别」按钮:调用 PaddleOCR API 要花额度、是分钟级的活,
 * 入口留在任务面(`POST /api/jobs {kind:"ocr"}`,票 19)。这一页做的是**人工那两条**:
 * 逐页校对,以及把人工在官网跑好的结果导回来。
 *
 * ── 独立评审(2026-10-15,7/10)之后改掉的 ──────────────────────────────
 * 1. **逐页导航**:一份 56 页的 PDF 实测 16774px(约 19 屏),而「哪几页还没做」正是
 *    用户唯一要回答的问题。现在文件条**吸顶**(`sticky top-14`),左栏文件卡在宽屏也吸顶,
 *    并给出「只看待校对」与「跳到下一处待校对」两个入口 —— 不滚动也能把待办的页走完。
 * 2. **三档状态**:「空结果」原先与「有文本」共用「已识别」徽章,连带把计数也算错
 *    (见 `lib/ocr-workbench.ts` 的 `pageReviewState`);现在换成有文本 / 空结果 / 未识别。
 * 3. **键盘**:确认删除时焦点落到「确认删除」,`Esc` 与「取消」等价(见 `OcrPageRow`)。
 * 4. **对照**:点页图开的是「图 + 这一页文本」并排的对照弹窗,不再是一张盖住正文的大图。
 */

/** `$fetch` 的窄化写法(与 `/files` 页同一手法)。**这个 cast 是必须的**:
 * Nuxt 把所有路由推成一张巨大的联合类型,一个页面里连着写几个 `$fetch(...)` 会让 tsc
 * 在比较路由键时爆栈(`TS2321`)。绕开推导,只在返回值上要类型。 */
const api = $fetch as unknown as <T>(
  url: string,
  opts?: {
    method?: 'GET' | 'POST' | 'DELETE' | 'PATCH'
    query?: Record<string, unknown>
    body?: unknown
  },
) => Promise<T>

interface FilesResponse {
  rows: StoredFileRow[]
  total: number
}

interface OcrListResponse {
  file: { id: number; relPath: string; filename: string; ext: string; parseState: string }
  channels: string[]
  pages: Array<{
    page: number
    engine: string
    model: string | null
    channel: string
    createdAt: string
    chars: number
    pageRelPath: string | null
    url: string | null
  }>
  count: number
}

interface WriteResponse {
  file: { id: number; relPath: string; filename: string }
  channel: string
  source: 'jsonl' | 'markdown'
  written: number
  pages: number[]
  pageCount: number | null
  renderedPageImages: number | null
  warning: string | null
}

interface DeleteResponse {
  file: { id: number; relPath: string; filename: string }
  page: number
  deleted: number
  remaining: number
}

/** 页面上的一行状态条:`tone` 决定用哪种语气说,消息之外不再有别的状态。 */
interface StatusLine {
  tone: 'ok' | 'warn' | 'error'
  message: string
}

/** 页号的紧凑写法:少则逐个列出,多则给区间 —— 12 个「第 N 页」连起来读不成句子。 */
function pageRangeLabel(pages: readonly number[]): string {
  if (!pages.length) return '无'
  if (pages.length <= 4) return pages.map(pageLabel).join('、')
  return `${pageLabel(pages[0]!)}–${pageLabel(pages[pages.length - 1]!)}`
}

// ---------------------------------------------------------------------------
// 左栏:选一份 PDF
// ---------------------------------------------------------------------------

const keyword = ref('')
const files = ref<StoredFileRow[]>([])
const filesLoading = ref(true)
const filesError = ref('')

/** 只列 PDF —— 这一页只对扫描件有意义(OCR 结果也只挂 PDF,见写入路由的 415)。 */
const pdfFiles = computed(() => files.value.filter((f) => f.ext === 'pdf'))

async function loadFiles() {
  filesLoading.value = true
  filesError.value = ''
  try {
    const out = await api<FilesResponse>('/api/files', {
      query: { q: keyword.value || undefined, pageSize: 200 },
    })
    files.value = out.rows
  } catch (error) {
    filesError.value = describeFetchError(error, '读不到文件列表。')
  } finally {
    filesLoading.value = false
  }
}

// 搜索防抖:每敲一个字就查一次会把列表刷成幻灯片(与 `/files` 页同一节奏)。
watchDebounced(keyword, () => void loadFiles(), { debounce: 250 })
void loadFiles()

const selectedPath = ref('')
const selected = computed(() => pdfFiles.value.find((f) => f.relPath === selectedPath.value) ?? null)

// ---------------------------------------------------------------------------
// 右栏:这一份 PDF 的页图 + OCR 结果
// ---------------------------------------------------------------------------

const pagesState = ref<PdfPagesState | null>(null)
const results = ref<OcrResultRow[]>([])
const detailLoading = ref(false)
const detailError = ref('')
const rendering = ref(false)
const status = ref<StatusLine | null>(null)

/**
 * 行 = 页码为骨、页图与结果挂在上面。
 *
 * `pageCount` 优先取**源页数**(`pagesState.pageCount`):一份还没渲染的 PDF 也应当
 * 逐页列出来,让人能先把文本贴进去,不必先渲染。
 */
const rows = computed<WorkbenchRow[]>(() =>
  buildWorkbenchRows({
    pageCount: pagesState.value?.pageCount ?? null,
    images: pagesState.value?.pages ?? [],
    results: results.value,
  }),
)

const counts = computed(() => workbenchCounts(rows.value))
const pageCount = computed(() => pagesState.value?.pageCount ?? null)
const renderedCount = computed(() => pagesState.value?.rendered ?? 0)
const pageNumbers = computed(() => rows.value.map((r) => r.page))

/** 「只看待校对」:一件活有 19 份 PDF、几十页一份,「哪几页还没做」是唯一要回答的问题。 */
const onlyPending = ref(false)
const visibleRows = computed(() =>
  onlyPending.value ? rows.value.filter((r) => pageReviewState(r.result) === 'none') : rows.value,
)

/** 上一次跳到过哪一页。`null` = 还没跳过,第一跳按**位置**挑。 */
const pendingCursor = ref<number | null>(null)

/**
 * 跳到下一处待校对。
 *
 * 两段判据,缺一不可:
 *  1. **第一跳按位置** —— 找第一个还在吸顶条之下的待校对页,这样它跳的是「我现在还没看
 *     到的那一页」,而不是从头开始;
 *  2. **之后按页号往前走**(末尾回到第一处)。
 *
 * 只有第 1 条会坏得很隐蔽:一份**每一页都待校对**的文件(还没渲染的那种)上,第 1 页
 * 本身就在吸顶条之下,于是每一跳都重新选中第 1 页 —— 按钮看起来点了、页也滚了,
 * 但永远停在开头(实测 56 页的文件上,连点两次 `scrollY` 都是 75)。所以第二段必须
 * 记住上一次跳到哪儿,由它来推进。
 */
function jumpToNextPending() {
  const pending = rows.value.filter((r) => pageReviewState(r.result) === 'none').map((r) => r.page)
  if (!pending.length) return
  const from = pendingCursor.value
  const next =
    from === null
      ? (pending.find((page) => {
          const el = document.getElementById(`ocr-row-${page}`)
          // 顶部两条吸顶(56 的顶栏 + 文件条)之下的位置才算「看得见」。
          return el ? el.getBoundingClientRect().top > 130 : true
        }) ?? pending[0]!)
      : (pending.find((page) => page > from) ?? pending[0]!)
  pendingCursor.value = next
  document.getElementById(`ocr-row-${next}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** 页图地址的版本号(清单的渲染时间):换了 DPI 后别拿浏览器缓存里的旧图。 */
const imageVersion = computed(() => pagesState.value?.manifest?.renderedAt ?? null)

/**
 * 正在对照看的那一页。**做成「图 + 这一页文本」并排的弹窗**,而不是一张盖住正文的大图 ——
 * 校对的全部意义就是「图对着文本看」,弹窗一盖,眼睛就得在弹窗与行之间来回跳。
 */
const previewPage = ref<number | null>(null)
const previewRow = computed(() => rows.value.find((r) => r.page === previewPage.value) ?? null)

const previewSrc = computed(() => {
  const url = previewRow.value?.image?.url
  if (!url) return ''
  return imageVersion.value ? `${url}?v=${encodeURIComponent(imageVersion.value)}` : url
})

const previewMeta = computed(() => {
  const r = previewRow.value?.result
  if (!r) return ''
  return [OCR_CHANNELS[r.channel] ?? r.channel, r.model ?? r.engine].filter(Boolean).join(' · ')
})

/** 刚写入成功的那一页 —— 让「变的是这一行」落在那一行上,而不是只在右上角说一句。 */
const justSaved = ref<number | null>(null)
let justSavedTimer: ReturnType<typeof setTimeout> | null = null

function flashSaved(page: number) {
  justSaved.value = page
  if (justSavedTimer) clearTimeout(justSavedTimer)
  justSavedTimer = setTimeout(() => {
    justSaved.value = null
  }, 1600)
}

/**
 * 取这一份文件的 OCR 结果。
 *
 * **两次请求**,因为接口是刻意分成两半的(票 14 的设计):`GET /api/ocr-results` 给
 * 逐页**元数据**(通路 / 引擎 / 时间 / 字符数),`GET /api/ocr-results/markdown` 给**正文**。
 * 元数据是「每次打开都要看一眼」的轻量问题,正文是几百 KB —— 合成一个接口会让轻的那个
 * 也得拖几百 KB。这里两个都要,所以两个都取,但**各取一份**,不是逐页 N 次。
 *
 * 正文那一份用 `splitMarkdown` 切回按页 —— 与导出用的是同一套规则
 * (`assembleMarkdown` 的逆),所以「导出的文件再传回来」与「页面看到的」永远一致。
 */
async function fetchResults(relPath: string): Promise<OcrResultRow[]> {
  const meta = await api<OcrListResponse>('/api/ocr-results', { query: { file: relPath } })
  if (meta.count === 0) return []

  let markdownByPage = new Map<number, string>()
  try {
    const text = await api<string>('/api/ocr-results/markdown', { query: { file: relPath } })
    const split = splitMarkdown(text)
    // 切不开也不该把已有结果藏起来:照常列元数据,正文显示为空。
    // (服务端组装出来的正文切不开是 bug,但那属于「正文那一半坏了」,
    //  不该连带把「哪几页识别过」这件事也一起弄丢 —— 那会让页面看起来像空的。)
    if (split.ok) markdownByPage = new Map(split.pages.map((p) => [p.page, p.markdown]))
  } catch {
    // 整份还没结果时接口回 404 —— 那与「一页都没有」是同一件事,照常往下走。
  }

  return meta.pages.map((p) => ({
    page: p.page,
    markdown: markdownByPage.get(p.page) ?? '',
    pageRelPath: p.pageRelPath,
    engine: p.engine,
    model: p.model,
    channel: p.channel,
    createdAt: p.createdAt,
  }))
}

async function loadDetail(relPath: string) {
  detailLoading.value = true
  detailError.value = ''
  status.value = null
  try {
    const [state, ocr] = await Promise.all([
      api<PdfPagesState>('/api/pdf-pages', { query: { file: relPath } }),
      fetchResults(relPath),
    ])
    pagesState.value = state
    results.value = ocr
  } catch (error) {
    pagesState.value = null
    results.value = []
    detailError.value = describeFetchError(error, '读不到这份文件的页图与识别结果。')
  } finally {
    detailLoading.value = false
  }
}

/** 只重取结果那一半(保存 / 删除 / 导入之后)—— 页图清单没变,不必重算。 */
async function reloadResults(relPath: string) {
  results.value = await fetchResults(relPath)
}

watch(selectedPath, (next) => {
  pagesState.value = null
  results.value = []
  status.value = null
  previewPage.value = null
  onlyPending.value = false
  pendingCursor.value = null
  if (next) void loadDetail(next)
})

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/** 哪一行正在飞(保存 / 删除)。同一时刻只允许一个动作 —— 一次点两页会撞在同一份状态上。 */
const pendingPage = ref<number | null>(null)
const rowFailure = ref<{ page: number; message: string } | null>(null)

async function savePage(page: number, markdown: string) {
  const relPath = selectedPath.value
  if (!relPath || pendingPage.value !== null) return
  pendingPage.value = page
  rowFailure.value = null
  try {
    await api<WriteResponse>('/api/ocr-results', {
      method: 'POST',
      // 单页写入:显式给 `page`,所以正文里**不要**带页标记(服务端会拒两种语义打架)。
      body: { file: relPath, markdown, page },
    })
    await reloadResults(relPath)
    // **读回核对**:落库会做归一(去掉行尾空白与首尾空行),所以提交与读回的比较
    // 走同一份归一规则 —— 归一不算失败,真丢了内容才算。
    const got = results.value.find((r) => r.page === page) ?? null
    const check = confirmWrittenPage(markdown, got?.markdown ?? null)
    status.value = {
      tone: check.ok ? 'ok' : 'warn',
      message: `${pageLabel(page)}保存完成:${check.message}`,
    }
    if (check.ok) flashSaved(page)
    else rowFailure.value = { page, message: check.message }
  } catch (error) {
    rowFailure.value = { page, message: describeFetchError(error, '保存失败,请重试。') }
  } finally {
    pendingPage.value = null
  }
}

async function removePage(page: number) {
  const relPath = selectedPath.value
  if (!relPath || pendingPage.value !== null) return
  pendingPage.value = page
  rowFailure.value = null
  try {
    const out = await api<DeleteResponse>('/api/ocr-results', {
      method: 'DELETE',
      query: { file: relPath, page },
    })
    await reloadResults(relPath)
    status.value = {
      tone: 'ok',
      message:
        out.deleted === 0
          ? `${pageLabel(page)}本来就没有识别结果,无需删除。`
          : `已删除${pageLabel(page)}的识别结果;这份文件还剩 ${out.remaining} 页有结果。`,
    }
    // 只看待校对时删掉一行,那一行会从列表里消失 —— 把弹窗 / 对照收掉,别停在已不在的页上。
    if (previewPage.value === page) previewPage.value = null
  } catch (error) {
    rowFailure.value = { page, message: describeFetchError(error, '删除失败,请重试。') }
  } finally {
    pendingPage.value = null
  }
}

/**
 * 重新渲染页图。**幂等**:源内容与分辨率都没变时服务端一个字节都不写
 * (见 `server/utils/pdf-pages.ts` 的清单判据)。
 */
async function renderPageImages() {
  const relPath = selectedPath.value
  if (!relPath || rendering.value) return
  rendering.value = true
  status.value = null
  try {
    const out = await api<RenderOutcome>('/api/pdf-pages', { method: 'POST', body: { file: relPath } })
    pagesState.value = out
    status.value = {
      tone: 'ok',
      message:
        out.written === 0
          ? `页图已是最新,未写入(跳过 ${out.skipped} 页)。`
          : `已渲染 ${out.written} 页页图。`,
    }
  } catch (error) {
    status.value = { tone: 'error', message: describeFetchError(error, '渲染失败。') }
  } finally {
    rendering.value = false
  }
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

const importOpen = ref(false)
const importPending = ref(false)
const importFailure = ref('')
const importResult = ref('')

async function runImport(payload: { jsonl: string } | { markdown: string; page: number | null }) {
  const relPath = selectedPath.value
  if (!relPath || importPending.value) return
  importPending.value = true
  importFailure.value = ''
  importResult.value = ''
  try {
    const out = await api<WriteResponse>('/api/ocr-results', {
      method: 'POST',
      body: { file: relPath, ...payload },
    })
    await reloadResults(relPath)

    // **读回确认**:报回来的每一页都必须真的读得到。整份(JSONL / 带标记的 markdown)
    // 的正文在服务端解,本地没有逐页原文可比,所以核对到「页数一致且每页都在」;
    // 单页 markdown 有原文,连**内容**一起核。
    const missing = out.pages.filter((p) => !results.value.some((r) => r.page === p))
    const singlePage =
      'markdown' in payload && payload.page !== null
        ? { text: payload.markdown, page: payload.page }
        : null
    const contentCheck = singlePage
      ? confirmWrittenPage(
          singlePage.text,
          results.value.find((r) => r.page === singlePage.page)?.markdown ?? null,
        )
      : null

    const parts = [`已写入 ${out.written} 页(${pageRangeLabel(out.pages)})`]
    if (missing.length) parts.push(`读回时第 ${missing.join('、')} 页不在库里,请刷新核对`)
    else if (contentCheck && !contentCheck.ok) parts.push(contentCheck.message)
    else parts.push('读回一致')
    if (out.warning) parts.push(out.warning)

    const clean = !missing.length && (!contentCheck || contentCheck.ok)
    importResult.value = parts.join(' · ')
    // 结论同时留在页面的状态条上:弹窗一关,「读回了什么」还要看得见。
    status.value = { tone: clean ? 'ok' : 'warn', message: `导入完成:${importResult.value}` }
    // 全绿才关弹窗:有疑问时留着,让人对着那句话决定下一步。
    if (clean) importOpen.value = false
  } catch (error) {
    importFailure.value = describeFetchError(error, '导入失败,请重试。')
  } finally {
    importPending.value = false
  }
}

// ---------------------------------------------------------------------------
// 刷新
// ---------------------------------------------------------------------------

async function refreshAll() {
  await loadFiles()
  // 选中的文件可能已不在列表里(被移出库)—— 那时清空右栏,不显示一份已经不存在的文件。
  if (selectedPath.value && !pdfFiles.value.some((f) => f.relPath === selectedPath.value)) {
    selectedPath.value = ''
    pagesState.value = null
    results.value = []
    status.value = null
    return
  }
  if (selectedPath.value) await loadDetail(selectedPath.value)
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <PageHeader
      class="rise-in"
      style="--rise-index: 0"
      title="识别校对"
      description="逐页对着页图核对 OCR 文本。"
    >
      <template #actions>
        <Button variant="outline" size="sm" :disabled="detailLoading" @click="refreshAll">
          <RefreshCw />
          刷新
        </Button>
      </template>
    </PageHeader>

    <!-- `grid-cols-1` 与 `lg:` 那条**都要写**:只写 `lg:` 时,窄屏下这个网格没有显式列,
         隐式列是 `auto`(按内容撑),而左栏文件名用了 `truncate`(`white-space: nowrap`)
         —— 它的 min-content 就是整个文件名的宽度,于是卡片撑到 572px、整页横向溢出
         (390px 视口实测 scrollWidth 588)。`grid-cols-1` 是 `minmax(0, 1fr)`,下限 0,
         列才会跟着容器收。 -->
    <div class="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
      <!-- 左栏:选文件。宽屏**吸顶** —— 翻到第 40 页还能换文件,不必滚回顶部
           (一份 56 页的 PDF 实测 16774px)。 -->
      <Card class="rise-in h-fit lg:sticky lg:top-20" style="--rise-index: 1">
        <CardHeader>
          <CardTitle class="text-sm">选择 PDF</CardTitle>
        </CardHeader>
        <CardContent class="flex flex-col gap-2">
          <div class="relative">
            <Search
              class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
            />
            <Input
              v-model="keyword"
              class="pl-8"
              type="search"
              aria-label="按文件名搜索"
              placeholder="搜索文件名"
            />
          </div>

          <div v-if="filesLoading" class="flex flex-col gap-1.5">
            <Skeleton v-for="i in 5" :key="i" class="h-8 w-full" />
          </div>

          <Alert v-else-if="filesError" variant="destructive">
            <AlertDescription class="text-destructive! font-medium">{{ filesError }}</AlertDescription>
          </Alert>

          <p v-else-if="!pdfFiles.length" class="text-muted-foreground text-xs leading-relaxed">
            没有匹配的 PDF。文件库里只登记了非 PDF 时,这一页没有可校对的扫描件。
          </p>

          <!-- 列表用一排按钮而不是表格:每行只有一个动作(选中),表格的列在这里没有信息。 -->
          <ul v-else class="flex max-h-[26rem] flex-col gap-0.5 overflow-auto">
            <li v-for="file in pdfFiles" :key="file.id">
              <button
                type="button"
                class="hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-ring/50 w-full truncate rounded-sm px-2 py-1.5 text-left text-xs transition-colors focus-visible:ring-3 focus-visible:outline-none"
                :class="
                  file.relPath === selectedPath
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground'
                "
                :aria-current="file.relPath === selectedPath ? 'true' : undefined"
                :title="file.filename"
                @click="selectedPath = file.relPath"
              >
                {{ file.filename }}
              </button>
            </li>
          </ul>
        </CardContent>
      </Card>

      <!-- 右栏:逐页校对。 -->
      <div class="flex min-w-0 flex-col gap-3">
        <Empty v-if="!selectedPath" class="rise-in bg-card rounded-lg border py-12" style="--rise-index: 2">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Images /></EmptyMedia>
            <EmptyTitle>先选一份 PDF</EmptyTitle>
          </EmptyHeader>
        </Empty>

        <template v-else>
          <!-- 文件条**吸顶**:翻到几十页之后,当前是哪一份、还剩几页要校对、导入入口
               都还在视野里。`top-14` 让开顶栏(布局里那条 `sticky top-0 z-30`)。 -->
          <div
            class="rise-in bg-card sticky top-14 z-20 flex flex-col gap-x-3 gap-y-2 rounded-lg border px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center"
            style="--rise-index: 2"
          >
            <span class="min-w-0 truncate text-sm font-medium sm:flex-1" :title="selected?.filename">
              {{ selected?.filename ?? selectedPath }}
            </span>

            <span class="flex flex-wrap items-center gap-x-3 gap-y-2">
              <!-- 「待校对」是这一页唯一要用户**去动**的数字,单独成标;
                   「有文本 / 空结果」是陈述,跟在后面用次级文字说。
                   原先「共 N 页」「页图 N 张」两个 chip 与它说的是同一批数,按评审删掉。 -->
              <Badge :variant="counts.none ? 'dashed' : 'solid'">{{ pendingLabel(counts) }}</Badge>
              <span class="text-muted-foreground text-xs tabular-nums">
                {{ reviewBreakdown(counts) }}
              </span>

              <span class="flex items-center gap-1.5">
                <Checkbox
                  id="ocr-only-pending"
                  :model-value="onlyPending"
                  @update:model-value="(v: boolean | 'indeterminate') => (onlyPending = v === true)"
                />
                <Label for="ocr-only-pending" class="cursor-pointer text-xs font-normal">
                  只看待校对
                </Label>
              </span>

              <Button
                v-if="!onlyPending && counts.none > 0"
                variant="outline"
                size="sm"
                @click="jumpToNextPending"
              >
                下一处待校对
              </Button>

              <span class="flex items-center gap-2">
                <Button
                  v-if="renderedCount < (pageCount ?? 0) || renderedCount === 0"
                  variant="outline"
                  size="sm"
                  :disabled="rendering"
                  @click="renderPageImages"
                >
                  <Loader2 v-if="rendering" class="animate-spin" />
                  {{ rendering ? '渲染中…' : '渲染页图' }}
                </Button>
                <Button size="sm" @click="importOpen = true">
                  <Upload />
                  导入结果
                </Button>
              </span>
            </span>
          </div>

          <!-- 状态条:`Alert` 自带 `role="alert"`(隐式 `aria-live="assertive"`),
               所以读屏会在动作完成后念出这句话 —— 行内只是换了几个字,不足以当反馈。 -->
          <Alert v-if="status" :variant="status.tone === 'error' ? 'destructive' : 'default'">
            <AlertDescription
              :class="status.tone === 'error' ? 'text-destructive! font-medium' : ''"
            >
              {{ status.message }}
            </AlertDescription>
          </Alert>

          <Alert v-if="detailError" variant="destructive">
            <AlertDescription class="text-destructive! font-medium">{{ detailError }}</AlertDescription>
          </Alert>

          <div v-if="detailLoading" class="flex flex-col gap-2">
            <Skeleton v-for="i in 3" :key="i" class="h-24 w-full" />
          </div>

          <Empty
            v-else-if="!rows.length && !detailError"
            class="bg-card rounded-lg border py-12"
          >
            <EmptyHeader>
              <EmptyMedia variant="icon"><FileText /></EmptyMedia>
              <EmptyTitle>这一页还没有可校对的内容</EmptyTitle>
              <EmptyDescription>
                读不到这份 PDF 的页数(文件可能已损坏或被移走),所以列不出页码。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>

          <!-- 「只看待校对」把要做的页挑出来之后,可能一页不剩(也可能这份文件本来就没有)。 -->
          <Empty v-else-if="!visibleRows.length" class="bg-card rounded-lg border py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon"><FileText /></EmptyMedia>
              <EmptyTitle>没有待校对的页</EmptyTitle>
              <EmptyDescription>这份文件的每一页都有识别结果了。</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" size="sm" @click="onlyPending = false">看全部页</Button>
          </Empty>

          <ul v-else class="flex flex-col gap-2" role="list">
            <!-- `rise-in` 接在页头那三块之后(0/1/2),逐行递增 35ms。
                 **只给前 7 行**:97 页的文件若每行都带上,末行要等 3.4 s 才出现 ——
                 出场动效是交代「读好了」,不是让人等着看动画;第 8 行起直接到位,
                 也就不会出现「四十几个卡同时打闪」那一幕。 -->
            <OcrPageRow
              v-for="(row, index) in visibleRows"
              :id="`ocr-row-${row.page}`"
              :key="row.page"
              :class="['scroll-mt-32', index <= 6 ? 'rise-in' : '']"
              :style="index <= 6 ? { '--rise-index': Math.min(index, 6) + 3 } : undefined"
              :row="row"
              :image-version="imageVersion"
              :pending="pendingPage === row.page"
              :failure="rowFailure?.page === row.page ? rowFailure.message : ''"
              :highlight="justSaved === row.page"
              @save="savePage"
              @remove="removePage"
              @preview="previewPage = $event"
            />
          </ul>
        </template>
      </div>
    </div>

    <OcrImportDialog
      v-model:open="importOpen"
      :filename="selected?.filename ?? ''"
      :page-numbers="pageNumbers"
      :page-count="pageCount"
      :pending="importPending"
      :failure="importFailure"
      :result="importResult"
      @submit="runImport"
    />

    <!-- 对照弹窗:**左页图、右这一页的文本**,一屏内对着看。
         不是「一张盖住正文的大图」—— 校对的全部意义就是图对着文本看,盖住正文等于让人
         在弹窗与行之间来回跳。文本在这里是**只读**的:改写走行内那一套(保存 / 删除 /
         二次确认都在那儿),免得同一件事有两个入口。 -->
    <Dialog :open="previewPage !== null" @update:open="(v: boolean) => !v && (previewPage = null)">
      <DialogContent
        class="flex h-[92vh] w-[96vw] flex-col border-0 bg-transparent p-0 shadow-none sm:max-w-[min(1500px,96vw)] [&_[data-slot=dialog-close]]:top-2 [&_[data-slot=dialog-close]]:z-10 [&_[role=toolbar]]:pr-10"
      >
        <DialogTitle class="sr-only">
          {{ previewPage === null ? '' : `${selected?.filename ?? ''}${pageLabel(previewPage)}` }}
        </DialogTitle>
        <DialogDescription class="sr-only">
          左边是这一页的页图,右边是它的识别文本(只读)。按 Esc 或点右上角关闭。
        </DialogDescription>

        <div class="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
          <ImagePreview
            v-if="previewSrc"
            class="min-h-0"
            :src="previewSrc"
            :name="previewPage === null ? '' : pageLabel(previewPage)"
            hide-kind-label
            :zoom-min="PAGE_IMAGE_ZOOM_MIN"
          />
          <div class="bg-card flex min-h-0 flex-col gap-2 overflow-hidden rounded-lg border p-3">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge :variant="previewRow?.result ? 'solid' : 'dashed'">
                {{ previewRow?.result ? '有文本' : (previewRow?.image ? '未识别' : '未渲染') }}
              </Badge>
              <span v-if="previewMeta" class="text-muted-foreground text-xs">{{ previewMeta }}</span>
            </div>
            <pre
              v-if="previewRow?.result?.markdown"
              class="min-h-0 flex-1 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap"
            >{{ previewRow.result.markdown }}</pre>
            <p v-else class="text-muted-foreground text-xs leading-relaxed">
              这一页还没有识别文本。关掉之后在列表里点「手工录入」可以贴进来。
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
