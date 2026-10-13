# 06 — 数据质量标记与清单

**What to build:** 导入时计算质量标记,看板提供各标记的清单视图,让经办人知道哪些记录需要人工核对。

**Blocked by:** 03 — 创新型公布文件并入 + 称号筛选 + 搜索

**Status:** ready-for-agent

- [ ] `quality_flags`:`uscc_missing`(无统代)、`name_ambiguous`(同名多企业)、`non_ningbo`(区县/城市非宁波)、`deregistered`(注销/吊销)、`attachment_unparsed`
- [ ] 看板可按标记筛选记录
- [ ] `GET /api/quality?kind=` 返回各标记清单
- [ ] 概览展示各标记计数
