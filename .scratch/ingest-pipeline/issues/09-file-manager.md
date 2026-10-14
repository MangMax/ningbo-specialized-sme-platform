# 09 — 文件管理页 + 文件表(统一管理)

**What to build:** app 新增 `/files` 页,统一管理**现有 23 个 + 之后上传的**全部文件;新增一张表记录文件的元数据与处理状态。

**Blocked by:** —

**Status:** ready

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

- [ ] 回填幂等:重跑两次,行数不变。
- [ ] `PATCH` 只改元数据、不改 `rel_path`、不动磁盘。
- [ ] 列宽/排序稳定;分类状态筛选正确。

## 验收

- [ ] 页面上能看到**现有 23 个**文件,元数据与目录规则一致。
- [ ] 改一个文件的年份 → 列表即时更新,磁盘文件不变。
- [ ] app `pnpm typecheck && pnpm test` 全绿。

**分支**:`feat/file-manager`。**只提交本票文件。**
