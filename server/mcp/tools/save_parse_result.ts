import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { EVENT_ORDER, TITLE_ORDER } from '~~/lib/labels'
import { PARSE_STATES } from '../../utils/stored-files'
import { fileRefShape, resolveFileRef } from '../../utils/mcp-files'
import { writeGuard } from '../../utils/mcp-guard'
import { applyParseResult } from '../../utils/parse-result'

/**
 * `save_parse_result` —— 写回解析出的**段**(票 18,**写入**,需鉴权)。
 *
 * 用途:代理看着文件(扫描件 + 页图/OCR)判出「这份文件里有哪些段」后写回来 ——
 * 这是票 11 的输入契约(按段取年份/批次/事件)在**没有台账记录**时的补位。
 *
 * ── 边界(票 18 写死的硬约束)───────────────────────────────────────────
 * 只写 `stored_file_part` 与该文件的 `parse_state`。**绝不**写 `record` /
 * `record_event` / `record_evidence` / `enterprise` —— 从文件到台账记录、以及随之而来的
 * **身份归并**,只能走 pipeline(见 `app/.scratch/data-integrity/SPEC.md` 的安全阀)。
 * 这个 tool 只回答「这份文件里写了什么」,不回答「谁被认定了」。
 * tests/mcp-surface.test.ts 有一条断言把这一点钉死。
 *
 * ── 全量替换 ────────────────────────────────────────────────────────────
 * `parts` 是这次解析的**全部代理段**:没列出的代理段会被删掉,空数组 = 清空代理段。
 * 派生段会保留;同坐标时代理段优先,行数不一致可从 `list_file_parts` 的 `hasConflict` 查到。
 * 这跟 `PATCH /api/files/:id` 的「只改给了的字段」不同 —— 段的集合是一个整体,
 * 「补一段」和「删一段」必须能用同一个调用表达,否则代理没法纠正自己上一次写错的结果。
 */
export default defineMcpTool({
  name: 'save_parse_result',
  title: '写回解析结果(段)',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  enabled: writeGuard,
  description: [
    '按 `fileId` 或 `relPath`(恰给其一)写回该文件解析出的**段**与/或解析状态。',
    '`parts` 是代理段的**全量替换**:派生段保留,同坐标时代理段优先;行数不同时标记 `hasConflict`。空数组只清掉代理段。',
    `每段:` + '`titleCode`(' + TITLE_ORDER.join(' / ') + ')、' +
      `\`eventKind\`(${EVENT_ORDER.join(' / ')} 认定/复核/维护/入库培育)、\`year\`(正整数或 null;` +
      '复核段记**被复核的原始认定年份**)、`batch`(正整数或 null)、`attachment`(会按归一规则收成「附件」/「附件N」)、`rowCount`(行数,省略为 0)。',
    '同称号/事件/年份/批次/附件给了两遍会**报错**(不自动合并)。',
    '`parseState`:unparsed / parsed / failed;省略时只要给了 `parts` 就置 `parsed`。',
    '**只写段与解析状态**。台账记录(record/enterprise)与身份归并只能由 pipeline 写,本 tool 碰不到。',
    '**需要鉴权**(Authorization: Bearer <NUXT_MCP_TOKEN>)。',
  ].join('\n'),
  inputSchema: {
    ...fileRefShape,
    parts: z
      .array(
        z.object({
          titleCode: z.enum(TITLE_ORDER as [string, ...string[]]).describe('称号'),
          eventKind: z.enum(EVENT_ORDER as [string, ...string[]]).describe('事件类型'),
          year: z
            .number()
            .int()
            .min(1900)
            .max(2100)
            .nullish()
            .describe('段的**内容**年份(复核段=被复核的原始认定年份)'),
          batch: z.number().int().positive().nullish().describe('段的批次序号'),
          attachment: z.string().nullish().describe('附件名(会归一;导出表无附件给 null)'),
          rowCount: z.number().int().min(0).optional().describe('该段行数,省略为 0'),
        }),
      )
      .optional()
      .describe('整份文件的**全部**段(全量替换)'),
    parseState: z
      .enum(PARSE_STATES as unknown as [string, ...string[]])
      .optional()
      .describe('解析状态;省略时给了 parts 就置 parsed'),
  },
  handler: async (input) => {
    const db = useDb()
    const found = resolveFileRef(db, input, { allowRemoved: false })
    if (!found.ok) throw createError({ statusCode: 404, message: found.message })

    const written = applyParseResult(db, found.row.id, {
      parts: input.parts,
      parseState: input.parseState,
    })
    if (!written.ok) throw createError({ statusCode: 400, message: written.message })

    // 返回最终状态:段 + 重新读出来的行(看 parse_state / category_state 的变化)。
    const after = resolveFileRef(db, { fileId: found.row.id }, { allowRemoved: true })
    return {
      file: after.ok ? after.row : { id: found.row.id, relPath: found.row.relPath },
      parts: written.parts,
      parseState: written.parseState,
    }
  },
})
