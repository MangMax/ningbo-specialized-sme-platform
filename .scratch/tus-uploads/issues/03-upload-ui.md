# 03 — 上传组件(oil-ui 打磨)

**What to build:** 用 `tus-js-client` 封装上传组件,含拖拽、进度、断点续传、错误提示;用 **oil-ui 技能**按现有 shadcn 组件库风格打磨,纳入看板。

**Blocked by:** 01

**Status:** ✅ done(2026-10-14)

- [x] 上传组件:选择/拖拽文件 → 填或推导 `source/kind/year/batch` → 上传 → 显示进度/结果路径（`components/upload/{UploadPanel,UploadDropzone,MetadataFields,UploadItem}.vue`）
- [x] 断点续传:`storeFingerprintForResuming`,页面刷新后可 `resumeFromPreviousUpload()`。—— 用 `tus-js-client` 的 `Upload` 并自定义 fingerprint（`lib/upload.ts` 的 `resumeKey` / `matchPreviousUpload`），续传提示在 `UploadItem.vue`。
- [x] 错误态:非法 metadata(400)、超限(413)有明确提示。—— `tests/tus.test.ts`「非法 metadata 在创建阶段返回 400」「超过 maxSize 的创建返回 413」；`tests/upload.test.ts` 校验 `isBatchComplete` / `validateBatch`。
- [x] **用 `oil-ui` 技能**评审并打磨:与现有 sidebar/card/table 视觉一致,不花哨
- [x] 只用 shadcn-vue 官方组件,禁止原生 `<input type=file>` 裸用之外的自造控件。—— `UploadDropzone.vue` 用 shadcn `Input type="file"`，注释明写「项目约定：不裸写原生控件」。
- [x] 不动台账读路径

> **收口（2026-10-15，docs-only）**：6 项按组件与测试已满足。注：maxSize 上限行为在服务端（413）已测；上传入口的实际投递在本环境走**页面自身的 tus 客户端**（组件 DOM File 输入），**原生文件选择控件路径未单独验收**（见票 12 收口），不把受控 DOM 注入称作原生 chooser 验收。
