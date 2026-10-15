# 04 — 看板:出处可点开 / 预览

**What to build:** 企业详情里每条出处的文件路径可点击:PDF 在新标签内联打开,`.doc`/`.xlsx` 触发下载;同时显示可读的「来源 / 年份 / 批次」。

**Blocked by:** 03

**Status:** ✅ done(2026-10-14,由并行的设计会话实现:components/preview/ + server/api/files/[...path].get.ts)

- [x] app 暴露文件库访问方式(Nitro 静态/受控路由读 `files/`,或配置化路径)。— `server/api/files/[...path].get.ts`
- [x] 详情页出处渲染为链接,PDF 内联、其余下载。— `components/preview/`（`PdfPreview` / `OfficePreview` / `UnsupportedPreview`）+ `SourceChip`
- [x] 显示来源、年份、批次(从路径解析)。— `lib/stored-file.ts` 的 `deriveParts` / `extensionOf`
- [x] 缺文件时优雅降级(标注「文件缺失」而非死链)。— `lib/preview.ts` `describeLoadError` 对 404 返回「文件不存在。出处路径可能已变更,或文件已被移走。」（`tests/preview.test.ts`「按状态码给可指导下一步的说明」）

> **收口（2026-10-15，docs-only）**：4 项按组件与测试已满足。
