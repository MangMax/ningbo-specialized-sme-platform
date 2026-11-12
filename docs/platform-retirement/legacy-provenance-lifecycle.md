# 历史分页补录契约

状态：#754 docs-only 候选，配套[补充 ADR](../adr/2026-11-13-legacy-provenance-lifecycle.md)。以下约束供后续 ≤M 实现，不表示当前代码已有该能力。固定代码基线为 `d359b85efd4ff4d6d789733ec959383be0bf6532`。schema0 公开语义、API、UI、资格规则与所有旧 hash 算法保持。

## 1. 一 collection 一次补录

推荐新增 `platform_collection_legacy_provenance`，仅由历史分页补录 owner 写入。普通新 collection writer 不生成补录。表名是后续实现建议，责任和约束是本契约要求。

| 字段 | 约束与责任 |
| --- | --- |
| `collection_id` | 正 safe INTEGER，PK、collection FK RESTRICT；同一 collection 最多一条 metadata，不以 public queryId 作物理 FK |
| `origin` | `t04_envelope` 或 `supplement`；前者是旧封套的结构化索引，后者是封存后新补录 |
| `source_identity`、`source_sha256`、`segment_index` | 保留原值；全表 UNIQUE(source_sha256,segment_index)，跨 origin 生效。新输入沿用原长度、64位小写 hex、非负 safe integer 规则，不 trim 或重新 hash |
| `input_fingerprint` | 保留原补录算法摘要；T04 从原封套逐字转入，不将当前重建摘要覆盖历史值 |
| `import_batch_id`、`created_at` | 原 batch FK RESTRICT 和原 TEXT 时间。旧行取封套原值，新行取本次 caller batch 与实际提交时间。重复补录不更新 |
| `archive_id` | archive FK RESTRICT、UNIQUE。`t04_envelope` 精确指向该 collection 原 sealed `legacyProvenance` 封套；`supplement` 独占一份 TEXT 原 collection JSON 的 BLOB 存储记录 |

metadata 行 INSERT-only，拒绝 UPDATE、DELETE、REPLACE 及重复 PK 覆盖。原 collection、page、unfinished、condition、scope/error、observation、assignment、version、basis 和全部已封存 ref 不更新。该附表不加入 collection ref 的字段集合，也没有可解封状态。

`t04_envelope` 的 archive 指针是已封存 owner 的二次索引，必须与同 collection 的既有 ref 一致；它不是第二份归档所有权。`supplement` 的 archive 不得与三个原 ref、observation fingerprint basis 或另一补录复用。schema owner 在新表及现有 ref/basis 的写边界作对称排他检查，仅允许上述同 owner 的 T04 二次指针。不复用相同 bytes 的 archive，不允许 runtime 调用 upgrade。

新补录归档的是旧 writer 实际保存的 `JSON.stringify(input.collection)` UTF-8 bytes。`sourceSha256` 是调用者提交的源文件摘要，原入口没有接收或验证整份源文件 bytes；继续保留该责任边界。不得宣称新 JSON 就是源文件原字节。T04 封套保留原八列的 SQLite storage class、bytes、原 metadata/hash/batch/time，不能重新序列化其 collection 再替换。

原始来源材料、不可变归档 bytes、metadata 索引分别有独立含义。archive 长度/SHA 核对只证明所存 bytes 未漂移，不证明文件身份陈述或业务资格。

## 2. 原公开指纹输入的逐字段来源

public `queryId` 只经 `platform_legacy_query_alias.old_id` 解析，relation ID 同理。必须验证 relation alias 所属 observation 的实际 collection，不能按相同整数猜测 owner。排序保持旧 `sequenceNo,id`；id 是外部旧 ID。重复业务 key、共享 version 的观察分别保留，不能按 record/version 去重。

[旧 inspector](../../server/utils/platform-legacy-provenance.ts)第19–59行计算的是下列 JS 对象的 `JSON.stringify` UTF-8 bytes，不是 canonicalPlatformJson，也不是 SQL JSON：

| 输入及插入顺序 | 目标原输入材料与解码 |
| --- | --- |
| query 的 `id, interface, queryKey, rdjb, titleCode, queriedAt, lastCollectedAt, status, failureReason, rawResponse, collectionEvidence, createdAt` | `id` 用 query alias；其余标量按 [platformQuery 声明](../../db/schema.ts)第627–665行顺序显式投影 collection 同名原标量。`rawResponse` 从 sealed 同名 ref 按原 SQLite TEXT/BLOB/NULL 读取；`collectionEvidence` 按旧 ORM JSON mode 解码同名原 ref。NULL 不改为省略 |
| rows 中每项 `id, sequenceNo, relationKey, rawFields, rawBytes` | `id` 用 relation alias；序号和原键须与 observation 及 `legacyRowSnapshot` 原 cells 一致。`rawFields` 按旧 ORM JSON mode 解码原 `raw_fields` cell；`rawBytes` 按原 SQLite driver 对该 cell 的 TEXT/BLOB/NULL 返回值读取，不能对 rawFields 重新 stringify |

根对象顺序是 `query` 然后 `rows`，行项字段顺序固定如表。JSON 对象内部的 own key 次序、数组顺序、原类型、空白和 Unicode 都沿旧解码规则。BLOB 按旧 driver 的 Buffer 序列化规则处理，不能擅自当 UTF-8 string。非法原 JSON 沿旧读取失败，不能用 normalized 值或 caller 载荷补齐。目标内部字段、ruleVersion、archive FK、basis、assignment 均不进入 hash。

T04 的 [transfer](../../upgrade/collections.ts)第135–188行逐字转移这些 query 标量与 raw/evidence；T05a 的 [观察转移](../../upgrade/observations.ts)保存完整原行 cells。W4a 的 [collection writer](../../lib/platform/collection-target-command.ts)保存实际落库 metadata、时间和原 raw/evidence；[relation evidence capture](../../lib/platform/relation-evidence-snapshot.ts)保存其外部 ID 和实际原行 cells。因此完整正常 T04/W4a 路径静态上有重建材料，本补充不增设 query snapshot 或 fingerprint basis。现有 display DTO 和 observation verifier 均不是本算法的直接实现；后续命令票拥有这份窄原输入投影与独立旧 oracle。

最小正常反例：schema0 查询 Q 的一行 `raw_fields` 为 `{"id":"a", "rdjb":"2"}`，对应补录 input 使用相同解析对象。另一合法原行是 `{"id":"a","rdjb":"2"}`。两者 input、normalized 投影和业务版本可以相同，但 `rawBytes` 不同，补录指纹必须不同。若 Q 的 public alias 是8001、物理 collection ID 是1，使用1也必然改变 query.id。当前 collection 对象另有 `ruleVersion` 等字段，直接 stringify 也不等于旧 query。这些反例要求读取原材料，不证明材料缺失。

若所需 archive、alias、cell 或 lifecycle 缺失，原字段不能由 normalized/source projection、当前 assignment 或现存 digest 证明。命令须 fail-closed，沿来源漂移错误拒绝，保留原缺口；离线转接报告阻塞，不创建假的输入。旧封套里的 `input_fingerprint` 只证明曾保存该摘要，不能证明当时所有 query/rows 输入。若迁移快照前 `lastCollectedAt` 已变化，新的 inspector 沿 schema0 对当前 query 的算法重核，并可与原摘要不符；不能回滚该时间或覆盖原摘要来通过。live reuse 的时间更新接线仍归其后续 owner。

## 3. 预检、提交与重复请求

输入仍只允许 `sourceKind=platform_archive`、`interface=business_list`，一请求1..100个互异 queryId 与互异 SHA/segment，每项至多5000个原 relation witness。`sourceIdentity` 长度1..2000。collection 仍是 strict legacy `businessList`，不接收 `dataRows`、`rawData` 或 caller hash。schema owner 复用[原 schema](../../lib/platform/legacy-provenance.ts)第13–26行，不新增公开参数。

预检 inspector 在同一只读源 snapshot 解析 aliases、核对完整自然键、NULL 原 `collectionEvidence`、原 status/time/conditions/titleScope、全部原行、sequence/key/rawFields 和页 rdjb，最后计算原 fingerprint。业务源只读；现有 importBatch/preflight/receipt 可以保存 `platformLegacyProvenanceSources` 的服务器摘要。禁止补档、补索引、建 basis 或预占文件 segment。旧 freeze 已存在时继续使用同一摘要，漂移不能被再次 preflight 刷新掉。

commit 在 caller 的同步事务内重核同一输入。归档插入、metadata、同批其他命令、importBatch 终态、receipt 全部属于既有事务 owner。新补录 writer 自身有 savepoint，调用者捕获异常也不能留下孤立 BLOB。后项或 receipt 保存失败整体回滚本次补录；既有失败回执流程仍可记录失败。重试沿原 key/hash 与 freeze 规则，不能吞掉 failure 继续提交前项。

| 情况 | 原公开行为及目标要求 |
| --- | --- |
| 首次合法补录 | preflight add=1；结果 `platform_legacy_provenance`、`provenanceKind=legacy_pagination`、`typedState=unknown`、relationCount；rowsWritten=1。BLOB/索引物理行数不计入公开 written |
| 同 idempotency key、相同请求再次 commit | 原 committed batch/receipt 读回，不新增 metadata、archive 或回执；保留历史序列化/hash，不重新认证后改写回执 |
| 同 key、不同请求 | source identity 不同，或 committed/processing 请求的 hash 不同时，沿原 receipt owner 报 `idempotency_conflict`。preflight/failed 下原有修正载荷路径保留，仍受已冻结 query fingerprint 约束；不借用 #753 的专属强锁规则，不更换 request hash 算法 |
| 新 key、同 collection、同一补录 | 重核原 fingerprint 与 deep equality 后 skip；rowsWritten=0，summary written=0/skipped=1，保持第一次 importBatch/time |
| 同 collection 改 sourceIdentity、SHA、segment、collection 或已有 fingerprint 不同 | `legacy_provenance_conflict`；不得覆盖 metadata |
| 文件 SHA/segment 已属另一 collection | `legacy_source_identity_conflict`。迁移旧行与新补录同一唯一域，事务内竞争也必须转成此原错误并回滚 |
| source 在 freeze 后变化 | `legacy_source_drift`，保留第一次 freeze；无本次补录 |
| HTTP replay endpoint | 保留[现有明确400拒绝](../../server/utils/roster-import-http.ts)第97–99行。service 的 evidence-convergence replay 沿原逻辑，不把它扩成新的补录入口 |

其余原错误保留：`legacy_provenance_invalid`、`legacy_query_missing`、`legacy_query_identity_conflict`、`legacy_query_not_legacy`、`legacy_collection_identity_conflict`、`legacy_relation_set_conflict`、`legacy_relation_payload_conflict`、`legacy_page_title_conflict`。缺 alias 为 missing；缺原档或不能核验输入为 source drift。未知或未完成目标由 readiness owner 在进入命令前明确拒绝，不伪装成“无补录”。批次失败的 `commit_rolled_back`、`not_executed` 和 summary 继续归 roster-import。

## 4. 原采集事实与补录页事实

原查询 status 的 success/partial/failed/no_record/not_queried，原 completeness 的 complete/partial/not_queried/unknown，以及原 `collectionEvidence` 是否捕获，保持原事实。补录自己可以声明 complete、partial、失败页、unfinished、显式完整空结果；这些只在 `legacyProvenance.collection` 下表达。不能把其 fullRange 或 complete 填回 collection、page、scope、见证或决定事实。

T04 在已有旧补录时以该补录派生部分 collection/page/conditions，`provenanceState=legacy_supplement`。本票不追溯重建这批已接受历史结构；它仍不等于 original evidence。新补录不重新执行 T04 transfer。完整性消费者必须保留原证据来源 gate，不因发现附表或展示页就把历史 unknown 认证为 complete。

| 消费者及当前接缝 | 补录后的语义 |
| --- | --- |
| `target-evidence-read.ts`、`target-query-display.ts`、`target-relation-display.ts`；schema0 `read.ts`/`evidence-read.ts` | 原 evidence 不变，另显示 metadata。行的 `sourceRdjb/sourcePage` 按原 `legacySourcePositionForSequence` 使用补录页；无补录才用原 evidence 页。精确 relation evidence 仍是原 DTO，不重写 snapshot |
| `enterprise-roster.ts`、`record-correspondence-read.ts` 的选中证据，comparison/difference 附件 | 只更新已选中原观察的分页展示。对应授权/角色/有效性、comparison membership、counts、代表记录、解释状态分别归原 owner，不能由 display 返回值反向驱动 |
| `candidate-target-sources.ts`、current-candidate scope capture/read、`record-comparison-target-sources.ts` | 候选集合、title 谓词、排序/分页和原来源预算不因补录改变。候选的展示位置与候选筛选用页分开；若展示位置需要补录，选择完成后调用同一证据 resolver |
| `recognized-filter-source.ts`、recognized witness、资格 #738–742 和导出 | 只用原结构化来源和各自既有 gate。business_list 补录不变成 recognized 见证，不新增有效名单或资格周期 |
| `decision-lifecycle-102.ts`、`evidence-impact-113.ts`、114、`comparison-scope-proof-source.ts`、annual closure | 原 collection/page/条件与业务事实继续支撑 admission、coverage、proof 和历史 hash。补录不触发新的113 revision、114审查或决定、不改变授权闭包，也不修复旧 proof 输入 |
| `platformRecordObservations`（#753）及三个 source writer | 不 bootstrap、不重分配身份、不改 version/basis/indexedAt；共享 version 的 observation 各保留自己的来源 |

不新增补录业务 structured facts。唯一新增结构化信息是 metadata 身份、唯一性及归档 FK。补录页 JSON 只在选中证据展示边界解码，不能放进 WHERE、候选、业务 count/sort、资格或聚合。若以后业务消费者确需补录事实，必须另票明确来源为 supplemental、规则版本、与 original evidence 的优先级和具体消费者，给出改变行为的反例；本票不授权该行为。

## 5. 统一读取、字节预算与快照

读取先验证原 T04/W4a 的固定 ref 集合，再查询新 metadata 索引。`provenancePresence` 的原封套判定应保留独立含义；新的补录 resolver 组合“原封套是否存在”与附表，不能让该函数接受多余 collection ref。完成 successor 后，T04 有封套但无对应索引、origin/owner/metadata 不一致都报 lifecycle 错误，不将异常降成 absent；T04 与新 supplement 同时存在也拒绝，不用任意优先级掩盖冲突。

resolver 对两种 origin 输出相同旧 metadata DTO。T04 只从原八列封套读取 collection cell，逐字保留该 cell；新 supplement 从自己的 collection archive 读。既有 metadata 与新补录不合并 rows、不覆盖 sourceIdentity/batch/time。

| 读取模式 | 保留的限制 |
| --- | --- |
| query summary | 不水合 provenance、rows 或 rawResponse；原 counts、按 queriedAt/public alias 的稳定分页不变 |
| full query/list 与 enterprise/source display | 原 `json_remove(collection,'$.rows')` 语义和 JSON 错误保持。选中页后才预算和水合；沿原4MiB每 query、8MiB每页预算及413错误，不把整个封套或 snapshot 另算一遍，也不漏计新 supplement |
| metadata 批读 | 外部ID先解析，去重后每批至多400参数；现有 target 300分块可沿用。每个请求对同 collection 只解码一次，不引入跨请求缓存 |
| `field=legacyProvenance` | 返回原 collection JSON bytes，含 rows；没有补录才返回 isNull/0 bytes。T04 返回封套内原 cell，不暴露封套；新补录返回已归档 TEXT bytes。base64、offset/length、65536上限及 hasMore 不变 |
| `field=relations/relation` 与其他 evidence fields | aliases 配对、原 total/sequence 分页和 relation DTO 序列化保持。补录不改原 rawResponse/collectionEvidence、原 relation snapshot 或身份 |

完整 evidence 的响应分块上限不等于内部内存上限。现有 T04 evidence reader 会构造整个封套，relation display 也会解码所选 owner；本票不声称这些已变成 chunk 内存读取。列表预算必须先在 SQLite 做去 rows 长度判断；新 TEXT archive 可直接 SQL BLOB 切片。旧封套的内存优化另属 evidence owner，不能作为本补录的业务改造。

count、分页、预算、补录 metadata、当前 assignment 与选中证据放在同一同步 read transaction。预检对原指纹材料同样保持一个 source snapshot，提交重新读取；现有 request-local Map 在事务结束即丢弃。补录后的下一请求必须可见，不能缓存“无 provenance”；已有读 snapshot 保留原视图。没有新的公开 cursor 或缓存失效 API。

既有 [REST summary cache](../../server/utils/platform-summary-cache.ts) 保留只读 observer 的 `data_version`、文件身份、事务绕过、no-store 与原资源限制；MCP及完整证据不进入该缓存。新补录 commit 必须使 observer 的既有失效机制正常生效，rollback 不发布未提交数据。R 验证这些路径，不增加 provenance 跨请求缓存。

## 6. 必要 successor 与离线恢复

现有旧表 FK 不能承担目标写入，原 sealed ref 又不能追加。因此需要一张专属表及一个显式离线 successor，限 schema/metadata 转接；不需要新输入归档 phase。后续 S 票分配确切版本号与 transform 名，必须晚于实际已接受71612，不在本 docs 票占用或实现版本。

S 只接受完成的71612 predecessor 的隔离一致副本，使用现有 migration run/checkpoint owner。拒绝未知/未完成目标、FK-OFF、源/目标同文件、缺原 archive/alias、重复 SHA/segment、跨 owner 封套和不支持的原 metadata 类型。先核对全 collection 及 provenance PK 集，再安装 schema、将旧 T04 metadata 建索引、保持新补录为空。没有原 provenance 的合法 collection 保持无行，不预占 source identity。W4a 没有原补录也保持无行。

每批索引插入和 checkpoint 同事务，失败没有半批；版本 promotion 与 complete 仅在全PK双向覆盖、原字节/metadata一致、唯一性、schema/FK及 integrity 核对通过后提交。相同 run、相同冻结 predecessor 与 transform 重放验证已完成批次；绑定漂移拒绝续跑。原 migration receipt、113/114、决定和 import receipt 全部保留，不改写其 hash，也不建立运行时前驱认证链。

完成后运行 readiness 沿 [#744 简化 owner](../../lib/platform/migration-readiness.ts) 的原则，仅检查明确支持版本、必要列与本 successor completion；这不是恢复旧 DDL/hash 信任根。不能把升级工具导入 server/lib，也不在查询时迁移。

完成目标已有新的普通 collection 或 supplement 时，重跑不能删表、truncate 或要求运行数据仍等于离线初始行数。离线完成重放只验证自身绑定的历史行和 checkpoint，保留后继正常写入。需重建时暂停写入、在独立副本前向修复并完整保留新 collection、观察、补录及 receipts；禁止用 predecessor 备份覆盖新提交。runtime admission 只在显式注入数据库上扩展所需 consumers；普通全局 runtime/import/worker guards 保持 CLOSED，旧二进制不得打开 successor。

## 7. 后续 ≤M 切片与独立正常路径

下列是建议拆分，未创建 tracker issue，未实现或预先接受。`S → W`、`S → R`，W+R 均独立接受后父级才组合正常补录读回；不增加全局切换前沿。

| 切片 | 接受输入和范围 | 正常路径与独立 oracle |
| --- | --- | --- |
| S：schema/离线转接，≤M | 本契约接受、实际完成71612；仅专属表、约束、必要对称 archive 排他、completion、T04 索引与显式升级工具。不改原 seal、观察 basis 或业务投影 | schema0 先种既有补录与无补录查询，经真实完整离线链到 predecessor，再运行 successor。逐原八列 SQLite storage class/bytes、alias/全PK双向集合及字面 metadata 核对；重复 segment、错 owner、FK-ON中途失败、同run续跑、完成后新写再重放。schema0仍正常，普通 guards拒绝 successor |
| W：命令/回执，≤M | S完成；接 `platformLegacyProvenance` 的原输入重建、plan/commit接缝及原 receipt。拥有显式 import/readiness 和必要 source writer 的 successor admission，使 #751/#753 既有能力可共存，不改它们的业务规则。已有原档足够则不另存 basis；缺材料报精确反例，不扩大 capture | 同一源分别用 schema0 原服务与完成目标 preflight→commit，独立按本契约字段顺序生成字面 query/rows bytes。覆盖8001/9001非同值 alias、raw空白、空/partial、共享version、assignment revision2+、freeze漂移、同key/新key重复/冲突；后项和receipt失败整批回滚并重试。原hash/113/决定/回执 bytes不变，目标SQL无旧业务表读写。以新collection正常导入后补录证明后继写入，再重放离线完成run；公开补录显示最终组合需R |
| R：证据读取/展示 consumers，≤M | S完成；旧 T04 索引与按S约束构造的合成 supplement。只接统一 resolver、generic list/evidence、target query/relation display 与实际转用该display的enterprise/source附件；选择predicate保持 | 用旧服务读同源已补录 schema0，另用字面 JSON bytes/page期望核对目标。验证11-byte多段拼接、完整空补录、分页去rows、400参数、4/8MiB边界、summary无水合、同snapshot及下一请求可见。独立集合证明候选/比较/资格/决定/113输出不变；授权闭包与附件位置分列。若实际consumer范围超过M，按generic evidence和已选附件拆分，不能顺带切业务选择 |

W 的 schema0 对照不得依赖新 resolver 生成期待值，R 的页面期望不得调用新页定位器自证。W/R 组合再使用同一隔离 SQLite，经现有 HTTP preflight/commit、精确 evidence 和来源读回验证新补录；REST/MCP handler 执行与 compiled Nuxt、served OpenAPI、dispatcher/auth 分列。各实现票按必要受影响测试验证，完整 wire 和全局切换仍是 C/H/Z owners。

## 8. 静态依据与本票限制

| 依据 | 固定基线位置与用途 |
| --- | --- |
| [旧 command](../../server/utils/platform-legacy-provenance.ts)、[schema/metadata reader](../../lib/platform/legacy-provenance.ts) | 第19–69行；第13–44行。原指纹、identity、unique source、rowsWritten与400参数 |
| [公开测试](../../tests/platform-legacy-provenance.test.ts) | 全276行。preflight、保护表、页2、11-byte证据、空/partial、重放、原错误、freeze、回滚、REST/MCP schema与HTTP语义；本轮未执行 |
| [roster-import](../../server/utils/roster-import.ts)、[receipt](../../server/utils/import-receipt-ledger.ts) | 第1537–1559、4366–4397、4463–4591、4670–4743行；receipt第19–65行。freeze、执行闭包、失败summary、最终回执事务；preflight不是整个DB零写 |
| [T04](../../upgrade/collections.ts)、[0048](../../db/migrations/0048_cute_madelyne_pryor.sql)、[0052](../../db/migrations/0052_swift_starhawk.sql) | 第115–188行；0048 ref CHECK/seal-only/no_replace；0052第645–649行重建观察ref约束，未允许扩sealed集合 |
| [immutable archive](../../lib/platform/immutable-archive.ts)、[target archive](../../lib/platform/target-archive.ts)、[fingerprint schema](../../upgrade/fingerprint-basis.ts) | archive第18–93行，target wrappers，basis第10–28行。不可变BLOB、归档排他、目标alias和不同basis owner |
| [target evidence](../../lib/platform/target-evidence-read.ts)、[query display](../../lib/platform/target-query-display.ts)、[relation display](../../lib/platform/target-relation-display.ts)、[query list](../../lib/platform/target-query-read.ts) | provenancePresence第42–87行；query第13–89行；relation第64–168行；list第35行起。固定生命周期、预算与选后水合 |
| [target schema](../../lib/platform/target-schema.ts)、[query readiness](../../lib/platform/query-history-target.ts) | 完整目标声明与显式71612 admission，非普通注册切换 |
| [candidate](../../server/utils/candidate-target-sources.ts)、[comparison](../../server/utils/record-comparison-target-sources.ts)、[113](../../server/utils/evidence-impact-113.ts)、[proof](../../server/utils/comparison-scope-proof-source.ts)、[决定](../../server/utils/decision-lifecycle-102.ts) | candidate第18–90行；comparison第19–66行；113第126–195行；proof第65–107行；决定第202–237行。展示页不能代替各领域predicate |

本票仅运行文档 diff-check、tracked 改动盘点、相对链接与静态一致性检查，不做作者自审循环。代码/SQLite probe、测试、Nuxt、typecheck、build、browser、CI、完整 wire、真实业务库和生产均 UNRUN。没有依赖链接或运行时修改。原始 source 与本轮要求矩阵保存在仓外独立证据目录，不把业务 JSON、DB 或凭据提交 Git。

父级交付的 #753 LOCAL 接受 `d359b85e`、最终候选 `322f286d`/tree `229d1907`、R2 fresh94 repository PASS和10 independent SQLite PASS、typecheck继承exit0，均为继承说明，本轮不重新计为 fresh。原3 projection-shape FAIL、早先4 wire timeout UNRUN、#752/compare失败、first FAIL、TMP缺口和#751配置偏差保持；本票静态检查不能消除它们。

企业归并/归属更正、live reuse/last_collected_at、jobs/transport/workers、其余FK/DROP与全局切换仍由各自后续owner承接。#738–742资格冻结。独立审查和最终LOCAL合并由父级安排，#706/#690仍未完成。
