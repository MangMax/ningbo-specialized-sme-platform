/**
 * 受保护 tool 的名单（保留历史导出名 MCP_WRITE_TOOLS）—— **单一来源**。三个作用:
 *  1. 未带合法 token 时,中间件据此拒掉对应的 `tools/call`(HTTP 401);
 *  2. 各写入 tool 的 `enabled` 守卫据此决定要不要出现在 `tools/list` 里;
 *  3. 测试据此断言「名单恰好是这几个」。
 *
 * 新增写入 tool 时必须同时改这里,否则它会变成**绕过鉴权**的写入口 ——
 * 所以测试里有一条断言把名单钉死(`tests/mcp-surface.test.ts` 的「写入 tool 名单就是
 * 票 18 的那三个」)。
 *
 * RL-11 追加 `save_roster_batch`(名录统一写入):它改的是**名录实体**
 * (`enterprise` / `record` / `record_event` / …),比文件元数据更重,必须有 token。
 * 同批注册的 `preflight_roster_batch` 是**只读预检**(契约 §9 如此归类),不在此列。
 */
export const MCP_WRITE_TOOLS = [
  'list_runtime_logs',
  'get_runtime_log',
  'get_runtime_log_policy',
  'set_runtime_log_policy',
  'clear_runtime_logs',
  'save_difference_decision',
  'preflight_qualification_decision',
  'commit_qualification_decision',
  'difference_snapshot',
  'maintain_enterprise_alias',
  'save_ocr_result',
  'delete_ocr_result',
  'set_file_category',
  'update_file',
  'remove_file',
  'restore_file',
  'quarantine_file',
  'recover_file',
  'save_parse_result',
  'preflight_file_parse_result',
  'commit_file_parse_result',
  'save_roster_batch',
  'submit_platform_batch',
  'retry_platform_batch',
  'submit_event_archive_candidate_task',
  'retry_event_archive_candidate_task',
  'cancel_event_archive_candidate_task',
  'submit_event_annual_correspondence_task',
  'retry_event_annual_correspondence_task',
  'cancel_event_annual_correspondence_task',
  'preflight_record_correspondences',
  'save_record_correspondences',
  'preflight_event_corrections',
  'commit_event_corrections',
  'get_record_correspondence_batch',
  // Protected read-only receipts share the existing credential gate.
  'get_roster_import_receipt',
  'list_roster_import_receipts',
  'list_roster_import_items',
  'patch_enterprise_profile',
  'preflight_title_cycle_disposition',
  'commit_title_cycle_disposition',
  'preflight_enterprise_fact',
  'commit_enterprise_fact',

  'preflight_roster_evidence_corrections',
  'commit_roster_evidence_corrections',
  'get_roster_evidence_correction_batch',
] as const

/** 写入 tool 名(字面量联合)。 */
export type McpWriteTool = (typeof MCP_WRITE_TOOLS)[number]

/** 判据:`name` 是不是写入 tool。 */
export function isMcpWriteTool(name: string): name is McpWriteTool {
  return (MCP_WRITE_TOOLS as readonly string[]).includes(name)
}

/** 一条 JSON-RPC 消息里,本次调用的是不是写入 tool。 */
function writeToolCallOf(message: unknown): McpWriteTool | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null
  const m = message as { method?: unknown; params?: unknown }
  if (m.method !== 'tools/call') return null
  if (!m.params || typeof m.params !== 'object') return null
  const name = (m.params as { name?: unknown }).name
  return typeof name === 'string' && isMcpWriteTool(name) ? name : null
}

/**
 * 从 JSON-RPC 请求体里找出「本次要调用的写入 tool」;不是写入调用(或读不出来)返回 `null`。
 *
 * 单条消息与批量数组都认(MCP 的 Streamable HTTP 现在只发单条,但报文格式允许数组,
 * 漏掉数组就等于漏掉一条绕过鉴权的路)。
 *
 * **读不出来一律当「不是写入」** —— 这一处刻意宽松:它只用来**决定要不要提前 401**,
 * 不是唯一的防线。真正的防线是每个写入 tool 自己的 `enabled` 守卫 + handler 复查,
 * 所以这里宁可漏判(交给下一道),不要误判(把只读请求也 401 掉)。
 */
export function writeToolCallIn(body: unknown): McpWriteTool | null {
  if (Array.isArray(body)) {
    for (const message of body) {
      const hit = writeToolCallOf(message)
      if (hit) return hit
    }
    return null
  }
  return writeToolCallOf(body)
}

export const sessionReadTools: readonly string[] = ['list_enterprises', 'get_enterprise_detail']
