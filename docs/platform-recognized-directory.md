# 平台认定目录（镜像）本地查询（#462）

本层消费 #461 的 `platform_recognized_projection`，提供只读的本地平台认定目录 HTTP/MCP 查询、最小页面与真实消费者深链。只覆盖 `recognized_list`（上游 `queryBusList`）；不迁移 `apply_list`/`business_list`，不访问外部平台，不写业务数据，不改变旧 ID/审计/对应/资格算法。

## 命名与边界：目录镜像 ≠ 当前有效

| 名称 | 含义 | 入口 |
|---|---|---|
| **平台认定目录（镜像）** | 本地归档的平台 `queryBusList` 目录行：目录业务ID、主体原名、有效期原值、维护年/批次、属地、原认定说明。只表达「平台当时返回了什么」。 | `/platform-recognized-directory`、`GET /api/platform/recognized-directory`、MCP `list_platform_recognized_directory` |
| **当前有效企业** | 清洗后、依正式认定与复核事件判定的当前资格读模型（既有 `current-qualification`）。 | `/current-enterprises`、`GET /api/roster/current-enterprises` |

- 目录存在/消失、`rddqrq` 原值、`whpcyear`/`whpc` **都不直接推出正式有效或失效**。本层不新建第二资格算法，也不写入正式事件/对应。
- 页面与接口名称固定为「平台认定目录（镜像）」；页面描述明写「不是『当前有效企业』资格模型」。每条目录记录提供到既有 `/current-enterprises` 的**导航入口**（`q=企业名称/USCC`，仅当观察到的查询称号范围唯一时才带 `titleCode`）；这是入口，不是判定。
- 目录行与正式资格的对照见「三路对照」；目录读路径与旧企业平台历史的对照见「影子对照」。
- 术语：**平台认定目录（镜像）** 指本读模型；**有效期原值** 指 `rddqrq` 原样字符串——不是认定日期，也不是精确到期日。两者见 [GLOSSARY](../GLOSSARY.md)。

## 查询入口

| 入口 | 契约 |
|---|---|
| `GET /api/platform/recognized-directory` | 等价 MCP `list_platform_recognized_directory`。 |
| `GET /api/platform/recognized-directory/{recordId}` | 等价 MCP `get_platform_recognized_record`。 |
| 页面 `/platform-recognized-directory` | 侧边栏「平台认定目录」；筛选、分页、观察与版本详情。 |
| 真实消费者（必需） | `components/PlatformRecords.vue` 的 `recognized_list` 行「本地目录记录」：仅在已解析出 `platformKey` 时渲染，深链携带精确 `platformKey`；缺编号/编号冲突/未核实行不渲染链接。 |
| 次级入口（非必需） | `/platform-queries` 的 `recognized_list` 查询卡片「本地目录记录」：USCC 形 key → `q=key`；`name:<名称>` → `q=<名称>`；`scope:...` 及其它 → 不带 `q`（进入目录页，不加筛选）。它只是导航，不承担消费者职责。 |

### 筛选（REST 与 MCP 同一 zod strict 契约）

| 参数 | 语义 |
|---|---|
| `view` | `records`（默认）或 `isolated`。 |
| `q` | 企业名称/统一社会信用代码关键词；只通过已归属观察匹配。查询卡片的 `scope:queryBusList:...` 键不含企业名称/统代，因此该入口不带 `q`。 |
| `enterpriseId` | 精确企业 ID（经已归属观察）。 |
| `platformKey` | 精确目录业务ID = `platform_business_record.platform_key`；`interface='recognized_list'` 限定，跨接口同编号不合并。`view=isolated` 下匹配原行编号，因为未投影观察没有目录业务ID。 |
| `rdjb` | 来源查询的**显式称号范围**（1/2/3），取 `platform_query.rdjb` 或 `platform_query_title_scope`；不是逐行称号事实。 |
| `rddqrq` | 原有效期字符串，**精确相等**；不解析日期、不按前缀/年份/格式匹配。 |
| `whpcyear` | 显式正整数（与 typed 投影同一解析规则）；未知保持 null。 |
| `whpc`、`szq` | 原值精确相等。 |
| `page`/`pageSize` | 稳定分页；`pageSize ≤ 200`（`MAX_PAGE_SIZE`）。 |

- HTTP 查询串由单一转换点解析，未知参数返回 400；REST 与 MCP 复用同一 strict schema。
- `view=isolated` 与 typed 值筛选（`rddqrq`/`whpcyear`/`whpc`/`szq`）组合时返回空：未投影观察没有 typed 值，不能被显式值命中。

## 读语义

- `records` 按目录业务记录组织：同一 `platform_business_record` 的匹配内容版本压缩为一行，返回匹配版本（按内容版本 ID 倒序的最新版，**不代表时间顺序**）、匹配版本数、全部版本数、观察数、最近采集时间、企业归属、观察到的明确称号范围与冲突。尚未建立 typed 投影的历史版本仍以空字段出现并标注 `ruleVersion=null`；不因回填未执行而从查询面消失。
- 冲突（有序）：`title_conflict`（行 `rdjb` 原值为已知 1/2/3 且不在该观察的显式查询范围内）、`unverifiable_observation`、`enterprise_assignment_conflict`（>1 家企业归属）。未知/缺失的行称号或空查询范围不算冲突。
- `isolated` 单独列出 `missing_key`、`conflict`、`unverifiable` 或无版本观察，不并入任何记录，仍按原 `relationId`/`queryId` 可定位。缺值保持 null/原值；不从 `queriedAt`、批次、名称或 `rddqrq` 猜填年份/称号/属地。
- 同 `platformKey` 跨接口（apply/business/recognized）是不同记录，永不合并。

## 详情边界

详情返回记录身份、全部内容版本（最多 100）和实际观察（最多 200）：版本 typed 字段、版本的观察称号范围、版本哈希、观察的 relation/query/采集时间/企业归属/identity/content 状态、查询称号范围、该观察自己的对应决定引用（id/status/revision，不返回决定内容、不传播到其他观察），以及记录级冲突。超出上限时 `counts.versionsTruncated`/`observationsTruncated=true`，不静默截断。**不返回 raw JSON**；原档仍走 `GET /api/platform/queries/{queryId}/evidence`，页面可按原行展开既有 `RecordSourceReader`。

## 预算

- 列表 SQL 只读 `platform_recognized_projection` 与既有 `platform_business_record(_version)`/`observation`/`relation`/`query` 列与其索引；企业关键词通过已归属 observation/relation/enterprise 做 `EXISTS`，称号范围通过 `platform_query`/`platform_query_title_scope` 做 `EXISTS`（不 JOIN，避免行倍增），**不扫描或解析 raw JSON**。
- `total` 与行查询共用同一组 `WHERE`：包括 `rdjb` 在内的每个筛选都约束**同一个被选中的内容版本**（`versionTitleScopeExists` 以 `v.id` 关联），不会出现「记录级命中、行级不命中」的 `total=1, rows=[]`。
- 记录级冲突只做 `select distinct o.record_id` 聚合：未核实观察一条、行称号与查询范围冲突一条（SQL 内联 `platform_query.rdjb` + `platform_query_title_scope` 判定，与 `titleScopesByQuery` 同一语义）、企业归属复用既有 helper；不物化观察行，内存与响应按 ≤200 个记录 ID 有界。
- 每页最多 200 条记录；详情最多 100 个版本、200 次观察，计数另查。详情称号范围只针对实际返回的 ≤100 个版本、≤200 次观察的 query id。
- 稳定排序：记录按最近采集时间倒序、记录 ID 倒序；版本按版本 ID 倒序；观察按采集时间倒序、relation ID 倒序。
- 测试预算：小详情响应体 < 600 KB；101 版本 / 201 观察的详情 < 900 KB（`tests/platform-recognized-directory-http.test.ts`）。
- 分页一致性与 60 观察有界冲突回归：`tests/platform-recognized-directory-http.test.ts`（`rdjb=1&whpcyear=2025` → total 0 / rows []；`rdjb=2&whpcyear=2025` → total 1；单记录 60 观察仍返回 `title_conflict` 且响应 < 10 KB）。
- 失败返回 400/404，不把失败/无记录混成空结果；响应 `cache-control: no-store`。

## 影子对照（同一隔离 SQLite，同一观察）

对照对象：旧企业详情平台历史读路径 `readPlatformBusinessDetails` vs 新 `listPlatformRecognizedDirectory`/`getPlatformRecognizedRecord`。输入为同一隔离库内同一企业的 6 次 `recognized_list` 观察：K1 同内容重放 2 次（1 版本 2 观察）、K2 缺省有效期/维护值、K3 行 `rdjb` 与查询范围冲突、一条缺编号观察、一条编号冲突观察，并写入一条 observation 级对应决定；另有同 `platformKey` 的 `business_list` 记录用于证明不合并。

| 对照项 | 结果 |
|---|---|
| 记录身份（platformKey / interface / recordId） | 一致，无差异 |
| 版本数 / 观察数 | 一致，无差异 |
| 观察 relationId 与版本 versionId 定位 | 一致，无差异 |
| 分页（pageSize=1 的两页） | 两页恰为旧 reader 观察时间最新的两条记录 |
| `platformKey` 筛选 | 与旧 reader 成员一致 |
| `rdjb` 筛选 | 新 reader 结果 = 旧 reader 中称号观察为查询范围的子集 |
| 同编号跨接口 | 新 reader 单列 recognized 记录；business 记录不并入 |
| 缺编号/编号冲突观察 | **已批准语义差异**：旧路径按 relation 独立成一条业务详情；新路径不并入记录，只在 `view=isolated` 单列 |
| 有效期/维护年/批次/属地 typed 字段 | **新增字段**：旧 DTO 无逐记录 typed 访问；新路径只从内容版本投影返回 |
| 查询称号范围 | **新增字段**：旧 DTO 每观察只有派生 `titleCode`，无显式范围集合；新路径显式返回查询事实 |
| `title_conflict` | 两侧都识别；**呈现位置差异**：旧路径在观察 conflicts，新路径在记录级 conflicts + 观察 `titleConflict` |
| 对应决定 | 两侧都保留该观察自己的引用；新路径只返回 id/status/revision |
| 未知值 | 新路径 `validityDateRaw/maintenanceYear/maintenanceBatch/district/awardNote` 保持 null（K2 断言） |

对照测试：`tests/platform-recognized-directory-shadow.test.ts`（记录集合、计数、relationId/versionId、分页、筛选、冲突与决定定位均为直接断言；`SHADOW_DIFF` 只列已批准差异）。不把新 reader 自身当唯一 oracle。

## 三路对照（同一隔离文件 SQLite）

- A = 新目录读路径（公开 HTTP `GET /api/platform/recognized-directory`）。
- B = `enterpriseReads.currentQualifiedJson(dbPath, {titleCode:'innovative_sme'})`（`/api/roster/current-enterprises` 路由同一调用）。
- C = 真实异步导出写入器 `writeCurrentWorkbook(db.$client, title, file, () => {})` + `readExportWorkbook`。
- 三称号：`innovative_sme`、`specialized_sme`、`little_giant` 各跑一遍基线 A/B/C、改 typed 投影、删 typed 投影三步。观测到的 `rddqrq`/`whpcyear` 筛选见证仅适用于 `innovative_sme`（`lib/roster/recognized-filter-facts.ts`），另两称号的 `matchedValidYears` 预期为空——这是既有已批准语义，不是本层差异。
- 种子：正式认定事实 + `recognized_list` 观察 + 已确认 `event_recognized` 对应（`matrix408(...).formal` 与 #461 投影路径 `ensurePlatformObservation`）。

| 步骤 | A（目录） | B（当前有效） | C（导出工作簿） | 理由与非结论边界 |
|---|---|---|---|---|
| 基线 + 三面只读 | 1 条，`rddqrq=2028-06-01`、`whpcyear=2024`、`titleRaw=1` | 1 条 eligible，`matchedValidYears=[2028]` | 有效企业 1 条 | 读前后全库 DDL+内容摘要一致 |
| 改 typed 投影（有效期/维护年/属地） | 立即显示新原值，总数不变 | **全量 JSON 深度相等**（去掉 `asOf`/`snapshotId`/`snapshotStartedAt`） | **全量工作簿深度相等**（去掉「生成时间」行） | typed 投影不是资格输入 |
| 只删 typed 投影行 | 记录仍在、typed 字段为 null、`ruleVersion=null`，无冲突 | **全量相等** | **全量相等** | 历史版本可读，不猜填 |
| 删目录观察 + 投影 + relation/query（目录消失） | 记录消失（total 0） | 资格/分组不变（仍 eligible），`matchedValidYears` 变为 `[]`；`validYear=2028` 命中数 1→0 | 决策面相等；**仅「来源及页码」列不再引用该观察** | 允许差异：B 的 `qualificationAssessment` 与 C 的出处列本来就记录已归档平台观察；正式资格、分组、导出行与计数不变 |
| 新增未确认目录行（无对应决定） | +1 | 资格/分组/行集合不变（`eligibility` 深度相等） | 决策面相等；出处列新增该观察引用 | 同上；未确认目录行不产生 Witness |
| 新增行 `rdjb=3` 与查询范围 `1` 冲突 | +1，记录级 `conflicts=['title_conflict']`、`titleScopes=['1']` | 不变 | 决策面相等 | 行称号不写入查询范围，也不影响资格 |
| validYear witness：删乙企业见证观察 | 由 2→1 | 关筛选：2 条仍 eligible；开 `validYear=2028`：2→1；乙企业分组仍 eligible | 决策面与 2 条身份不变；出处列少 1 条引用 | 目录见证只提供筛选事实；删见证只移除筛选命中，不删企业资格 |

结论边界：以上证明的是「目录镜像的新增/消失/原值变化**不改变正式资格判定与导出的正式内容**」。它**不**证明目录值可推出资格，也**不**证明 B 的 `qualificationAssessment` 观察清单或导出的「来源及页码」出处文字不随平台归档变化——这两处按既有设计记录已归档观察，属已批准、有理由的差异。

对照测试：`tests/platform-recognized-directory-three-way.test.ts`（每步都断言 A 的精确变化、B 的资格面与 C 的决策面；不使用新 reader 作为 B/C 的 oracle）。

## 人工 UI 验收

- 表格沿用共享 `data-table-scroll`（不再用 `[&_[data-slot=table-container]]:overflow-visible` 关闭其滚动）；表格最小宽 `min-w-[880px]`，1280px 下不产生页面级横向溢出，1024/768 由卡片自身横向滚动到达「详情」；「版本 / 观察」列 10% 且 `whitespace-nowrap`，`1 / 1` 不裁切。
- 详情弹窗标题 `pr-8` 并缩短为「平台认定目录 #<recordId> · 观察与版本」，390px 下不钻到绝对定位的关闭按钮下；观察表改用共享 `Table` 原语并保留同一 `overflow-x-auto`。

**实操记录（2026-11-04，Asia/Shanghai；集成分支 `t3/implement-spec-319` 的 `pnpm dev`，隔离临时 SQLite，经领域层写入 3 条已解析目录记录 + 缺编号/冲突隔离观察）**：

- **1280px**：侧边栏「平台认定目录」可达；表格实际宽 974px、卡片内容宽 974px，页面无横向溢出（`scrollWidth-clientWidth=0`），9 列全部可见，「版本 / 观察」显示 `1 / 1` 且不裁切，「详情」列的「观察与版本」「当前有效资格」完整可点；企业关键词 `示例` 查询返回 1 条且计数同步为「共 1 条记录」；「观察与版本」打开详情，记录身份、内容版本、有效期/维护年/批次/属地、行称号原值与查询称号范围、观察表均可见。
- **390px**：筛选纵向排列、记录改为卡片（「观察与版本」按钮高 44px），页面无横向溢出；详情弹窗宽 358px、内部纵向滚动，标题「平台认定目录 #3 · 观察与版本」单行显示且不压住右上关闭按钮（标题 `padding-right: 32px`），观察表在弹窗内横向滚动（内容 991px / 视口 296px），关闭可用。
- **真实消费者**：企业详情平台记录表的 `recognized_list` 行出现「本地目录记录」链接，携带 `platformKey=DIR-UI-1 / DIR-UI-2`；`/platform-queries` 认定查询卡片链接按 USCC/名称归一为 `q`，`scope:` 键不带 `q`。
- 以上为人工操作观察，不是像素级断言；覆盖筛选、空态/失败重试、分页、详情与深链的组件用例仍见下方测试表。

## 测试

| 命令 | 覆盖 |
|---|---|
| `pnpm vitest run tests/platform-recognized-directory-http.test.ts --maxWorkers=1 --no-file-parallelism` | 公开 HTTP：筛选（企业/目录ID/称号范围/有效期原值/维护年/批次/属地）、精确原值、分页、未知值、缺编号/冲突隔离、跨接口不合并、详情 100 版本/200 观察截断、无 raw 泄露、400/404、响应体预算 |
| `pnpm vitest run tests/platform-recognized-directory-mcp.test.ts --maxWorkers=1 --no-file-parallelism` | MCP 工具名、与 REST/领域服务同一契约、isolated 视图 |
| `pnpm vitest run tests/platform-recognized-directory-ui.test.ts --maxWorkers=1 --no-file-parallelism` | 表格 typed 原值/冲突/当前有效导航（唯一称号范围才带 titleCode）、隔离表、详情/截断/未投影版本、`PlatformRecords` 真实消费者深链 |
| `pnpm vitest run tests/platform-recognized-directory-page-ui.test.ts --maxWorkers=1 --no-file-parallelism` | 页面 `q`/`platformKey` 预填、筛选/视图/分页、维护年校验、空态、失败重试、`/platform-queries` 卡片深链 |
| `pnpm vitest run tests/platform-recognized-directory-shadow.test.ts --maxWorkers=1 --no-file-parallelism` | 旧企业平台历史读路径 vs 新目录读路径 |
| `pnpm vitest run tests/platform-recognized-directory-three-way.test.ts --maxWorkers=1 --no-file-parallelism` | A/B/C 三路与四种目录变更 |

## 真实业务副本验证（2026-11-04）

数据来源：`3482` 端口 Docker 实例的 `/state/data/roster.db`（部署镜像 `spztx-roster:main-49133834`）。用 `better-sqlite3` 的在线 `backup` 接口复制到隔离文件（约 1.9GB），**原实例只读、未写入、未改容器内状态**；验证代码为 `main` 的 `fd8efe32`。

### 迁移与回填

- 部署库有 55 张表，**没有** `platform_apply_projection` / `platform_business_projection` / `platform_recognized_projection`。在副本上按 main 迁移后新增这 3 张表（0033/0034/0035），既有表与行不变。
- 认定数据：7,327 次 `recognized_list` 查询（6,964 success / 339 no_record / 21 failed / 3 partial），10,065 行 / 记录 / 版本 / 观察，覆盖 6,965 家企业；全部 `resolved + verified`，无缺编号、编号冲突或未核实观察，`view=isolated` = 0。
- `ensurePlatformObservation` 为 10,065 个真实观察创建 10,065 条 typed 投影：0 冲突、0 复用、耗时约 5.4s。
- 真实空值分布：`validity_date_raw` 0 空、`maintenance_year` **10,065 空**（真实 `whpcyear` 全为空串）、`maintenance_batch` 2 空（空串）、`district` 0 空、`award_note` **10,065 空**（行内无 `rdxx`）、`title_raw/name_raw/uscc_raw` 0 空。
- 原值精度：`rddqrq` 有 9,503 条 date-only（`YYYY-MM-DD`）与 **562 条 datetime**（`YYYY-MM-DD HH:MM:SS`）；投影全部原样保留，未解析成日期。精确过滤 `rddqrq=2024-03-28 10:33:22` 命中 1 条且返回同值；用年份前缀 `2024` 过滤为 0。

### 查询与影子对照

- 目录 total = 10,065；51 页（每页 200，末页 65，合计 10,065）；isolated = 0。
- `rdjb` 过滤返回 10,062 / 10,061 / 10,062（1/2/3）：真实查询多数记录的范围是 `1,2,3`，过滤按**查询称号范围**而不是逐行称号，符合契约；行称号超出查询范围的冲突为 0。
- `whpc=2024-1` 2,082；`szq=133020300` 665；`whpcyear=2024` 0（真实 `whpcyear` 为空）。
- 影子对照：抽取 100 家企业、163 条记录，旧 `readPlatformBusinessDetails` 与新目录 reader 的记录/版本/观察定位 **0 差异**。

### 资格与导出不变

- 删除全部 typed 投影与回填后，三称号各 20 家 USCC 抽样的 `current-enterprises` 结果（total / rows / group）完全一致。
- 三称号**完整真实导出工作簿**的 counts、四个 sheet 行数与「有效企业」身份 hash 在删除/回填前后完全一致：创新型 eligible 4,186 + pending 2,444；专精特新 2,996 + 806 + 3 excluded；小巨人 156 + 1,084 + 29 excluded。
- 目录 ≠ 当前有效（真实样本）：按企业 ID 取 120 条目录行，专精特新 73/73 当前 eligible，创新型 1/1，小巨人仅 2/46。样本按企业 ID 抽取、非随机，不能外推为总体比例；它只证明「目录行存在且行称号在小巨人范围内」也不等于本地当前有效资格，与设计边界一致。

### 公开入口与限制

- `GET /api/platform/recognized-directory?pageSize=5`：200，total 10,065，5 行响应 4.9KB，约 88ms；详情 200（1 版本 / 1 观察，2.2KB，约 4ms）；页面 200；MCP `tools/list` 含 `list_platform_recognized_directory` 与 `get_platform_recognized_record`；按企业 USCC 的 `current-enterprises` 查询 200（约 2.8s，走既有 off-main reader）。
- 1280px 与 390px 真实数据页面：表格 954px 与容器同宽、无页面横向溢出；25 行/卡片正常；390px 详情弹窗 358px、标题避让关闭按钮、观察表在弹窗内横向滚动（1329px / 296px）。
- **限制**：1.9GB 真实副本上的全量 `current-enterprises` 逐页读取超过 8 分钟未完成，本次资格不变性改用每称号 20 家 USCC 抽样；导出为全量真实工作簿。抽样结论不外推到未抽样企业。

## 存储与历史投影

存储、迁移、规则版本与回填路径见 [平台业务记录契约](platform-business-record-contract.md) 的「recognized_list 来源专用 typed 投影（#461）」。历史观察继续通过 `platformRecordObservations`（每批 1..100）投影；预检/提交回执给出 `recognizedProjectionsCreated`/`recognizedProjectionsReused`。本层不新增写入命令。
