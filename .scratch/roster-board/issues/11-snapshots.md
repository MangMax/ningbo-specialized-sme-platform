# 11 — 导入幂等(快照概念已作废)

**What to build:** 导入**幂等** —— 同一份数据目录重复导入不产生重复行。

> ⚠️ **本票已收窄。** 原设计里的「导入快照 / `import_batch`」被用户否掉:**没有任何地方需要它,不应存在于数据模型中**。故 `import_batch` 表、`record.import_batch_id`、`/api/batches`、台账页的快照选择器、`?batch=` 筛选**全部移除**(迁移 `0001_married_mister_fear`)。
> 幂等本身不再靠快照实现,而是靠**身份键去重**:企业按 `(uscc_norm)` 或 `(name_norm)`、记录按 `(enterprise_id, title_code, source)`、事件按 `(record_id, event_type, year, batch_seq)`。

**Blocked by:** 02

**Status:** ✅ done(2026-10-13;快照部分已作废)

- [x] ~~`import_batch` 表~~ — 已删除
- [x] 重跑同一目录:所有表行数不变(靠身份键去重)
- [x] ~~台账页切换快照~~ — 已删除
- [x] 导入入口支持绝对路径 `--root`,回退 `SOURCE_ROOT` → `../`
- [x] `pnpm check:jxj --root <abs>` 交叉校验可用
