# #760 A：旧关联办理 stored status 的 BLOB 保真契约

状态：docs-only 修订候选，待父级安排固定 SHA 的独立 Standards/Spec 审查。只补充[已接受退役契约](contract.md)的关联办理 status 表示缺口；不表示 B 获准、实现完成或 source→71613 已通过。#760 为 scope:L 跟踪票，顺序为 A 契约→独立接受→B ≤M 实现，不新增票链。

固定代码依据：LOCAL `d0cc15684e337903e788063bf74fa480a117d7ae`，tree `af5a94bdcabc21e2fade1589af4fa69f4e2e7753`。权威范围是仓外 `legacy-stored-cell-compat/ISSUE-BODY-R2.md` 与 `ISSUE760-R2.json`；原 `ISSUE-BODY.md`、`ISSUE760.json` 保持历史原件。此文是设计约束，代码链接描述的是该基线，尚未实现下列修正。

## 1. 已证明的缺口与范围

仓外根目录为 `/Users/mang/.t3/acceptance/platform-complete-migration/legacy-stored-cell-compat/`。已完整读取 `implementation760/REPORT.md`、`SOURCE-FACTS.json`、`probe.test.ts`、`fresh-completion-run.json` 和 `REQUIREMENTS.tsv`。原作者零产品修改；10 项诊断 PASS 与实际 T05b 1 FAIL 都是本候选的**继承证据**。

原 schema0 文件 SHA256 为 `acc4c90e339a2aace1784e66465e46cd43b5afba260e94da01883781694a89bc`。query101 / relation1101 的 status 是 BLOB `00FF`；raw_fields 也是合法 JSON bytes 的 BLOB。原 inspector、preflight/commit、独立 indexing 和 selected detail 接受该已存源，`archiveProcessFacts.status` 返回 `Buffer([0,255])`。原 fingerprint `3ccdef9f55232c9b6deda315dd9f625c7e46c4bf096335b71f7b2f4f02bde935`、contentHash `b3a76d8a82f2b783464a6512e2c468740965e8798ad0b26609535c8fe43e8968` 不变。这证明旧持久化源合法，不声称 JSON command 可以写任意 Buffer。

实际 `upgradeCollections→upgradeObservations→upgradeProjections` 在 [transferObservation](../../upgrade/projections.ts) 插入时失败：`CHECK constraint failed: platform_business_projection_stored_status_kind_ck`。原失败与同 run 两次拒绝/回滚证据保留。该源没有到达 completed71613；#759 的 raw_fields 修正不能替代本 status 修正。

本补充仅准入 `business_list` observation-owner 的 **status** BLOB，及同一值通过 verifier、process exact capture、source facts、selected detail 的必要类型传播。`apply_list` / `recognized_list` 的 CHECK、parser 和准入不扩大。其他 province/batch/declareKind/appliedAt/awardBatchLabel/year、身份及时间列的非 TEXT 范围未获全域证明；原拒绝边界保持。遇到这些字段的独立反例，记录 owner、storage class、hex、旧行为并报告 NOTREADY，不能把它们转 NULL 或宣称本票支持全部 SQLite 类型。已证明的 status 则必须贯穿以下全部 owner，不能改成下游 uncaptured。

## 2. 两种结构与决定

| 表示 | 具体变化与后果 | 决定 |
| --- | --- | --- |
| 现有 native cell | `platform_business_projection.stored_status`、`reconciled_status` 保留 TEXT affinity，允许实际 storage class 为 BLOB；`stored_status_kind` 增加 `blob`。Drizzle 用不转换的 customType 和边界检查描述 `string \| Buffer \| null` | **选择**。零新增业务列；旧归一化输入与输出仍在原 source owner；exact_status 本来就保存原 SQLite cell |
| 独立二进制列 | 同表新增 `stored_status_blob BLOB`、`reconciled_status_blob BLOB`，原 TEXT 列在 blob 分支为 NULL，kind 与互斥 CHECK 配对；每个 extractor/verifier/facts reader 都要重组两列，reconcile CHECK 跨两组列 | 不选。至少两列及双路读取；空 BLOB 仍须显式分支，不能用 truthiness/coalesce 猜类型；对既有完成库也不能自动填值，不解决 checkpoint 绑定 |

不另造 generic observation 业务列、第二通用 fact 表、JSON 业务槽、snapshot 业务 fallback 或 hash scheme。原 `status` 内容 projection（包括 observation-owner 的 parser 内容字段）与 version-owner 的 `status` 继续 TEXT/NULL，不能由旧 stored Buffer 补写版本。

## 3. 字段及 CHECK

仅修改 business projection 的四项 CHECK：stored_status_kind_ck、stored_status_ck、reconciled_status_ck、status_reconcile_ck；保留 owner/capture、parsed-kind/parsed-value、source/archive FK、version 组合 FK、UNIQUE、source-owner triggers 与全部不相关约束。下述是完整目标谓词的记法：`o=observation_id`、`k=stored_status_kind`、`s=stored_status`、`p=parsed_status`、`r=reconciled_status`、`c=status_conflict`。

| 字段 | 目标类型与约束 |
| --- | --- |
| `stored_status_kind` | TEXT nullable；既有 absent/null/text/number/boolean/array/object/invalid 加 **blob**，仅 business 的 stored status 可用；不是通用 `sourceValueKind` 或 JSON parsed kind 的新增类型 |
| `stored_status` | 原 TEXT 声明/affinity；实际只允许 null/text/blob；BLOB（包括 `X''`）当且仅当 `k='blob'`，Buffer 原 bytes，不 trim/decode/stringify |
| `parsed_status_kind`、`parsed_status` | 原 JSON kind 枚举不变，parsed 值 TEXT/NULL；processFactsFromRow 的 cszt parser 不变；parsed kind 可以是 object/invalid，但值仍 NULL |
| `reconciled_status` | 原 TEXT affinity；实际 null/text/blob；由下述 CHECK 决定，不能独立写入另一值 |
| `status_conflict` | observation-owner 为 INTEGER NOT NULL 且精确0/1；version-owner 为 NULL；由原严格不等语义确定 |
| `status` | parser 的内容状态，TEXT/NULL；无论 owner 都不改为 mixed cell |
| `exact_status` | 后续 process-stored 原 TEXT affinity 的 native cell；原八 cell capture 规则不变，不新增 BLOB 副本或新捕获 scheme |

以下是 business 表的目标谓词（上表/正文使用缩写，SQL 使用实际列名）；约束名保持原 `platform_business_projection_` 前缀：

```sql
-- stored_status_kind_ck：保留旧 kind 分支，增加显式 blob 分支。
CHECK (
  stored_status_kind IS NULL
  OR (stored_status_kind IN ('absent','null','text','number','boolean','array','object','invalid')
      AND (stored_status_kind NOT IN ('absent','null','array','object','invalid','boolean')
           OR stored_status IS NULL)
      AND typeof(stored_status) IN ('null','text'))
  OR (stored_status_kind = 'blob' AND typeof(stored_status) = 'blob')
);
-- stored_status_ck：防止 k=NULL 借 SQLite CHECK 的 NULL 结果混入 BLOB。
CHECK (
  typeof(stored_status) IN ('null','text')
  OR (typeof(stored_status) = 'blob' AND stored_status_kind IS 'blob')
);
-- parsed_status_ck、parsed_status_kind_ck 保持原谓词。
CHECK (parsed_status IS NULL OR typeof(parsed_status) = 'text');
-- reconciled_status_ck
CHECK (typeof(reconciled_status) IN ('null','text','blob'));
-- status_reconcile_ck：parsed 永不为 BLOB，blob 对任何非空 parsed TEXT 都冲突。
CHECK (
  observation_id IS NULL OR (
    typeof(status_conflict) = 'integer'
    AND status_conflict = (
      stored_status IS NOT NULL AND parsed_status IS NOT NULL
      AND (typeof(stored_status) = 'blob'
           OR stored_status COLLATE BINARY <> parsed_status COLLATE BINARY)
    )
    AND reconciled_status IS (
      CASE WHEN status_conflict = 1 THEN NULL ELSE coalesce(stored_status,parsed_status) END
    )
  )
);
```

保留原 capture CHECK：version-owner 全部比较列（包括 k/s/p/r/c）均 NULL；observation-owner 的 stored/parsed kind 与 conflict 必须非 NULL。这样上述 kind 可空不会变成 observation 漏洞。原对象/布尔/非法 JSON 输入仍不得携带 stored BLOB；仅在可信 SQLite status 边界以 `Buffer.isBuffer` 得到 blob 分支。不得用普通 JS `typeof value === 'object'` 代替它。

`s` 为 TEXT 时仍执行旧 JS `trim() || null`，原 whitespace bytes 在 sealed snapshot/exact_status 保留，比较槽不是原 TEXT cell 的重复归档。SQL 不负责重新 trim。原 BLOB bytes 同时在 snapshot 的原 cell 证据和这里的结构化 cell 保留，业务只读后者。`IS` 比较相同 storage class 的 BLOB bytes，包含零长度；不比较 Buffer 对象地址。旧 JS 的 stored-vs-parsed 严格不等在此域只有 BLOB-vs-TEXT，不存在 parsed Buffer-vs-Buffer 的新 equality 规则。

## 4. 类型、归一化与读结果

内部类型草图如下。名称是实现方向，最终类型须由实际 schema/检查器推导；此文不宣称草图已经 typecheck。

```ts
type BusinessStatusValue = string | Buffer | null
type CheckedStoredStatus =
  | { kind: 'blob'; value: Buffer }
  | { kind: 'text'; value: string | null } // 原空/空白 TEXT 比较后为 null
  | { kind: 'absent' | 'null'; value: null }
  | { kind: 'number'; value: string | null } // 仅保留既有可表示分支，不新增数值准入
  | { kind: 'boolean' | 'array' | 'object' | 'invalid'; value: null }
type BusinessStatusConflict = {
  field: 'status'; storedValue: string | Buffer; rawValue: string
}
type BusinessStatusComparison = {
  stored: CheckedStoredStatus
  parsedStatus: string | null
  reconciledStatus: BusinessStatusValue
  statusConflict: 0 | 1
}
```

DB 驱动输出先按 kind、`typeof`、`Buffer.isBuffer` 检查，再构造分支；customType 的 driverData 是 unknown，不能只 `.$type<Buffer>()` 或 `as string` 伪造。business 的 sourceFieldComparison 返回该已检查结果；其他六字段保留现有类型。不要扩通用 `sourceValueKind` 以免把 raw JSON/title 的 object 改成 blob。

`PlatformNormalizationConflict` 按 field 区分：status 分支允许上述 Buffer，其他字段仍是原 string/number。`ArchiveProcessFacts` 不能再直接 Pick 一个声称 status 永远 string 的内容类型。source fact 类型应按 interface 区分：business 的未投影/无版本 status 和 archiveProcessFacts.status 可为 Buffer；business 有版本的内容 status 与其他来源 status 仍为 parser 文本。共享 `PlatformObservationFact` 用该来源分支的 union 表达；不可把所有来源/所有字段改为 unknown 或 any。旧 schema0 类型只纠正真实可观察的 business Buffer，不改变旧算法。

| 旧存储输入 / parsed status | stored 比较值 | conflict / reconciled | version status / archiveProcessFacts.status |
| --- | --- | --- | --- |
| SQL NULL / NULL | NULL，kind null | 0 / NULL | NULL / NULL |
| TEXT `" pending "` / NULL | `"pending"`，kind text | 0 / `"pending"` | NULL / `"pending"` |
| TEXT `" \t "` / NULL | NULL，kind text | 0 / NULL | NULL / NULL；exact_status 仍是原空白 TEXT |
| BLOB `00FF` / NULL | Buffer `00FF`，kind blob | 0 / Buffer `00FF` | NULL / Buffer `00FF` |
| BLOB 空 bytes / NULL | Buffer 空 bytes，kind blob | 0 / Buffer 空 bytes | NULL / Buffer 空 bytes，绝不等于 NULL |
| BLOB `00FF` 或空 bytes / `"done"` | 原 Buffer | 1 / NULL | `"done"` / NULL，冲突的 storedValue 保持 Buffer |
| TEXT `"done"` / `"done"` | `"done"` | 0 / `"done"` | `"done"` / `"done"` |
| TEXT `"pending"` / `"done"` | `"pending"` | 1 / NULL | `"done"` / NULL |

版本 supplementation 保留 `withArchiveProcessFacts` 原条件：确有 projectionVersionId、modeledFields 拥有该字段、版本非 NULL、该观察无该字段冲突，才用版本值。无版本时直接保留 normalized Buffer；有版本但 status 为 NULL 时也保留 Buffer。内容 status 非空且 conflict=true 时绝不能覆盖冲突 NULL。无索引、不认识、未捕获、真实 NULL、空 TEXT、空 BLOB 各自保留，不用缺结果/INNER JOIN 消失来表达它们。

在内存中保留 Buffer；对原公共 JSON serialization 保留 Node Buffer 的 `{ "type": "Buffer", "data": [0,255] }`（空 BLOB 为 data:[]），包括 archiveProcessFacts 及 conflict.storedValue。不是新 DTO/tag/base64/string 或 `{}`，也不把 wire 对象反过来当业务 Buffer。实际 handler/serializer 等价是 B 的待执行门槛；本静态设计没有 fresh wire PASS。

## 5. 必须一起闭合的 source owners

| 基线 owner | 必要变化 / 保留 |
| --- | --- |
| [normalization](../../lib/platform/normalization.ts)、[source-extraction](../../lib/platform/source-extraction.ts) | 保留 trim、declareKind allowlist、non-null strict inequality；仅 business status 的 Buffer 明确分类为 blob，旧 Buffer 不因 kind 变化失去 bytes；移除该路径不实的全 string 返回断言 |
| [db/schema](../../db/schema.ts)、[0050](../../db/migrations/0050_source_projection_observation.sql)、[target schema](../../lib/platform/target-schema.ts) | business 比较槽声明和 CHECK 同义；0050 是冻结 TEXT-only 历史，不原地编辑 migration/journal/snapshot；新 isolated target 经 §6 专用 prerequisite 重建 business 表。apply/recognized 不变 |
| [T05b](../../upgrade/projections.ts)、[新 target 安装入口](../../upgrade/cli.ts) | prerequisite 在首次 T04 绑定前安装；真实 T05b 插入 native Buffer。修正 catalog 对应显式新 T05b transform `t05b-source-projections-v2-status-blob`；business sourceTitleRuleVersion 同值，其他来源保持 v1，不改 parser ruleVersion |
| [legacyFingerprintInput / verifyLegacyFacts](../../lib/platform/fingerprint-verifier.ts) | 只对 business 的旧 status cell 增加 null/text/blob decoder；验证原 hex 后 `Buffer.from(hex,'hex')`。其余 text/year/坐标 decoder 保持；比较 expected projection 包括 kind/blob/bytes 与对应 v1/v2 sourceTitleRuleVersion，extra-field 检查不跳过。hash envelope 本来不含 stored status，原 input bytes/hash 不重新定义 |
| [legacy source custody](../../lib/platform/legacy-fingerprint-custody.ts)、[apply recovery](../../upgrade/apply-stored.ts)、[process recovery](../../upgrade/process-stored.ts) | offline `withLegacyFingerprintCustody` 的 T05b 回执槽按 §6 选择唯一 v1 或 v2；不得仍硬编码必须有 v1。其余前驱回执和原源 hash/schema/manifest、活动 token、文件身份及 source drift 核验保持；apply/process 的 legacySource 恢复必须实际经过此 owner |
| [process-stored upgrade](../../upgrade/process-stored.ts) | verifierRepresentable 仅对白名单 business status 增加 blob。先认证 sealed snapshot/可信原 source，原 `expression` 已有 blob 分支；必须捕获 exact8cells 与 fact-title、origin、pair。此 status 不再报 predecessor-verifier-cell-type-unrepresentable；其他不可表示字段仍照旧报告 |
| [process-stored schema](../../upgrade/process-stored-schema.ts)、[typed schema](../../lib/platform/process-stored-schema.ts)、[verifier](../../lib/platform/process-stored-verifier.ts) | 原 exact_status native BLOB、逐cell storageClass/hex 比较、八列和版本全NULL、deferred pair FK、屏障不变。重建从输入 catalog 保留 §3 修正 CHECK；不得恢复成0050 TEXT-only。现有 unknown exact cell 类型不能被假称 string；此处无需新列/新scheme |
| [process writer](../../lib/platform/process-target-writer.ts)、[command verifier](../../lib/platform/fingerprint-command-facts.ts) | JSON command 仍原输入/真实物化，不新增 Buffer command 准入；依据已安装 catalog 选对应 comparison rule，普通/reference replay 保留原输入认证、extra-field 及 capture 检查。旧 catalog/v1 command 兼容，不借 replay 补值 |
| [source facts](../../server/utils/platform-business-processes.ts)、[target facts](../../server/utils/platform-business-processes-target.ts)、[observation-facts](../../lib/platform/observation-facts.ts) | target 从 source.reconciledStatus/storedStatus 取 native Buffer，冲突 tuple 按 field 缩窄；版本 status 保持字符串。withArchiveProcessFacts 不转型；schema0 oracle 继续独立 |
| [selected detail](../../server/utils/platform-business-detail-read.ts)、[detail DTO](../../lib/roster/platform-business-detail.ts) | schema0 走 platform-source-facts，显式71613通过 queryHistoryTarget 后调用 readTargetBusinessProcessFacts(scope:selected)；grouping/selected relation/version 与 typedFields 显示条件不变，Buffer 透传 |
| [shared selected display](../../lib/platform/target-relation-display.ts) | business observation 的 sourceTitleRuleVersion 精确接受已知 v1 或 v2；apply/recognized 只接受 v1。保留 source owner、parseState、capture、archive 认证与字段白名单，不能放开任意规则字符串。新 v2 的普通 TEXT 行也必须可读 |
| [generic history](../../lib/platform/target-query-read.ts)、[public read types](../../lib/platform/read.ts) | 在已知 collection.interface 边界解析 relation：仅 business status 允许原生 Buffer，且仅 field=status 的 conflict.storedValue 可为 Buffer；其他字段、rawValue 与其他来源保持原验证。输出类型表达这一来源差别，不将全部 relation 字段改为 unknown。保留 SQL 选择、计数、稳定分页、预算和 Node Buffer serialization |
| [enterprise target history](../../lib/roster/enterprise-platform-history.ts)、[snapshot](../../lib/roster/enterprise-read-snapshot.ts)、[default detail](../../lib/roster/enterprise-roster.ts) | 这些入口先调用 shared selected display，再到 source facts。必要类型透传覆盖整条调用链，不能仅用预组装 rows 调用 readPlatformBusinessDetails 来声称 default enterprise detail 通过 |

此外，`record-comparison-target-sources`、`annual-process-target-sources`、`record-correspondence-target-sources` 及旧 `record-correspondence-candidates` / `event-annual-process-read` / `lib/comparison-platform` 消费 status/conflict。B 只允许必要类型透传和原严格文本匹配的缩窄；Buffer 不获得正向状态含义，不转 String，不改变筛选、资格、年度规则或选择范围。若发现必须改变业务判据才能编译/运行，停止报告精确 NOTREADY；不能为本修正重做这些消费者或把其完整验收算成本票已覆盖。

## 6. source→full71613：prerequisite、完成库及 checkpoint

选择**新鲜离线 target 的前置 DDL 修正**，不是71613之后的 successor。证据是示例在 T05b 就失败；完成后 successor 无法让它通过先前必经的 CHECK。native cell 没有新增业务列，后续 process DDL 复用输入 catalog；没有证据要求新的 phase number 或全库在线修复。

按[已接受维护窗口与固定源操作契约](apply-stored-offline.md)，停写/排空是操作者条件；SQLite backup 得到包含已提交 WAL 的固定源，既有回执已绑定的源文件保持原件。B 的真实完整路径为：

1. 从同一固定 schema0 源建立全新的独立 target，执行既有 expand 安装。专用 offline prerequisite 仅在 user_version=0、无 migration runs/checkpoints、无 collection/aliases/observation-owner projection、且实际 catalog 为预期0050后形状时，重建 **business projection** 的四个 status 约束。已有 version-owner 行、PK、sqlite_sequence、原 cell 和所有 index/trigger/FK 均保留。
2. prerequisite 在 FK-ON IMMEDIATE 事务中验证 incoming FK/相关 trigger inventory，保存原数据及 catalog，按命名列复制，安装 §3 CHECK，核 before/after 原cell/PK/sequence、FK/integrity后提交；失败连 DDL 回滚。拒绝未知 catalog/incoming owner、已开始T04或后续process pair的目标。仅重建时临时移除并完整恢复相关 triggers；交付 catalog 不少任何 CHECK/FK/immutability。不注册 startup migration，不改0050/原 __drizzle_migrations 行，不在 source 执行 DDL。
3. prerequisite 的 exclusive-create 仓外 receipt 记录源码 SHA/tree、原/新 schema hash、固定源 SHA、完整 before/after cell/PK/sequence 摘要；不先插 platform_migration_run（T04 要求该表空）。T04 随后将修正后的实际 target schema hash 绑定到它自己的原 run；这同时避免在 T04 绑定之后偷偷改 schema。新 CLI 安装分支必须显式选该 prerequisite，不能对既存 target 自动执行。
4. 实际依次执行 T04 collections → T05a observations → T05b v2 projections → T05c independent observation /71605 → collection scope /71606 → fingerprint basis /71607 → apply exact /71608 → candidate scope、recognized stored、witness /71609 → process stored /71610 → correspondence /71611 → difference references /71612 → legacy provenance /71613。每个阶段从既有 owner 要求的固定 predecessor snapshot 读取；保持原 legacySource custody。不跳过任何 completion、FK或原 bytes 校验。
5. T05b v2 仅用于修正 catalog 的新 run；T05b v1 与旧 catalog 的已有绑定仍按原 v1 语义验证。T05c 再验证 T05b 时按已绑定 transform/catalog 分派，不改 run。verifyLegacyFacts 与新 command 的 business sourceTitleRuleVersion 同样按明确 catalog/rule 分派；只接受这两份已知形状，不是任意schema宽松兼容。后续 receipt 按每次真实 catalog 建立；不重写前驱 targetSchemaVersion。#744 的运行时必要形状/完成检查不恢复递归 DDL hash 信任链。

`withLegacyFingerprintCustody` 也拥有这次 offline 分派。其 T05b 槽从完整历史中读取 transform 为 `t05b-source-projections-v1` 或 `t05b-source-projections-v2-status-blob` 的回执，**合计必须恰有一条**，且 state=complete。零条、重复同版本、v1/v2并存、未知替代或与该离线 predecessor 的既有已知 catalog/transform 不兼容均拒绝。不能按“优先v2”挑选后忽略另一条，不能补造 v1 回执，不能重写原 run。

选中的回执仍逐项核对固定 legacy source 的原 SHA256、schema hash，以及原 owner 已要求的 manifest 绑定；其余 T04、T05a、T05c、collection-scope 回执各自唯一且完整，原 source 一致性和 T05a observation manifest 条件不变。v1 已有历史沿原语义核验，v2 新链使用原 v2 回执；恢复 token 仍只在原 frozen source/predecessor 连接和生命周期内有效。此规则仅属于离线恢复 owner，不引入 query-time 前驱认证或放宽 #744 runtime guard。

| 既有对象 | 处理 |
| --- | --- |
| 旧 completed71613，TEXT-only catalog | 保持文件、facts、日志、hash、receipt及显式既有读写边界，不安装 prerequisite、不改 marker、不回填。原T05b不可能成功保存本反例的blob比较值；它不是待“修复”的已完成版本 |
| 原 T05b 失败或任何中断 run | 原 schema/transform/checkpoint 与 first FAIL 保留。同一旧 run 不能换成v2、改目标DDL、删除checkpoint或续跑冒充。无后续新写的隔离副本可留作证据，然后从同一绑定源另建新target和新run IDs；这不是成功 same-run retry 的证据 |
| 新 prerequisite + v2 下中断 | 相同固定源、target、run/transform/schema和checkpoint可按原事务规则重试；B 必须证明成功retry。人为换schema/transform/source必须拒绝且零写 |
| 已有71613且有后续新写 | 不从旧schema0备份重建覆盖。保留原库，本票不执行修复；只有证明该库确有本问题且无法由现存结构表达后，才讨论独立接受的前向方案。当前没有这种证据，不预造successor |

B 不承诺给旧 running run 换代码后无条件续跑，也不承诺 online repair。若实现证明 prerequisite 无法保持 incoming graph、manifest 或实际后续 DDL，须提交具体源码/静态或运行反例并返回 NOTREADY，由父级裁定本契约；不能自行加 successor/ticket chain。

## 7. B 的单个 ≤M 实现边界与验收

B 是同票一个局部兼容候选，高难度，待 A 独立接受及父级另行授权。单一行为是“已合法持久化的 business status Buffer 从 source 到 completed71613及 selected facts 无损”。允许 §5 owner 的窄类型/约束/decoder/离线安装改动和定向验收；不改公共 API 输入、parser、source ownership、hash scheme、113/114、资格/归属/worker、global guards、其它FK/DROP、UI或实时复用。若超出这些约束，交精确 NOTREADY，不能在同候选扩业务。

验收使用一份共享只读原 fixture 与一份有明确“派生”标签的合并 source corpus；必要 writable SQLite 为私有0600独立文件，不 hardlink。先在源端把需要的行合并好，每个 case 不重建整条全库fixture；NULL/TEXT/空白/BLOB00FF/空BLOB/parsed冲突/shared-version 等在一次完整迁移中批量断言。原 source 与派生 corpus 的 hash、修改列表和 oracle 分开，不能把派生行称作原始历史。拒绝 case 使用小型定向输入；回滚只在专门事务目标上注入。

| 门槛 | 独立期待与必须运行的实际路径 |
| --- | --- |
| 原源完整管线 | 从保留的 `investigation01.tar.gz` 单一原member恢复并核 source SHA；保留原 first FAIL；实际 §6 全链至completed71613，记录每阶段命令/exit/run/transform/schema/source hash。直接 owner函数证明与真实offline CLI dispatch分别记录，不以伪造target cell或跳completion替代 |
| 旧service + literal | 在独立schema0副本运行原 provenance inspector/preflight/commit/replay、indexing、facts与selected detail；literal由storageClass/hex及 §4逐项期待构造，不能从新extractor返回值生成。实际JS42绑定为TEXT `42.0`沿原证据，不猜`42` |
| comparison与selection | 同一迁移target核stored/parsed/reconciled/kind/conflict、exact8cells/fact-title、fingerprint-verifier、实际source facts和selected detail；有/无version、not_indexed、共享版本但原stored不同均独立。Buffer bytes/空BLOB与JSON序列化都按旧/literal核；实际handler serialization另列，不把JSON.stringify probe称wire PASS |
| legacy custody dispatch | 新 v2-only 历史携真实 legacySource 完成 apply exact 与 process stored recovery；旧 v1 完整链仍通过原源核验。零/重复/并存的 T05b 回执、来源 hash/schema/manifest 不符、foreign/inactive token 均拒绝且零写。不伪造额外回执来绕过原失败 |
| history与default enterprise detail | 新 v2 target 的普通 TEXT、BLOB00FF/空BLOB且 parsed=NULL、BLOB且 parsed=done 冲突，分别经实际 full-history entry 和 default getRosterEnterpriseDetail，保留原 membership/order/counts/DTO及 Buffer bytes/serialization。与独立 schema0/literal 比较；apply/recognized v2规则、非status Buffer和非法规则仍拒绝。不能绕过 snapshot→enterprise history→shared display 前置链 |
| 补充与冲突 | 原`00FF` + raw无cszt；派生`00FF`/空BLOB + `cszt=done`；version null/non-null、typed-fields membership；冲突NULL不被版本覆盖，未冲突Buffer不被NULL覆盖。保留platform_field_conflict及原业务状态严格文本判据 |
| 不变量 | 原全PK/aliases/原cell storage class+bytes/版本hash+rule/观察version区分/归档与seal；派生source内非空decision/correspondence、113 revision/114 review、import_batch/receipt逐cell及hash核对。原源没有这些非空历史，不能借其空表证明；不重写requestHash/planHash/sourceFingerprint |
| 失败与同run成功retry | prerequisite DDL及T05b batch/checkpoint、process DDL/capture/pair/barrier/receipt、最终promotion注入失败；核零半组owner、回滚前后manifest/catalog/sequence、FK/integrity与源不变。恢复后用同一**新**run、原schema/transform/source、全新evidence目录成功重试；旧失败run原样留存 |
| completed replay | 在实际完成的新链上用既有合法command增加collection/observation/provenance supplement/receipt及归属revision；仅对工具契约支持完成重放的阶段，以同run重放并核历史绑定和新增数据不丢。#755完成重放须真实跑；早期phase若按原contract拒绝successor数据，保留拒绝并验证零写，不放宽全库摘要。无后续写的完成重放也独立核 |
| 保留拒绝 | 非法raw BLOB仍platform_raw_not_json；伪blob kind/对象、非status非TEXT、缺档/冲突来源、schema/source/transform/checkpoint漂移、FK-OFF、缺capture及跨owner替换不被本修正放行；区分整链拒绝与exact层可表示 |

B 的类型检查覆盖实际受影响 app/server/source事实声明及serializer消费者，输出精确命令/退出码/新增诊断；整体未通过仍保留 inherited FAIL 或 fresh FAIL/UNRUN。单worker/no-cache/configLoader=runner/JITI_FS_CACHE=false、私有TMP/config与既定helper evidence env，重型执行只经 `parallel-provenance-756-757/heavy-slot.py`。每批归档一次、逐成员读回后清自有raw/TMP，保留首FAIL和清理映射；不安装依赖、复制整仓/数据库全集或操作其他owner文件。

## 8. 本候选证据封顶

本轮只做静态有界源码及契约核对、文档diff/链接/范围检查。运行测试、typecheck、fixture生成、迁移、DB读取、HTTP/MCP/wire、浏览器、CI、生产均 **UNRUN**。没有 fresh schema0/runtime PASS；旧10 PASS/实际T05b FAIL、整体TypeScript FAIL及其他历史FAIL不改判。

仓外 `contract760/` 保存本轮源码/权威输入hash、要求映射与最终SHA/tree/base/clean报告。A提交后交父级独立审查；stage B、review loop、tracker、push/PR/merge/integration/main/realDB/prod均不在本任务授权内。
