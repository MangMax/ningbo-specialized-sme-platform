# 05 — 记录出处:回溯到文件、附件、序号

**What to build:** 每条记录(及其事件)都带出处:来自哪份公布文件、哪个附件、第几号。看板上可展开看到出处,便于核对与回溯原始文件。

**Blocked by:** 03 — 创新型公布文件并入 + 称号筛选 + 搜索

**Status:** ready-for-agent

- [ ] 解析公布文件时记录 `source_file` / `attachment` / `list_no`,写入 `record_evidence`
- [ ] `GET /api/enterprises/:id` 与企业详情视图返回出处
- [ ] 看板记录行可展开显示出处
- [ ] 出处路径相对数据根目录,可直接定位到文件

> 注:02 已建 `record_evidence` 表并写入最小字段;本票补齐多段名单下的附件/段位标识与界面呈现。
