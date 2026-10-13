# 03 — 上传组件(oil-ui 打磨)

**What to build:** 用 `tus-js-client` 封装上传组件,含拖拽、进度、断点续传、错误提示;用 **oil-ui 技能**按现有 shadcn 组件库风格打磨,纳入看板。

**Blocked by:** 01

**Status:** ✅ done(2026-10-14)

- [ ] 上传组件:选择/拖拽文件 → 填或推导 `source/kind/year/batch` → 上传 → 显示进度/结果路径
- [ ] 断点续传:`storeFingerprintForResuming`,页面刷新后可 `resumeFromPreviousUpload()`
- [ ] 错误态:非法 metadata(400)、超限(413)有明确提示
- [ ] **用 `oil-ui` 技能**评审并打磨:与现有 sidebar/card/table 视觉一致,不花哨
- [ ] 只用 shadcn-vue 官方组件,禁止原生 `<input type=file>` 裸用之外的自造控件
- [ ] 不动台账读路径
