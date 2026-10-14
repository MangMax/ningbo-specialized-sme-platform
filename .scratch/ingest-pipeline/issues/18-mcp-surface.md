# 18 — 把 app 的能力暴露成 **MCP**(供代理调用)

**What to build:** 用 **`@nuxtjs/mcp-toolkit`**(官方模块)在 app 里建 MCP server,把「代理需要的那几个能力」声明成 tool,让代理**直接调**,而不是 shell 进仓库或每次手搓脚本。

**Blocked by:** 09、17(表在)、13(渲染在)

**Status:** ready

## 为什么(用户 2026-10-14 指出)

需求原文里「代理使用 api 或 mcp 获取」「也可以由代理调用 mcp」一直**没有落点**。查证结果:

| 模块 | 实况 |
|---|---|
| **`@nuxtjs/mcp-toolkit` v0.24.2** | ✅ 官方;`server/mcp/tools/*.ts` + `defineMcpTool`(Zod `inputSchema`、`annotations.readOnlyHint`、`cache`)、resources/prompts、**鉴权中间件**、DevTools 检查器。**声明式 —— 不会自动把 Nitro 路由变成 tool**,每个能力写一个文件。 |
| `nuxt-mcp`(antfu) | ❌ 定位是「帮模型理解你的 app」,非业务能力。 |
| **OpenAPI 生成** | ❌ **无成熟模块**(`nuxt-openapi` 是占位空包;`@scalar/nuxt` 只渲染已有 spec)。**本期不做 OpenAPI** —— 页面直调自己的 Nitro 路由即可,代理走 MCP。 |

## 要暴露的能力(只列代理真用得上的)

**只读**(`readOnlyHint: true`):
- `list_files` / `get_file` —— 文件库列表与元数据(含 `category_state`、`parse_state`)
- `list_file_parts` —— 某文件含哪些**段**(称号/事件/年份/批次/附件/行数)
- `list_page_images` —— 某 PDF 的页图(票 13 的产物)
- `get_ocr_result` —— 某文件/某页的 OCR 结果(markdown,带页码)

**写入**(必须过鉴权;C24 谨慎,`readOnlyHint: false`):
- `save_ocr_result` —— 写回 OCR 结果
- `set_file_category` —— 回写分类(票 12 的代理通路)
- `save_parse_result` —— 写回解析出的段/条目

> **边界**:MCP 是**代理的入口**,不是第二个写库通道。**身份归并/回填仍只走 pipeline**(见 [data-integrity 安全阀](../../data-integrity/SPEC.md))。MCP 的写入只碰**文件元数据 / 解析结果 / OCR 结果**,**不得**直接改 `record` / `enterprise`。

## 鉴权与凭证

- 用模块的中间件做**鉴权**(token 从 `NUXT_*` 环境变量读;**不入库、不入仓库**)。
- 本地开发可只绑 `127.0.0.1`。

## 与其它票的关系

- **11 不用它**(11 是 pipeline 输入源改造,本地 CLI 直读库)。
- **14 的「代理经 MCP 取图解析并写回」** 改为**调本票的 tool**,不再手搓通路。
- **12 的代理回写**同理走 `set_file_category`。

## 测试 / 验收

- [ ] `npx nuxt add mcp`,起服务后 **MCP 客户端能列出 tools**;
- [ ] `list_files` 返回**现有 23 个文件**;`list_file_parts` 对 192号 返回 **2 段**;
- [ ] `set_file_category` 写回后 **`/files` 页可见**(端到端);
- [ ] **未带鉴权**的写入被拒;
- [ ] `pnpm typecheck && pnpm test` 全绿。

**分支**:`feat/mcp-surface`。
