import { appLog } from '../../../layers/core/lib/logging'
import { registeredFileAtLocator, verifyFileRead, verifyPageRead } from '../file-read-identity'
import type { StoredFileContentIdentity } from '../file-content-identity'
import { isPdfPath, normalizeDpi } from '../../../lib/pdf-page'
import type { RenderOutcome } from '../pdf-pages'
import { renderPdfPages } from '../pdf-pages'
import type { JobCompletion, JobContext, JobParseResult, JobSpec } from '../../../layers/core/server/utils/job-runner'

/**
 * `render-pages` —— **批量**把 PDF 逐页渲染成 PNG。
 *
 * 票 13 已经有了这件事的**同步单文件**入口(`POST /api/pdf-pages`,一次一份、跑完才回)。
 * 本文件是把同一份渲染接到异步任务面上,**批量**是新增的部分:一次提交 N 份,
 * 拿一个 jobId 轮询,而不是 N 个请求各等 N 秒。
 *
 * 渲染本身一行没改 —— 仍走 `server/utils/pdf-pages.ts` 的 `renderPdfPages`,
 * 所以页图落盘、幂等判据(源 sha256 + dpi + 每页尺寸)、`.pages.json` 清单、
 * 页图与源 PDF 的相对路径口径**全部与票 13 一致**。两边的产物因此可以直接比对:
 * 同一份 PDF 经同步入口与经本任务渲染,页图字节相同(幂等判据同一个)。
 *
 * ── 逐份之间的取消检查 ──────────────────────────────────────────────────
 * `ctx.throwIfCancelled()` 放在**每份文件之前**:粒度就是「一份 PDF」。
 * 一份 97 页的 PDF 实测 3.3 s(票 13),不做页级取消 —— 页级要在 `renderPdfPages`
 * 内部插回调,那是票 13 的文件,本票不去动它。
 */

/** 一份文件的渲染结果。两种形状,`ok` 是判据。 */
export type RenderedFileOutcome =
  | {
      file: string
      ok: true
      contentIdentity: StoredFileContentIdentity
      /** 源 PDF 的页数(打开失败时为 null,但那种情况会走 ok:false)。 */
      pageCount: number | null
      /** 渲染后磁盘上的页图数。 */
      rendered: number
      /** 本次写入的页数(幂等命中时为 0)。 */
      written: number
      skipped: number
      removed: number
      dpi: number
      elapsedMs: number
      /** 每页的页号、尺寸、字节数与预览 URL(与 `GET /api/pdf-pages` 同一形状)。 */
      pages: RenderOutcome['pages']
    }
  | { file: string; ok: false; error: string }

/** 任务的产出。 */
export interface RenderPagesResult {
  files: RenderedFileOutcome[]
  total: number
  ok: number
  failed: number
  dpi: number
  force: boolean
  /** 被取消时才是 true。 */
  cancelled?: boolean
  /** 停下时**已处理**(尝试过)的份数 —— 取消时它是「停在第几份之前」。 */
  done?: number
}

/** 已校验的参数(只有 `parse` 通过后才会被交到 `run`)。 */
interface RenderPagesParams {
  files: string[]
  dpi: number
  force: boolean
}

/**
 * 参数校验(纯函数,提交时跑)。
 *
 * 一次**全部**校验完再报错?不 —— 报**第一个**错就够:代理拿到一句话就能改,
 * 而一份「你第 2、第 5 项都不对」的清单只会让它的重试逻辑更复杂。逐个报错。
 */
export function parseRenderPagesParams(raw: Record<string, unknown>): JobParseResult {
  const rawFiles = raw.files
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return { ok: false, message: 'files 必须是非空数组(相对文件库根的 PDF 路径)' }
  }
  const files: string[] = []
  for (const item of rawFiles) {
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, message: 'files 的每一项都必须是非空字符串' }
    }
    const file = item.trim()
    if (!isPdfPath(file)) return { ok: false, message: `不是 PDF:${file}` }
    files.push(file)
  }

  let dpi: number
  try {
    dpi = normalizeDpi(raw.dpi)
  } catch (error) {
    return { ok: false, message: (error as Error).message }
  }

  if (raw.force !== undefined && raw.force !== null && typeof raw.force !== 'boolean') {
    return { ok: false, message: `force 必须是布尔值:${JSON.stringify(raw.force)}` }
  }

  return { ok: true, params: { files, dpi, force: raw.force === true } }
}

/**
 * 逐份渲染。
 *
 * **一份失败不停下整批**:把原因记进那一项(`ok:false`),继续下一份。
 * 批量任务的用处正是「一次交一堆」,因为第 2 份是坏的就把第 3–7 份也撂下,等于把
 * 「哪几份坏了」这个信息换成了「任务失败」—— 调用方还得自己再跑一遍去定位。
 * 跑完之后如果**有任何**一份失败,任务状态记 `failed`(见 `JobCompletion` 的说明),
 * 明细仍在 `result.files[]` 里。
 *
 * **取消**走 `{ cancelled: true }` 而不是让 `throwIfCancelled` 抛:抛出去的话
 * 「已经渲染好的那几份」的明细就跟着异常一起没了,而调用方最想知道的恰恰是
 * 「停在哪、做完了哪些」。所以这里查 `ctx.cancelled()` 并**带着部分产出收尾**。
 * 粒度是**一份文件** —— 一份 97 页的 PDF 实测 3.3 s(票 13),不做页级取消
 * (页级要在 `renderPdfPages` 内部插回调,那是票 13 的文件,本票不动它)。
 */
export async function runRenderPages(
  ctx: JobContext,
  params: Record<string, unknown>,
  registeredInputs?: Array<StoredFileContentIdentity | null>,
): Promise<JobCompletion> {
  const { files, dpi, force } = params as unknown as RenderPagesParams
  const inputs = registeredInputs ?? files.map(file => registeredFileAtLocator(ctx.db, file))
  const logContext = { ...ctx.logContext, taskId: ctx.jobId }
  const outcomes: RenderedFileOutcome[] = []
  let failed = 0

  const snapshot = (): RenderPagesResult => ({
    files: outcomes,
    total: files.length,
    ok: outcomes.filter((o) => o.ok).length,
    failed,
    dpi,
    force,
  })

  for (let i = 0; i < files.length; i += 1) {
    // 每份之前看一眼取消标记 —— 这是「尽力而为」唯一的检查点。
    if (ctx.cancelled()) {
      appLog({ module: 'core', source: 'file', operation: 'file.render.batch', outcome: 'cancelled', counts: { done: i, total: files.length, failed } }, logContext)
      return {
        result: { ...snapshot(), cancelled: true, done: i },
        cancelled: true,
      }
    }

    const file = files[i]!
    const fileContext = { ...logContext }
    try {
      const expected = inputs[i]
      if (!expected) throw new Error('file_content_unknown: 待核实登记,禁止渲染发布')
      fileContext.fileId = expected.fileId
      const checkInput = async () => {
        const identity = await verifyFileRead(ctx.db, ctx.filesDir, file)
        const current = identity.registered
        if (identity.status !== 'verified') throw new Error('file_content_unknown: 待核实登记,禁止渲染发布')
        if (!current || current.fileId !== expected.fileId || current.sha256 !== expected.sha256 || current.bytes !== expected.bytes) throw new Error('file_content_conflict: 渲染输入登记已变化')
        return identity
      }
      await checkInput()
      const out = await renderPdfPages(ctx.filesDir, file, { dpi, force, logContext: fileContext })
      const verified = await checkInput()
      await verifyPageRead(ctx.db, ctx.filesDir, file, undefined, verified)
      outcomes.push({
        file,
        ok: true,
        contentIdentity: expected,
        pageCount: out.pageCount,
        rendered: out.rendered,
        written: out.written,
        skipped: out.skipped,
        removed: out.removed,
        dpi: out.dpi,
        elapsedMs: out.elapsedMs,
        pages: out.pages,
      })
    } catch (error) {
      failed += 1
      outcomes.push({ file, ok: false, error: (error as Error).message ?? String(error) })
    }

    ctx.progress(i + 1, files.length)
  }

  const result = snapshot()
  appLog({ module: 'core', source: 'file', operation: 'file.render.batch', outcome: failed ? (result.ok ? 'partial' : 'failure') : 'success', level: failed ? 'error' : 'info', counts: { done: outcomes.length, total: files.length, failed } }, logContext)
  return failed
    ? { result, error: `${files.length} 份里 ${failed} 份渲染失败(逐项原因见 result.files[].error)` }
    : { result }
}

export const renderPagesSpec: JobSpec = {
  kind: 'render-pages',
  status: 'ready',
  summary: '批量把 PDF 逐页渲染成 PNG(票 13 的渲染,批量入口)',
  paramsHint:
    '{ files: string[](相对文件库根的 PDF 路径,非空), dpi?: 72–600(默认 300), force?: boolean }',
  parse: parseRenderPagesParams,
  // 分母提交时就知道 —— 轮询方一上来就能看到「一共 3 份」。
  total: (params) => (params.files as string[]).length,
  prepare: (params, db) => {
    const inputs = (params.files as string[]).map(file => registeredFileAtLocator(db, file))
    return (ctx, input) => runRenderPages(ctx, input, inputs)
  },
  run: runRenderPages,
}
