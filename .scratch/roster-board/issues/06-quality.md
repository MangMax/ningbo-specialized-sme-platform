# 06 — 数据质量标记与清单

**What to build:** 导入时计算质量标记,看板提供各标记的清单视图,让经办人知道哪些记录需要人工核对。

**Blocked by:** 03 — 创新型公布文件并入 + 称号筛选 + 搜索

**Status:** ✅ done(2026-10-13)

- [x] `quality_flags`:`uscc_missing`(无统代)、`duplicate_event`(记录下重复事件)
- [x] `GET /api/quality?kind=` 返回各标记清单
- [x] 质量清单页(`/quality`):各组卡片 + 样本表 + 计数徽章
- [x] 概览展示各标记计数
- [ ] `name_ambiguous` / `non_ningbo` / `deregistered` — 需外部富化数据(登记状态/当前城市),本期不做(见 ADR-2026-10-13-announcements-as-input)
