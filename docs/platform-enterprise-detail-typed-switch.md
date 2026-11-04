# 企业详情平台字段切换到来源专用 typed 读取（#455 slice 2）

本切片只切换第 1 组「平台三业务」中的**企业详情**读路径：`GET /api/roster/enterprises/{id}` → `getRosterEnterpriseDetail` → `readPlatformBusinessDetails` → `components/PlatformRecords.vue` / `PlatformBusinessHistory.vue`。不新增接口，不改企业列表、对比页、差异列表、资格、年度、对应或导出算法，不删除旧表/旧列/raw/旧 reader。

## 读取链

- 入口：`server/api/roster/enterprises/[id].get` → `lib/roster/enterprise-roster.ts` 的 `getRosterEnterpriseDetail`（既有读事务内）。
- 平台详情：`server/utils/platform-business-detail-read.ts` 的 `readPlatformBusinessDetails`。
- typed 读取：同文件新增 `readPlatformTypedDetailFields`，按观察的 `relationId` 经 `platform_business_observation.(version_id, record_id)` LEFT JOIN 三张来源专用投影：
  - `platform_apply_projection`（`platform-apply-v1`）
  - `platform_business_projection`（`platform-business-v1`）
  - `platform_recognized_projection`（`platform-recognized-v1`）
- DTO：`lib/roster/platform-business-detail.ts` 的 `PlatformDetailObservation.typedFields`（`PlatformDetailTypedFields | null`）。
- 展示：`PlatformRecords.vue` 主表与 `PlatformBusinessHistory.vue` 观察头部优先 typed；typed 缺失时回退旧 relation/raw 列。

新增的 typed 投影查询只读取 `platform_business_observation`、`platform_relation`、`platform_query` 的轻量定位列和三张投影的业务列，不读取 `raw_fields`、`canonical_raw_json` 或原封套正文。既有 `normalizePlatformRelation`/未投影回退路径仍会读取 `archived.rawFields`，用于保留历史行、normalization 冲突和未投影展示；原有 `readPlatformBusinessMetadata` 的「不读大字段」约束保持不变。

## 切换前 vs 切换后

| 字段/展示 | 切换前 | 切换后 | 回退 |
|---|---|---|---|
| 企业名称、统一社会信用代码 | `platform_relation.name_raw/uscc_raw`（导入时冗余列） | 投影的 `name_raw/uscc_raw` | `typedFields=null` 时旧列 |
| 省份、申报类型、办理状态、申报时间、维护批次 | `platform_relation` 对应列（经 `normalizePlatformRelation`） | business/apply 投影对应列 | 未投影行回退旧列；apply 投影不建模 `batch/province`，这两列仍回退旧列 |
| 已认定列表：属地、认定信息、有效期原值、维护年、维护批次 | `raw_fields.szq/rdxx/rddqrq/whpcyear/whpc`（`recognizedField`） | recognized 投影 `district/award_note/validity_date_raw/maintenance_year/maintenance_batch` | 未投影行回退 `rawFields` |
| 行集合、`relationId/queryId/versionId`、企业归属、分组、对应决定、冲突标记 | 既有读取 | 不变 | 不适用 |
| 页面布局、列顺序、390px 横向滚动 | 既有 | 不变 | 不适用 |

## 回退条件（显式）

1. **观察没有可复用 typed 行**：未建立观察映射（`not_indexed`）、缺编号（`missing_key`）、编号冲突（`conflict`）、原文不可核实（`unverifiable`），或历史内容版本没有对应投影行时，`typedFields=null`，所有字段走切换前的 `normalizePlatformRelation` / `rawFields` 读取。
2. **投影存在但字段为空/未知**：`typedFields` 是对象且字段为 `null` 时，展示「未提供」，**不**从 `raw_fields`、导入列、查询条件、批次或时间补猜。这是本切片已批准的语义差异（例如空串 `rddqrq`、非正整数 `whpcyear`、空白 `szq`）。
3. **来源投影未建模的字段**：apply 投影没有 `batch/province` 列，DTO 中不出现这两个属性；主表对 apply 行继续使用旧 relation 列，避免把「未建模」误当成「源字段为空」。
4. **没有 businessRecords 的页面**：`components/ComparisonPlatformEvidence.vue` 不传 `businessRecords`，因此对比页全部走旧展示；企业详情页传 `data.platform.businessRecords`，使用 typed。

## 已批准的差异清单

- **typed null 保持 null**：投影存在而源字段为空/未知时，不再显示导入列或 raw 里的旧值；unprojected 行才回退。示例测试：recognized 投影的 `nameRaw/usccRaw/validityDateRaw/maintenanceYear/maintenanceBatch/district/awardNote` 均为 null，但 relation 上仍有导入名称/批次/年份，展示保持「未提供」。
- **stored-vs-raw 冲突的显示位置**：冲突仍由 `normalizePlatformRelation` 产生并保留 `platform_field_conflict` 标记；旧 normalized 列在冲突时为空，typed 显示归档 raw 值。用户会同时看到「字段冲突，待核」与 raw 值，而不是把冲突吞掉或凭导入列补值。
- **名称/信用代码的 stored-vs-raw 差异**：typed 优先显示归档 raw 值；原有 `identity_conflict` 标记和分组语义不变。
- **行称号不进入 typed 详情 DTO**：recognized 投影保存行级 `title_raw`，但企业详情主表的称号展示/筛选继续使用既有查询范围（`sourceRdjb` / `query.rdjb`）与 `title_conflict` 检查；本切片不把行称号升格为查询称号，也不改变冲突名。行级原值仍可由既有原行详情读取。

未改变的语义：同一隔离库上的行集合、每行 `relationId/queryId`、内容版本 `versionId`、企业归属、未知/null 与冲突标记、对应决定定位与页面信息架构（企业详情无分页）。

## 测试

新增：

- `tests/enterprise-detail-typed-read-455.test.ts`：同一隔离真实 SQLite；三接口投影、同一版本多观察、不同版本、未投影历史行、typed null 不回填、stored-vs-raw 冲突、HTTP 行集合与 canonical raw 不泄露。
- `tests/enterprise-detail-typed-ui-455.test.ts`：`PlatformRecords` 三来源 typed 优先、typed null「未提供」、未投影回退、apply 未建模列回退、history 观察头 typed 优先；布局仍用既有横向滚动容器。

命令：

```bash
pnpm vitest run tests/enterprise-detail-typed-read-455.test.ts tests/enterprise-detail-typed-ui-455.test.ts --maxWorkers=1 --no-file-parallelism
pnpm vitest run tests/platform-business-detail.test.ts tests/platform-records-ui.test.ts tests/platform-business-history-ui.test.ts tests/platform-recognized-records-ui.test.ts tests/platform-recognized-directory-ui.test.ts tests/enterprise-read-http.test.ts --maxWorkers=1 --no-file-parallelism
```
