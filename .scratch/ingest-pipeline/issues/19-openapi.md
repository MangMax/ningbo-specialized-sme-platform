# 19 — 面向**代理**的 HTTP 能力面(含**异步任务**)+ Nitro 内建 OpenAPI

**What to build:** 把 app 的能力做成**代理可直接调用的 HTTP 接口**,重点是**异步任务**(提交 → 拿 `jobId` → 轮询);并用 **Nitro 自带的 OpenAPI** 让它**可被发现**。

**Blocked by:** **18**(两者都改 `nuxt.config.ts` / `package.json`,会撞)+ **迁移编号必须串行**

**Status:** ready,**但排在并行票之后再做**(用户 2026-10-14 定)

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
- [ ] 提交一个 `render-pages` 任务 → 立刻 `202` + jobId;**轮询到 done**,页图落盘正确(与票 13 同步入口产物一致);
- [ ] 提交一个**批量**任务(如 3 份 PDF)→ 一次提交、轮询拿到全部结果(**证明"能异步批量"**);
- [ ] 同一时刻两个任务不互相破坏(并发语义写清);
- [ ] `/_openapi.json` 含上述端点;`/_scalar` 能打开;
- [ ] **未带 token** 的任务提交被拒(实测状态码);
- [ ] 生产构建下 OpenAPI 端点**不暴露**(实测 404);
- [ ] **任务表 + 迁移**:`job` 表落库,重启后任务史仍在;按 `kind`/`state` 能查;
- [ ] `pnpm typecheck && pnpm test` 全绿(现在 app **234 项**)。

**分支**:`feat/agent-http`。
