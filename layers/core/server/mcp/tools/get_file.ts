import { describeFileRead, describeFileReadAtLocator } from '../../utils/file-read-identity'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { fileRefShape, requireFileRef, requirePostgresFileRef } from '../../utils/file-agent-reference'
import { openFileStore } from '../../../../../server/mcp-file-store'
import { readPostgresFileIdentity, usePostgresFileDb } from '../../utils/file-store-postgres'

/**
 * `get_file` —— 一个文件的完整元数据(票 18,只读)。
 *
 * 比 `list_files` 多的是「**已移出库**的文件也认」:它是个查详情的能力,
 * 「这文件还在不在库里」正是要查的信息之一(`removedAt` 会如实返回)。
 */
export default defineMcpTool({
  name: 'get_file',
  title: '文件详情',
  annotations: { readOnlyHint: true, openWorldHint: false },
  description: [
    '按 `fileId` 或 `relPath` 取一个文件的完整元数据(含引用数与 `parts`)。两者**恰给其一**。返回 `displayName`(用户可见名称)与 `filename`(磁盘文件名)。',
    '`relPath` 与 `record_evidence.source_file` 同口径,如 `jxj/announcement/2024/2/甬经信中小〔2024〕192号….pdf`。',
    '改用户可见名称请用 `PATCH /api/files/{id}` 的 `displayName`;该操作追加审计记录,不改变 `stored_file.id`、磁盘文件名/路径或出处。',
    '`removedAt` 非空表示该文件已被移出库(软删除,磁盘文件通常还在)。',
  ].join('\n'),
  inputSchema: fileRefShape,
  handler: async (input) => {
    const pg = usePostgresFileDb()
    if (pg) {
      const row = await pg.transaction(tx => requirePostgresFileRef(tx, input, { allowRemoved: true }),
        { isolationLevel: 'repeatable read', accessMode: 'read only' })
      const contentIdentity = await describeFileReadAtLocator(useRuntimeConfig().filesDir, row.relPath, path => readPostgresFileIdentity(pg, path))
      return { ...row, contentIdentity }
    }
    const { db, root } = await openFileStore()
    // 读 tool:已移出库的文件也认(见上)。
    const row = requireFileRef(db, input, { allowRemoved: true })
    // 摊平成对象字面量再返回:tool handler 的返回类型是 `Record<string, unknown>`,
    // 而 `StoredFileRow` 是 interface(没有隐式索引签名),直接返回过不了类型检查。
    const contentIdentity = await describeFileRead(db, root, row.relPath)
    return { ...row, contentIdentity }
  },
})
