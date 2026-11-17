import { dispositionSchemas, dispositionToolActions } from '../utils/title-cycle-disposition-protocol'
import toolkitConfig from '#nuxt-mcp-toolkit/config.mjs'
import { useEvent } from 'nitropack/runtime'
import { isSessionEvent } from '../utils/mcp-session-runtime'
import { officialEvidenceRpcError } from '../utils/official-evidence-read'
import { runtimeLogPolicyRpcError } from '../utils/logging-mcp'
import { decisionRpcError102 } from '../utils/decision-lifecycle-102-mcp'
import { qualificationPreflight102, qualificationCommit102 } from '../utils/decision-lifecycle-102'
import { parseRpcError105 } from '../utils/parse-maintenance-105-rpc'
import { admitEnterpriseResponse } from '../utils/enterprise-read-response'
import { eventCorrectionRpcError } from '../utils/mcp-event-correction'
import { platformQueryRpcError } from '../utils/mcp-platform-query'
import { currentQualifiedRpcError } from '../utils/current-qualified-filter'
import { getHeader, getMethod, readBody, setHeader } from 'h3'
import { defineMcpHandler, getMcpTools, getMcpResources, getMcpPrompts } from '@nuxtjs/mcp-toolkit/server'
import { requestLogContext } from '../../lib/logging'
import { applyMcpLogMetadata } from '../utils/mcp-log-context'
import { logSemanticOperation, semanticErrorCode } from '../utils/semantic-operation-log'
import {
  MCP_WRITE_TOOLS,
  readMcpToken,
  resolveMcpAuth,
  unauthorizedMessage,
  writeToolCallIn,
  type McpAuthState,
  type McpAuthReason,
  type McpWriteTool,
} from '../utils/mcp-auth'

/**
 * MCP server 的**默认 handler**(票 18):`POST /mcp`。
 *
 * 这个文件只做两件事 —— 定义 server 的身份/说明书,以及**写入的鉴权**。
 * 每个能力一个文件,在 `server/mcp/tools/` 下声明;本文件不含任何业务逻辑。
 *
 * ── 鉴权(票 18 的硬约束)────────────────────────────────────────────────
 * **只读 tool 不鉴权,写入 tool 必须带 token。** 这里的中间件做三件事:
 *
 *  1. 把请求翻成 `event.context.mcpAuth`(见 `server/utils/mcp-auth.ts`);
 *  2. 若是 `tools/call` 打向写入 tool 而鉴权不过 → **直接回 HTTP 401**;
 *  3. 其余原样放行。
 *
 * 第 2 步是「明面上的拒绝」,但它**不是**唯一的防线:每个写入 tool 自己还有
 * `enabled` 守卫(未鉴权时连 `tools/list` 都不列出来)。两道同判据,免得将来某一道忘了改。
 * (没有第三道 handler 内的复查 —— MCP 的 tool handler 拿不到请求头,复查不出「本次请求
 * 带没带 token」;写一条复查不了自己前提的检查只会是摆设,所以不写。)
 *
 * ── 为什么第 2 步要读 body ───────────────────────────────────────────────
 * 想让「未带鉴权的写入」得到一个**可实测的状态码**,就得在转发之前知道这次调的是哪个
 * tool —— 那信息只在 JSON-RPC body 里。读 body 是安全的:h3 的 `readBody` 把结果
 * 缓存在 `req[RawBodySymbol]` 上,而 transport 侧的 `getRequestWebStream` 正是从这个
 * 缓存取的(见 `providers/node.js` 的 `toWebRequest`),所以下游仍能拿到完整 body。
 */
export default defineMcpHandler({
  resources: event => isSessionEvent(event) ? [] : getMcpResources({ event, orphansOnly: toolkitConfig.defaultHandlerStrategy === 'orphans' }),
  prompts: event => isSessionEvent(event) ? [] : getMcpPrompts({ event, orphansOnly: toolkitConfig.defaultHandlerStrategy === 'orphans' }),
  tools: async configuredEvent => (await getMcpTools()).filter(tool => !isSessionEvent(configuredEvent) || ['list_enterprises', 'get_enterprise_detail'].includes(tool.name ?? '')).map(tool => ({
    ...tool,
    ...(tool.name && tool.name in dispositionToolActions ? { inputSchema: dispositionSchemas[dispositionToolActions[tool.name as keyof typeof dispositionToolActions]] as unknown as NonNullable<typeof tool.inputSchema> } : {}),
    // Toolkit 0.24 types expose only raw shapes, but its registration forwards
    // schemas unchanged to SDK 1.32, which accepts full Zod objects. Preserve
    // strict root keys/refinements for these two qualification protocols.
    ...(tool.name === 'preflight_qualification_decision' ? { inputSchema: qualificationPreflight102 as unknown as NonNullable<typeof tool.inputSchema> }
      : tool.name === 'commit_qualification_decision' ? { inputSchema: qualificationCommit102 as unknown as NonNullable<typeof tool.inputSchema> } : {}),
    handler: async (...args: Parameters<typeof tool.handler>) => {
      const event = isSessionEvent(configuredEvent) ? useEvent() : configuredEvent
      if (isSessionEvent(configuredEvent) && !isSessionEvent(event)) throw new Error('session_context_missing')
      const operation = `mcp.tool.${tool.name}`
      const started = performance.now()
      try {
        // Conditional protected fields on these two otherwise public tools also need
        // the request's established auth when invoked through another toolkit path.
        if (['get_roster_evidence','get_official_event'].includes(tool.name??'') && args[0] && typeof args[0]==='object' && 'official' in args[0]
          && (event.context.mcpAuth as {writeAuthorized?:boolean}|undefined)?.writeAuthorized!==true) {
          throw Object.assign(new Error(JSON.stringify({error:{code:'unauthorized',message:'Configured MCP token required'}})),{code:'unauthorized',statusCode:401})
        }
        const result = await tool.handler(...args)
        if (!LOG_TOOLS.has(tool.name!)) logSemanticOperation('mcp', operation, requestLogContext(event), started, result)
        event.context.semanticMcpLogged = true
        return result
      } catch (error) {
        if (!LOG_TOOLS.has(tool.name!)) logSemanticOperation('mcp', operation, requestLogContext(event), started, error, undefined, true)
        event.context.semanticMcpLogged = true
        // Keep existing domain errors; arbitrary initialization/third-party errors must
        // not reach the toolkit's default Error.message-to-text converter.
        const code = semanticErrorCode(error)
        const status = error && typeof error === 'object'
          ? ('statusCode' in error ? error.statusCode : 'status' in error ? error.status : undefined)
          : undefined
        const domainError = code || (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599)
        if (domainError && !['invalid_request', 'alias_input_invalid'].includes(code ?? '')) throw error
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: code ?? 'internal_error', message: code ? 'Invalid operation request' : 'Operation failed' } }) }] }
      }
    },
  })),
  name: 'spztx-roster-board',
  version: '1.0.0',
  description:
    '专精特新台账看板的**文件库 + 名录**入口:查文件与文件里的段、查 PDF 页图与 OCR 结果、' +
    '把分类 / 解析结果 / OCR 结果写回,以及经**统一写入路径**提交清理后的名录批次',
  instructions: [
    '这个 server 暴露两层能力:**文件库**(上传文件 → 页图 → OCR → 解析段)与' +
    '**名录**(企业 / 曾用名 / 称号事件 / 出处 / 平台证据 / 导出快照 / 差异解释)。',
    '运行日志：list_runtime_logs/get_runtime_log/get_runtime_log_policy/set_runtime_log_policy/clear_runtime_logs 均需MCP token；只影响独立运行日志，不能代替业务审计。',
    '',
    '差异决定维护：save_difference_decision 显式替代/撤回，必填 expectedCurrentId、actor、basis、ruleVersion、effectiveAt 与幂等键。',
    'get_current_difference_decision / get_difference_decision / list_difference_decision_history 读当前及稳定 ID 历史；preview_legacy_difference_decisions 只读映射/冲突，旧标注不等于 confirmed_no_diff。',
    '旧 comparison/curated PATCH 对未接管坐标保持兼容；已接管坐标返回409 decision_lifecycle_required；旧标注不等同正式决定，生产迁移需另授权。',
    '',
    '典型流程:',
    '1. `list_files` 找到目标文件(拿 `id` 或 `relPath`);',
    '2. `get_file` / `list_file_parts` 看它的元数据与**段**(一份公布文件常含多年份、多事件);',
    '3. `list_page_images` 拿 PDF 每页的 PNG(已渲染时直接给 URL,未渲染时 `rendered: 0`);',
    '4. 识别之后用 `save_ocr_result` **按页**写回结果、`set_file_category` 回写分类、',
    '   当前解析先读文件/`get_ocr_result`实际采用页版本,用`preflight_file_parse_result`冻结输入,再`commit_file_parse_result`带原inputRef/独立expectedVersion/幂等键/actor/reason提交全部段。输入冲突必须重读,不得改用兼容口绕过。`save_parse_result`保留旧载荷和状态更正;缺血缘的兼容解析写记unknown。审计用`get_file_parse_history`;',
    '   OCR 单页重做:读页图→save_ocr_result {fileId,page,markdown,expectedVersion};delete_ocr_result 只删一页派生结果,保留来源与台账。',
    '   expectedVersion 取 get_ocr_result {includeVersion:true} 的 results[].version;冲突409须重新读。代理 REST 对等入口 /api/files/{id}/ocr-pages/{page},写入用独立 API token。',
    '5. 名单纠偏完成后,用 `preflight_roster_batch` **先预检**(只算影响、不写业务数据),',
    '   确认无误再用 `save_roster_batch` **提交**(单批事务 + 幂等键);',
    '   写完之后用 `list_enterprises` / `query_records` / `get_enterprise_detail` /',
    '   `list_differences` 核对企业、称号事件、出处与解释。',
    '- 导入断线后用 `get_roster_import_receipt` 按 batchId/原幂等键恢复状态；`list_roster_import_items` 分页核对逐项结果，`list_roster_import_receipts` 读历史，`get_roster_import_request` 按需读取脱敏原文块。这四个工具均只读且需要 MCP token，不会重新提交。',
    '- `get_platform_capabilities` 查看实时来源能力；`query_platform` 查询三来源记录（不写库，不接收Cookie）。失败/partial须补查unfinished，不能当无记录。',
    '- 批量查询用 `submit_platform_batch`，然后 `get_platform_batch` / `get_platform_batch_item`；只对unfinished显式 `retry_platform_batch`。提交/重试需MCP token；凭据仅服务端快照。',
    '- 精确正式读回：get_roster_evidence 可选 official=latest|history，get_official_event 可选 official=latest；这些新增投影需 MCP token，旧不带 official 的读法仍公开。history beforeRevision/event afterEvidenceId，pageSize默认20最高50，maxBytes默认16384最高65536。list_roster_import_items 的 projection=snapshot|eventIds 必须显式 source=private_batch+batchId 或 redacted_receipt+receiptId、itemIndex、oldRecordId；eventIds 单独cursor分页，receipt缺快照不回退。',
    '- 正式事件更正先 `get_official_event`，再 `preflight_event_corrections` / `commit_event_corrections`；需独立 MCP token，传原 request+planHash；原出处保留，关联对应需显式重核。审计用 `get_event_correction_audit` 分页。',
    '- 正式出处更正先 `get_roster_evidence`，再 `preflight_roster_evidence_corrections` / `commit_roster_evidence_corrections`；需 MCP token，按证据/事件/记录/企业ID和version定位，不能用裸名单序号。审计用 `get_roster_evidence_audit`；回执用 `get_roster_evidence_correction_batch`。坐标改回原值仍须显式重核关联对应。',
    '- `query_records` 是通用企业×称号记录查询；`year` 筛事件年份，`dueYear` 筛生命周期到期年份。',
    '  详情请用 `get_enterprise_detail`，它与 REST 企业详情共用读模型。',
    '- 企业普通资料更正：`get_enterprise_profile` 取版本，再用需 token 的 `patch_enterprise_profile`；历史用 `get_enterprise_profile_history` 分页核对。仅 name/city/district；更名明确确认旧名，同事务保留旧名与审计，不补统代或归并。',
    '- 企业别名维护：`list_enterprise_aliases` / `get_enterprise_alias` 读取版本，再用需 token 的 `maintain_enterprise_alias` 显式确认、更正、撤回或恢复；历史用 `get_enterprise_alias_history` 分页核对。保留原名与原来源，withdrawn 不自动恢复。',
    '',
    '- `get_file_maintenance` 读维护修订和有界历史；`update_file` 更新分类或显示名，`remove_file` 软移出，`restore_file` 核验原字节后恢复。',
    '  三个新增维护写工具需要 MCP token，必须同时提供 expectedRevision/idempotencyKey/actor/basis。原 set_file_category 载荷保留 legacy 适配。quarantine_file 显式隔离原字节，recover_file 按 intentId 验证 SHA+bytes 恢复；两者需完整版本封套。get_file_physical_intent 读取待处理状态/完成回执。隔离不永久擦除；',
    '边界(重要):',
    '- **写入前需要 token**:`save_ocr_result` / `delete_ocr_result` / `set_file_category` / `save_parse_result` /',
    '  `save_roster_batch` / `submit_platform_batch` / `retry_platform_batch` 需要 `Authorization: Bearer <NUXT_MCP_TOKEN>`,未带时这几个 tool',
    '  不会出现在 `tools/list` 里,强行调用会得到 HTTP 401。只读 tool(含只读预检',
    '  `preflight_roster_batch`)不需要；导入回执四工具含提交证据，仍需 MCP token，且保持 readOnlyHint=true。',
    '- 名录来源导入经 `save_roster_batch`；既有资源经明确领域维护命令：普通企业资料用 `patch_enterprise_profile`，已接管的差异决定用 `save_difference_decision`，旧导入不能覆盖。',
    '  不要绕过应用服务直写库。导入载荷见',
    '  `lib/roster-import-client.ts`;证据不足一律**留空并标待核**,',
    '  不要猜填、不要为填满字段而复制来源里没有的值。',
    '- `year` / `batch` 在文件级是**公布**年份/批次(目录给的、单值);文件**内容**里的年份/批次',
    '  一律看 `parts`(段)。别把两者混用。',
    '- `save_ocr_result` 的页号**要显式给**(或让 markdown 自带 `<!-- page: N -->` 标记)',
    '  —— 页号是「出处能显示第几页」的锚点,猜不得。',
  ].join('\n'),
  middleware: async (event, next) => {
    const started = performance.now()
    let operation: string | undefined
    const finish = (response: Response, code: string) => {
      if (operation) logSemanticOperation('mcp', operation, requestLogContext(event), started, { error: { code } }, response.status)
      return response
    }
    setHeader(event, 'cache-control', 'no-store')
    const auth = resolveMcpAuth({
      given: readMcpToken({
        authorization: headerOf(event, 'authorization'),
        'x-mcp-token': headerOf(event, 'x-mcp-token'),
      }),
      configured: useRuntimeConfig().mcpToken,
    })
    event.context.mcpAuth = auth

    if (METHODS_WITH_BODY.has(getMethod(event)) && (getHeader(event, 'content-type') ?? '').toLowerCase().includes('json')) {
      const body = await readBody(event, { strict: false }).catch(() => undefined)
      const knownTools = new Set((await getMcpTools()).flatMap(def => typeof def.name === 'string' ? [def.name] : []))
      // One place knows the actual initialize body and the static registry; the
      // toolkit's evlog metadata remains the transport/method source of truth.
      applyMcpLogMetadata(event, body, knownTools)
      const tool = body?.method === 'tools/call' ? body?.params?.name : undefined
      if (LOG_TOOLS.has(tool)) {
        event.context._evlogShouldEmit = false
      } else if (typeof tool === 'string') {
        // Match a static registered name; unknown client-supplied names never enter logs.
        operation = knownTools.has(tool) ? `mcp.tool.${tool}` : 'mcp.tool.unknown'
      } else if (Array.isArray(body) && body.some(entry => entry?.method === 'tools/call' && !LOG_TOOLS.has(entry?.params?.name))) {
        operation = 'mcp.tool.batch'
      }
      const invalidOfficialRead=officialEvidenceRpcError(body,auth.writeAuthorized)
      if(invalidOfficialRead) return finish(invalidOfficialRead,invalidOfficialRead.status===401?'unauthorized':'invalid_request')
      const invalidCurrentQualified = currentQualifiedRpcError(body)
      if (invalidCurrentQualified) return finish(invalidCurrentQualified, 'invalid_request')
      if (body?.method === 'tools/call' && ['list_enterprises','get_enterprise_detail','list_current_qualified_enterprises'].includes(body?.params?.name)) admitEnterpriseResponse(event)
      const invalidDecision = decisionRpcError102(body)
      if (invalidDecision) return finish(invalidDecision, 'invalid_request')
      const invalidParse = parseRpcError105(body)
      if (invalidParse) return finish(invalidParse, 'invalid_request')
      const invalidEventCorrection = eventCorrectionRpcError(body)
      if (invalidEventCorrection) return finish(invalidEventCorrection, 'invalid_request')
      const invalidQuery = platformQueryRpcError(body)
      if (invalidQuery) return finish(invalidQuery, 'invalid_request')
    }
    if (!auth.writeAuthorized) {
      const called = await writeToolCalledIn(event)
      if (called) return finish(unauthorizedResponse(called, auth.reason), 'unauthorized')
    }
    if (METHODS_WITH_BODY.has(getMethod(event)) && (getHeader(event, 'content-type') ?? '').toLowerCase().includes('json')) {
      const invalidPolicy = runtimeLogPolicyRpcError(await readBody(event, { strict: false }).catch(() => undefined))
      if (invalidPolicy) return invalidPolicy
    }
    try {
      const response = await next()
      // SDK argument validation and unknown tools reject before invoking a handler.
      if (operation && !event.context.semanticMcpLogged) finish(response, 'invalid_request')
      return response
    } catch (error) {
      if (operation && !event.context.semanticMcpLogged) logSemanticOperation('mcp', operation, requestLogContext(event), started, error, 500, true)
      throw error
    }
  },
})

function headerOf(event: Parameters<typeof getHeader>[0], name: string): string | undefined {
  const value = getHeader(event, name)
  return typeof value === 'string' ? value : undefined
}

/** 有 body 的方法(与 h3 的 `PayloadMethods` 同集:GET 的 SSE 流不进这里)。 */
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const LOG_TOOLS = new Set(['list_runtime_logs', 'get_runtime_log', 'get_runtime_log_policy', 'set_runtime_log_policy', 'clear_runtime_logs'])

/**
 * 这次请求是不是在调写入 tool。读不出来(方法/类型不对、JSON 坏了)**一律返回 `null`** ——
 * 见 `writeToolCallIn` 的注释:这一处宁可漏判,交给 tool 自己的守卫兜底,不要误判。
 */
async function writeToolCalledIn(event: Parameters<typeof getMethod>[0]): Promise<McpWriteTool | null> {
  if (!METHODS_WITH_BODY.has(getMethod(event))) return null
  const contentType = getHeader(event, 'content-type') ?? ''
  if (!contentType.toLowerCase().includes('json')) return null
  const body = await readBody(event, { strict: false }).catch(() => undefined)
  return writeToolCallIn(body)
}

/**
 * 未鉴权写入的拒绝:HTTP **401** + 一条 JSON-RPC 错误(客户端既看得到状态码,
 * 也看得到「是哪一种没带」的中文原因)。
 */
function unauthorizedResponse(tool: McpWriteTool, reason: McpAuthReason): Response {
  const state: McpAuthState = { writeAuthorized: false, reason }
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        // 服务端自定义错误段(-32000 起)。MCP 没有为「写入未鉴权」保留标准码,
        // 真正要紧的是 HTTP 401 与下面这句话。
        code: -32001,
        message: unauthorizedMessage(tool, reason),
        data: { tool, reason: state.reason, writeTools: MCP_WRITE_TOOLS },
      },
      id: null,
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="mcp-write"',
        'cache-control': 'no-store',
      },
    },
  )
}
