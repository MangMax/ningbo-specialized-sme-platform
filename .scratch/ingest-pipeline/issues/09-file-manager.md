# 09 — 文件管理页 + 文件表(统一管理)

**What to build:** app 新增 `/files` 页,统一管理**现有 23 个 + 之后上传的**全部文件;新增一张表记录文件的元数据与处理状态。

**Blocked by:** —

**Status:** done — 文件管理实现及独立界面验收已合入本地 main；2026-10-15 当前目录为23条登记（21条有效、2条重复DOC软删除），旧验收中的23是当时快照。

## 为什么先做这张表

现在 `files/` 里的文件**只有磁盘上的路径**(`record_evidence.source_file` 引它),**没有一行元数据**:谁来分「来源 / 类别 / 年份 / 批次」、谁记「已分类 / 待分类」「已解析 / 未解析」、谁挂 OCR 结果?—— 都缺。故先立表。

## 表:`stored_file`(建议名)

| 列 | 说明 |
|---|---|
| `id` PK | |
| `rel_path` UQ | 文件库内相对路径(`jxj/announcement/2024/1/….pdf`) |
| `filename` / `ext` / `bytes` / `sha256` | 磁盘事实(启动时扫描 `files/` 回填) |
| `source` / `kind` / `year` / `batch` | **可空** —— 允许「上传时未定、后续回写」(票 12) |
| `title_code` | 可空;该文件对应的称号 |
| `category_state` | `set` / `inferred` / `unset` |
| `parse_state` | `unparsed` / `parsed` / `failed` |
| `created_at` | |

> 现有 23 个文件:写一个**一次性回填**(扫 `files/` + 按目录规则反推 source/kind/year/batch,复用 `pipeline/src/files.ts` 的 `resolveJxjParts`)。**回填要幂等**。

## 页面 `/files`

- 列表:文件名 / 来源 / 类别 / 年份 / 批次 / **分类状态** / **解析状态** / 引用记录数 / 大小。
- 筛选:来源、分类状态、解析状态;搜索文件名。
- 行操作:**编辑元数据**(shadcn `Dialog` + `Select`/`Input`)、**预览**(复用平行会话已做的 `FilePreviewDialog`)、**删除**。
- 顶部:**上传**(票 10 接 tus)。
- 侧栏加入口(`AppSidebar.vue`),图标如 `FolderOpen`/`Files`。

## 接口(概要)

- `GET /api/files?source=&categoryState=&parseState=&q=&page=&pageSize=` → 列表
- `PATCH /api/files/:id` → 改 `source/kind/year/batch/title_code`(仅元数据,**不动磁盘文件**)
- `DELETE /api/files/:id` → 仅从库与索引移除 + 打标;**默认不删磁盘文件**(要删磁盘须显式二次确认)

## 测试

- [x] 回填幂等:重跑两次,行数不变。—— `tests/stored-file.test.ts`「回填幂等:再跑两次,行数不变」；`tests/mcp-surface.test.ts` 亦断言「扫文件库补文件行…重跑不再回填(幂等)」。
- [x] `PATCH` 只改元数据、不改 `rel_path`、不动磁盘。—— `server/api/files/[id].patch.ts`；`tests/mcp-surface.test.ts`「磁盘事实字段被拒」。
- [x] 列宽/排序稳定;分类状态筛选正确。—— 列宽见 `UI-ACCEPTANCE-files.md`（逐列实测改宽，1440 下不再横滚）；排序见 `server/utils/stored-files.ts`（按 `relPath` `localeCompare`）；分类状态筛选见同文件 `categoryState` `inArray` 条件与 `GET /api/files` 同名参数。

## 验收

- [x] 页面上能看到**现有 23 个**文件,元数据与目录规则一致。—— 旧快照的 23 = 现 23 条登记（**21 条有效 + 2 条重复 DOC 软删除**）；终库实物 21 份活跃文件，元数据与目录规则一致。
- [x] 改一个文件的年份 → 列表即时更新,磁盘文件不变。—— `tests/mcp-surface.test.ts`「改完之后 `list_files` 的查询层立刻能看到(端到端的库内半边)」；磁盘不动由 PATCH 用例覆盖。
- [x] app `pnpm typecheck && pnpm test` 全绿。—— 已接受主线 28 文件 525 测试 / typecheck 通过。

**分支**:`feat/file-manager`。**只提交本票文件。**

## 2026-10-15 当前验收记录

本地 app 代码主线 `5be3e60e3fd94cfd37929f79f07d692decf555ee`（后续8be仅文档），pipeline `4eb396f74f4ac75738dbe47ab9f09b4e1da2a95a` 已集成；app 28文件/517测试、类型检查及生产构建通过，pipeline 9文件/144测试和check通过。正式21个有效文件、55段、21443源行已重建并用两个独立CLI进程验证五张账表hash不变。证据在项目 `acceptance/20261015/{main-integration-ancestry.json,final-ledger-run3-audit.json,final-source-fact-integrity.json,runtime-production-smoke.json}`。3470生产服务已实际验证8个MCP工具列举、文件19读取17页OCR及457行。此段补充当前证据，不将下方旧快照中每个未勾选交互项一律冒充本轮重测。全新清洗验收仍由票12单独跟踪。

> **收口（2026-10-15，docs-only）**：上表按代码、测试与只读库核已满足。真实3470的独立 `/files` UI 复核已完成：桌面1440、窄屏390、PDF原文/12及17页图库/单页缩放返回关闭、DOCX只读预览通过。报告 `acceptance/20261015/evidence/ui-files-final/independent-ui-final.md`；后续平台解释窄屏浮层局部修复与独立复验见 `acceptance/20261015/tooltip-width-fix/independent-review.md`，不冒称加密PDF与该轮禁用写路径已测。
