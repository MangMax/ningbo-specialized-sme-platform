# 当前资格的 recognized_list 类型化读取（#468，第 6 组）

状态：**部分完成**。资格见证与四个消费者（HTTP、MCP、页面、三称号异步工作簿）已切到
`platform_recognized_projection`；`currentCandidateSql` 的候选集合仍是旧 `platform_relation`
路径，按本票范围显式登记、未切换。本文只记录第 6 组的读路径切换，不改资格/年度/对应/导出规则。

## 旧调用清单

切换前，当前资格读取全部经 `lib/roster/current-qualification.ts` 的同一评估器；该评估器被
下列入口共享：

| 消费者 | 入口 | 旧读取 |
|---|---|---|
| HTTP | `GET /api/roster/current-enterprises` → `enterpriseReads.currentQualifiedJson` → `listCurrentQualified` | `filterSource` 从 `platform_relation.raw_fields` 取 `rddqrq`/`whpcyear`/`whpc`，从 `platform_query.collection_evidence` 取 `pages`/`effectiveConditions`/`completeness`/`fullRange` |
| MCP | `list_current_qualified_enterprises` → 同一 `enterpriseReads.currentQualifiedJson` | 同上 |
| 页面 | `pages/current-enterprises.vue` → HTTP | 同上（页面不另读数据库） |
| 三称号异步工作簿 | `lib/roster/current-workbook.ts` → `createCurrentQualificationAssessmentReader(...).readTitle/readWorkbook` | 同一评估器；工作簿只消费分组/列，不消费筛选见证 |
| 候选集合 | `lib/roster/current-candidates.ts` 的 `currentCandidateSql` | `platform_relation`/`platform_query` union；**本票未切** |
| 筛选事实纯函数 | `lib/roster/recognized-filter-facts.ts` | 仍只解释 `queryBusList` 的返回值，不读表 |

旧 query/relation ID、对应决定、proof/审计定位全部保留；旧读者可显式回退（见下）。

## 切换后的读取

新增窄接缝 `lib/roster/recognized-filter-source.ts`：

- **查询级事实仍来自 `platform_query.collection_evidence`**：`pages`、`effectiveConditions.rddqrq/whpcyear/whpc`、
  `status`、`source`、`completeness`、`fullRange`、称号范围 `rdjb`、`sequence_no`。类型化投影没有这些字段，
  本票不把它们伪造进内容投影。
- **内容事实 typed 优先**：按 `platform_business_observation.relation_id` → `version_id` →
  `platform_recognized_projection` 取 `validity_date_raw`（`rddqrq`）、`maintenance_year`（`whpcyear`）、
  `maintenance_batch`（`whpc`）。
- **显式回退，不用 COALESCE**：`case when p.version_id is not null then <typed> else json_extract(r.raw_fields,...) end`。
  投影存在但字段为 null 时按「来源未知」处理，不猜、不回填 raw；投影不存在（历史未投影）才回退 raw。
- 读取仍受原 SQL 约束：关系已确认、`interface='recognized_list'`、查询 success、来源 `queryBusList`、
  AND 组合、`completeness='complete'`、`fullRange=1`。
- `recognizedFilterFacts` / `sourcePositionForSequence` / 称号范围核对原样复用，不新建第二资格算法。
- `responseVersion` 保持 `current-qualified-408-v1`，`ruleVersion` 保持 `current-roster-116-v9`，
  `assessmentVersion` 保持 `enterprise-qualification-407-v2`；MCP 描述与 OpenAPI 未改（无不兼容变化）。
- 导出列/排序/四张表不变；工作簿仍通过同一评估器判定分组。

### 候选集合（显式未切）

`currentCandidateSql` 仍从 `record` / `difference_reason` / `record_correspondence` / `platform_relation`
union 候选，未改为按投影/观察枚举。原因与边界：

- `tests/current-candidate-covering-index-363.test.ts` 的 C04 冻结了 `currentCandidateSql` 的字节与
  sha256；本票不改该断言。
- 投影与观察都以 `platform_relation` 为根（`platform_business_observation.relation_id`），按 relation
  union 的候选集合不会因投影存在/缺失而增减；本票的资格见证与四消费者均已切到 typed。
- 未投影的历史行仍由 LEFT 语义（本票为自动 raw 回退）保留为候选与见证，不因回退丢失。
- 若后续要把候选枚举也改为 observation/projection 优先，必须单独处理 C04 冻结、行数不变与未投影
  历史行证明，另开切片。

## 回退方式与判断条件

1. **按行自动回退**：某 relation 没有 `platform_business_observation` / `platform_recognized_projection`
   行时，该行内容事实走原 `raw_fields` JSON。历史归档无需回填即可继续被读取。
2. **显式旧读者**：
   - 运维：设置 `ROSTER_RECOGNIZED_FILTER_SOURCE=legacy`，所有当前资格读取使用切换前的
     `filterSource` SQL（字节与切换前一致，无新增 join）。去掉该变量即回到 typed。
   - 代码/测试：`listCurrentQualified(db, filter, { recognizedFactSource: 'legacy' })` 或
     `createCurrentQualificationAssessmentReader(db, runtime, { recognizedFactSource: 'legacy' })`。
3. **判断条件**：typed 路径在同一关系上存在 projection 行即视为该内容版本的来源答案；字段 null 是
   「来源未知」，不是投影缺失。只有 projection 行不存在才回退 raw。旧 relation/query/correspondence
   ID 在两种路径下相同。

## 切换前/后差异

同一隔离 SQLite、同一观察、同一时点/规则下，typed 与 legacy 的 `total`/`uncertainTotal`/
`publishedPending`、行集合、分页、`q`/district/recognitionFrom+To/validYear/maintenanceYear+
maintenanceBatch、`qualificationAssessment`、proof/audit 定位由
`tests/current-qualified-recognized-typed-468.test.ts` 逐项比较；投影值等于原值时无差异。

**已批准差异（#461 投影规则的直接结果，单列）：**

| 差异 | 旧 raw 读取 | typed 读取 | 理由 |
|---|---|---|---|
| 前后空白 `rddqrq` | `' 2028-11-20 '` 不匹配 date-only，未知 | 投影按 #461 trim 为 `'2028-11-20'`，有效年 2028 | 类型化投影的既定原值规范化；只影响带空白的合成/历史值 |
| 前后空白 `whpc` | `' 2023-2 '` 不匹配复合年，未知 | trim 后为 `'2023-2'`，维护年 2023、批次 null | 同上 |
| 带空白的 `whpcyear` | `' 2024 '` 被旧判定视为「非空」，抑制 `whpc` 复合年 | #461 明确空白不是整数 → null（缺失），`whpc` 复合年可作维护年 | 同上；非空但非法的原值在 typed 中按未知处理 |

除以上 trim 类差异外，本票未观察到行集合、计数、分页、筛选或 T2/proof 定位的差异。未把 typed
reader 本身当唯一 oracle：对照的旧侧是切换前 SQL，且测试同时断言未投影行仍走旧值。

**未变**：资格/年度/对应/导出规则；三称号 Excel 12 列与排序；四张表及计数；旧表/列/raw/审计；
旧 relation/query/对应/proof ID；`responseVersion`。

**未切**：候选 SQL（见上）；页面只消费 HTTP，未新增第二读取器；目录镜像读路径不属于本票。

## 测试与证据

本次实现后的定向单 worker 结果（Asia/Shanghai，2026-11-04）：

| 命令 | 结果 |
|---|---|
| `pnpm vitest run tests/current-qualified-recognized-typed-468.test.ts --maxWorkers=1 --no-file-parallelism` | 5/5 PASS：影子对照（13 组筛选/分页）、null 投影不回退、未投影回退、trim 差异、HTTP+MCP+工作簿同读者 |
| `pnpm vitest run tests/current-qualified-155-http.test.ts --maxWorkers=1 --no-file-parallelism` | 26/26 PASS（旧 fixture 只写 raw_fields，走自动回退） |
| `pnpm vitest run tests/current-qualified-408.test.ts --maxWorkers=1 --no-file-parallelism` | 87/87 PASS |
| `pnpm vitest run tests/platform-recognized-projection-http.test.ts --maxWorkers=1 --no-file-parallelism` | 12/12 PASS（#461 投影行为未变） |
| `pnpm vitest run tests/platform-recognized-directory-three-way.test.ts --maxWorkers=1 --no-file-parallelism` | 4/4 PASS（typed 改动只移动筛选见证；正式资格/导出决策面不变） |
| `pnpm vitest run tests/current-qualified-408-http.test.ts tests/current-export-118-http.test.ts --maxWorkers=1 --no-file-parallelism` | 8/8 + 10/10 PASS（真实 Nuxt/Nitro、真实 SDK/MCP、隔离 SQLite；导出四表/下载/重生成原断言未改） |
| `pnpm vitest run tests/current-qualified-408-ui.test.ts tests/current-workbook.test.ts --maxWorkers=1 --no-file-parallelism` | 15/15 + 18/18 PASS（页面控制用例与真实工作簿写入器） |
| `pnpm typecheck` | EXIT=0 |

环境门控未运行：`tests/current-export-runtime-context-409.test.ts` 需要 `ISSUE409_COMPILED_INVENTORY` /
`ISSUE409_COMPILED_INVENTORY_SHA256` 编译清单，缺省时按设计报 `409 actual worker artifact grant required`；
本次保持 UNRUN，不改测试或延长 timeout。

未执行：全量套件、CI、真实业务库/备份、部署、页面桌面/390px 实操与异步导出下载后的独立解析重跑。
本切片只证明页面消费的 HTTP DTO 与工作簿分组面不变。

## 与 #455 第 6 组登记

- 第 6 组状态：**资格见证与四消费者已切换**；**候选 SQL 未切**，按上文显式登记。
- 旧调用与前后差异：本文。
- 回退：`ROSTER_RECOGNIZED_FILTER_SOURCE=legacy` 或内部 `recognizedFactSource:'legacy'`。
