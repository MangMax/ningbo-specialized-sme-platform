# 02 — 省专公布文件入库 + 最小记录列表(tracer bullet)

> ⚠️ 本票的**解析/入库**部分属于**项目外的前期工作**(`../pipeline/`),不在 app 仓库内。app 侧只保留查询与展示。见 [ADR-数据入库是项目外的前期工作](../../../docs/adr/2026-10-13-ingestion-is-outside-the-app.md)。

**What to build:** 从 `经信局名单/省专/**` 的公布文件解析出记录并入库,看板上按分页列出这些记录(企业名、称号=专精特新中小企业、来源=经信局)。一条最窄但完整的路径:公布文件 → 解析 → 归并企业 → 写库 → API → 分页表格。

**Blocked by:** 01 — 项目脚手架与运行时打通

**Status:** ✅ done(2026-10-13)

- [x] DOCX 正文按「附件」段切分;段标题判定称号与事件类型
- [x] 表格列按表头定位;只收序号为数字的数据行
- [x] `.doc` 先转 docx(soffice);无统代列时按企业名称归并
- [x] 写入 `enterprise` / `record` / `record_event` / `record_evidence`
- [x] `GET /api/records` 分页返回;台账表格渲染
- [x] 导入幂等:同目录导入两次行数不变

> 实测:省专 5,347 条(nurture 951 / award 3,390 / review 1,006),与基线一致。
