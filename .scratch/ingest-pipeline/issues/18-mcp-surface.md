# 18 — 把 app 的能力暴露成 **MCP**(供代理调用)

**What to build:** 用 **`@nuxtjs/mcp-toolkit`**(官方模块)在 app 里建 MCP server,把「代理需要的那几个能力」声明成 tool,让代理**直接调**,而不是 shell 进仓库或每次手搓脚本。

**Blocked by:** 09、17(表在)、13(渲染在)

**Status:** implemented(2026-10-14,分支 `feat/mcp-surface`,待主代理复核;界面零变化,按 README 规则**不需要** oil-ui 验收)

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

- [x] ~~`npx nuxt add mcp`~~ → 用 `pnpm add @nuxtjs/mcp-toolkit zod` + 在 `nuxt.config.ts` 注册模块(等价;`nuxt add` 做的也是这两步)。起服务后 **MCP 客户端能列出 tools** —— 见「交付记录 · 验收证据 1」;
- [x] `list_files` 返回**现有 23 个文件**;`list_file_parts` 对 192号 返回 **2 段** —— 见证据 2、3;
- [x] `set_file_category` 写回后 **`/files` 页可见**(端到端)—— 证据 4(**经 `/api/files` 读回**,即该页的数据源;见「已知缺口 1」为何不是浏览器实测);
- [x] **未带鉴权**的写入被拒(实测 **HTTP 401**)—— 证据 5;
- [x] `pnpm typecheck` 全绿(`nuxt typecheck` + 显式跑 `.nuxt/tsconfig.server.json` / `tsconfig.json` 两份,均 0 error);`pnpm test` **261 passed**(基线 234 + 本票 27)。

**分支**:`feat/mcp-surface`。

---

# 交付(2026-10-14)

## 改了什么

| 文件 | 改动 |
|---|---|
| `nuxt.config.ts` | 注册 `@nuxtjs/mcp-toolkit` 模块;`runtimeConfig.mcpToken`(默认空 = 写入关闭) |
| `package.json` | `@nuxtjs/mcp-toolkit@^0.24.2`、`zod@^4.6.7`(后者是模块的 peer dep) |
| `.env.example` | **新增** —— `NUXT_MCP_TOKEN` 占位与生成办法;仓库里**只有**占位,没有值 |
| `server/mcp/index.ts` | **新增** —— 默认 handler:server 身份 / `instructions`(给代理的边界说明)+ **写入鉴权中间件** |
| `server/mcp/tools/*.ts` | **新增 8 个** —— 票面那 5 个只读 + 3 个写入,一个能力一个文件 |
| `server/utils/mcp-auth.ts` | **新增** —— 鉴权判据(纯函数):token 读法、恒定时间比较、写入 tool 名单、body 里的写入调用识别 |
| `server/utils/mcp-files.ts` | **新增** —— 共用件:文件引用解析(id / relPath)、懒回填、两个 tool 级操作 |
| `server/utils/mcp-guard.ts` | **新增** —— 写入 tool 的 `enabled` 守卫 |
| `server/utils/parse-result.ts` | **新增** —— `save_parse_result` 的写入逻辑(段的校验 / 归一 / 全量替换) |
| `server/utils/ocr-result.ts` | **新增** —— OCR 两个 tool 的「尚未启用」出口(票 14 的落点) |
| `tests/mcp-surface.test.ts` | **新增 27 条** |

**没有动**(硬约束,已逐条核对):`db/schema.ts`、`db/migrations/**`、`pages/**`、`components/**`、`pipeline/**`、`files/**`。
本票**界面零变化** ⇒ 按 README 规则**不需要** oil-ui 验收。

## 形状

**声明式,一个能力一个文件**(模块要求,不会把 Nitro 路由自动变成 tool):

```
server/mcp/
├── index.ts            默认 handler(/mcp):身份 + instructions + 鉴权中间件
└── tools/
    ├── list_files.ts       只读  list_files
    ├── get_file.ts         只读  get_file
    ├── list_file_parts.ts  只读  list_file_parts
    ├── list_page_images.ts 只读  list_page_images
    ├── get_ocr_result.ts   只读  get_ocr_result(尚未启用)
    ├── save_ocr_result.ts  写入  save_ocr_result(尚未启用,需鉴权)
    ├── set_file_category.ts 写入 set_file_category(需鉴权)
    └── save_parse_result.ts 写入 save_parse_result(需鉴权)
```

tool 文件一律**只做声明 + 转发**,业务判断全在 `server/utils/` 里(可单测,不必起服务)。
只读 tool **复用既有查询层**:`list_files` → `listStoredFiles`(与 `/api/files` 同一函数)、
`list_page_images` → `listPdfPages`(与 `GET /api/pdf-pages` 同一函数)、
`set_file_category` → `parseMetadataPatch` + `updateStoredFile`(与 `PATCH /api/files/:id` 同一入口)。
**不另立一套口径** —— 代理看到的和页面看到的是同一份数据、同一套规则。

## 鉴权

- token 走 `NUXT_MCP_TOKEN`(→ `runtimeConfig.mcpToken`);**不入库、不入仓库**,仓库只留 `.env.example` 占位。
- **空 token = 写入整体关闭**。反向默认(空 = 放行)会让「忘了配」变成「静默的公开写入口」;
  「忘了配 → 写不了」只是少个功能,报错文案直接告诉你怎么开。
- 只读 tool **不鉴权**;写入 tool **必须带**(`Authorization: Bearer <token>` / 裸 token / `X-MCP-Token`)。
- 三道同判据:①中间件对未鉴权的写入调用**直接回 HTTP 401**;②写入 tool 的 `enabled` 守卫
  让它们在未鉴权时**连 `tools/list` 都不出现**;③`MCP_WRITE_TOOLS` 名单有测试钉死。
- 本地开发:服务默认绑 `127.0.0.1`。

## 验收证据(实跑,服务在 `:3480`)

### 1. `tools/list` 的实际输出

启动日志:`[@nuxtjs/mcp-toolkit] ✔ /mcp enabled with 8 tools`

**带鉴权**(`Authorization: Bearer <token>`,本次实跑用的是临时生成的一次性值,不记录)—— 8 个:

```
- get_file             readOnly=True   title=文件详情
- get_ocr_result       readOnly=True   title=取 OCR 结果(尚未启用)
- list_file_parts      readOnly=True   title=文件的段明细
- list_files           readOnly=True   title=文件库列表
- list_page_images     readOnly=True   title=PDF 页图
- save_ocr_result      readOnly=False  title=写回 OCR 结果(尚未启用)
- save_parse_result    readOnly=False  title=写回解析结果(段)
- set_file_category    readOnly=False  title=回写文件分类
```

**不带鉴权** —— 只剩只读 5 个(写入 tool 连列都不列):

```
tools: ['get_file', 'get_ocr_result', 'list_file_parts', 'list_files', 'list_page_images']
```

`initialize` 的 `serverInfo`:`{"name":"spztx-roster-board","version":"1.0.0",…}`,带 `instructions`(边界说明)。

### 2. `list_files` → 23 个文件

```json
{"total": 23, "page": 1, "pageSize": 50, "rows": [ … 23 行 … ]}
```

23 行与 `/files` 页同一份列表(同一函数);首行起 `id=18`(2026/1 …101号),
含 3 份 `miit/export/*.xlsx`。每行带 `parts`(段)、`referenceCount`(被引用数)、
`categoryState` / `parseState`。

### 3. `list_file_parts` → 192号 = **2 段**

```json
{"fileId": 13, "parts": [
  {"titleCode":"specialized_sme","eventKind":"award","year":2024,"batch":2,"attachment":"附件1","rowCount":389},
  {"titleCode":"specialized_sme","eventKind":"review","year":2021,"batch":2,"attachment":"附件2","rowCount":67}
]}
```

**认定 2024/2(附件1,389 行)+ 复核 2021/2(附件2,67 行)** —— 与票 17 的口径一致,
复核段的年份是**被复核的原始认定年份 2021**,不是公布年份 2024。

### 4. `set_file_category` 端到端(写入 → `/api/files` 读回)

| 步骤 | 结果 |
|---|---|
| 写前 `GET /api/files?q=公布.pdf` | `{id:1, year:2022, batch:null}` |
| **未带鉴权** MCP 写入 `year=1999` | **HTTP 401**,库未变(读回仍是 `year:2022`) |
| 带鉴权 MCP 写入 `year=2001, batch=3` | HTTP 200,返回 `{id:1, year:2001, batch:3, categoryState:'set'}` |
| 写后 `GET /api/files?q=公布.pdf` | **`{id:1, year:2001, batch:3}`** ← 端到端可见 |
| 带鉴权 MCP 写回 `year=2022, batch=null` | 读回 `{id:1, year:2022, batch:null}`(还原;`null` = 清空生效) |

`/files` 页就是拿 `/api/files` 渲染的,所以这条读回即该页所见(见「已知缺口 1」)。

`save_parse_result` 同样实测:写 192号 两段(附件名给「附 件 1」)→ 返回 `parseState:'parsed'`,
`attachment` 归一为 `附件1`;经 `/api/files` 读回段与行数一致。

### 5. 未带鉴权的写入被拒(实测状态码)

```
$ curl -X POST /mcp -d '{"…","method":"tools/call","params":{"name":"set_file_category",…}}'
{"jsonrpc":"2.0","error":{"code":-32001,
  "message":"写入 tool \"set_file_category\" 需要鉴权:请求未带 token(Authorization: Bearer <token> 或 X-MCP-Token)。",
  "data":{"tool":"set_file_category","reason":"token-missing","writeTools":["save_ocr_result","set_file_category","save_parse_result"]}},
 "id":null}
[HTTP 401]
```

- 带**错** token → 同样 **401**,`reason: "token-invalid"`;
- **没配** `NUXT_MCP_TOKEN` 时 → **401**,`reason: "no-token-configured"`(写入整体关闭);
- **只读**调用不带鉴权 → 正常 200(只读不受影响)。

### 6. OCR 两个 tool:明确报「尚未启用」

```
[501] OCR 结果尚未启用:票 14(OCR 三通路 + 结果入库)未实现,表 `ocr_result` 还不存在。
      这不是本 tool 的临时缺陷,而是本票有意留的空位 —— 等票 14 建表后原样接上。
      在那之前,页图可以用 list_page_images 取(票 13 已可用)。
```

`get_ocr_result` / `save_ocr_result` 都**在 `tools/list` 里**(票面要求「明确报」),
调用一律 `isError: true` + **501**。用 501 而不是 404/400:能力**存在**、只是还没做,
客户端不该把它当成「参数给错了」去反复改参数重试。

### 7. 测试 / 类型

```
$ pnpm test        → 16 files, 261 passed  (基线 234 + 本票 27)
$ pnpm typecheck   → exit 0
  (另显式跑 .nuxt/tsconfig.server.json / tsconfig.json 两份,均 0 error)
$ npx nuxt build   → exit 0(生产构建通过;zod 进 `.output/server/package.json`,运行时可解析)
```

`tests/mcp-surface.test.ts` 27 条:鉴权判据(含「写入 tool 名单就是那三个」的钉死断言)、
文件引用解析、解析结果写回、懒回填、页图取值。**★ 边界**那条断言:
`save_parse_result` 前后 `record` / `enterprise` / `record_evidence` / `record_event`
的行数**一个都不变**。

## 已完成

- 5 个只读 + 3 个写入 tool,**不多开**;声明式(一能力一文件);只读 tool 复用既有查询层。
- 写入鉴权:中间件 401 + `enabled` 守卫 + 名单钉死;token 走 `NUXT_*`,仓库只有占位。
- 硬边界:MCP 写入**只碰** `stored_file`(元数据)/ `stored_file_part` / `parse_state`;
  台账记录与企业归并**碰不到**(有测试钉死)。
- 票面 5 条验收**全部实测通过**(证据 1–5);`typecheck` / `test` / `build` 全绿。
- 独立评审(`code-review`,Standards + Spec 两轴)跑过,意见已逐条处理(见下)。

## 未完成 / 已知缺口

1. **「`/files` 页可见」是经 `/api/files` 读回证明的,不是浏览器实测。**
   票面写的是「端到端」;但 `/files` 页当前**正被另一个会话改**(README 说 UI 验收在跑),
   本票的硬约束又要求**不动** `pages/files.vue` / `components/**`。两者相权,取了
   「调该页的**数据源**证明写回生效」这条路 —— 页面拿的就是 `/api/files` 的这一份 `rows`,
   `year`/`batch`/`categoryState` 都在里面。**真要在浏览器里点一遍,应等那张 UI 票让开。**
2. **`get_ocr_result` / `save_ocr_result` 是空壳。** 票 14 的 `ocr_result` 表还不存在
   (`db/schema.ts` / 迁移里都没有)。按票面要求**留成明确报「尚未启用」**,没有现造一张表
   —— 现造会把票 14 的选型(页码怎么挂?一段多页?三通路怎么写?)提前锁进仓库。
   接口形状**已按打算支持的声明**(`fileId`/`relPath` + `page` + `markdown`),
   票 14 接上时只需改 `server/utils/ocr-result.ts` 一处,两个 tool 文件一行不动。
3. **`save_parse_result` 写段与票 17 的派生段是两条路径,没有唯一索引保护。**
   `stored_file_part` 本来是**由 `record_evidence` 聚合派生**的(票 17:`backfillFileParts`
   先删后插、整体重建)。本票给了它**第二条写入路径**(代理声明)。两条路径语义不同
   (派生 vs 声明),冲突时谁赢**没有定义**。当前的缓解:`ensureFileStoreReady` 只在
   **段表为空**时才跑派生回填,不会静默覆盖代理写入的段(有测试固定)。但票 11 若在
   代理写过段之后跑派生回填,代理的段会被**整体重建掉**。**这是本票最该先处理的一条** ——
   要么给 `stored_file_part` 加「来源」列区分派生/声明,要么在票 11 侧定优先级。
4. **写入 tool 的 handler 拿不到请求头,复查不出「本次带没带 token」。**
   所以写入 tool 里**没有**「handler 内复查」这一道 —— 只有中间件 401 + `enabled` 守卫两道。
   写一条复查不了自己前提的检查只会是摆设,故不写。MCP 若将来提供 handler 级 auth 上下文,
   这里可以补上第三道。
5. **`/api/pdf-pages` 与 `list_page_images` 的判定顺序不同**,「一个不存在的 `.xlsx`」两边给的
   状态码不一样(这里 404、那里 415)。两者都不是错的(先答的问题不同),要逐字一致得改
   **票 13 的那条路由** —— 不在本票范围。已在 `server/utils/mcp-files.ts` 注明。
6. **`ensureFileStoreReady` 的进程内标记与 `/api/files` 的那份是两处。**
   抽公共件要改票 09/17 的文件(另有会话在动),故照抄并注明 —— 与 `pdf-pages.ts` 照抄
   `sha256Of` 同一处置,是仓库已有的先例。两处各自幂等,重复跑只多一遍扫描。

## 独立评审(Standards + Spec 两轴)与处理

按规程跑了 `code-review` 技能(两个并行子代理:只看标准 / 只看规格)。

| 评审意见 | 轴 | 处理 |
|---|---|---|
| **`list_files` 声明了 `kind` 筛选却从不传给查询层** —— 代理按 `kind:'export'` 筛会**静默拿到全量** | Spec | **已改**:删掉 `kind` 入参,并在 description 里写明「**没有**类别筛选,要收窄用 `source` 或自己过滤 `rows`」。查询层(`listStoredFiles`)本来就没有这一维,`/api/files` 也没有 |
| `mcp-auth.ts` 注释引用了**不存在的** `tests/mcp-auth.test.ts` | Standards | **已改**:改成实际的 `tests/mcp-surface.test.ts` |
| `parse-result.ts` / `save_parse_result.ts` / `set_file_category.ts` **重抄**了 `parse_state` / 称号枚举,与 `lib/labels.ts` 的「唯一来源」规则冲突(`save_parse_result` 自己就在用 `TITLE_ORDER`,两个写入 tool 互相不一致) | Standards | **已改**:三处全部改为从 `PARSE_STATES` / `TITLE_ORDER` 取 |
| `pageImagesForAgent` 的注释声称状态码与 `/api/pdf-pages`「逐条对齐」—— **不准确**(判定顺序不同) | Standards | **已改**:注释改成如实说明两边的顺序差异与后果(见缺口 5) |
| 读 tool 重复 `useDb() + ensureFileStoreReady + resolveFileRef + throw 404`(Duplicated Code) | Standards | **已改**:抽 `openFileStore()` + `requireFileRef()` 到 `mcp-files.ts`,四个读 tool 各减 3–4 行 |
| `get_ocr_result` / `save_ocr_result` 声明了永远执行不到的 `inputSchema`(Speculative Generality) | Standards | **保留**:票面明确要求「留成明确报尚未启用」,而声明接口形状正是为票 14 定契约;已在缺口 2 说明 |
| 「`/files` 页可见」只证到查询层,没有页面证据 | Spec | **保留并记录为缺口 1**(不能动那张页;改用它的数据源证明) |
| 硬约束逐条核对(评审确认均未触碰):tool 名单恰好 8 个、`db/schema.ts`/迁移/`pages/**`/`components/**` 零 diff、凭证只有占位、写入碰不到 `record`/`enterprise` | Spec | — |
| 测试风格与 `tests/file-parts.test.ts` 一致(中文 `describe/it`、真实形状种子、`★ 边界`、同款种子助手);唯一差异是 §5 中途改 `NUXT_DB_PATH` 重导入 `../db` | Standards | **保留**:§5 要的正是「一个全新的空库」,与文件级 `beforeAll` 共用一个库做不到;已就地注释 |
