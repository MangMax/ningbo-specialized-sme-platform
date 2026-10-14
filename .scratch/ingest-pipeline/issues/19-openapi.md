# 19 — 面向**代理**的 HTTP 能力面(含**异步任务**)+ Nitro 内建 OpenAPI

**What to build:** 把 app 的能力做成**代理可直接调用的 HTTP 接口**,重点是**异步任务**(提交 → 拿 `jobId` → 轮询);并用 **Nitro 自带的 OpenAPI** 让它**可被发现**。

**Blocked by:** **18**(两者都改 `nuxt.config.ts` / `package.json`,会撞)+ **迁移编号必须串行**

**Status:** ✅ **done**(2026-10-14,分支 `feat/agent-http`,迁移 `0004`)—— 交付记录见文末。

## 更正:我先前把 OpenAPI 归错了类(用户 2026-10-14 指出)

我原先把 OpenAPI 说成「给人看文档 / 给 HTTP 消费者用」,把**代理**归给 MCP。**这是错的**:

- **代理一样能调 HTTP API** —— 而且**能在技能里直接 `curl`**,不必先接一层 MCP。
- **异步才是关键**:MCP 的 tool 是**同步请求/应答**;97 页 OCR、700+ 家平台核查这类长活,一次 tool call 干等,**批量时效率差得多**。
- ⇒ **HTTP(带异步任务)是代理的第一接口;MCP 是补充**(18 票),不是替代。

## 查证:生成 spec 的能力是 **Nitro 内建**,不用装第三方

| 候选 | 实况 |
|---|---|
| **Nitro 自带 `openAPI`** | ✅ `openAPI: { meta: {...} }` → `/_openapi.json`、`/_scalar`、`/_swagger`;路由用 **`defineRouteMeta({ openAPI })`** 宏(构建期、零运行时)。路径参数自动推断,**query/header 手写**,无 zod 推断。 |
| `@scalar/nuxt` | ❌ 消费方;**Nitro 已在 `/_scalar` 自带 UI**,重复。 |
| `@hey-api/nuxt` | ❌ 消费方(从 spec 生成客户端);页内直调 `$fetch`,暂不需要。 |
| `nuxt-openAPI-wrapper` | ❌ 消费方 + 仅 5 stars。 |

## 要做的

### 1. 异步任务端点(**本票主体**)
统一形状(建议):
- `POST /api/jobs` —— 提交任务,`202` + `{ jobId }`;body 指明 `kind` 与参数。
- `GET /api/jobs/:id` —— 轮询:`{ state: queued|running|done|failed, progress, result?, error? }`。
- `GET /api/jobs` —— 列出(可按 kind/state 过滤)。
- `DELETE /api/jobs/:id` —— 取消(尽力而为,**要写清"取消是尽力"**)。

覆盖(**按票 13/14/16 的能力**):
- `render-pages` —— 批量渲染页图(票 13 现只有同步单文件入口)。
- `ocr` —— 批量 OCR(票 14)。
- `reconcile` —— 批量平台核查(票 16 现是 CLI)。

### 存储:**新建任务表**(用户 2026-10-14 定,不是 JSON)

**表 `job`**(建议名):`id`(ULID/uuid)/ `kind` / `params`(JSON)/ `state`(queued|running|done|failed|cancelled)/ `progress`(0–100 或 `{done,total}`)/ `result`(JSON,可空)/ `error`(可空)/ `created_at` / `started_at` / `finished_at`。

**为什么不用 JSON**:任务要**按 kind/state 查**、要**跨重启保留**、要**并发写不互相覆盖**;JSON 文件三者都做不到(改一个任务要重写整份,还得自己管锁)。宁可一次迁移。

> ⚠️ **迁移编号是串行资源**:当前最新是 `0003`(票 17)。**19 的迁移必须排在所有要建迁移的票之后**,否则两条分支各生成 `0004_xxx.sql` 会撞。
> **⇒ 等 18 与在跑的票都合入后,再派本票。**

### 2. 同步读接口
已有的 `GET` 路由保持;**补 `defineRouteMeta`** 让它们进 spec。

### 3. 发现(Nitro 内建 OpenAPI)
- 开 `openAPI`(设 `meta.title/description/version`);
- 给公开路由加 `defineRouteMeta({ openAPI: {...} })`;
- `/_openapi.json` 给**代理读**,`/_scalar` 给**人看**。

### 4. 鉴权与暴露面(必须在票里落)
- **写/任务类端点要 token**(`NUXT_*` 环境变量,仓库只留 `.env.example`);
- Nitro 的 OpenAPI 端点在**生产默认关闭**;**若开生产必须加保护**(文档明确警告)。**默认只开开发**;
- **凭证/密钥不进 spec**。

## 边界(与票 18 同一套)
只碰**文件元数据 / 解析结果 / OCR 结果 / 任务**;**严禁**直接改 `record` / `enterprise` / 触发身份归并(见 [data-integrity 安全阀](../../data-integrity/SPEC.md))。

## 验收
- [x] 提交一个 `render-pages` 任务 → 立刻 `202` + jobId;**轮询到 done**,页图落盘正确(与票 13 同步入口产物一致);
- [x] 提交一个**批量**任务(3 份 PDF)→ 一次提交(12 ms 拿 202)、轮询拿到全部结果(23 + 21 + 8 页);
- [x] 同一时刻两个任务不互相破坏(并发语义写清:单进程**串行**队列,见交付记录);
- [x] `/_openapi.json` 含上述端点;`/_scalar` 能打开;
- [x] **未带 token** 的任务提交被拒(实测 **401**,响应里说明是「未带」还是「不匹配」);
- [x] 生产构建下 OpenAPI 端点**不暴露**(`pnpm build` + `node .output/server/index.mjs` + curl → **404**);
- [x] **任务表 + 迁移**:`job` 表落库,重启后任务史仍在;按 `kind`/`state` 能查;
- [x] `pnpm typecheck && pnpm test` 全绿(基线 **261** 项一条不挂,新增 47 项,共 **308**)。

**分支**:`feat/agent-http`。

## 交付记录(2026-10-14)

### 做了什么

| 件 | 落点 |
|---|---|
| 任务表 + 迁移 | `db/schema.ts` 的 `job`(id/kind/params/state/progress/result/error/created_at/started_at/finished_at)+ `db/migrations/0004_lazy_echo.sql` |
| 纯规则 | `lib/job.ts` —— 状态、`{done,total}` 进度与 `percent`(floor)、ULID 生成/校验、参数归一 |
| 库读写 | `server/utils/job-store.ts` —— 状态迁移的守卫、按 kind/state 查、重启对账、`toJobDto` 投影 |
| 执行面 | `server/utils/job-runner.ts` —— kind→handler **注册表** + 进程内**串行队列** + 取消 + `whenIdle` |
| 第一个真 kind | `server/utils/jobs/render-pages.ts` —— **批量**复用票 13 的 `renderPdfPages`,渲染本身一行没改 |
| 未接入的 kind | `server/utils/job-specs.ts` —— `ocr`(等票 14 的表)、`reconcile`(票 16 是 pipeline CLI),提交得到 **501 + 原因** |
| 端点 | `server/api/jobs/{index.post,index.get,[id].get,[id].delete,kinds.get}.ts` |
| 鉴权 | `server/utils/api-auth.ts`(`NUXT_API_TOKEN`;与 MCP 那把**各自独立**,可分别吊销) |
| OpenAPI | `nuxt.config.ts` 的 `nitro.openAPI` + 各公开路由的 `defineRouteMeta` |
| 生产守卫 | `server/utils/openapi-guard.ts` + `server/middleware/openapi-prod-guard.ts` |

### 实测证据

**(1) 一次提交 3 份 PDF(批量)**
```
POST /api/jobs {"kind":"render-pages","params":{"files":[…3 份…],"dpi":150}}
→ HTTP 202 in 12ms | jobId=01M4X4R7DEP37QMYVCWGM1XW2C state=queued progress=0/3
  Location: /api/jobs/01M4X4R7DEP37QMYVCWGM1XW2C
轮询 9 次采样 → done 100%;结果 total/ok/failed = 3/3/0
   OK  〔2022〕145号   pageCount=23 rendered=23 1240x1754
   OK  2025 一批创新型 pageCount=21 rendered=21 1240x1754
   OK  〔2026〕73号    pageCount=8  rendered=8  1240x1754
页图 URL: /api/files/jxj/announcement/2022/.…145号….pdf.pages/p001.png
```

**(2) 与票 13 同步入口产物一致(双向)**
```
同一份 73号 走同步 POST /api/pdf-pages(dpi=150) → 200 written=0 skipped=8 upToDate=true
反方向:先同步再异步 → written=0 skipped=8
换 dpi(200 ↔ 150)→ written=23 重渲染,p001 sha 变化;页图目录仍是 23 个文件(原地覆盖,不膨胀)
```

**(3) 并发语义:两个任务不互相破坏**
```
A、B 连着提交(不等待):t0…t11 采样全是 A=running B=queued —— **从未同时 running**
终态 A=done 2/2、B=done 2/2
两份都渲染 145号 且都不带 force → 第二份 written=0 skipped=23(没覆盖、没重写)
```
口径:**单进程串行队列,先进先出**,任何时刻最多一个 handler 在跑;
批量靠「一个任务带 N 份文件」,不靠「同时跑多个任务」。
(多实例部署——两个 node 进程指向同一个 db——**不在本票范围**,那需要跨进程锁。)

**(4) 取消是「尽力而为」**
```
运行中 DELETE → 202 {"cancelled":false,"cancelRequested":true,"note":"…**尽力而为**:handler 会在
                   下一个检查点停止,正在进行的单步(一次渲染 / 一次外部调用)会先跑完…"}
随后 GET     → state=cancelled progress=1/4,error="已按取消请求停止…已完成的部分见 result"
               result.files 长度 1 —— 停下时**已做完那份的明细保留**(不是丢掉)
排队中 DELETE → 200 {"cancelled":true} 直接摘出队列,未执行
已结束 DELETE → 200 {"alreadyFinished":true,"note":"任务已结束(state=done),无法取消。"}
```

**(5) 重启后任务史仍在;半截任务如实标失败**
```
正常重启:库里 14 条全部照原样可读(12 done + 2 cancelled),result 与 progress 都在
崩溃重启:kill -9 时留下 running + queued 各一条
        → 重启后两条都变 failed,error="服务重启,任务未完成(进行中的任务不跨进程恢复,请重新提交)"
```
**任务史跨重启保留,任务本身不跨进程续跑** —— 后者是刻意的:队列在内存里,
`running` 那行的真实进度是未知数,接着跑只是猜。这是**已知取舍**,写在
`job-store.ts` 的 `reconcileInterruptedJobs` 上。

**(6) 鉴权(实测状态码)**
```
POST   /api/jobs          未带 token           → 401 "需要鉴权:请求未带 token(Authorization: Bearer <token> 或 X-API-Token)。"
POST   /api/jobs          带 token,未知 kind  → 400 "未知的任务种类:nope。已登记:ocr(尚未接入)、reconcile(尚未接入)、render-pages(已接入)"
POST   /api/jobs          带 token,kind=ocr   → 501 "任务种类尚未接入:ocr。尚未接入:等票 14 的 OCR 结果表…"
DELETE /api/jobs/:id      未带 token           → 401
GET    /api/jobs/:id      非 ULID → 400;不存在的 ULID → 404
GET    /api/jobs、/api/jobs/kinds              → 200(只读不鉴权)
```

**(7) 生产隐藏(真实 build + 起服务 + curl)**
```
pnpm build && PORT=3482 node .output/server/index.mjs
  /_openapi.json 404   /_scalar 404   /_swagger 404      ← 且 body 是 JSON 错误,不是 SPA 兜底页
  /api/health    200   /api/jobs/kinds 200               ← 业务接口照常
开发环境(pnpm dev,3481):/_openapi.json 200(openapi 3.1.0,info.version 1.0.0)、/_scalar 200
```
> 为什么除了「nitro 不注册」还要加一层守卫:本仓是 `ssr:false` 的 SPA,**未匹配的路径会落
> 到 SPA 兜底回 `index.html`(200)**。spec **确实没有暴露**(没有 JSON),但「这里没有」
> 这个信号是模糊的 —— 代理会以为拿到了什么。守卫把票面的「实测 404」坐实,
> 只在生产生效、只匹配那三条确切路径。见 `server/utils/openapi-guard.ts`。

**(8) `/_openapi.json` 片段**
```json
{ "openapi": "3.1.0",
  "info": { "title": "专精特新台账看板 — 代理 HTTP 能力面", "version": "1.0.0",
            "description": "文件库与台账的 HTTP 接口。写/任务类接口需要 token(`NUXT_API_TOKEN`)。长活走异步:`POST /api/jobs` 拿 jobId,再 `GET /api/jobs/{id}` 轮询。" },
  "components": { "securitySchemes": { "bearerAuth": { "type": "http", "scheme": "bearer",
                   "description": "`NUXT_API_TOKEN` 的值。写/任务类接口需要。" } } },
  "paths": ["/api/records", "/api/enterprises/{id}", "/api/stats", "/api/quality", "/api/export",
            "/api/comparison", "/api/comparison/curated", "/api/files", "/api/files/{id}",
            "/api/files/{path}", "/api/pdf-pages", "/api/health",
            "/api/jobs", "/api/jobs/{id}", "/api/jobs/kinds"] }
```
`POST /api/jobs` 与 `DELETE /api/jobs/{id}` 都带 `security: [{bearerAuth:[]}]`,响应
202/400/401/501 各有描述。**spec 里没有任何 token 值**(只有 `NUXT_API_TOKEN` 这个
**变量名**),可测判据是 `server/utils/api-auth.ts` 的 `specLeaksToken`。

### 测试
```
pnpm typecheck   → 干净
npx vitest run   → Test Files 17 passed (17) | Tests 308 passed (308)
                   基线 261(票面写的 234 是更早的数字)一条不挂;新增 47 条 = tests/agent-http.test.ts
```
新增覆盖:纯规则(ULID 可排序性 / 进度 floor 取整 / 参数归一)、库(状态迁移守卫、
kind+state 查询、重启对账、`ensureJobRunnerReady` 按 db 实例只对一次账)、执行面
(**串行队列 / 排队中与运行中两种取消 / 部分失败保留产出 / handler 抛出**)、
`render-pages`(参数校验 + 真 pdfium 渲染:「一份坏的不停下整批」「取消保留部分产出」「幂等 written=0」)、
HTTP 鉴权判据、**Nitro 开发注册 / 生产不注册**(问 nitro 自己要 handler 表)、生产守卫判据。

### 与票面不同、但有意为之的两处（独立评审查出，记在这里而不是默默做掉）

1. **token 只加在本票新增的两个写口上**（`POST /api/jobs`、`DELETE /api/jobs/:id`），
   **没有**回填到既有的写路由（`POST /api/pdf-pages`、`PATCH/DELETE /api/files/:id`、
   `PATCH /api/comparison/curated`）。票面说的是「**写/任务类端点**要 token」,字面上
   包含那几条 —— 但它们是**页面在用**的接口（`/files` 页正在被另一个会话改），
   加上 token 会当场把界面打死。⇒ 本票选择：**只覆盖新增的代理面**，把既有写路由的
   鉴权留成一条**待定项**（需要用户拍板：要么给页面也发 token,要么那几条继续只靠
   本地绑定保护）。`.env.example` 里写明了当前只覆盖两个写口，不假装覆盖了全部。
2. **`GET /api/jobs/kinds` 是票面四端点之外的第五个**。加它是因为本票的目标里写着
   「可被发现」:代理在技能里 `curl`，没有编译期类型，总得有个地方问「现在能派什么活」
   —— `/_openapi.json` 说的是接口形状，说不清 `ocr` 是「已登记但没接」还是「根本没这回事」。
   代价是一条只读路由，收益是代理不用猜。
3. 另外两处小的：**生产守卫**（`middleware/openapi-prod-guard.ts`）——
   nitro 不注册之后 SPA 兜底会回 200 + index.html,票面要的「实测 404」需要它坐实;
   **`ui.swagger: false`** —— 同一份 spec 的两种渲染留一个就够，票面只要求 `/_scalar`。

### 独立评审

`code-review` 技能两轴跑过（Standards / Spec）。两轴都**没有硬违约**
（凭证不入库/不入 spec、边界不越、基线测试不挂，均已核对）。提出的判断项已处理:
抽了 `lib/csv.ts`（多值查询参数，原先是第 5 份照抄）、`api-guard.ts` 与 `api-auth.ts`
按票 18 的 `mcp-auth`/`mcp-guard` 分法拆开（去掉两处重复的头适配）、
`ACTIVE_JOB_STATES` 常量、删掉没人用的 `throwIfCancelled`/`JobCancelled`（取消只留
「返回 `{cancelled:true}`」一条路，少一个出口）、`pump` 改名 `drainQueue`、
**撤掉**了对 `enterprises/[id].get.ts` 错误文案的无谓改动（那是顺手改的、不在票内）。
评审提的「没有针对真实生产构建的 404 测试」已补：`pnpm verify:prod-openapi`。

### 复现命令

```bash
npx vitest run                 # 308 项全绿（基线 261 + 新增 47）
pnpm typecheck                 # 干净
pnpm verify:prod-openapi       # build + 起产物 + curl:三条 404、业务接口 200
pnpm dev                       # 然后 curl http://localhost:3000/_openapi.json 看 spec
```

### 已知缺口

- **既有写路由仍未鉴权**（`POST /api/pdf-pages`、`PATCH/DELETE /api/files/:id`、
  `PATCH /api/comparison/curated`）—— 见上面「与票面不同」第 1 条。**需要用户拍板**：
  要不要给页面也发 token（会牵动 `/files` 页），还是那几条继续只靠本地绑定。
- `ocr` / `reconcile` **未接入**(有意,见 `server/utils/job-specs.ts` 的说明);扩展点在
  注册表里,加一个 `JobSpec` + 一行登记即可。
- 队列是**单进程内存**的:多实例部署需要跨进程锁,不在本票范围。
- 进度粒度是**一份文件**(一份 97 页 PDF 是一次 0→1),不做页级 —— 页级要在
  `renderPdfPages` 内部插回调,那是票 13 的文件,本票不动。
- `defineRouteMeta` 是编译期宏,vitest 裸 node 下没有 → 加了 `tests/setup.ts` 垫片
  (只影响测试进程,不改运行时行为)。

