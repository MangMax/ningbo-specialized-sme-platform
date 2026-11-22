import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import type { FilePart } from '../../../../db/file-part'
import type { ParseState } from '../../lib/stored-file'
import { derivedPartsForFile } from './file-parts'
import { PARSE_STATES } from '../modules/sme-roster/files'
import { mergeParseParts, normalizeParseParts, type ParsePartInput } from './parse-result-model'

export * from './parse-result-model'

type Db = BetterSQLite3Database<typeof schema>

/**
 * **解析结果写回**(票 18 的 `save_parse_result`)。
 *
 * ── 边界(硬约束,票 18 写死)──────────────────────────────────────────
 * 只写**文件级的解析产物**:
 *  - `stored_file_part`(这份文件里有哪些段)重建;
 *  - `roster_file_classification.parse_state`(解析到哪一步了)。
 *
 * **绝不**碰 `record` / `record_event` / `record_evidence` / `enterprise` —— 也就是说,
 * 它落的是「这份文件里**写了什么**」,不是「谁被认定了」。从文件到台账记录(以及
 * 随之而来的身份归并)仍只走 pipeline 的导入路径,守
 * 单一来源不得触发归并。
 * tests/mcp-surface.test.ts 里有一条断言把这一点钉死:调用前后
 * `record` / `enterprise` / `record_evidence` 的行数必须**一个都不变**。
 *
 * ── 与票 17 / 20 的关系 ─────────────────────────────────────────────────
 * `stored_file_part` 本来是**由 `record_evidence` 聚合派生**的(票 17:
 * `layers/sme-roster/server/utils/file-parts.ts` 的 `backfillFileParts`)。代理写入是另一条路径:
 * 解析结果全量替换代理段,同时按当前 evidence 重建派生集合;同坐标由代理段承接,行数不同时
 * 标记 `hasConflict`。回填可重复运行,只重建派生段。见票 20。
 */

/** 一次解析结果写回。`parts` 与 `parseState` **至少给一个**。 */
export interface ParseResultInput {
  /** 整份文件里**全部**的段:**全量替换**(没列出的段会被删掉),空数组 = 这份文件没有段。 */
  parts?: ParsePartInput[]
  /** 解析状态。省略时:给了 `parts` 就置 `parsed`,只改状态时才必填。 */
  parseState?: string
}

/** 写入结果。失败给**给人看的中文原因**,由 tool 转成 MCP 错误。 */
export type ParseResultWrite =
  | { ok: true; parts: FilePart[]; parseState: ParseState }
  | { ok: false; message: string }

/**
 * `parse_state` 的合法取值。**直接取自 `stored-files.ts` 的 `PARSE_STATES`** ——
 * 那是这套枚举的唯一来源(页面筛选、PATCH、这里三处共用),再写一份就会漂移。
 * 收窄成 `readonly string[]` 是因为这里校验的是**未定类型的输入**(`input.parseState`
 * 来自 MCP 客户端),不是已定类型的 `ParseState`。
 */
const PARSE_STATE_LIST: readonly string[] = PARSE_STATES

/**
 * 写回一份文件的解析结果。**全量替换**该文件的代理段,并从当前 evidence 重建派生集合;
 * 同坐标由代理段承接,并按需改 `parse_state`。
 *
 * 事务内重建派生集合与代理段;同坐标由代理段取代,行数不同时标记冲突。重放同样的输入
 * 结果完全一致,省略旧代理段后对应的 evidence 派生段会恢复,中途失败也不会留下半成品。
 */
export function applyParseResult(
  db: Db,
  fileId: number,
  input: ParseResultInput,
): ParseResultWrite {
  const hasParts = input.parts !== undefined
  const rawState = input.parseState
  if (!hasParts && rawState === undefined) {
    return { ok: false, message: '至少给 `parts` 或 `parseState` 之一' }
  }
  if (rawState !== undefined && !PARSE_STATE_LIST.includes(rawState)) {
    return { ok: false, message: `parseState 不在白名单(${PARSE_STATE_LIST.join(' / ')}):${rawState}` }
  }
  // 给了段却没给状态 ⇒ 这次就是「解析完成」;只改状态的处理方式见下。
  const parseState = (rawState ?? 'parsed') as ParseState

  let parts: FilePart[] = []
  if (hasParts) {
    const normalized = normalizeParseParts(input.parts ?? [])
    if (!normalized.ok) return { ok: false, message: normalized.message }
    parts = normalized.parts
  }
  db.transaction((tx) => {
    const derivedParts = hasParts ? derivedPartsForFile(tx as Db, fileId) : []
    if (hasParts) {
      tx.delete(schema.storedFilePart)
        .where(eq(schema.storedFilePart.fileId, fileId))
        .run()

      for (const part of mergeParseParts(parts, derivedParts)) {
        tx.insert(schema.storedFilePart).values({ fileId, ...part }).run()
      }
    }
    if (rawState !== undefined || hasParts) {
      tx.update(schema.rosterFileClassification)
        .set({ parseState })
        .where(eq(schema.rosterFileClassification.fileId, fileId))
        .run()
    }
  })

  return { ok: true, parts, parseState }
}
