import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { normalizeAttachment } from '../../lib/attachment'
import { compareParts, partKey } from '../../lib/file-parts'
import type { EventKind, FilePart } from '../../../../db/file-part'
import { EVENT_ORDER, TITLE_ORDER } from '../../lib/labels'
import type { ParseState } from '../../lib/stored-file'
import { derivedPartsForFile } from './file-parts'
import { PARSE_STATES } from '../modules/sme-roster/files'

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

/** 一个段的写入输入。`year` / `batch` / `attachment` 可空(导出表无附件)。 */
export interface ParsePartInput {
  titleCode: string
  eventKind: string
  year?: number | null
  batch?: number | null
  attachment?: string | null
  /** 该段行数。省略为 0(代理只判段、不数行是合法情形)。 */
  rowCount?: number
}

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

/** 校验一个段;失败给中文原因。`null` 表示通过。 */
function validatePart(raw: ParsePartInput, index: number): string | null {
  const at = `parts[${index}]`
  if (!raw || typeof raw !== 'object') return `${at} 必须是对象`
  if (!TITLE_ORDER.includes(raw.titleCode)) {
    return `${at}.titleCode 不在称号白名单(${TITLE_ORDER.join(' / ')}):${raw.titleCode}`
  }
  if (!EVENT_ORDER.includes(raw.eventKind)) {
    return `${at}.eventKind 不在事件白名单(${EVENT_ORDER.join(' / ')}):${raw.eventKind}`
  }
  const year = raw.year
  if (year !== undefined && year !== null) {
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      return `${at}.year 必须是 1900–2100 的整数或 null:${year}`
    }
  }
  const batch = raw.batch
  if (batch !== undefined && batch !== null) {
    if (!Number.isInteger(batch) || batch <= 0) {
      return `${at}.batch 必须是正整数或 null:${batch}`
    }
  }
  const rowCount = raw.rowCount
  if (rowCount !== undefined && (!Number.isInteger(rowCount) || rowCount < 0)) {
    return `${at}.rowCount 必须是非负整数:${rowCount}`
  }
  return null
}

/**
 * 把输入规整成待写入的段:校验 → 附件名归一 → 去重 → 排序。
 *
 * **同一坐标给两遍是错误**(不是自动合并):`stored_file_part` 坐标有唯一索引,
 * 默默求和会让「代理写重了一段」变成一份看不出问题的行数,不如直接报错。
 * 归一见 `layers/sme-roster/lib/attachment.ts`(「附 件 1」与「附件1」必须并成同一段)。
 */
export function normalizeParseParts(
  raw: readonly ParsePartInput[],
): { ok: true; parts: FilePart[] } | { ok: false; message: string } {
  const parts: FilePart[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]!
    const bad = validatePart(item, i)
    if (bad) return { ok: false, message: bad }
    const part: FilePart = {
      titleCode: item.titleCode,
      eventKind: item.eventKind as EventKind,
      year: item.year ?? null,
      batch: item.batch ?? null,
      attachment: normalizeAttachment(item.attachment),
      rowCount: item.rowCount ?? 0,
    }
    const key = partKey(part)
    if (seen.has(key)) {
      return {
        ok: false,
        message: `parts[${i}] 与前面的段重复(同称号/事件/年份/批次/附件):${key.replaceAll('\u0000', '∅')}`,
      }
    }
    seen.add(key)
    parts.push(part)
  }
  return { ok: true, parts: parts.sort(compareParts) }
}

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

      const agentByKey = new Map(parts.map((part) => [partKey(part), part]))
      const derivedKeys = new Set<string>()
      for (const part of derivedParts) {
        const key = partKey(part)
        const agent = agentByKey.get(key)
        if (agent) {
          derivedKeys.add(key)
          tx.insert(schema.storedFilePart)
            .values({
              fileId,
              ...agent,
              origin: 'agent',
              hasConflict: agent.rowCount !== part.rowCount,
            })
            .run()
        } else {
          tx.insert(schema.storedFilePart)
            .values({ fileId, ...part, origin: 'derived', hasConflict: false })
            .run()
        }
      }

      for (const part of parts) {
        if (derivedKeys.has(partKey(part))) continue
        tx.insert(schema.storedFilePart)
          .values({
            fileId,
            ...part,
            origin: 'agent',
            hasConflict: false,
          })
          .run()
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
