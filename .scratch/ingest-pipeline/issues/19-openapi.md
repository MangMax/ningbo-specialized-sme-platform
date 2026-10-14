# 19 — 开启 **Nitro 内建 OpenAPI**(可选 / 低优先)

**What to build:** 用 **Nitro 自带的 OpenAPI** 生成 spec,给机器读、给人看文档。**不引任何第三方模块。**

**Blocked by:** —(可与任何票并行;只动 `nuxt.config.ts` + 各 `server/api/*.ts` 顶部加宏)

**Status:** ready —— **低优先,用户点名才做**

## 查证结论(2026-10-14,别再重查)

用户记得「Nuxt 有把服务端命令转 OpenAPI 的模块」—— **方向对,真身是 Nitro 内建**,不是模块:

| 候选 | 实况 |
|---|---|
| **Nitro 自带 `openAPI` 选项** | ✅ **就是它**。`openAPI: { meta: {...} }` → 出现 `/_openapi.json`、`/_scalar`、`/_swagger`。 |
| `@scalar/nuxt` | ❌ 消费方(渲染文档);**Nitro 已经在 `/_scalar` 画了 UI**,再装重复。 |
| `@hey-api/nuxt` | ❌ 消费方(从 spec 生成 TS 客户端)。我们页内直调 `$fetch`,**当前不需要客户端**. |
| `nuxt-openAPI-wrapper`(Pentadome) | ❌ 消费方 + **仅 5 stars**,不成熟。 |

## 要做

1. `nuxt.config.ts` 开 `openAPI`(设 `meta.title/description/version`)。
2. 给**公开路由**加 `defineRouteMeta({ openAPI: {...} })`(构建期宏、零运行时成本):
   - `GET /api/records`、`/api/enterprises/:id`、`/api/stats`、`/api/quality`、`/api/export`、`/api/comparison`(含 `PATCH /api/comparison/curated`)、`/api/files`(`GET`/`PATCH`/`DELETE`)、`/api/pdf-pages`。
   - **query 参数要手写**(路径参数自动,其余不推)。**tags** 按路径前缀自动,必要时覆盖。
3. `/_openapi.json` 拿到的 spec 与实际路由**对得上**(抽查 3 条)。

## ⚠️ 安全(必须在票里落)

- 这些端点在**生产默认关闭**;**若开生产**,`/_openapi.json` 等**必须加保护**(文档明确警告)。
- 本票**默认只开开发环境**;若你要生产也开,单独说,别默默开。
- **凭证/密钥不进 spec**(别把 token 写进参数描述)。

## 验收

- [ ] `/_openapi.json` 返回合法 spec,含上述路由;
- [ ] `/_scalar` 能打开并列出接口;
- [ ] 抽查 3 条路由的 spec 与实际 handler **一致**(含 path 参数);
- [ ] 生产构建下这些端点**不暴露**(实测 404);
- [ ] `pnpm typecheck && pnpm test` 全绿。

**分支**:`feat/openapi`。
