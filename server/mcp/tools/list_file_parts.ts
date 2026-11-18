import { describeFileRead } from '../../../layers/core/server/utils/file-read-identity'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { fileRefShape, requireFileRef } from '../../../layers/core/server/utils/file-agent-reference'
import { openFileStore } from '../../utils/mcp-files'

/**
 * `list_file_parts` —— 一份文件里含哪些**段**(票 18,只读)。
 *
 * 段 = `(称号, 事件类型, 年份, 批次, 附件, 行数)`,票 17 的粒度。实测 19 份经信局文件里
 * 7 份是多段 —— 例如《〔2024〕192号》= 「认定 2024/2(附件1)」+「复核 2021/2(附件2)」。
 * 代理要按段取年份/批次/事件(票 11 的输入契约),靠的就是这个 tool。
 *
 * 段为空数组是**正常**的:它表示「这份文件还没写出过段」,不表示「文件里没有名单」——
 * 那 2 份没有引用的 `.doc` 在票 11 解析前就是这个状态。
 */
export default defineMcpTool({
  name: 'list_file_parts',
  title: '文件的段明细',
  annotations: { readOnlyHint: true, openWorldHint: false },
  description: [
    '按 `fileId` 或 `relPath`(恰给其一)列出该文件里的**段**,按展示顺序排好(称号等级 → 事件 → 年份 → 批次 → 附件)。',
    '每段含 `titleCode` / `eventKind`(award 认定 / review 复核 / maintain 维护 / nurture 入库培育)/ `year` / `batch` / `attachment`(已归一为「附件」「附件N」)/ `rowCount`。',
    '`year` 是**内容**年份:复核段记的是**被复核的原始认定年份**(2024 年公布的「2021 年度第二批复核」这里就是 2021),不是公布年份。',
    '`parts: []` = 尚未写出段(不是「没有名单」)。',
  ].join('\n'),
  inputSchema: fileRefShape,
  handler: async (input) => {
    const { db, root } = await openFileStore()
    const { id, relPath, filename, parts, partsBinding } = requireFileRef(db, input, { allowRemoved: true })
    return { file: { id, relPath, filename }, parts, partsBinding, contentIdentity: await describeFileRead(db, root, relPath) }
  },
})
