# 企业详情共享资格评估（#406）

> 版本说明：以下原 #406 条款、`enterprise-qualification-406-v1` 与回执按发布时历史保留。
> 当前 #407 增量使用 `enterprise-qualification-407-v1`，见文末；历史 PASS 不替代当前候选验收。

`GET /api/roster/enterprises/:id` 与 MCP `get_enterprise_detail` 继续使用
`getRosterEnterpriseDetail`，兼容新增 `qualificationAssessment`。原 `enterprise`、
`records.lifecycle`、`recognitions`、`differences`、`titleAssessments` 和平台原行含义不变。
当前查询、导出、列表差异及年度对应等其它消费者尚未切换（#407–#411）。

## 快照与依据

- 同一次详情读取，在同一 SQLite 读事务内冻结一次执行时点 `asOf`。这是对当前存储事实的评估时间，
  **不是历史数据库回放**；公开 HTTP/MCP 未新增指定历史时点的参数。
- `enterpriseId` 是稳定主体标识；`titles[].titleCode` 与 `cycles` 绑定称号及原认定周期。
  `originYear` 为原年，`batchSeq: null` 保留未知；不从平台批次或目录猜填。
- `ruleVersion` 保留现有 `current-roster-116-v8`，增量评估封套版本为
  `enterprise-qualification-406-v1`。未更改原周期算法或全面放宽 #238 空批次规则。
- 每称号的 `versions.facts/sources/decisions/observations` 是读取输入的 SHA-256 摘要，
  不是数据库新版本表。`snapshotId` 绑定执行时点、规则版本及三称号结果。
  摘要只用于同范围、同时点评估的身份比较，不是对来源真实性的证明。
- `evidence` 列出正式事件 ID、revision、原年/批次/结论年及出处 ID。
  `sourceVersions` 返回当前文件 hash/bytes、最新逐出处留档 revision/hash；未留档保持 null。
  `references` 保留具体决定、别名、平台观察和对应版本引用，供原入口进一步核实。
- 不读取来源原件或平台原始正文，不创建第二份可变权威事实表、缓存、job、审计或确认决定。

## 分维度结果

| 字段 | 业务含义 |
| --- | --- |
| `group` | 宁波当前纳入结果：eligible / pending / excluded |
| `officialQualification` | 复用原周期及已核实迁入资格期间的裁定，独立于主体终止和地域迁移；身份、正式出处和本称号解释的未决保护保留 |
| `subject` | 可适用的已确认注销/主体终止、适用性待核，或未建立主体终止事实；后者不证明实际存续 |
| `region` | 已确认迁入/迁回、迁出、顺序/适用性待核，或未建立迁移事实；迁出不自动撤销全国称号 |
| `platform` | 尚未查询、查询失败、或需核实的实际观察；保留原状态、来源接口、时间、条件、主体匹配与覆盖，查询失败不冒充无记录 |
| `correspondence` | 候选、已确认、需重核或无对应（未完成复验不声称来源已变化）；confirmed 不是正式资格或完整性证明 |
| `completeness` | 正式出处、原周期语义、身份、公布名留档及文件版本缺口；记录齐备不等于新的人工作业确认 |
| `shadow` | 原 reader 的 legacyGroup；如新评估因明确主体终止优先排除而不同，明确给出解释，旧投影不改 |

正式公布有效时，平台未查到、退回、不通过、查询失败、尚未查询都不会直接否定正式资格。
平台状态按原文保留。既有来源对应无法单独证明主体、称号、周期、时点和覆盖均可比，
因此本片的 `platform.comparison` 保守返回 `not_established`，不自动签署“一致”或“已核实未同步”，
也不写入人工 `platform_stale` 原因。被截断的覆盖读取明确返回 `truncated`。
观察的 `applicability` 区分时点内、时点后和时间未知，均保留原陈述；时间未知或覆盖被截断时只报需核实，不能报已确认无记录。

已确认且可适用的主体终止对全部称号优先排除；独立迁回不复活主体。迁出排除宁波当前集合，
迁回只影响地域；正式复核失败、旧周期/多批次冲突、仅培育、仅平台获批、身份冲突等原保护仍在。
撤回或替代沿现有 #102 当前 head 及 #108/#114 适用性读取；不删除旧决定。

当前正式事件仍只有年份精度，沿用原三年周期到复核年的待核边界；计划复核年不是新推断的具体失效日。
未录入的精确有效日、撤销事实类型或视同有效政策不由自由文本/平台日期推断，也不无来源普遍续期。
已有已核实迁入资格的 `[validFrom, validUntil)` 期间继续由原 reader 处理。本片没有新增政策事实模型。

公布名未留档、文件版本缺失与资格无效分别表达，不能据此否定稳定企业标识已关联的正式资格。
旧集合 count=0/status=null 不自动升级为 `confirmed_no_diff`。

## 验证与待验收

`tests/enterprise-qualification-assessment-406.test.ts` 使用内存真实 SQLite、正式迁移和独立预期值，
从公开 HTTP/MCP 共用的详情函数读取，核对分维度结果、版本变化、原保护和旧投影影子。
`PRAGMA query_only=ON`、`total_changes()` 及 job/决定/复核回执数量约束读取零写。
这不是已启动服务的 HTTP/MCP 或 worker 实测。

父独立验收 pending：实际 HTTP/MCP 信封、native worker 与预算、build/type/full、详情桌面/390px折叠与
读取失败/重试/返回路径；本片未启动任何服务或浏览器。#234 实例修复证据为继承，不在本片重复写真实库。
R1 rg exit2、R1 截断与 R2 缺 Nuxt 配置的 harness FAIL 独立保留；不计作产品 FAIL 或业务 RED。

本片 fresh small 回执（2026-10-27 UTC）：R3 16:27:42–16:27:44 预声明业务 RED，
1 个用例仅因缺新增字段失败，exit 1 / signal null；16:35:17–16:35:19 GREEN 22/22；
补替代决定与观察时间后，16:36:39–16:36:40 GREEN 25/25，exit 0 / signal null、skip 0。
runner 为 `pnpm exec vitest run tests/enterprise-qualification-assessment-406.test.ts --maxWorkers=1`，
同时使用内置 JSON reporter 并解析逐 case 结果；report 未提供 unhandled 字段，保持 UNKNOWN。
父在同 assigned worktree 执行的 Nuxt prepare exit 0 为继承设置证据，本实施未重跑 prepare。

## R1反馈窄修

- 完整性直接复用同事务 `publishedPresentation`，按正式事件的 evidenceId 列出未捕获、捕获名未知、读取不可用；旧 record 名不代替逐出处留档。不会重复读取已完成的公布事实。
- 已核实迁入资格使用原验证条件独立计算，后续迁出只决定宁波纳入范围；正式资格说明采用实际生效依据，不再并列“缺少资格依据”。旧地域分支和 legacyGroup 保留。
- 对应需重新核实可能来自预算未完成，因此汇总消息不声明确定来源变化。
- 测试种子只复制为可变数组以适配 Drizzle，不改种子值。父新增六个 focused 回归；原25条断言保留。原类型检查exit2、R1三P2及父两次误路径读取exit2均保留。

## #407 当前增量：字段解释、提交快照与历史读回

当前共享封套版本为 `enterprise-qualification-407-v1`，规则版本仍为
`current-roster-116-v8`。`fieldGaps` 是原事件字段的解释增量，不回写或改变原
`group`、`completeness.gaps/status`、周期恢复/终止和未知批次保护。
review 的 `year` 是原认定年，`decidedYear` 是结论年，`batchSeq` 是原批次；不借本通知新批次猜填。
缺口按 `year/decidedYear/batchSeq/reviewOutcome` 点名，`valueState` 区分 unknown/blank/invalid，
原 helper 的 `inputState` 区分 omitted/null/provided。原候选 blank 不 trim 成 null；已入库字段为 null 时如实解释 null。
award 的原 year fallback、未知批次兼容沿旧算法；记录字段未知可有 fieldGaps，但不套 review 的资格失败条件。
nurture/maintain 不套 review 缺口；纯培育的 excluded 表示不构成称号，不是主体注销/终止，
也不将 `none` 当作确定终止。它们各自原 group 继续由现有 reader 判定。

详情仍是**当前存储事实**在一个读事务/执行时点的评估，不是可指定历史数据库回放的接口。
完整 snapshot 包含三份称号 assessment（innovative_sme、specialized_sme、little_giant），不能裁掉称号或维度。
其身份算法为 `SHA256(JSON.stringify([scope, titles]))`，其中 scope 按
`{enterpriseId, asOf, ruleVersion, assessmentVersion}` 构造；`snapshotId` 与每称号四个输入版本摘要可独立核对，
不代表原件真实性或人工确认。保存的旧 snapshot 保留当时的版本/时点/内容，不能升级版本后冒充原捕获。

| 阶段 | #407 输出的含义 |
| --- | --- |
| announcement preflight / 正式事件 correction preflight | `qualificationDiagnostics` 是原候选或 patch 应用后的候选字段解释；独立的 `qualificationReadback.stage=before` 只读当前已存在的唯一主体，proposed 不是 after |
| announcement commit / 正式事件 correction commit | 全部真实业务更改成功后、既有 summary/receipt JSON 保存前，同事务捕获 actual `stage=after`，不使用候选新ID或 before 代替实际结果 |
| 当前详情 | 重新评当前事实，可能与旧 receipt 不同；不反填历史 |
| qualification 历史投影 / correction 同键回放 | 读原保存的 capture，保留原 asOf/versions/digest；不再调用当前 assessment reader |

每个预检/提交阶段，唯一实际主体最多调用一次共享 assessment reader，返回完整三称号；多主体零次，
明确 multiple_targets/target:null，不选第一个。新候选未有主体为 new_target，不虚构 enterpriseId/T2。
原合法批量、旧载荷/null/省略值兼容和真实业务失败回滚语义保留；来源、revision、file/plan CAS 与审计沿旧路径。
published-name 原行 capture、名称 known 与否、来源 confirmed 对应、正式事件语义更正是不同事实维度，不能互相填充。

精确历史读使用既有 `/api/roster/import/receipts/items?projection=qualification` / MCP
`list_roster_import_items`：只选 announcement 成功 record_event，source=private_batch+batchId 或
redacted_receipt+receiptId 互斥，itemIndex 必需，拒收 oldRecordId/page/pageSize/cursor/idempotencyKey。
更正历史沿原 request+planHash 的幂等 commit，不借 announcement receipt 白名单。
当前源代码中的具体封套、独立预算与错误见[契约的 #407 增量](roster-lifecycle-contract.md)。

历史 `qualificationDiagnostics` 是 availability 封套：captured/items（只在确实保存且无诊断时才为空）、
not_retained/legacy_receipt，或 unavailable/read_unavailable。
生产端把同一 plan 执行位置的原候选与成功结果绑定，内部 `summary.qualificationDiagnosticsByItem`
保存 itemIndex、实际 ref/enterpriseId/recordId、原 candidateRef、诊断及 binding+诊断的独立 digest；
不以新record ID猜原输入下标。原 null/blank/omitted 状态不从当前事件/T2/preflight 重建；
旧 summary 没留存就是未留存。内部 map 不重复泄漏到公共 counts summary。

capture 封套本身 <=65536 UTF8 bytes，与**整个历史 response**的 maxBytes 是两个预算。
后者含两个 slot 和全部 metadata，qualification 默认65536、允许1..65536，超出为413 response_limit+requiredBytes，无partial。
SQL 先精确定位、类型/长度限制，再有界载入；当前 redactor 若改变一个 slot 的任意内容/键，该 slot 整体 unavailable，
不修改原摘要、不重算共享 T2 digest，也不影响另一份安全完整 slot。
correction 公开回放在当前 redactor 上重新检查保存 capture，reader0且不覆盖原存储。
新增安全 finalization 的具体覆盖面是 correction API 与 qualification 历史投影；
不能外推为所有 announcement 写 transport 或未来消费者均已完成安全改造。

## #407 验证状态与范围

原 #406 历史回执与所有 FAIL/STOP/UNKNOWN 保留。当前406测试文件的静态 inventory 是20个声明、32个
literal展开行；这不是新的 runtime discovery，也不回改前文历史25/25。此次仅追加4个字段/详情控制，
旧测试全文前缀保留；新增测试 runtime/语义编译均 UNRUN。
helper 控制只证明字段解释；真实内存SQLite详情控制经 `getRosterEnterpriseDetail` 与共享 snapshot函数接缝，
不冒充已启动的 HTTP/MCP 服务。具体新用例与源SHA由本轮交接记录。

#407 已有分阶段合成SQLite/公开handler/本地HTTP focused 回执分别绑定各自源码；
后续生产增量不能继承成当前三文件整套GREEN。真实SDK/Nitro/native worker、browser/390px、
相关完整测试/typecheck/build/full/CI及生产没有本次 fresh验收，父另grant。
#406/PR414 的继承设置、类型/构建及有限SDK/浏览器证据保留原范围，不外推为#407验收。
#408–#411 的查询/导出/列表差异/年度等消费者没有在本片统一切换或统一验收。
