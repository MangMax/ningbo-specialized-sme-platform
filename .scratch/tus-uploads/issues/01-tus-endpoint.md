# 01 — tus 服务端端点与落位规则

**What to build:** 在 app 内接入 `@tus/server`+`@tus/file-store`,经 Nitro 中间件暴露 `/api/uploads`;上传完成后按文件库规则落位。协议端到端可用。

**Blocked by:** None — can start immediately.

**Status:** ✅ done(2026-10-14)

- [x] `server/utils/tus.ts`:`Server` 单例,`FileStore` 工作目录 `.incoming/`(与 `files/` 同卷),`maxSize`、`allowedOrigins`
- [x] `server/middleware/tus.ts`:`startsWith('/api/uploads')` → `sendWebResponse(event, await getTus().handleWeb(toWebRequest(event)))`（实现按前缀精确匹配基路径与子路径）
- [x] `onUploadCreate`:校验 metadata 白名单(`source∈{jxj,miit}`、`kind∈{announcement,export}`、`year` 四位、`batch` 安全段、`filename` 无 `/ \ .. \0`),非法返回 400（`tests/tus.test.ts`「拒绝白名单外的 source/kind」「拒绝非四位 year 与 batch 无 year」「拒绝含路径分隔符 / `..` / 空 的 filename」）
- [x] `onUploadFinish`:拼 `files/<source>/<kind>/<year>/<batch>/<filename>` 并 `rename`;同名加 ` (n)` 不覆盖（`linkUnique`，`tests/tus.test.ts`「同名第二次上传落到 ` (1)`,原文件不动」）
- [x] 不加 h3 v2;不改台账读路径与数据库
- [x] 端到端测试:创建 → 分片 → HEAD → 续传 → 落位,断言文件逐字节一致（`tests/tus.test.ts` 两条 e2e 用例）

> **收口（2026-10-15，docs-only）**：6 项按实现与测试已满足。
