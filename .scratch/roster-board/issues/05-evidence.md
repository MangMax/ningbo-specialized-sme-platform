# 05 — 记录出处:回溯到文件、附件、序号

**What to build:** 每条记录(及其事件)都带出处:来自哪份公布文件、哪个附件、第几号。看板上可展开看到出处,便于核对与回溯原始文件。

**Blocked by:** 03 — 创新型公布文件并入 + 称号筛选 + 搜索

**Status:** ✅ done(2026-10-13)

- [x] 解析公布文件时记录 `source_file` / `attachment` / `list_no`,写入 `record_evidence`
- [x] `GET /api/enterprises/:id` 与企业详情视图返回出处
- [x] 详情页出处可展开(Collapsible)显示文件/附件/序号
- [x] 出处路径相对数据根目录,可定位到文件
