# 03 — 出处路径改为文件库相对路径

**What to build:** 导入时写入的 `record_evidence.source_file` 改为**相对文件库根**的路径(如 `jxj/announcement/2024/1/…pdf`);app 侧按此解析。

**Blocked by:** 02

**Status:** ✅ done(2026-10-14)

- [x] pipeline:解析公布文件时,`sourceFile` 用新规则路径(与文件库一致)
- [x] app:`lib/query.ts` 的 evidence 输出保持相对文件库根（`lib/query.ts` 的 `sourceFile` 字段直出库内相对路径）
- [x] 重建库,抽查 `source_file` 全部为新规则路径、且文件库里都存在。—— 只读核现行正式库：`record_evidence` 21 个 distinct `source_file`，全部符合 `jxj|miit` 前缀，且在 `acceptance/20261015/files/` 下**逐一存在**（0 缺失）。
- [x] 测试:断言导入后的 `source_file` 能在文件库定位到文件。—— `pipeline/tests/build-files.test.ts` 的 `resolveStoreFile`（PDF → `.docx` → `.doc`）用例。

> **收口（2026-10-15，docs-only）**：4 项按代码、只读库核与测试已满足。
