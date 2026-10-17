import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useOcrNavigation } from './useOcrNavigation'
import {
  buildWorkbenchRows,
  confirmWrittenPage,
  pageReviewState,
  workbenchCounts,
  type WorkbenchRow,
} from '~~/lib/ocr-workbench'
import { OCR_CHANNELS } from '~~/lib/labels'
import { pageLabel } from '~~/lib/page-gallery'
import { describeFetchError } from '~~/lib/upload-register'
import type { OcrResultRow } from '~~/server/utils/ocr-result'
import type { PdfPagesState, RenderOutcome } from '~~/server/utils/pdf-pages'
import type { StoredFileRow } from '~~/server/utils/stored-files'

/** Existing OCR API workflow plus guarded single-page navigation. */
export function useOcrWorkbench() {
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
    file: {
      id: number
      relPath: string
      filename: string
      ext: string
      parseState: string
    }
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

  const files = ref<StoredFileRow[]>([])
  const filesLoading = ref(true)
  const filesError = ref('')

  /** 只列 PDF —— 这一页只对扫描件有意义(OCR 结果也只挂 PDF,见写入路由的 415)。 */
  const pdfFiles = computed(() => files.value.filter((f) => f.ext === 'pdf'))

  async function loadFiles() {
    filesLoading.value = true
    filesError.value = ''
    try {
      const all: StoredFileRow[] = []
      let page = 1
      while (true) {
        const out = await api<FilesResponse>('/api/files', {
          query: { pageSize: 200, page },
        })
        all.push(...out.rows)
        if (all.length >= out.total || !out.rows.length) break
        page += 1
      }
      files.value = all
    } catch (error) {
      filesError.value = describeFetchError(error, '读不到文件列表。')
    } finally {
      filesLoading.value = false
    }
  }

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

  const pendingPage = ref<number | null>(null)
  const importPending = ref(false)
  const writeBusy = computed(
    () => pendingPage.value !== null || importPending.value,
  )
  const ready = computed(() => loadedPath.value !== '' && !detailLoading.value)
  const {
    selectedPath,
    currentPage,
    currentRow,
    keyword,
    source,
    year,
    filters,
    dirty,
    notice,
    filteredRows: visibleRows,
    fileMatches,
    selectFile,
    navigate,
    setFilters,
    setFileFilter,
    blocked,
  } = useOcrNavigation({ files: pdfFiles, rows, ready, busy: writeBusy })
  const selected = computed(
    () => pdfFiles.value.find((f) => f.relPath === selectedPath.value) ?? null,
  )
  const fileYears = computed(() =>
    [
      ...new Set(
        pdfFiles.value.flatMap((f) => (f.year == null ? [] : [f.year])),
      ),
    ].sort((a, b) => b - a),
  )
  void loadFiles()

  /**
   * 现在能不能导入。
   *
   * 判据与三个写口同一条(`writeTarget()`):右栏内容必须**已经装载完成且属于当前选中**。
   * 装载在飞(刚点选文件、正文还在路上)与「读不到这份文件的结果」这两种状态下
   * `loadedPath` 是空的 —— 此时导入**本来就发不出去**,必须让按钮**看得出不能点**,
   * 而不是点完什么也不发生(独立代码审核 R4:那两种状态恰恰是用户最想去点它的时候)。
   */
  const canImport = computed(
    () => writeTarget() !== null && !dirty.value && !writeBusy.value,
  )

  /** 导入入口不可用时的说明(`disabled` 的按钮不会自己解释原因)。 */
  const IMPORT_NOT_READY = '这份文件还没读好(或读不到结果),读到了才能导入。'

  /** 页图地址的版本号(清单的渲染时间):换了 DPI 后别拿浏览器缓存里的旧图。 */
  const imageVersion = computed(
    () => pagesState.value?.manifest?.renderedAt ?? null,
  )

  /**
   * 正在对照看的那一页。**做成「图 + 这一页文本」并排的弹窗**,而不是一张盖住正文的大图 ——
   * 校对的全部意义就是「图对着文本看」,弹窗一盖,眼睛就得在弹窗与行之间来回跳。
   */
  const previewPage = ref<number | null>(null)
  const previewRow = computed(
    () => rows.value.find((r) => r.page === previewPage.value) ?? null,
  )

  const previewSrc = computed(() => {
    const url = previewRow.value?.image?.url
    if (!url) return ''
    return imageVersion.value
      ? `${url}?v=${encodeURIComponent(imageVersion.value)}`
      : url
  })

  /** 对照弹窗那一页属于哪一档 —— 与行内共用 `pageReviewState`。 */
  const previewState = computed(() =>
    pageReviewState(previewRow.value?.result ?? null),
  )

  const previewMeta = computed(() => {
    const r = previewRow.value?.result
    if (!r) return ''
    return [OCR_CHANNELS[r.channel] ?? r.channel, r.model ?? r.engine]
      .filter(Boolean)
      .join(' · ')
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
  type ResultsRead =
    { ok: true; rows: OcrResultRow[] } | { ok: false; message: string }

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
  let detailGeneration = 0
  async function loadDetail(relPath: string) {
    const generation = ++detailGeneration
    detailLoading.value = true
    detailError.value = ''
    status.value = null
    try {
      const [state, read] = await Promise.all([
        api<PdfPagesState>('/api/pdf-pages', { query: { file: relPath } }),
        fetchResults(relPath),
      ])
      if (relPath !== selectedPath.value || generation !== detailGeneration)
        return
      if (!read.ok) {
        // Keep the last successful snapshot; writes are disabled until a complete retry.

        detailError.value = read.message
        return
      }
      pagesState.value = state
      results.value = read.rows
      loadedPath.value = relPath
    } catch (error) {
      if (relPath !== selectedPath.value || generation !== detailGeneration)
        return
      detailError.value = describeFetchError(
        error,
        '读不到这份文件的页图与识别结果。',
      )
    } finally {
      // 只有仍是当前目标时才收 loading —— 否则会把「新目标那一次读」的 loading 提前关掉。
      if (relPath === selectedPath.value && generation === detailGeneration)
        detailLoading.value = false
    }
  }

  /**
   * 只重取结果那一半(保存 / 删除 / 导入之后)—— 页图清单没变,不必重算。
   *
   * 返回这一趟读回的逐页结果;目标已经不是这一份文件时返回 `null`(回包丢弃)。
   */
  async function reloadResults(
    relPath: string,
  ): Promise<OcrResultRow[] | null> {
    const read = await fetchResults(relPath)
    if (relPath !== selectedPath.value) return null
    if (!read.ok) {
      detailError.value = read.message
      return null
    }
    detailError.value = ''
    results.value = read.rows
    loadedPath.value = relPath
    return read.rows
  }

  watch(selectedPath, (next) => {
    detailGeneration += 1
    pagesState.value = null
    results.value = []
    // 右栏现在什么都不属于了 —— 写目标随之为空,在数据回来之前点不动任何写。
    loadedPath.value = ''
    status.value = null
    previewPage.value = null
    dirty.value = false
    // 导入弹窗的结论属于**上一份**文件,不跟着切过去(独立代码审核 N5:
    // 在 A 上导入成功后切到 B,弹窗里还写着 A 的「已写入 12 页…」)。
    importFailure.value = ''
    importResult.value = ''
    importOpen.value = false
    // 行级的两个残留也属于上一份文件:`OcrPageRow` 只按**页码**认领它们
    // (`rowFailure?.page === currentRow.page`),不清就会让 A 第 3 页的报错/高亮
    // 出现在 B 的第 3 页上(独立代码审核 R3)。
    rowFailure.value = null
    justSaved.value = null
    if (next) void loadDetail(next)
  })

  // ---------------------------------------------------------------------------
  // 动作
  // ---------------------------------------------------------------------------

  /** 哪一行正在飞(保存 / 删除)。同一时刻只允许一个动作 —— 一次点两页会撞在同一份状态上。 */
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
    if (
      !relPath ||
      relPath !== selectedPath.value ||
      detailLoading.value ||
      detailError.value
    )
      return null
    return relPath
  }

  async function savePage(page: number, markdown: string) {
    const relPath = writeTarget()
    if (!relPath || pendingPage.value !== null || page !== currentPage.value)
      return
    pendingPage.value = page
    rowFailure.value = null
    justSaved.value = null
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
      if (next === null) {
        if (relPath === selectedPath.value) rowFailure.value = { page, message: '写入已提交,但读回失败 —— 请重试读取后核对这一页。' }
        return
      }
      // **读回核对**:落库会做归一(去掉行尾空白与首尾空行),所以提交与读回的比较
      // 走同一份归一规则 —— 归一不算失败,真丢了内容才算。
      const got = next.find((r) => r.page === page) ?? null
      const check = confirmWrittenPage(markdown, got?.markdown ?? null)
      status.value = {
        tone: check.ok ? 'ok' : 'warn',
        message: `${pageLabel(page)}保存完成:${check.message}`,
      }
      if (check.ok) {
        dirty.value = false
        flashSaved(page)
      } else rowFailure.value = { page, message: check.message }
    } catch (error) {
      if (relPath !== selectedPath.value) return
      // 写失败与**读回**失败分开说:读回失败时写入其实已经提交(再点一次是幂等覆盖),
      // 报成「保存失败」会让人以为白写了一遍。
      rowFailure.value = {
        page,
        message: describeFetchError(
          error,
          committed
            ? '写入已提交,但读回失败 —— 刷新后核对这一页。'
            : '保存失败,请重试。',
        ),
      }
    } finally {
      pendingPage.value = null
    }
  }

  async function removePage(page: number) {
    const relPath = writeTarget()
    if (!relPath || pendingPage.value !== null || page !== currentPage.value)
      return
    pendingPage.value = page
    rowFailure.value = null
    justSaved.value = null
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
      if (relPath === selectedPath.value)
        rowFailure.value = {
          page,
          message: describeFetchError(error, '删除失败,请重试。'),
        }
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
    if (!relPath || rendering.value || writeBusy.value) return
    const generation = detailGeneration
    rendering.value = true
    status.value = null
    try {
      const out = await api<RenderOutcome>('/api/pdf-pages', {
        method: 'POST',
        body: { file: relPath },
      })
      // **同一个目标守卫**(B1 在 `loadDetail` 上用的是同一条):渲染 50 页要好几秒,
      // 期间用户完全可能切到另一份文件。晚到的回包把 `pagesState` 换成 A 的,
      // 右栏就会在 **B 的文件名下列出 A 的页数与 A 的页图** —— 校对的前提(图对着文本)
      // 当场被破坏(独立代码审核 R1)。
      //
      // **不**用「渲染在飞就冻结切换」来堵:`rendering` 算进 `writeBusy` 会让一次几秒的
      // 渲染把文件切换锁死,而丢掉一个晚到的回包本来就够了。
      if (relPath !== selectedPath.value || generation !== detailGeneration)
        return
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
      if (relPath !== selectedPath.value || generation !== detailGeneration)
        return
      status.value = {
        tone: 'error',
        message: describeFetchError(error, '渲染失败。'),
      }
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
  const importFailure = ref('')
  const importResult = ref('')

  /**
   * 有写在飞时**冻结文件切换**:写目标与显示内容必须始终是同一份文件。
   * (这是 B1 的第二道锁 —— 第一道是 `writeTarget()` 的不一致就拒写。)
   */
  async function runImport(
    payload: { jsonl: string } | { markdown: string; page: number | null },
  ) {
    // 正在导入时重复提交静默忽略(按钮也是 disabled 的);**读不到目标则必须说出来** ——
    // 这条路以前是「点了没反应」,而它恰恰出现在「读不到结果」那个空状态里。
    if (importPending.value || blocked()) return
    const relPath = writeTarget()
    if (!relPath) {
      importFailure.value = IMPORT_NOT_READY
      return
    }
    importPending.value = true
    importFailure.value = ''
    importResult.value = ''
    let committed = false
    try {
      const out = await api<WriteResponse>('/api/ocr-results', {
        method: 'POST',
        body: { file: relPath, ...payload },
      })
      committed = true
      const next = await reloadResults(relPath)
      if (next === null) {
        if (relPath === selectedPath.value) importFailure.value = '写入已提交,但读回失败 —— 请刷新后核对导入结果。'
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
      if (missing.length)
        parts.push(`读回时第 ${missing.join('、')} 页不在库里,请刷新核对`)
      else if (contentCheck && !contentCheck.ok)
        parts.push(contentCheck.message)
      else parts.push('读回一致')
      if (out.warning) parts.push(out.warning)

      const clean = !missing.length && (!contentCheck || contentCheck.ok)
      importResult.value = parts.join(' · ')
      // 结论同时留在页面的状态条上:弹窗一关,「读回了什么」还要看得见。
      status.value = {
        tone: clean ? 'ok' : 'warn',
        message: `导入完成:${importResult.value}`,
      }
      // 全绿才关弹窗:有疑问时留着,让人对着那句话决定下一步。
      if (clean) importOpen.value = false
    } catch (error) {
      if (relPath === selectedPath.value) importFailure.value = describeFetchError(error, committed ? '写入已提交,但读回失败 —— 请刷新后核对导入结果。' : '导入失败,请重试。')
    } finally {
      importPending.value = false
    }
  }

  // ---------------------------------------------------------------------------
  // 刷新
  // ---------------------------------------------------------------------------

  onBeforeUnmount(() => {
    if (justSavedTimer) clearTimeout(justSavedTimer)
  })

  async function refreshAll() {
    if (blocked()) return
    await loadFiles()
    // 选中的文件可能已不在列表里(被移出库)—— 那时清空右栏,不显示一份已经不存在的文件。
    if (
      selectedPath.value &&
      !pdfFiles.value.some((f) => f.relPath === selectedPath.value)
    ) {
      selectedPath.value = ''
      pagesState.value = null
      results.value = []
      loadedPath.value = ''
      status.value = null
      return
    }
    if (selectedPath.value) await loadDetail(selectedPath.value)
  }

  return {
    refreshAll,
    detailLoading,
    filesLoading,
    filesError,
    loadFiles,
    pdfFiles,
    fileMatches,
    fileYears,
    keyword,
    source,
    year,
    selectedPath,
    selected,
    selectFile,
    setFileFilter,
    writeBusy,
    counts,
    renderedCount,
    pageCount,
    rendering,
    renderPageImages,
    canImport,
    IMPORT_NOT_READY,
    filters,
    visibleRows,
    currentPage,
    currentRow,
    dirty,
    notice,
    ready,
    setFilters,
    navigate,
    status,
    loadedPath,
    detailError,
    loadDetail,
    rows,
    imageVersion,
    pendingPage,
    rowFailure,
    justSaved,
    savePage,
    removePage,
    previewPage,
    previewSrc,
    previewRow,
    previewState,
    previewMeta,
    importOpen,
    importPending,
    importFailure,
    importResult,
    runImport,
    pageNumbers,
  }
}
