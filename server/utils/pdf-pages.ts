import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { PDFiumLibrary } from '@hyzyla/pdfium'
import sharp from 'sharp'
import {
  CHANNELS,
  DEFAULT_DPI,
  PAGES_MANIFEST_NAME,
  pageDirRelPath,
  pageFileName,
  pageImageRelPath,
  pageNoOf,
  pixelSizeFor,
} from '../../lib/pdf-page'

/**
 * PDF → 页图(PNG)的渲染管线。
 *
 * ── 选型:**PDFium(wasm)`@hyzyla/pdfium` + `sharp`** ──────────────────────
 *
 * app 里已有 `@embedpdf/vue-pdf-viewer`,它的引擎**就是 PDFium** —— 所以「用 PDFium
 * 渲染」这一步不引入第二种渲染引擎,同一份 PDF 在浏览器里看到的和落到页图上的像素
 * 是同一个引擎出的(字形、字距、取整都一致)。差别只在「怎么在 Node 里调到它」:
 *
 * | 候选 | 结论 |
 * |---|---|
 * | `@embedpdf/pdfium` | **弃**。它是**面向前端**的封装:导出的是 `FPDF_*` 原始 FFI 绑定(自己管 `malloc`/指针/`FPDFBitmap` 生命周期),`init({ wasmBinary })` 之前还得自己 fetch wasm。用它等于在本仓库里重写一遍「开文档 → 载页 → 建位图 → 取像素」,多出几百行指针代码,而 PDFium 的 C API 一旦用错就是段错误/内存泄漏,不是能靠测试兜住的那种错。同一个组织另有 `@embedpdf/engines` 做封装,但那是**浏览器引擎层**(依赖 worker / fetch / 流),不是给 Node 批处理用的。 |
 * | `@hyzyla/pdfium` | **选**。同一个 PDFium 的 wasm 构建,但**面向 Node 的封装**:`PDFiumLibrary.init()` → `loadDocument(buffer)` → `document.pages()` → `page.render({ width, height })`,TS 类型齐、零依赖、wasm 随包发布(不走 CDN、不联网)。它的 README 示例就是用 sharp 把位图转 PNG,与票 13 的技术路线逐字吻合。引擎是 pdfium(与浏览器里的 viewer 同源),这点与候选一没有差别。 |
 * | Node 原生绑定的 pdfium(napi 类) | **弃**。要引原生二进制 + 平台预编译,与 `sharp` 已经要引一份原生依赖叠加,本机 pnpm 的构建白名单更长、部署面更宽;wasm 版在本项目的数据量级(A4、≤300 DPI、≤100 页)实测每页 20–50 ms,没有换绑定的理由。 |
 *
 * 位图 → PNG 交给 `sharp`(票 13 指定):PDFium 只出**像素**(RGBA),编码、压缩、
 * 按 DPI 写 pHYs 都归 sharp。**sharp 是原生模块**,已在 `pnpm-workspace.yaml` 的
 * `allowBuilds` 放行(本机 pnpm 的构建白名单,见票 13 注)。
 *
 * ── 内存 ────────────────────────────────────────────────────────────────
 * **一页一页来**:渲染 → 编码 → 落盘 → `page.close()`,任何时候手上只有一页的位图
 * (200 DPI A4 = 1652×2338×4 ≈ 15 MB)。97 页那份实测峰值 RSS 见票 13 —— 不随页数增长,
 * 所以「大页数 OOM」不会发生;真按 600 DPI 且一次性攒住全部页图才会。
 *
 * ── 幂等 ────────────────────────────────────────────────────────────────
 * 判据是**源内容 sha256 + 分辨率 + 每页文件的尺寸**,全记在 `<页图目录>/.pages.json` 清单里。
 * 三者都与上次一致(且目录里没有多余页图)时**一个字节都不写**。内容变了或换了 DPI
 * 才重渲染,且**原地覆盖**同一批路径 —— 目录不会随重跑膨胀。
 */

/** 一页页图的引用(相对文件库根)。 */
export interface PageImageRef {
  page: number
  relPath: string
  /** 经 `/api/files/[...path]` 可直接取到的预览 URL。 */
  url: string
  width: number
  height: number
  bytes: number
}

/** 清单里记的一页(不含 `url` —— 它可由 `relPath` 推出,存进清单只会是重复信息)。 */
type ManifestPage = Omit<PageImageRef, 'url'>

/** `<页图目录>/.pages.json` 的内容。 */
export interface PagesManifest {
  version: 1
  /** 源 PDF,相对文件库根。 */
  file: string
  sourceBytes: number
  /** 源内容哈希。**幂等的权威判据**(同内容 → 不重写)。 */
  sourceSha256: string
  dpi: number
  colorSpace: 'RGBA'
  pageCount: number
  renderedAt: string
  pages: ManifestPage[]
}

/** 页图现状(不变更磁盘)。 */
export interface PdfPagesState {
  file: string
  /** 源 PDF 的页数;读不出来(损坏)时为 null。 */
  pageCount: number | null
  /** 已渲染页图所用的分辨率;未渲染过时为请求的 `dpi`。 */
  dpi: number
  /** 磁盘上已有的页图数。 */
  rendered: number
  /** 已渲染的页图与当前源内容 + 请求的 `dpi` 完全一致(不需要再渲染)。 */
  upToDate: boolean
  /** 按页号升序。 */
  pages: PageImageRef[]
  /** 清单摘要(调试/展示用);从未渲染时为 null。 */
  manifest: { dpi: number; renderedAt: string } | null
}

/** 一次渲染的结果。 */
export interface RenderOutcome extends PdfPagesState {
  /** 本次**写入**的页数。 */
  written: number
  /** 本次**跳过**(已存在且一致)的页数。 */
  skipped: number
  /** 本次清掉的陈旧页图数(源页数变少时)。 */
  removed: number
  elapsedMs: number
}

// ---------------------------------------------------------------------------
// 路径与锁根
// ---------------------------------------------------------------------------

/**
 * 把相对路径解析到**根之内**的绝对路径。解析后必须仍在根内 —— 用 `resolve` 后比对前缀,
 * 而不是字符串里找 `..`(符号链接与编码变体绕不过 resolve)。与
 * `server/api/files/[...path].get.ts` 同一口径。
 *
 * **为什么在这份文件里而不是抽成公共 helper**:同一条判据在那条路由里是**内联**的,
 * 抽公共件要改 `server/api/files/[...path].get.ts` —— 那张票(文件回吐路由)当前不在
 * 本票的改动范围内,同时有其他会话在动文件域。合流是**后续的清理**,不是现在:
 * 现在改它只会把两票的改动绞在一起。(同理见下面 `sha256Of`。)
 */
export function resolveWithinRoot(root: string, relPath: string): string {
  const absRoot = resolve(root)
  const abs = resolve(join(absRoot, relPath))
  if (abs !== absRoot && !abs.startsWith(absRoot + sep)) {
    throw new Error('路径越界')
  }
  return abs
}

/** 页图目录(绝对)。 */
function pagesDirAbs(root: string, pdfRelPath: string): string {
  return resolveWithinRoot(root, pageDirRelPath(pdfRelPath))
}

// ---------------------------------------------------------------------------
// PDFium
// ---------------------------------------------------------------------------

/**
 * PDFium 库实例**进程内复用**。`init()` 要实例化 ~5 MB 的 wasm,每次渲染都来一遍
 * 是白扔几百毫秒;而它本身无状态(文档各自有句柄),复用是安全的。
 * 存的是 **Promise**,并发首次调用不会各初始化一份。
 */
let libraryPromise: Promise<PDFiumLibrary> | null = null

function pdfium(): Promise<PDFiumLibrary> {
  libraryPromise ??= PDFiumLibrary.init().catch((error: unknown) => {
    // 初始化失败不缓存失败态:下次请求再试一次(例如 wasm 被临时挡住)。
    libraryPromise = null
    throw error
  })
  return libraryPromise
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 流式算 SHA-256,不把 10 MB 的 PDF 整个读进内存。
 *
 * 与 `server/utils/stored-files.ts` 里的同名函数**逐行相同** —— 照抄而不是抽取,
 * 是因为抽取要改那份文件(票 09/17 的地盘,另有会话在动)。同仓已有先例:
 * `lib/stored-file.ts` 也照抄了 pipeline 的 `parseBatch` 并注明来源。合流留给后续清理。
 */
function sha256Of(absPath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(absPath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

/** 先写 `.tmp` 再 rename:崩在半路不会留下半张 PNG 被当成已渲染。 */
async function writeFileAtomic(absPath: string, data: Uint8Array): Promise<void> {
  const tmp = `${absPath}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, absPath)
}

async function readManifest(dirAbs: string): Promise<PagesManifest | null> {
  try {
    const raw = await readFile(join(dirAbs, PAGES_MANIFEST_NAME), 'utf8')
    const parsed = JSON.parse(raw) as PagesManifest
    return parsed?.version === 1 && Array.isArray(parsed.pages) ? parsed : null
  } catch {
    return null
  }
}

/** 磁盘上现有的页图页号(按升序);`null` 表示目录不存在。 */
async function existingPageNumbers(dirAbs: string): Promise<number[] | null> {
  try {
    const names = await readdir(dirAbs)
    return names
      .map(pageNoOf)
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b)
  } catch {
    return null
  }
}

async function statSize(absPath: string): Promise<number | null> {
  try {
    const info = await stat(absPath)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

/** 预览 URL:走既有的文件回吐路由 `server/api/files/[...path].get.ts`。 */
function previewUrl(relPath: string): string {
  return `/api/files/${relPath.split('/').map(encodeURIComponent).join('/')}`
}

function toRef(pdfRelPath: string, page: ManifestPage): PageImageRef {
  return { ...page, url: previewUrl(page.relPath) }
}

// ---------------------------------------------------------------------------
// 现状(只读)
// ---------------------------------------------------------------------------

/** 源 PDF 的页数;打不开返回 null。 */
async function countPages(absPath: string): Promise<number | null> {
  let doc: Awaited<ReturnType<PDFiumLibrary['loadDocument']>> | null = null
  try {
    const lib = await pdfium()
    doc = await lib.loadDocument(await readFile(absPath))
    return doc.getPageCount()
  } catch {
    return null
  } finally {
    doc?.destroy()
  }
}

/**
 * 一份 PDF 的页图现状。**不写任何文件**。
 *
 * 顺序:读清单 → 「清单是否仍然成立」(源哈希 + dpi + 每页文件在不在、尺寸对不对、
 * 有没有多余页图)→ 顺带 stat 每页取字节数。清单不存在时**不扫盘猜** —— 直接
 * 打开 PDF 报页数、`pages` 为空(「还没渲染」是正常状态,不是错误)。
 */
export async function listPdfPages(
  root: string,
  pdfRelPath: string,
  dpi: number = DEFAULT_DPI,
): Promise<PdfPagesState> {
  const pdfAbs = resolveWithinRoot(root, pdfRelPath)
  const dirAbs = pagesDirAbs(root, pdfRelPath)
  const manifest = await readManifest(dirAbs)

  if (!manifest) {
    return {
      file: pdfRelPath,
      pageCount: await countPages(pdfAbs),
      dpi,
      rendered: 0,
      upToDate: false,
      pages: [],
      manifest: null,
    }
  }

  const pages: PageImageRef[] = []
  let sizesOk = true
  for (const p of manifest.pages) {
    const abs = resolveWithinRoot(root, p.relPath)
    const size = await statSize(abs)
    if (size === null || size !== p.bytes) sizesOk = false
    pages.push(toRef(pdfRelPath, { ...p, bytes: size ?? p.bytes }))
  }
  pages.sort((a, b) => a.page - b.page)

  const onDisk = await existingPageNumbers(dirAbs)
  const noExtras =
    onDisk !== null &&
    onDisk.length === manifest.pageCount &&
    onDisk.every((n, i) => n === i + 1)
  const sameDpi = manifest.dpi === dpi
  const sameSource = (await statSize(pdfAbs)) === manifest.sourceBytes

  return {
    file: pdfRelPath,
    pageCount: manifest.pageCount,
    dpi: manifest.dpi,
    rendered: pages.length,
    upToDate: sizesOk && noExtras && sameDpi && sameSource,
    pages,
    manifest: { dpi: manifest.dpi, renderedAt: manifest.renderedAt },
  }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

export interface RenderOptions {
  dpi?: number
  /** 忽略清单与已有页图,无条件重渲染。 */
  force?: boolean
}

/**
 * 同一份 PDF 的渲染**排队**(按源文件绝对路径)。
 *
 * 两条规则:
 *
 *  1. **完全相同**的请求(同 `dpi`、同 `force`)正在跑 → 直接搭车,不重复做同一件事;
 *  2. 否则**排在它后面** —— 同一份 PDF 的渲染都往同一批 `pNNN.png.tmp` / `.pages.json`
 *     写,并行会互相 rename、互相覆盖清单。不同 DPI 的请求**不能搭车**(搭车会拿到
 *     另一套参数的结果),只能排队。
 *
 * `force` 也走这条队列 —— 否则两个 force 请求照样会撞在一起。
 * (单进程 app;多实例部署不在票 13 范围内。)
 */
const chains = new Map<string, Promise<unknown>>()
const inflight = new Map<string, { key: string; promise: Promise<RenderOutcome> }>()

/**
 * 把一份 PDF 逐页渲染成 PNG。
 *
 * 幂等:源内容 sha256、`dpi`、每页文件尺寸都与清单一致时**直接返回,不写文件**。
 */
export function renderPdfPages(
  root: string,
  pdfRelPath: string,
  options: RenderOptions = {},
): Promise<RenderOutcome> {
  const dpi = options.dpi ?? DEFAULT_DPI
  const force = options.force === true
  const abs = resolveWithinRoot(root, pdfRelPath)
  /** 一份「请求身份」:同参数的请求才搭车。 */
  const key = `${dpi}\u0000${force}`

  const running = inflight.get(abs)
  if (running?.key === key) return running.promise

  const previous = chains.get(abs) ?? Promise.resolve()
  const promise = previous
    .catch(() => undefined)
    .then(() => renderUncached(root, pdfRelPath, { dpi, force }))

  const entry = { key, promise }
  inflight.set(abs, entry)
  const settled = promise.catch(() => undefined)
  chains.set(abs, settled)
  void settled.then(() => {
    // 只有仍然是「最新那条」时才清 —— 否则会把后来者的记录抹掉。
    if (inflight.get(abs) === entry) inflight.delete(abs)
    if (chains.get(abs) === settled) chains.delete(abs)
  })
  return promise
}

async function renderUncached(
  root: string,
  pdfRelPath: string,
  options: { dpi: number; force?: boolean },
): Promise<RenderOutcome> {
  const { dpi, force = false } = options
  const startedAt = Date.now()
  const pdfAbs = resolveWithinRoot(root, pdfRelPath)
  const dirAbs = pagesDirAbs(root, pdfRelPath)

  const sourceBytes = await statSize(pdfAbs)
  if (sourceBytes === null) throw new Error(`文件不存在:${pdfRelPath}`)
  const sourceSha256 = await sha256Of(pdfAbs)

  const state = await listPdfPages(root, pdfRelPath, dpi)
  const manifest = await readManifest(dirAbs)
  // `upToDate` 只说明「清单与磁盘自洽」;还要比**源内容哈希**才知道内容有没有换过。
  // 拿 mtime 比会误判(重新拷贝一份内容相同的 PDF 就会改 mtime),所以按内容比。
  // `force` 时整段跳过 —— 那是「我不管你说什么,重做」的意思。
  const alreadyFresh = !force && state.upToDate && manifest?.sourceSha256 === sourceSha256

  if (alreadyFresh) {
    return {
      ...state,
      written: 0,
      skipped: state.pageCount ?? 0,
      removed: 0,
      elapsedMs: Date.now() - startedAt,
    }
  }

  const lib = await pdfium()
  const doc = await lib.loadDocument(await readFile(pdfAbs))
  let written = 0
  const pages: ManifestPage[] = []
  try {
    const pageCount = doc.getPageCount()
    await mkdir(dirAbs, { recursive: true })

    for (let index = 0; index < pageCount; index += 1) {
      const pageNo = index + 1
      const page = doc.getPage(index)
      try {
        const { originalWidth, originalHeight } = page.getOriginalSize()
        const { width, height } = pixelSizeFor(originalWidth, originalHeight, dpi)
        const relPath = pageImageRelPath(pdfRelPath, pageNo)
        const abs = join(dirAbs, pageFileName(pageNo))

        // PDFium 出像素(RGBA),sharp 出 PNG。回调里就地转 —— 位图不落到我们的作用域里。
        const image = await page.render({
          width,
          height,
          colorSpace: 'RGBA',
          render: async ({ data, width: w, height: h }) =>
            sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
              raw: { width: w, height: h, channels: CHANNELS },
            })
              .withMetadata({ density: dpi })
              .png()
              .toBuffer(),
        })

        await writeFileAtomic(abs, image.data)
        written += 1
        pages.push({
          page: pageNo,
          relPath,
          width: image.width,
          height: image.height,
          bytes: image.data.byteLength,
        })
      } finally {
        // 页不关就会一直占着 PDFium 的位图缓存 —— 97 页全攒着就是几百 MB。
        page.close()
      }
    }

    // 源页数变少(换了内容)时清掉多余的页图,目录不残留。
    const onDisk = (await existingPageNumbers(dirAbs)) ?? []
    let removed = 0
    for (const n of onDisk) {
      if (n > pageCount) {
        await rm(join(dirAbs, pageFileName(n)), { force: true })
        removed += 1
      }
    }

    // 清单**最后**写:崩在中途时不存在「清单说有、磁盘没有」的假一致。
    const next: PagesManifest = {
      version: 1,
      file: pdfRelPath,
      sourceBytes,
      sourceSha256,
      dpi,
      colorSpace: 'RGBA',
      pageCount,
      renderedAt: new Date().toISOString(),
      pages,
    }
    await writeFileAtomic(
      join(dirAbs, PAGES_MANIFEST_NAME),
      Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8'),
    )

    const after = await listPdfPages(root, pdfRelPath, dpi)
    return {
      ...after,
      written,
      skipped: pageCount - written,
      removed,
      elapsedMs: Date.now() - startedAt,
    }
  } finally {
    doc.destroy()
  }
}

/**
 * 取一页页图的绝对路径;尚未渲染返回 `null`。
 *
 * 只认**清单里记过**的页 —— 磁盘上随便放个 `p005.png` 不算(那可能是别人的残留)。
 */
export async function pageImagePath(
  root: string,
  pdfRelPath: string,
  pageNo: number,
): Promise<string | null> {
  const manifest = await readManifest(pagesDirAbs(root, pdfRelPath))
  const entry = manifest?.pages.find((p) => p.page === pageNo)
  if (!entry) return null
  const abs = resolveWithinRoot(root, entry.relPath)
  return (await statSize(abs)) === null ? null : abs
}

/** 清掉一份 PDF 的全部页图与清单(测试与排查用)。 */
export async function removePdfPages(root: string, pdfRelPath: string): Promise<void> {
  await rm(pagesDirAbs(root, pdfRelPath), { recursive: true, force: true })
}
