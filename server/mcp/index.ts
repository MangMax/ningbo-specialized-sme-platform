import { getHeader, getMethod, readBody } from 'h3'
import { defineMcpHandler } from '@nuxtjs/mcp-toolkit/server'
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
  name: 'spztx-roster-board',
  version: '1.0.0',
  description:
    '专精特新台账看板的**文件库**入口:查文件与文件里的段、查 PDF 页图与 OCR 结果,' +
    '以及把分类 / 解析结果 / OCR 结果写回。',
  instructions: [
    '这个 server 暴露的是「文件库」这一层的能力,不是台账记录的写入口。',
    '',
    '典型流程:',
    '1. `list_files` 找到目标文件(拿 `id` 或 `relPath`);',
    '2. `get_file` / `list_file_parts` 看它的元数据与**段**(一份公布文件常含多年份、多事件);',
    '3. `list_page_images` 拿 PDF 每页的 PNG(已渲染时直接给 URL,未渲染时 `rendered: 0`);',
    '4. 识别之后用 `save_ocr_result` **按页**写回结果、`set_file_category` 回写分类、',
    '   `save_parse_result` 写回解析出的段;要回看识别结果用 `get_ocr_result`。',
    '',
    '边界(重要):',
    '- **写入前需要 token**:`save_ocr_result` / `set_file_category` / `save_parse_result` 需要',
    '  `Authorization: Bearer <NUXT_MCP_TOKEN>`,未带时这三个 tool 不会出现在 `tools/list` 里,',
    '  强行调用会得到 HTTP 401。只读 tool 不需要。',
    '- 写入**只碰文件元数据、解析结果、OCR 结果**。台账记录(`record`)与企业身份归并',
    '  (`enterprise`)**只能由 pipeline 写入** —— 拿不准就空值 + 标记,不要在这里硬补。',
    '- `year` / `batch` 在文件级是**公布**年份/批次(目录给的、单值);文件**内容**里的年份/批次',
    '  一律看 `parts`(段)。别把两者混用。',
    '- `save_ocr_result` 的页号**要显式给**(或让 markdown 自带 `<!-- page: N -->` 标记)',
    '  —— 页号是「出处能显示第几页」的锚点,猜不得。',
  ].join('\n'),
  middleware: async (event) => {
    const auth = resolveMcpAuth({
      given: readMcpToken({
        authorization: headerOf(event, 'authorization'),
        'x-mcp-token': headerOf(event, 'x-mcp-token'),
      }),
      configured: useRuntimeConfig().mcpToken,
    })
    event.context.mcpAuth = auth

    if (auth.writeAuthorized) return
    const called = await writeToolCalledIn(event)
    if (called) return unauthorizedResponse(called, auth.reason)
  },
})

function headerOf(event: Parameters<typeof getHeader>[0], name: string): string | undefined {
  const value = getHeader(event, name)
  return typeof value === 'string' ? value : undefined
}

/** 有 body 的方法(与 h3 的 `PayloadMethods` 同集:GET 的 SSE 流不进这里)。 */
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

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
      },
    },
  )
}
