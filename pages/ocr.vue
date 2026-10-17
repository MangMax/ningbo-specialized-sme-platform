<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { FileText, FileWarning, Images, Loader2, RefreshCw, Search, Upload } from '@lucide/vue'
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
import {
  buildWorkbenchRows,
  confirmWrittenPage,
  pageReviewState,
  pendingLabel,
  reviewBreakdown,
  STATE_BADGE,
  STATE_WORD,
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
    /** 逐页正文。只有带 `markdown=1` 问的时候服务端才给 —— 见 `fetchResults`。 */
    markdown?: string
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
 * 右栏**现在显示的是哪一份文件**的数据。装载成功才写它,切文件时立刻清空。
 *
 * 它是两件事的判据:
 *  1. 异步回包该不该落地(对不上就是上一份的,丢掉);
 *  2. 一次写该写到哪儿 —— 见 `writeTarget()`。
 */
const loadedPath = ref('')

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

/**
 * 现在能不能导入。
 *
 * 判据与三个写口同一条(`writeTarget()`):右栏内容必须**已经装载完成且属于当前选中**。
 * 装载在飞(刚点选文件、正文还在路上)与「读不到这份文件的结果」这两种状态下
 * `loadedPath` 是空的 —— 此时导入**本来就发不出去**,必须让按钮**看得出不能点**,
 * 而不是点完什么也不发生(独立代码审核 R4:那两种状态恰恰是用户最想去点它的时候)。
 */
const canImport = computed(() => writeTarget() !== null)

/** 导入入口不可用时的说明(`disabled` 的按钮不会自己解释原因)。 */
const IMPORT_NOT_READY = '这份文件还没读好(或读不到结果),读到了才能导入。'

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

/** 对照弹窗那一页属于哪一档 —— 与行内共用 `pageReviewState`。 */
const previewState = computed(() => pageReviewState(previewRow.value?.result ?? null))

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
 * 读回的结果:要么是一整份逐页结果,要么是一句**说不出来就得说**的失败原因。
 *
 * 做成判别式而不是抛异常,是因为「读不到正文」与「网络断了」在界面上的说法不同:
 * 前者要把原因原样给人看(它决定用户去刷新还是去查数据),后者走 `describeFetchError`。
 */
type ResultsRead = { ok: true; rows: OcrResultRow[] } | { ok: false; message: string }

/**
 * 取这一份文件的 OCR 结果:**元数据 + 逐页正文,一次请求**。
 *
 * ── 为什么不再走「整份导出 → 按页标记反切」 ─────────────────────────────
 * 老写法拿 `GET /api/ocr-results/markdown` 的整份文本,再用 `splitMarkdown` 切回按页
 * (`assembleMarkdown` 的逆)。那条路在**页体自带整行页标记**时会坏,而且是**静默**地坏:
 * 页体里有一行 `## 第 1 页` → 整份反切报「页码重复」→ 三页全变空;
 * 页体里有一行 `<!-- page: 4 -->` → 第 3 页的正文被挂到第 4 页、第 3 页读成空。
 * 而「页体自带这种行」**真会发生**:通路 a 直写模型返回的 markdown,模型完全可能把
 * 「第 N 页」当标题输出。空正文在看板上是「空结果」,点编辑就是个空框 ——
 * 保存一下就把真实文本抹了(独立代码审核 B2,附确定性复现)。
 *
 * 现在直接问服务端要**库里的逐页那一行**(`?markdown=1`),不再拼起来又切开。
 *
 * ── 拿不到正文就不许装成「空结果」──────────────────────────────────────
 * 任何一页的正文不是字符串,整份读回算失败:`loadDetail` 会**不给行** —— 没有行就没有
 * 编辑框,也就不会出现「对着空框保存、把真实文本抹掉」那条路。
 */
async function fetchResults(relPath: string): Promise<ResultsRead> {
  const meta = await api<OcrListResponse>('/api/ocr-results', {
    query: { file: relPath, markdown: '1' },
  })
  if (meta.count === 0) return { ok: true, rows: [] }

  const missing = meta.pages.find((p) => typeof p.markdown !== 'string')
  if (missing) {
    return {
      ok: false,
      message: `这份文件的逐页正文没读回来(第 ${missing.page} 页)。为避免把正文当成空白,暂不给编辑 —— 请刷新重试。`,
    }
  }

  return {
    ok: true,
    rows: meta.pages.map((p) => ({
      page: p.page,
      markdown: p.markdown as string,
      pageRelPath: p.pageRelPath,
      engine: p.engine,
      model: p.model,
      channel: p.channel,
      createdAt: p.createdAt,
    })),
  }
}

/**
 * 装载一份文件的右栏内容。
 *
 * **目标守卫**:两个请求都在飞的时候用户可能已经换了文件,而这份回包属于**上一份**。
 * 不检查就会把它灌进新页面 —— 文件名写着 B、页图与正文却是 A,点保存就是把 A 的正文
 * 写进 B(独立代码审核 B1:跨文件静默错写,且 A、B 多为同批扫描件,肉眼难辨)。
 * 成功与失败两条路都要守:失败回包同样会把新页面清空。
 */
async function loadDetail(relPath: string) {
  detailLoading.value = true
  detailError.value = ''
  status.value = null
  try {
    const [state, read] = await Promise.all([
      api<PdfPagesState>('/api/pdf-pages', { query: { file: relPath } }),
      fetchResults(relPath),
    ])
    if (relPath !== selectedPath.value) return
    pagesState.value = state
    if (!read.ok) {
      // 页图还在(清单有用),但正文一半不可信 ⇒ **不给行**,只报错。
      results.value = []
      loadedPath.value = ''
      detailError.value = read.message
      return
    }
    results.value = read.rows
    loadedPath.value = relPath
  } catch (error) {
    if (relPath !== selectedPath.value) return
    pagesState.value = null
    results.value = []
    loadedPath.value = ''
    detailError.value = describeFetchError(error, '读不到这份文件的页图与识别结果。')
  } finally {
    // 只有仍是当前目标时才收 loading —— 否则会把「新目标那一次读」的 loading 提前关掉。
    if (relPath === selectedPath.value) detailLoading.value = false
  }
}

/**
 * 只重取结果那一半(保存 / 删除 / 导入之后)—— 页图清单没变,不必重算。
 *
 * 返回这一趟读回的逐页结果;目标已经不是这一份文件时返回 `null`(回包丢弃)。
 */
async function reloadResults(relPath: string): Promise<OcrResultRow[] | null> {
  const read = await fetchResults(relPath)
  if (relPath !== selectedPath.value) return null
  if (!read.ok) {
    results.value = []
    loadedPath.value = ''
    detailError.value = read.message
    return null
  }
  detailError.value = ''
  results.value = read.rows
  loadedPath.value = relPath
  return read.rows
}

watch(selectedPath, (next) => {
  pagesState.value = null
  results.value = []
  // 右栏现在什么都不属于了 —— 写目标随之为空,在数据回来之前点不动任何写。
  loadedPath.value = ''
  status.value = null
  previewPage.value = null
  onlyPending.value = false
  pendingCursor.value = null
  // 导入弹窗的结论属于**上一份**文件,不跟着切过去(独立代码审核 N5:
  // 在 A 上导入成功后切到 B,弹窗里还写着 A 的「已写入 12 页…」)。
  importFailure.value = ''
  importResult.value = ''
  // 行级的两个残留也属于上一份文件:`OcrPageRow` 只按**页码**认领它们
  // (`rowFailure?.page === row.page`),不清就会让 A 第 3 页的报错/高亮
  // 出现在 B 的第 3 页上(独立代码审核 R3)。
  rowFailure.value = null
  justSaved.value = null
  if (next) void loadDetail(next)
})

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/** 哪一行正在飞(保存 / 删除)。同一时刻只允许一个动作 —— 一次点两页会撞在同一份状态上。 */
const pendingPage = ref<number | null>(null)
const rowFailure = ref<{ page: number; message: string } | null>(null)

/**
 * 一次写该写到**哪一份文件**上。
 *
 * 取的是**右栏内容所属的那一份**(`loadedPath`),不是「当前选中的那一份」。
 * 两者不一致时(切换在飞)返回 `null` ⇒ 拒绝写 —— 行里的 `page` 说的是「这一行」,
 * 而这一行属于哪份文件只有 `loadedPath` 说得准(独立代码审核 B1)。
 */
function writeTarget(): string | null {
  const relPath = loadedPath.value
  if (!relPath || relPath !== selectedPath.value) return null
  return relPath
}

async function savePage(page: number, markdown: string) {
  const relPath = writeTarget()
  if (!relPath || pendingPage.value !== null) return
  pendingPage.value = page
  rowFailure.value = null
  /** 写这一段是否已经提交 —— 决定下面那句失败文案说的是「没写成」还是「写成了、读回失败」。 */
  let committed = false
  try {
    await api<WriteResponse>('/api/ocr-results', {
      method: 'POST',
      // 单页写入:显式给 `page`,所以正文里**不要**带页标记(服务端会拒两种语义打架)。
      body: { file: relPath, markdown, page },
    })
    committed = true
    const next = await reloadResults(relPath)
    if (next === null) return
    // **读回核对**:落库会做归一(去掉行尾空白与首尾空行),所以提交与读回的比较
    // 走同一份归一规则 —— 归一不算失败,真丢了内容才算。
    const got = next.find((r) => r.page === page) ?? null
    const check = confirmWrittenPage(markdown, got?.markdown ?? null)
    status.value = {
      tone: check.ok ? 'ok' : 'warn',
      message: `${pageLabel(page)}保存完成:${check.message}`,
    }
    if (check.ok) flashSaved(page)
    else rowFailure.value = { page, message: check.message }
  } catch (error) {
    // 写失败与**读回**失败分开说:读回失败时写入其实已经提交(再点一次是幂等覆盖),
    // 报成「保存失败」会让人以为白写了一遍。
    rowFailure.value = {
      page,
      message: describeFetchError(
        error,
        committed ? '写入已提交,但读回失败 —— 刷新后核对这一页。' : '保存失败,请重试。',
      ),
    }
  } finally {
    pendingPage.value = null
  }
}

async function removePage(page: number) {
  const relPath = writeTarget()
  if (!relPath || pendingPage.value !== null) return
  pendingPage.value = page
  rowFailure.value = null
  try {
    const out = await api<DeleteResponse>('/api/ocr-results', {
      method: 'DELETE',
      query: { file: relPath, page },
    })
    if ((await reloadResults(relPath)) === null) return
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
    // **同一个目标守卫**(B1 在 `loadDetail` 上用的是同一条):渲染 50 页要好几秒,
    // 期间用户完全可能切到另一份文件。晚到的回包把 `pagesState` 换成 A 的,
    // 右栏就会在 **B 的文件名下列出 A 的页数与 A 的页图** —— 校对的前提(图对着文本)
    // 当场被破坏(独立代码审核 R1)。
    //
    // **不**用「渲染在飞就冻结切换」来堵:`rendering` 算进 `writeBusy` 会让一次几秒的
    // 渲染把文件切换锁死,而丢掉一个晚到的回包本来就够了。
    if (relPath !== selectedPath.value) return
    pagesState.value = out
    status.value = {
      tone: 'ok',
      message:
        out.written === 0
          ? `页图已是最新,未写入(跳过 ${out.skipped} 页)。`
          : `已渲染 ${out.written} 页页图。`,
    }
  } catch (error) {
    // 失败回包同样守:否则「A 渲染失败」会挂在 B 的状态条上。
    if (relPath !== selectedPath.value) return
    status.value = { tone: 'error', message: describeFetchError(error, '渲染失败。') }
  } finally {
    // `rendering` 不按目标收:它答的是「有没有渲染在飞」(全局只有一次),
    // 这次渲染确实结束了;不收会让按钮永远转着。
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

/**
 * 有写在飞时**冻结文件切换**:写目标与显示内容必须始终是同一份文件。
 * (这是 B1 的第二道锁 —— 第一道是 `writeTarget()` 的不一致就拒写。)
 */
const writeBusy = computed(() => pendingPage.value !== null || importPending.value)

async function runImport(payload: { jsonl: string } | { markdown: string; page: number | null }) {
  // 正在导入时重复提交静默忽略(按钮也是 disabled 的);**读不到目标则必须说出来** ——
  // 这条路以前是「点了没反应」,而它恰恰出现在「读不到结果」那个空状态里。
  if (importPending.value) return
  const relPath = writeTarget()
  if (!relPath) {
    importFailure.value = IMPORT_NOT_READY
    return
  }
  importPending.value = true
  importFailure.value = ''
  importResult.value = ''
  try {
    const out = await api<WriteResponse>('/api/ocr-results', {
      method: 'POST',
      body: { file: relPath, ...payload },
    })
    const next = await reloadResults(relPath)
    if (next === null) {
      importFailure.value = '读回时这份文件已经不是页面上的那一份了 —— 请刷新后核对结果。'
      return
    }

    // **读回确认**:报回来的每一页都必须真的读得到。整份(JSONL / 带标记的 markdown)
    // 的正文在服务端解,本地没有逐页原文可比,所以核对到「页数一致且每页都在」;
    // 单页 markdown 有原文,连**内容**一起核。
    const missing = out.pages.filter((p) => !next.some((r) => r.page === p))
    const singlePage =
      'markdown' in payload && payload.page !== null
        ? { text: payload.markdown, page: payload.page }
        : null
    const contentCheck = singlePage
      ? confirmWrittenPage(
          singlePage.text,
          next.find((r) => r.page === singlePage.page)?.markdown ?? null,
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
    loadedPath.value = ''
    status.value = null
    return
  }
  if (selectedPath.value) await loadDetail(selectedPath.value)
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <PageHeader
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
      <Card class="h-fit lg:sticky lg:top-20">
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
                :disabled="writeBusy"
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
        <Empty v-if="!selectedPath" class="bg-card rounded-lg border py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Images /></EmptyMedia>
            <EmptyTitle>先选一份 PDF</EmptyTitle>
          </EmptyHeader>
        </Empty>

        <template v-else>
          <!-- 文件条**吸顶**:翻到几十页之后,当前是哪一份、还剩几页要校对、导入入口
               都还在视野里。`top-14` 让开顶栏(布局里那条 `sticky top-0 z-30`)。 -->
          <div
            class="bg-card sticky top-14 z-20 flex flex-col gap-x-3 gap-y-2 rounded-lg border px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center"
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
                <Button
                  size="sm"
                  :disabled="!canImport"
                  :title="canImport ? undefined : IMPORT_NOT_READY"
                  @click="importOpen = true"
                >
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

          <div v-if="detailLoading" class="flex flex-col gap-2">
            <Skeleton v-for="i in 3" :key="i" class="h-24 w-full" />
          </div>

          <!-- 读回失败(页图或**逐页正文**拿不到):**一页都不给**。
               没有行就没有编辑框,也就不会出现「对着空框保存、把真实文本抹掉」那条路
               —— 这是 B2 那条「读不到正文不许冒充空结果」的界面落点。 -->
          <Empty v-else-if="detailError" class="bg-card rounded-lg border py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon"><FileWarning /></EmptyMedia>
              <EmptyTitle>读不到这份文件的结果</EmptyTitle>
              <EmptyDescription>{{ detailError }}</EmptyDescription>
            </EmptyHeader>
            <Button
              variant="outline"
              size="sm"
              :disabled="detailLoading"
              @click="selectedPath && loadDetail(selectedPath)"
            >
              <RefreshCw />
              重试
            </Button>
          </Empty>

          <Empty v-else-if="!rows.length" class="bg-card rounded-lg border py-12">
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
            <OcrPageRow
              v-for="row in visibleRows"
              :id="`ocr-row-${row.page}`"
              :key="row.page"
              class="scroll-mt-32"
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
              <!-- 与行内**同一份判据**:弹窗曾经自己拿 `result` 真值判档,于是空结果页
                   这里标「有文本」、正下方正文却写着「还没有识别文本」—— 徽章与正文互相拆台
                   (独立代码审核 N1)。`previewState` 走 `pageReviewState`。 -->
              <Badge :variant="STATE_BADGE[previewState]">{{ STATE_WORD[previewState] }}</Badge>
              <span v-if="previewMeta" class="text-muted-foreground text-xs">{{ previewMeta }}</span>
            </div>
            <!-- 与行内同一条规则:空结果就写「(空)」,不再说「还没有识别文本」——
                 那句话属于「未识别」那一档。 -->
            <pre
              v-if="previewRow?.result"
              class="min-h-0 flex-1 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap"
            >{{ previewRow.result.markdown || '(空)' }}</pre>
            <p v-else class="text-muted-foreground text-xs leading-relaxed">
              这一页还没有识别文本。关掉之后在列表里点「手工录入」可以贴进来。
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
