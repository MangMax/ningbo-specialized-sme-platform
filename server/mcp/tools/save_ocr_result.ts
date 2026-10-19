import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { fileRefShape, openFileStore } from '../../utils/mcp-files'
import { writeGuard } from '../../utils/mcp-guard'
import { saveOcrImport, requireOcrFileRef, ocrExpectedVersionSchema, ocrPageSchema } from '../../utils/ocr-page-lifecycle'

/**
 * `save_ocr_result` —— **通路 c**:代理经 MCP 把识别结果写回。
 *
 * 票 18 的 501 空壳到此结束(表由票 14 建好)。代理的典型流程是:
 * `list_page_images` 拿到某页的 PNG → 自己(或经别的服务)识别 → 本 tool 按**页号**写回。
 * 所以这里**页号是必需的**:省略 `page` 时,markdown 必须自带 `<!-- page: N -->` 页标记
 * (整份结果的情形),否则报错 —— **不猜页号**,猜出来的页码会让整条「按页回填出处」失真。
 *
 * ── 边界(与票 18 一致,没变)────────────────────────────────────────────
 * 只写 `ocr_result`。**不碰** `record` / `record_event` / `record_evidence` / `enterprise`
 * —— 「谁被认定了」只由 pipeline 写(见 data-integrity 的安全阀)。
 * 本 tool 是**写入** tool,需要鉴权(`Authorization: Bearer <NUXT_MCP_TOKEN>`),
 * 未鉴权时不出现在 `tools/list` 里,强行调用得到 HTTP 401(见 `server/mcp/index.ts`)。
 *
 * ── 幂等 ────────────────────────────────────────────────────────────────
 * `(file_id, page_no)` 唯一,写的是**覆盖** —— 同一页重写不会堆重复行,
 * 所以代理重试是安全的(`idempotentHint: true`)。
 */
export default defineMcpTool({
  name: 'save_ocr_result',
  title: '写回 OCR 结果',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  enabled: writeGuard,
  description: [
    '按 `fileId` 或 `relPath`(恰给其一)写回 OCR 结果。',
    '给 `page` ⇒ 这段 markdown 就是**那一页**的内容;不给 ⇒ markdown 必须自带 `<!-- page: N -->` 页标记(整份结果)。',
    'expectedVersion 可取 get_ocr_result.results[].version;null 表示预期不存在。版本不符为 409,且需要显式 page。省略保持兼容覆盖;只覆盖列出的页。',
    '**幂等**:同一页重写是覆盖,不会堆重复行。',
    '**是写入 tool**,需要鉴权(Authorization: Bearer <NUXT_MCP_TOKEN>)。',
    '只写 OCR 结果;**不改**台账记录与企业身份(pipeline 的事)。',
  ].join('\n'),
  inputSchema: {
    ...fileRefShape,
    page: ocrPageSchema.optional().describe('显式页号;省略须 markdown 自带页标记'),
    expectedVersion: ocrExpectedVersionSchema,
    markdown: z.string().describe('OCR 结果 markdown(带页码更能对上出处的页码)'),
    engine: z.string().optional().describe('识别引擎;默认 paddleocr'),
    model: z.string().nullable().optional().describe('模型名(可空)'),
  },
  handler: async (input) => {
    const { db, root } = await openFileStore()
    const row = requireOcrFileRef(db, input)
    return saveOcrImport({ ok: true, db, root, row }, input, 'mcp')
  },
})
