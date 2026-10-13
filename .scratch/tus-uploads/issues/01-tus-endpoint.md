# 01 — tus 服务端端点与落位规则

**What to build:** 在 app 内接入 `@tus/server`+`@tus/file-store`,经 Nitro 中间件暴露 `/api/uploads`;上传完成后按文件库规则落位。协议端到端可用。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `server/utils/tus.ts`:`Server` 单例,`FileStore` 工作目录 `.incoming/`(与 `files/` 同卷),`maxSize`、`allowedOrigins`
- [ ] `server/middleware/tus.ts`:`startsWith('/api/uploads')` → `sendWebResponse(event, await getTus().handleWeb(toWebRequest(event)))`
- [ ] `onUploadCreate`:校验 metadata 白名单(`source∈{jxj,miit}`、`kind∈{announcement,export}`、`year` 四位、`batch` 安全段、`filename` 无 `/ \ .. \0`),非法返回 400
- [ ] `onUploadFinish`:拼 `files/<source>/<kind>/<year>/<batch>/<filename>` 并 `rename`;同名加 ` (n)` 不覆盖
- [ ] 不加 h3 v2;不改台账读路径与数据库
- [ ] 端到端测试:创建 → 分片 → HEAD → 续传 → 落位,断言文件逐字节一致
