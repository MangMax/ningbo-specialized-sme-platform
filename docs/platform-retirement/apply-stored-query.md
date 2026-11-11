# 申报 exact-stored 查询分支（#727）

状态：scope:M、docs-only 候选，待独立接受。固定 LOCAL `integration/690-current-roster-performance` 为 `a54afbe2c48c3ea085102dfdceada4bab27c94c9`，tree `fdd11672fcd61c0efe5993ee2fdde8ef4a973c8f`。本补充修正[原契约](contract.md#复用三来源投影)“原列归档＋normalized stored 比较值足够”的缺口；不改变原 parser/reconciled/conflict 语义。不代表 #726、#722 或完整退役通过。runtime/tests/build/DB 全部 UNRUN。

## 已证反例与适用范围

仓外 `/Users/mang/.t3/acceptance/platform-complete-migration/r1a/REPORT.md` 的既有失败：两个无业务 key 的 apply 观察，raw 同为 `{"cszt":"pending","rdjb":"2"}`，旧 status 分别 `" pending "`、`"pending"`。旧 isolated `status=pending` 仅第二行、total=1，options 保留两项；71607 两个 observation projection 的 stored_status 均为 `pending`，target total=2、options 只一项。归档原字节仍在，失败是结构化查询输入不足，不能用 archive JSON filter、分页后补过滤或改旧规则掩盖。

本补充只给 apply observation-owner 增加精确存储查询事实。依据[旧申报服务](../../server/utils/platform-declarations.ts)、[options](../../server/utils/platform-filter-options.ts)、[公开过滤 schema](../../lib/platform/declarations.ts)；公开 HTTP/MCP 转换仍由原 schema 拥有。只读显式 target 的 R1a 消费，R1b 才接公开入口。这里的 exact 指旧 SQLite cell，不是平台 raw JSON 值，也不是要求所有入口取消既有 trim。

## 字段与消费者矩阵

| 旧字段 | 旧入口的实际规则 | 已有 target / 决定 |
|---|---|---|
| status | isolatedConditions 直接 `r.status = :status`，同谓词 count；isolated DTO 原列；options 原列 distinct/BINARY。输入 status 已 trim | **新增 exact_status TEXT**；stored_status 已 trim，不可复用 |
| declare_kind | filter 输入先 normalizeDeclareKind（申请→apply）；isolated 比较原列，不归一化列；DTO/options 原列 | **新增 exact_declare_kind TEXT**；stored_declare_kind 会字典转换 |
| applied_at | isolated DTO 原列，无 isolated 时间过滤/options；records 代表版本按 p.applied_at NULL-last/降序 | **新增 exact_applied_at TEXT** 仅满足 isolated DTO；不改版本排序 |
| year | isolated `r.year=:year`、count、DTO；options distinct/order desc 后 JS safe integer 且 >0 | **新增 exact_year INTEGER**；stored_year 的安全整数约束不能表示全部旧 cell，不能借 parser 丢掉 REAL/非数文本 |
| title_raw | isolated 比较/DTO/options 用原 r.title_raw；由 [0043](../../db/migrations/0043_platform_row_title.sql) text-only JSON/object 提取，ECMAScript trim、空→NULL；历史可被直接改列，迁移不重算 | **新增 exact_title_raw TEXT**。source_title_text 未 trim，数字/布尔分支不等于旧列；p.title_raw 是 raw parser 结果，不证明历史列值 |
| name_raw / uscc_raw | isolated DTO 原列；q 搜索是当前 enterprise.name_norm/uscc_norm LIKE，**不是**原名/统代 LIKE | 复用 assignment **revision=1** 的 name_raw/uscc_raw；[T05a](../../upgrade/observations.ts) 逐 cell 原样复制。不得取 max revision、enterprise 当前名称或共享版本 p.name_raw。W 必须验证 revision1 原值来源 |
| relation_key | isolated platformKey 输入 trim 后与原 r.relation_key 相等 | 复用 observation.source_relation_key；T05a 原样转移 NULL/空/空白。不得用 raw.id 或 record.platform_key 覆盖 |
| enterprise_id / match / verification | 当前归属独立变化；isolated enterpriseId/q 和 enterpriseName 使用当前归属；records 聚合多 owner | 使用同 snapshot 最大 assignment revision；revision1 原名/统代与当前 enterpriseId 是两个用途，不复制第二套 owner |
| query/row IDs、顺序、时间 | isolated 按 q.queried_at DESC、旧 relationId DESC；detail first/last、记录计数原语义 | collection、observation 坐标及两个 namespace alias 足够；旧 IDs/time/alias 不改，不拿 target 新 ID 替代 |
| province/batch/awardBatchLabel | applyFactBase 仍返回 normalized 字段，但不在 APPLY_MODELED_FIELDS；不是 isolated filter/options/DTO 字段 | 现有 observation stored/parsed/reconciled/conflict 足够；本票不再加 exact 列 |

[旧 facts](../../server/utils/platform-declarations.ts) 的 readPlatformDeclarationFacts 必须分别复现：typed 时 declareKind/year/appliedAt/status/name/uscc 来自 **version projection**；无版本时取 observation 的 reconciled（name/uscc 用 revision1），modeledFields=[]；normalizationConflicts 总是逐观察。title 来自 [legacyRawRdjb](../../server/utils/platform-legacy-relation-read.ts) 的严格 json_valid/text-only 提取，再 legacyRowTitle trim，不用 query scope、数字/布尔；顶层数组路径亦不会产生 text。withArchiveProcessFacts 只在 version 字段非空、被模型拥有且本观察无冲突时补值，否则 reconciled。不得把 exact_status 当 fact.status，亦不得把 version.status 当 isolated.status。

getPlatformDeclaration 的 observation.version 来自版本投影，versionId NULL 则 version=NULL；它没有新增 exact 字段的公开 DTO。records 过滤/options/匹配版本、全版本计数、观察计数、detail 100/200 截断和 400/404 错误继续原服务语义。共享 version 的两个观察 raw.status=通过、原列分别退回/通过：exact 分支保留各自列，只有前者 normalization conflict；版本字段仍共同指通过。此处不通过改业务 DTO 解决缺口。

## 最窄物理选择与类型边界

在现有 `platform_apply_projection` **observation-owner** 行追加五列（上表 affinities），以及 `exact_stored_state`（captured/uncaptured）、`exact_stored_rule`、`exact_stored_origin`（legacy_source/sealed_snapshot/command_materialized）和 `exact_stored_reason`。版本 owner 的所有新增列必须 NULL；观察 owner 必有 state，captured 必有 rule/origin、reason=NULL，uncaptured 的五列/rule/origin 必须 NULL、reason 非空。全 NULL 的 captured 五列表示真实五个 SQL NULL，不能当 uncaptured。rule 固定为 `apply-stored-cells-v1`，command materialization 另在 receipt/manifest 记录 `legacy-apply-insert-v1` 规则。类型由列 `typeof` 自证，不用 sourceValueKind 冒充 SQLite storage class。

不新增表、通用字典、JSON 业务表达式或新 archive owner；现有 UNIQUE(observation_id)、owner FK、source_archive_id/seal 继续约束。schema shared builder、target 注册与 DDL catalog 同步；不只改 expand 声明。exact 分支的只写一次约束覆盖 INSERT/UPDATE/DELETE/REPLACE/upsert：successor 完成后不得覆盖 captured、转 uncaptured 或删除以重插；历史补捕获只能离线 successor。保留原 projection/version 列和 rule 的值、类型、created_at。

列沿用旧 TEXT/INTEGER affinity、BINARY collation，禁止 STRICT 或强制 text-only CHECK 把旧合法 BLOB/REAL 削掉。TEXT-affinity 列的普通数字输入已由 SQLite 存成 TEXT，不能声称数字原 JSON 是数字原列。exact_year 允许 SQLite 的 NULL/INTEGER/REAL/TEXT/BLOB；其余四列保留旧 SQLite 可存类型，经绑定后必须逐 cell 再核 typeof/bytes/REAL bits。不允许通过 String/Number/parseInt 将 BLOB、非数文本或 REAL 修好。JS number 无法无损表达的 INTEGER、非可逆 TEXT 解码或绑定后 cell 不同：保留原档并标 uncaptured，拒绝该目标的完整读取接受，不丢观察或静默近似。S 用原 SQLite cell 复制，runtime typed 解码不能以 number|string DTO 标注伪造其实际类型；遇既有 DTO 不能表示的原 cell，保留独立旧服务的实际输出/错误 oracle，无法复现则拒绝 R1a 接受。

revision1/source_relation_key 复用有前提：T05a 在 `exact()` 中已要求这些旧 TEXT 字段为 text/null，assignment CHECK 也如此。可验证的 text/null 不新增重复列；若历史 BLOB/非法文本不被现结构表示，S 必须逐 owner 报 uncaptured/阻塞，不能宣称这类旧值已覆盖。新 command 需核 revision1 name/uscc 等于真实 materialization 的原列。revision2+ 原名字段可能随更正变化，不能回头改变 revision1 或 exact 来源。

候选索引只限 apply observation 过滤键（exact_status/declare_kind/year/title 与 observation_id），S 不预设四个都值得建；R1a 根据实际 Drizzle 查询 EXPLAIN 决定组合/partial 索引及 catalog，禁止未测量声称加速。count/options 的全域 captured gate 必须在过滤和分页**之前**执行；不能仅检查返回页或用 inner join 隐藏缺投影观察。

## 独立旧 oracle：未来实施须逐项执行，本轮未运行

SQL oracle 冻结旧 isolated FROM/JOIN/隔离条件和 filter schema；所有筛选与 count 使用同谓词，options 使用 `DISTINCT c`、`c IS NOT NULL AND trim(c)<>'' ORDER BY c COLLATE BINARY`；year 使用 `DISTINCT r.year ... ORDER BY r.year DESC` 再 JS safe integer/>0。SQLite trim 在此默认只去 U+0020，不能替换成 JS trim。旧服务用单独 legacy fixture，期待值另写 literal，不能调用新 extractor 作 oracle。

| 字段 / 最小输入 cells | 必须固定的旧期待（合法 cell 为插入旧 affinity 后的结果） |
|---|---|
| status: NULL、`''`、`' '`、`' pending '`、`'pending'`、tab | DTO 原样；status=pending 仅命中第五项，total=1；options 排除前三项，tab 仍存在，空白包裹 pending 与 pending 各一项，BINARY 排序 |
| declareKind: `申请`、`apply`、` apply `、NULL、空串、未知 `toString` | filter=申请 归一为 apply，仅第二项；options 保留前三原字符串和未知值；NULL/空串不出现 |
| appliedAt: NULL、空串、` 2026-01-01 `、`2026-01-01` | isolated DTO 四者区分，无新增时间筛选；records/detail 的 p 排序/版本值完全独立 |
| year: SQL NULL、INTEGER 2024、REAL 2024.5、TEXT `bad`、BLOB x'32303234'、INTEGER 0/-1 | filter=2024 只命中整数；options=[2024]；DTO 按旧 driver 实值；存入 INTEGER-affinity 的 `'2024'`/`2024.0` 本来就变 INTEGER，不能虚构三种不同存储类 |
| title: raw.rdjb text `' 2 '`、空白、number 2、true、缺失/null、非法JSON | 0043 原列依次 `'2'`、NULL、NULL、NULL、NULL、NULL；filter titleRaw='2' 只命中第一项，options=['2']。请求 titleRaw=' 2 ' 本身不 trim，不命中该列。另测历史直接改列 `' 2 '`：离线必须原样转移，禁止重新运行触发器 |
| name/uscc: NULL、空串、空白包裹、历史别名；rev2 与 rev1 不同 | isolated DTO 用 rev1 原列；q 只匹配当前 enterprise 的 norm；原名不能参与 q；无归属 q 不匹配；改当前 enterprise 名不改变原 DTO |
| key: NULL、空串、`' K '`、`'K'`，raw.id 与 key 不同 | filter platformKey=K 仅命中原 key='K'；raw.id 不替代原 key；NULL/空串不同但原公开 filter 无空串查询 |
| storage classes | 每五列插 NULL/TEXT/INTEGER/REAL/BLOB，先记录旧 affinity 后 typeof/hex；target 每 cell 相同；嵌入 NUL、零长度 BLOB、Unicode trim chars、REAL bits、unsafe integer 独立覆盖。不能表示的明确拒绝；不以 options 排除等于 cell 可丢 |

以上是 literal 设计期待，只有首段 status-pair 是继承 R1a 实测 FAIL。SQL affinity、driver DTO 异常类型和错误边界仍需 S/R1a 独立执行，文档不能签 PASS。

## S：schema / 离线转移（≤M）

前置：本契约独立接受和已接受 71607 基线。S 不依赖 W，不写运行 writer。规划 successor **71608**，实施前核号未占用，transform=`apply-exact-stored-offline-v1`；不能覆盖 71607 receipt/checkpoint，也不能把旧阶段改为接受新 catalog 后重跑。

1. 冻结一致隔离 source 与 target，记录 realpath/dev/ino、文件 SHA256、schema hash、user_version、原全部 PK/SQLite cell manifest、原 archive refs/seals/metadata/bytes、两个 namespace aliases、assignment 全 revisions、版本/hash/rules/time、sqlite_sequence 高水位、predecessor receipt 和后加 command 的完整 owner 集合。仍有旧 relation 并不意味着 runtime 可以读取它。
2. 对旧 T05 历史：先按原链完成到 71607，再由本 successor 执行；source 用冻结旧源按旧 relation alias 对照 collection/sequence，直接读五个 cell。已在 T05 target 中有 sealed legacyRowSnapshot 时，可在本 **offline-only** 阶段按 `t05a-sqlite-cells-v1` 的 fields/name/storageClass/hex/real64be 解码。原档必须属于同一 observation、sealed、sha/长度/metadata 匹配，并核旧源/映射/revision1/key。不用 upgrade/projections 的 normalize 结果重建。source 与 snapshot 同时存在而不一致时拒绝事务，不任意选一份；只有可信一方可恢复时登记来源。
3. 已有 71607 command：没有 legacyRowSnapshot 是合法状态，不能添改已 sealed refs。可用已 captured `target-command-v1` basis 的真实 row/assignment，经现有 fingerprint verifier 认证及完整 mapping 校验，从原输入计算下节定义的 legacy materialization。此 origin=command_materialized，明确是旧插入规则对应值，不冒称曾存在的旧 SQLite cell。核 assignment revision1 name/uscc 及 source key 兼容性；如先前 writer 存储与 materialization 不符，不覆盖原字段，标 uncaptured 并阻塞该数据集接受。request 只有在能独立绑定确切 row/owner/input shape、通过原 fingerprint scheme 验证时才可用，不以 DTO 或当前归属猜输入。
4. 缺档、未捕获 basis、无可信源、非法 encoding/重复或缺字段、不可逆 cell：分类 uncaptured（完整 owner 清单+reason），保留原事实。证据自相矛盾、archive hash/owner/映射漂移为冲突，整个 successor 拒绝，不降级为可读 NULL。历史 normalize conflict 不等于证据冲突，合法退回/通过差异仍应 captured。
5. 一个 FK-ON immediate 事务完成 DDL、离线填充、写屏障、全覆盖/旧事实前后 manifest、successor receipt/checkpoint，最后推进 phase；失败连 DDL/trigger/phase/checkpoint 一并回滚。允许 state=uncaptured 的隔离产物用于诊断，receipt 必列其 IDs，不能标 query-ready；R1a 拒绝包含未捕获观察的 apply 请求域，不能返回部分 counts/options。后续补证据只能新 successor，不修改本回执。
6. 重放绑定固定 source+predecessor+transform+当前 target manifest，核全部五列和 state，不以 rowcount 相同通过。恢复失败保留原副本与第一 FAIL。不得重新 seal、添 legacyRowSnapshot、重算旧 observation/content hash 或重分配 alias/ID。

S 必须先安装写屏障：successor phase 的新 apply observation 在最外层提交前必须有 captured exact observation projection（同 observation_id/collection apply owner）、revision1 及原 fingerprint basis；旧 writer 仅填旧 comparison 列的插入必须失败。具体选择 observation 两个内部引用 `apply_exact_owner_id` / `apply_exact_state`，延迟复合 FK 指向 apply projection 的 UNIQUE(observation_id, exact_stored_state)。离线旧 apply 引用自身 id 及实际 captured/uncaptured；新 observation INSERT guard 按 collection.interface 要求 apply 引用自身 id + captured，非 apply 两引用皆 NULL。CHECK 保证引用成对与 owner=id，UPDATE guard 禁止改变原配对；projection 对 observation 的现有 FK 保留。**不能只加 projection INSERT trigger**，因为遗漏整个 projection 时不会触发。S 冻结该 catalog 并用独立 SQLite probe 证明；这些是配对内部引用，不是通用业务列。重建 observation 时仅追加约束引用，不改变原身份/时间字段；版本行无 exact 分支。S 的 populated DDL 回滚必须覆盖全部 incoming FK owners，未闭合配对可 RELEASE savepoint、必须 outer COMMIT 拒绝。所有支持入口写前检查实际 FK ON，不能事务内尝试打开后假定成功。

正常 runtime/init/三个 worker 非零 phase 拒绝保持。71607 旧 writer 即使绕过 JS phase 检查，也不可在 successor 留下未捕获 apply；S 接受后 W 接受前暂停该隔离 target 的新 apply 提交。process/recognized 的结构/字段不扩充，不以本票授权其接线。

## W：新写 / replay 验证（≤M）

前置仅 S 独立接受及既有 #725 capture/verifier；不依赖 #726/R1a 或 #722 最终接线。最窄扩展 [apply writer](../../lib/platform/apply-target-writer.ts)、apply command/replay 的相应接缝和 verifier 的 apply exact 分支。其它 source parser/业务规则不改。现有 fingerprint-verifier 的 legacy extra observation field 检查会拒绝任何新增非 NULL 列（当前 :132）；W 必须仅对白名单 exact 字段转交独立 cell 认证，不能直接跳过整个 extra-field 检查。S 离线恢复用 predecessor verifier 在 DDL/填值前认证并冻结结果；推进后旧 verifier/旧 replay 不作 successor 认证入口，须 phase 拒绝，不能把预期拒绝误写成 S 失败或以放宽旧 verifier 绕过。

**真实物化规则**来自 [writePlatformQuery](../../server/utils/roster-import.ts)：先 normalizePlatformRelation('apply_list', 原 row)，再 optionalString（非 string→NULL，trim/空→NULL）写 status/declareKind/appliedAt/name/uscc/key；year 用 optionalInt（finite number→Math.trunc，否则NULL）；title 用 0043 的实际 serialized raw_fields、json_valid/object/text-only/ECMAScript trim。例如新 row.status=' pending '、raw.cszt='pending' 实际旧写得到 pending；不能为“保真”把输入空白伪称旧插入原列。历史旧列的空白反例仍原样保留。processFactsFromRow 的 year 接受 Number('2e3')，parseApplyRecord 则仅十进制字符串，两者不得混用。

W 在同一 savepoint 保留原 row/position/assignment 的 own keys 与 canonical bytes 给现有 fingerprint capture，另外从它生成实际旧写 materialization；不得把 normalized clone 交给 hash serializer，或给原 envelope 塞 exact 字段。新 revision1 name/uscc、source_relation_key 必须符合物化原列，调用方 assignment 原名不符则写前拒绝（不偷偷覆盖已授权 provenance）。对 direct writer 同样校验，不能仅在 collection command 中做。五列在创建 observation 的同事务写 captured；raw/version/projection/alias/basis/highwater 任一失败全部回滚，包括外层 caller catch。

已存在 71607 key/rev1 不回写以迁就新 profile；S 无法证明兼容的 owner 保留 uncaptured。新 apply writer 对 key 的物化影响须在 verifier 中按 origin/profile 验证；既有 basis/hash 仍按其原 scheme 验证原输入，不能用“现字段已 normalize”令旧输入认证通过。

ordinary / explicit-reference replay 均先 typed 坐标选择 owner，再认证原 fingerprint 和 mapping、rule、原档，独立验证 exact cells、rev1 原名/统代、source key 与该 owner 的可信来源。ordinary bootstrap 继续原 legacy-bootstrap 生命周期；reference 不 bootstrap；exact 缺失不能由 replay 补写。新 command 同 raw 不同真实 status 原列输入必须被原 input hash/cell 校验区分；相同原输入但 exact 列被篡改也必须拒绝，不能只看 hash。revision2 正常变化不影响原输入，revision1 漂移拒绝。使用 archive/basis 是有界原输入认证，不参与业务筛选。

原 replay 源比较 `relationSourceConflict` 对 supplied fields 做 normalize 是已存在行为，不能全局改成 exact 比较。例如已迁移空白 status 与 replay pending 可在原来源比较等价，但 target 的 exact_status 仍必须对**原 sealed 来源**验证空白，不能被 replay 的 pending 覆盖。保留现有 kind/ref/field=relations 与 source/mapping conflict 错误；新增内部 `apply_stored_uncaptured` / `apply_stored_conflict` 只用于显式 target seam，公开映射留 R1b/C3，不擅改旧 HTTP 错误。

W 独立验收：原输入 literal bytes/hash 不变、直接 writer/完整 command/ordinary/reference 的 materialization 例子、omit/null/空白、已有 71607 恢复、同 raw 不同列、单 exact cell drift、rev1/rev2、FK-OFF 零写、safe-ID 耗尽及 caller-caught rollback、延迟 FK outer COMMIT。既有 normalized/reconciled/conflict 与原档/aliases/时间逐 cell 前后不变；不靠调用新 extractor 生成期待。

## 依赖与 R1a 恢复顺序

依赖边：`#727接受 → S → W`；`71607已接受 → S`；`#725已接受 → W`；`S → R1a隔离只读实现`；`S+W → R1a最终兼容验收 → R1b公开接线`。S 不调用 W，W 可用直接 seam 独立验收，不要求 #722 接受；#722 自身 F1/F2 和最终 replay 接线仍是其原任务，不能以本契约替代。

S 接受后，先在保留的 R1a status-pair 隔离副本生成 successor（不改原71607失败副本）；旧独立 oracle 仍 total1/options2，exact 列逐 cell 固定期待。再实现 #726 的 Drizzle list/count/options/detail/fact，过滤/聚合在DB、分页后水合；明确 seam 从71607输入升级为本 successor，原71607拒绝不能默默回退。W 接受后补新写/replay再读的同输入矩阵，最终 exact SHA 运行 #726 所有限定验收；原首 FAIL 和历史 HTTP FAIL/#705 B409 不改。未获授权前不执行任何一步。

切换/回滚遵循原退役 contract：S 失败事务回滚到完整71607；S 成功产物只离线可用。支持新 phase 的 rollback binary 才能打开 successor；旧二进制不得强改 user_version 降级。需要撤销 schema 时，先冻结新增 command/receipt/ref/原档，验证逆向迁移可完整保存新增事实，否则拒绝降级，不能覆盖旧备份。生产另行批准。

相邻源码风险仅登记：[platform-business-processes](../../server/utils/platform-business-processes.ts) 的 isolatedConditions/DTO 也读 r 原列，[platform-filter-options](../../server/utils/platform-filter-options.ts) 的 process isolated options 同样从 r 取值；[recognized-directory](../../server/utils/platform-recognized-directory.ts) 的 isolated title 也用 r.title_raw。这些归 R2/R3，各源独立 oracle；本票不扩其 schema/writer/规则。H1/H3、C1/C2 的 fact 消费者仍按原 coverage 独立接受。
