# 文件上传(tus)落在 app 内

`app` 通过一个 Nitro 中间件接入 **tus** 断点续传上传(`@tus/server` + `@tus/file-store`),上传的文件按文件库规则 `files/<source>/<kind>/<year>/<batch>/<filename>` 落位。前端用 `tus-js-client` 封装一个上传组件。

**为什么放 app:** 文件库(`app/files/`)**属于 app** —— 看板要预览它、用户要往它上传(见 [ADR-来源文件内化为仓库内的文件库](./2026-10-13-source-files-in-repo.md))。上传的目标就是 app 自己的文件库,把上传端点放到别处,反而要跨进程访问这个目录。`app` 的「只读」是**第一阶段的边界**,不是永久定位(见 [ADR-第一阶段:只读查阅看板](./2026-10-13-readonly-board-first.md));文件上传是**文件写入**,不动台账记录。

**可行性(已实测,`.research/tus-research.md`):** Nuxt 4(Ssr:false)+ Nitro 下,`@tus/server` v2 的 web 入口 `handleWeb(req: Request)` 与 h3 的 `toWebRequest`/`sendWebResponse` 对接只需几行;dev 与 `nuxt build` 产物行为一致;真实中断续传后文件逐字节正确;200MiB 上传内存平稳。

**关键约束:**

- **入口用中间件**(`server/middleware/tus.ts` + `startsWith('/api/uploads')`):catch-all 路由匹配不到基路径,中间件单入口同时覆盖基路径与子路径。
- **落位由服务端裁决**:客户端在 `Upload-Metadata` 里**声明** `source/kind/year/batch/filename`,服务端**白名单校验**(防路径穿越)后在 `onUploadFinish` 里拼目标路径并 `rename`;**同名不覆盖**,追加 ` (n)`。
- **工作目录与文件库同卷**(`rename` 需同一文件系统)。
- **鉴权**:tus 协议本身不含鉴权,在中间件或 `onIncomingRequest` 里先过一道;限定 `allowedOrigins`。
- 不引入与 Nitro 冲突的 h3 版本(Nitro 自带 h3 v1)。

**已考虑但未选:** 把上传端点放 pipeline 或独立服务——目标文件库属于 app,跨进程写同一目录会带来权限/协调成本。
