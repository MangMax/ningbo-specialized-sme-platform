# 11 — 导入快照与幂等重跑

**What to build:** 把每次导入做成一个不可变的**导入快照**(`import_batch`);看板可切换快照;同一目录重跑幂等。让工具可逐年复用:换一个新数据目录就得到一个新快照。

**Blocked by:** 02 — 省专公布文件入库 + 最小记录列表

**Status:** ✅ done(2026-10-13)

- [x] `import_batch` 表(label / source_root / imported_at);同 label 复用同一快照
- [x] 导入按快照隔离;重跑同 label 逐表行数不变(实测)
- [x] 台账页可用 `Select` 切换快照(默认最新 / 全部),经 `/api/records?batch=` 筛选
- [x] 导入入口支持绝对路径 `--root`,回退 `SOURCE_ROOT` → `../`
- [x] `pnpm check:jxj --root <abs>` 交叉校验可用

> 归属规则:record 的 `import_batch_id` 跟随**最近一次包含它的导入**;异 label 导入按身份键全局复用企业/记录,只新增本次事件与证据。理由见 `lib/import.ts` 注释。
