import type { LogContext } from '../../../../core/lib/logging'
import { legacyFileMaintenanceControlShape } from '../../../../core/server/utils/file-maintenance-contract'
import { parseFileMaintenanceOptions } from '../../../../core/server/utils/file-maintenance-shared'
import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { TITLE_ORDER } from '#sme-roster/lib/labels'
import { fileRefShape, requirePostgresFileRef } from '../../../../core/server/utils/file-agent-reference'
import { maintainPostgresFile } from '../../../../core/server/utils/file-maintenance-postgres'
import { usePostgresFileDb } from '../../../../core/server/utils/file-store-postgres'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'

/**
 * `set_file_category` —— 回写文件分类(票 18,**写入**,需鉴权)。
 *
 * 这是**票 12「分类回写」的代理通路**:文件上传时没定来源/年份/批次(或定错了),
 * 代理看出它是哪一批、哪一类之后从这里写回。
 *
 * 复用的是页面那条 PATCH 的**同一个写入口**(`maintainPostgresFile`)—— 白名单、三态(未提供 / 置空 / 置值)、
 * 以及「分类补齐后自动把 `category_state` 从 `unset` 提升为 `set`」全部照旧。
 * 所以从 MCP 写进去和从页面写进去是**同一件事**,不存在「代理有后门改库」这条通路。
 *
 * **不碰的东西**:`rel_path` / `filename` / `bytes` / `sha256`(磁盘事实,
 * `parseMetadataPatch` 直接拒掉这些键)、磁盘上的文件、以及台账记录
 * 文件分类维护不能直接删除 `record` 或 `enterprise`。
 */
export default defineMcpTool({
  name: 'set_file_category',
  title: '回写文件分类',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  enabled: writeGuard,
  description: [
    '按 `fileId` 或 `relPath`(恰给其一)改一个文件的**元数据分类**:`source` / `kind` / `year` / `batch` / `titleCode`。',
    '至少给一个字段;给 `null` 表示**清空**该字段(与「不给」不同)。',
    '`year` / `batch` 是**公布**年份/批次(目录口径、单值),不是文件内容里的年份/批次(那看 `parts`,用 `save_parse_result` 写)。',
    '分类补齐后 `categoryState` 会自动从 `unset` 升为 `set`;清空则会退回 `unset`。返回改后的整行,可直接核对结果。',
    '改不到:`relPath` / `bytes` / `sha256` 等磁盘事实,以及台账记录 —— 那些不在本 tool 的范围内。',
    '原载荷保留 legacy blind-write 适配：不要求控制字段，不推断操作者或确认依据；实际写入推进维护修订。若提供现代控制字段，四项必须齐全。',
    '**需要鉴权**(Authorization: Bearer <NUXT_MCP_TOKEN>)。',
  ].join('\n'),
  inputSchema: {
    ...fileRefShape,
    ...legacyFileMaintenanceControlShape,
    source: z.enum(['jxj', 'miit']).nullish().describe('来源;jxj 经信局 / miit 工信部;null 清空'),
    kind: z
      .enum(['announcement', 'export'])
      .nullish()
      .describe('类别：announcement 公布名单 / export 导出表，null 清空'),
    year: z
      .number()
      .int()
      .min(1900)
      .max(2100)
      .nullish()
      .describe('**公布**年份(四位,目录给的);null 清空'),
    batch: z.number().int().positive().nullish().describe('**公布**批次序号(正整数);null 清空'),
    titleCode: z
      .enum(TITLE_ORDER as [string, ...string[]])
      .nullish()
      .describe('该文件对应的称号(取值见 db/titles.ts 的称号字典);null 清空'),
  },
  handler: async (input, extra) => {
    // 只把**给了的**字段递下去:`parseMetadataPatch` 把「键不存在」当未提供、
    // 「值为 null」当清空,两者语义不同,所以不能用 undefined 占位。
    const meta: Record<string, unknown> = {}
    for (const key of ['source', 'kind', 'year', 'batch', 'titleCode'] as const) {
      if (input[key] !== undefined) meta[key] = input[key]
    }

    const options = parseFileMaintenanceOptions(input)
    const context = (extra as { logContext?: LogContext } | undefined)?.logContext
    const pg = usePostgresFileDb()
    const file = await requirePostgresFileRef(pg, input)
    if (!Object.keys(meta).length) throw createError({ statusCode: 400, message: '至少给一个分类字段:source / kind / year / batch / titleCode' })
    try {
      const row = await maintainPostgresFile(pg, useRuntimeConfig().filesDir, file.id, 'update', meta, options, context, { requireActive: true })
      return { file: row }
    } catch (error) {
      throw createError({ statusCode: (error as { statusCode?: number }).statusCode ?? 500, message: (error as Error).message })
    }
  },
})
