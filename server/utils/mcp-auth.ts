import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * MCP 面的**鉴权判据**(票 18)。
 *
 * ── 口径 ────────────────────────────────────────────────────────────────
 * 常规只读 tool 不鉴权,写入 tool 必须带 token；提交回执等敏感只读工具也复用此凭据门禁。
 * 「MCP 是**代理的入口**,不是第二个写库通道」—— 只读是查询,写入是改库,
 * 两者的风险不对称,所以开关也不该是同一个。
 *
 * **token 未配置 ⇒ 写入整体关闭**(而不是「无 token 也能写」)。反向的默认
 * (空 token = 放行)会让一次忘记配置变成一次静默的公开写入口,那是这条判据
 * 最坏的失效方式;「忘了配 → 写不了」只是少个功能,报错文案会告诉你怎么开。
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────────────
 * `server/mcp/index.ts` 的中间件只做「把请求翻成鉴权状态」这一件事;判据本身
 * (头怎么读、怎么比、body 里哪个 tool 是写入)是**纯函数**,放这里可单测 ——
 * 中间件里写这些就只能靠起服务手测,而鉴权恰恰是那块最不能只靠手测的。
 *
 * ── 凭证不入库不入仓库 ──────────────────────────────────────────────────
 * token 只从 `NUXT_MCP_TOKEN`(→ `runtimeConfig.mcpToken`)读;仓库里只有
 * `.env.example` 占位。「凭证不入库」。
 */

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
  'refresh_enterprise_differences',
  'process_evidence_impacts',
  'release_evidence_rule',
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
  'preflight_comparison_scope_proofs',
  'commit_comparison_scope_proofs',
  'get_comparison_scope_proof_batch',
  // Protected read-only receipts share the existing credential gate.
  'get_roster_import_receipt',
  'list_roster_import_receipts',
  'list_roster_import_items',
  'get_roster_import_request',
  'patch_enterprise_profile',
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

/** 鉴权状态与理由。理由既进日志、也进 JSON-RPC 错误文案 —— 让人一眼看出是哪种没带。 */
export type McpAuthReason =
  /** 带了 token 且匹配。 */
  | 'authorized'
  /** 服务端**没配** `NUXT_MCP_TOKEN` —— 写入功能整体关闭。 */
  | 'no-token-configured'
  /** 服务端配了,但请求没带。 */
  | 'token-missing'
  /** 带了,但不匹配。 */
  | 'token-invalid'

export interface McpAuthState {
  /** 本次请求是否可以做**写入**。 */
  writeAuthorized: boolean
  reason: McpAuthReason
}

/** 取 token 的两个来源,按优先级。`authorization: Bearer <t>` 是 MCP/HTTP 的惯例。 */
export const MCP_TOKEN_HEADERS = ['authorization', 'x-mcp-token'] as const

/**
 * 从请求头里取 token。
 *
 * 认两种写法:
 *  - `Authorization: Bearer <token>`(`Bearer` 大小写不敏感,这是 OAuth/MCP 的惯例写法);
 *  - `Authorization: <token>` —— **裸 token**。MCP 的调试客户端(以及手搓 `curl`)
 *    常直接把这个头当 token 传,不认它会得到一个「明明带了却说没带」的报错。
 *  - `X-MCP-Token: <token>`(给不方便改 `Authorization` 的客户端留的退路)。
 *
 * 取不到(头缺失 / 空串 / 只有 `Bearer` 没有值)返回 `null`。
 */
export function readMcpToken(
  headers: Record<string, string | undefined> | undefined,
): string | null {
  for (const name of MCP_TOKEN_HEADERS) {
    const raw = headers?.[name]
    if (typeof raw !== 'string') continue
    const value = raw.trim()
    if (!value) continue
    // 只写了 `Bearer` 而没有值:这不是 token,当没带 —— 否则「Bearer」会被当成
    // 一个 token 去比对,报出来的错会是「token 不匹配」而不是「未带」,误导排查。
    if (/^bearer$/i.test(value)) continue
    const bearer = /^bearer\s+(.*)$/i.exec(value)
    const token = (bearer ? bearer[1]! : value).trim()
    if (token) return token
  }
  return null
}

/**
 * 恒定时间比较 token。
 *
 * 两边先各取 **SHA-256** 再比 —— 摘要恒为 32 字节,所以 `timingSafeEqual` 不会因为
 * 长度不同而立刻返回(`timingSafeEqual` 在长度不等时是**直接抛/立刻 false** 的,
 * 那就把「token 多长」泄出去了),比较次数也固定。
 *
 * 空口令一律不匹配 —— 「配了个空串」不该等于「人人可写」。
 */
export function tokenMatches(given: string | null, configured: string | null | undefined): boolean {
  if (!given || !configured) return false
  const a = createHash('sha256').update(given, 'utf8').digest()
  const b = createHash('sha256').update(configured, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/** 把「请求带来的 token」与「服务端配置的 token」折成鉴权状态。 */
export function resolveMcpAuth(input: {
  given: string | null
  configured: string | null | undefined
}): McpAuthState {
  if (!input.configured) return { writeAuthorized: false, reason: 'no-token-configured' }
  if (!input.given) return { writeAuthorized: false, reason: 'token-missing' }
  if (!tokenMatches(input.given, input.configured)) {
    return { writeAuthorized: false, reason: 'token-invalid' }
  }
  return { writeAuthorized: true, reason: 'authorized' }
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

/** 鉴权失败时给客户端的 JSON-RPC 错误文案。 */
export function unauthorizedMessage(tool: McpWriteTool, reason: McpAuthReason): string {
  switch (reason) {
    case 'no-token-configured':
      return `写入 tool "${tool}" 未启用:服务端没有配置 NUXT_MCP_TOKEN。只读 tool 不受影响。`
    case 'token-missing':
      return `写入 tool "${tool}" 需要鉴权:请求未带 token(Authorization: Bearer <token> 或 X-MCP-Token)。`
    case 'token-invalid':
      return `写入 tool "${tool}" 需要鉴权:提供的 token 不匹配。`
    default:
      return `写入 tool "${tool}" 需要鉴权。`
  }
}
