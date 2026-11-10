# 完整退役的数据与迁移契约

状态：#707 proposed，所有新表、字段及模块名均为待审实施目标，不是现有能力。决策见 [ADR](../adr/2026-11-10-platform-mixed-table-retirement.md)。本契约不改变比较 membership、资格规则、对应角色或授权范围。

## 标识与存储

SQLite ID 使用 INTEGER，应用边界要求正 safe integer。时间保留原 TEXT，未知时 NULL，不重新格式化历史值。所有 FK 默认 RESTRICT，删除业务主体不得级联清除历史观察或归档。新 ID 的序列起点必须高于保留旧 ID 的最大值。映射中的同一个数字属于不同 namespace，不允许省略 kind。

| 目标 owner | 字段、类型与约束 | 索引与责任 |
|---|---|---|
| `platform_collection` | id PK；interface TEXT，沿用现有三接口枚举；query_key、rdjb、queried_at、created_at TEXT NOT NULL；title_code FK nullable；last_collected_at TEXT nullable；status 沿用 success/failed/no_record/not_queried/partial；failure_reason TEXT nullable | UNIQUE(interface,query_key,rdjb,queried_at)，保留旧幂等自然键；index(query_key,id)、(status,queried_at,id)、(title_code,id)。不放业务 status/year/name 列 |
| collection 采集事实 | source TEXT nullable；evidence_status TEXT nullable，保留 auth_failed 等来源状态；completed_at TEXT nullable；completeness complete/partial/not_queried/unknown；full_range INTEGER nullable，仅0/1；fetched_count、declared_total INTEGER nullable；scope_mode TEXT nullable；provenance_state captured/legacy_supplement/unknown/conflict；parse_state valid/invalid/absent；rule_version TEXT；error_code/error_message TEXT nullable（来源顶层error，不覆盖query.failure_reason） | query.status 不等于 evidence.status；两者不能合成一列。补充 provenance 不冒充原 collectionEvidence |
| `platform_collection_page` | id PK；collection_id FK；ordinal INTEGER NOT NULL；source、rdjb TEXT nullable；page_no、max_page、fetched_count、declared_total INTEGER nullable；status、error_code、error_message TEXT nullable；sequence_start/end INTEGER nullable；position_state verified/unknown/conflict | UNIQUE(collection_id,ordinal)，顺序按原 pages 数组 ordinal，不按 page_no 排序去重；index(collection_id,rdjb,page_no)。重复页、失败页、成功0行页都保留。非法数值不强制合法化，原值在归档，parse_state 标 unknown/conflict |
| `platform_collection_unfinished` | collection_id FK、ordinal INTEGER、source/rdjb TEXT nullable、page_no INTEGER nullable；PK(collection_id,ordinal) | 保留 unfinished 的原序和重复位置；不能由观察数推断完成 |
| 现有 `platform_query_title_scope`、`platform_query_title_scope_error` | query_id 转 collection_id FK，分别保留 PK(collection_id,rdjb) 与 PK(collection_id)；原 rdjb TEXT bytes 不 trim | 保留 index(rdjb,collection_id)；移除旧 JSON 触发器，新 writer 显式写入；不会再新增 collection-title-scope 复制表 |
| `platform_collection_condition` | collection_id FK、name TEXT、value_kind TEXT、text_value TEXT nullable、integer_value INTEGER nullable；PK(collection_id,name) | name 限 name/uscc/combination/sqsj/rddqrq/whpcyear/whpc/szq/orderField/orderDirection；value_kind 为 absent/null/text/integer/real/boolean/array/object。仅可无损表达的 string、safe integer、bool 入对应列；real/array/object 只标类型、原值归档、业务判断 unknown，不以 String(value) 转换。条件不含业务行字段 |
| collection limits | max_requests、max_rows、max_duration_ms、page_size INTEGER nullable | 来自已验证采集输入，历史缺失留 NULL，不能从结果猜出请求预算 |
| 重建 `platform_business_observation` | id PK，移除 relation_id FK；collection_id FK NOT NULL；sequence_no INTEGER NOT NULL；page_id FK nullable；page_row_no INTEGER nullable；position_state verified/unknown/conflict；保留 record_id、version_id、identity_state、content_state、key_source、projection_rule_version、input_fingerprint、indexed_at、batch_id 及现有组合 FK/CHECK | UNIQUE(collection_id,sequence_no)；index(record_id,version_id,id)、(version_id,id)、(collection_id,page_id,sequence_no)。已有 observation 的 id=旧 relation_id；所有未建索引的旧 relation 也得到一个 observation，不按企业或业务号去重 |
| `platform_observation_assignment` | observation_id FK、revision INTEGER、enterprise_id FK nullable、match_basis 沿用 uscc/alias/manual/none、verification_status confirmed/pending、uscc_raw/name_raw/alias_name_raw TEXT nullable；actor/basis 由现有命令类型定义；command_receipt_id nullable、recorded_at TEXT nullable、origin migrated_current/command；PK(observation_id,revision) | index(enterprise_id,observation_id,revision)、(uscc_raw,observation_id)。历史当前归属作 revision1，origin=migrated_current，不能声称知道其确认时间或操作者。后续修改只追加，读取同一 snapshot 中最大 revision；不覆盖历史，不在 record 上放 currentOwner |

collection 原 request、rawResponse、collectionEvidence、legacy supplementation、sourceText 和业务 rawFields 都进归档。源字段与传输字段不能装进一个可空混合 relation。除显式集合 metadata 外，运行代码不解析上述归档来筛选企业、称号、条件或完整性。

## 复用三来源投影

现有 record、version ID、identityRuleVersion、hashAlgorithm、contentHash 和三投影 ruleVersion 原样保留。版本 `canonical_raw_json` 改为 `canonical_archive_id` 外键，正文完整转存 BLOB；旧 contentHash 不改。唯一约束仍是 (record_id,hash_algorithm,content_hash)，命中后比对长度与原 bytes，不以摘要相同省略内容核对。

各源沿用 [apply-record](../../lib/platform/apply-record.ts)、[business-projection](../../lib/platform/business-projection.ts)、[recognized-projection](../../lib/platform/recognized-projection.ts) 的解析策略和 [schema](../../db/schema.ts) 的字段：

| 现有表 | 业务字段与来源边界 | 新读写 owner（规划模块） |
|---|---|---|
| `platform_apply_projection` | titleRaw、declareKind、declarationYear、appliedAt、status、nameRaw、usccRaw；year 按申报原规则 | `platform-apply-write.ts` / 现有 `platform-declarations.ts` |
| `platform_business_projection` | titleRaw、declareKind、businessYear、appliedAt、status、batch、awardBatchLabel、province、nameRaw、usccRaw；personuuid 是来源批次标签 | `platform-process-write.ts` / 现有 `platform-business-processes.ts` |
| `platform_recognized_projection` | validityDateRaw、maintenanceYear、maintenanceBatch、district、awardNote、titleRaw、nameRaw、usccRaw；sourceValidityDate、sourceMaintenanceBatch、sourceMaintenanceYearAbsent 保真字段不动 | `platform-recognized-write.ts` / 现有 `platform-recognized-directory.ts` |

不能只迁 resolved+verified 的行。为每张**现有投影表**增加 id PK、observation_id nullable FK、basis verified_raw/legacy_columns/unavailable。version_id 改 nullable UNIQUE，record_id 改 nullable；CHECK 恰有 version_id 或 observation_id，一个非空。version-owner 必须有 record_id，保留(version_id,record_id)组合 FK；observation-owner 必须无 record_id，并校验 collection.interface 对应本源。UNIQUE(observation_id)，不新建第二组三表。id 是新投影内部标识，不替换旧 version ID，也不进入历史 fingerprint。

resolved+verified 观察仍通过 version_id 共享唯一投影，不能为重复采集各造版本。无版本观察只在其来源表持 observation-owner 行：确有旧列的字段按旧类型原样转入、basis=legacy_columns；不能作为已验证源内容。无版本分支字段逐个按旧列对应：status→status、batch→batch、declare_kind→declareKind、applied_at→appliedAt、award_batch_label→awardBatchLabel、year→declarationYear或businessYear；title_raw→titleRaw按migration0043已存值原样迁移，不重新trim；名称/统代/属地原值照旧；无旧列的recognized保真字段保持未捕获。原始列与 normalized 投影有差异时，旧列留不可变 legacy row snapshot，不覆盖已验证投影。旧候选所需 source uscc/name 和当前归属由 assignment 提供；旧来源业务字段由此分支提供，消费者明确区分 verified 与 unknown。无法解析 raw 的关系仍可显示、待核和反查，不能假造稳定业务 ID、资格见证或 source fidelity。

`platform_business_observation` 只保存身份、位置和规则状态，不增加 status/batch/year 等通用业务字段。三投影 owner 分支扩展单独成票，不作为第一采集 schema 票的前置条件。

## 范围与条件

所有提取在 upgrade 或 ingest 边界进行。保存提取规则版本和原 archive ID，后续更正不得改原文。无法解析的历史输入保留 bytes 和 parse_state；遇到旧接口应抛出的 scope error，新读接口保持同类错误，不能悄悄返回空集合。

| 消费者 | 保留的判据 | 目标读取 |
|---|---|---|
| 通用归档 title membership | migration0027 的 `json_valid(...,2)` 和嵌套 json_each/json_extract 两次解析；只收 text 值，保留 error 行 | 原 scope/error 表转 FK；rdjb 本身仍按各消费者原规则使用 |
| 当前候选 | `current-platform-scope.ts`：单 title 用 title_code/rdjb；多 title 按成功页 fetchedCount 前缀定位，失败页不贡献；无页 title 时回退 query.title_code，仍未知时才按 query.rdjb token membership | 有序 page 的 sequence_start/end，collection title_code 与 rdjb；不以行 title 替代。为旧规则保存命中的 page_id，未知/冲突原样保留 |
| 认定目录列表/选项 | row title 与 query.rdjb/scope 的组合，含已存在 trimmed display 判据和源 scope 冲突 | 来源投影 titleRaw、collection scope/error。逐个保留列表、选项及冲突不同谓词，不能用候选 effectiveTitle 代替 |
| 差异决定 | `decision-lifecycle-102.ts:202-227` 的 confirmed、企业归属、query key、query rdjb 和多 title 页定位 | assignment、collection、page；多 title 缺页仍拒绝，与候选允许未知 membership 不同 |
| 范围证明 | `comparison-scope-proof-source.ts:64-73` 完整、fullRange、unfinished空、无窄条件，所选 title 页从1连续到末页 | typed conditions/pages/unfinished；原 source fingerprint 输入见下节 |
| 认定资格见证 | `recognized-filter-source.ts` 的 source=queryBusList、双 success、and/complete/fullRange、confirmed owner、保真字段已捕获；仍按原 observed page/条件语法判断 | collection 独立 status/evidence_status、条件类型、page、assignment 与保真投影；缺失不补猜 |
| 年度闭包 | `event-annual-process-read.ts:263-451` 的 query titles、原行覆盖、同业务全部历史观察、潜在 apply/process query 与 protected correspondence 集合 | 完整 collection/page 和 observation record history；不缩成“最新版本”或只看已确认行 |

例：失败采集没有 observation，也必须有 collection、失败页/unfinished 及原原因。complete no_record 可作原规则允许的覆盖证据，failed、not_queried、partial 均不能替代。重试 segment 的 page_no 相同不代表同一采集，collection 自然键及 job item/attempt/segment binding 必须同时保留。

## 不可变归档与引用

新增 `platform_archive_value(id PK, storage_class TEXT NOT NULL, bytes BLOB nullable, byte_length INTEGER nullable, sha256 TEXT nullable, created_at TEXT)`。storage_class 限 null/text/blob；null 时后三者 NULL；text/blob 时 bytes 非空值允许零长度，length(bytes)=byte_length，sha256 用原 bytes 计算。JSON null 为 text 四字节，SQL NULL 为 null 状态。不要把 TEXT 经 JSON.parse/stringify 再保存；BLOB 也不转 UTF-8 string。每个 owner 字段一份值，不进行跨字段去重和片段组合。archive表安装拒绝UPDATE/DELETE的约束触发器，领域接口只提供insert与read；更正新增值及明确修订，不改已发布的owner-field绑定。类型化ref表在首次seal后同样禁止改绑，mutable assignment不存入原文绑定。升级工具的恢复操作单独授权，不能作为runtime通用删除口。

collection、observation、version 使用各自类型化 archive FK 附表，PK(owner_id,field)。field 分别限 rawResponse/collectionEvidence/legacyProvenance/request、rawFields/sourceText/legacyRowSnapshot、canonicalRawJson；每项实际存在的 NULL 字段也有记录，区别“不存在字段”与“存在但 SQL NULL”。legacyRowSnapshot 保留旧混合行完整列序、JSON 类型与原值，供证据和历史 fingerprint 使用，**不得接入业务过滤**。现有 `platform_query_legacy_provenance` 转成 collection provenance metadata（sourceIdentity/sourceSha256/segmentIndex/inputFingerprint/importBatchId/createdAt），collection 原文进 archive；保留原 UNIQUE(sourceSha256,segmentIndex)。

旧引用解析使用两张类型化别名表：`platform_legacy_query_alias(old_id PK,collection_id UNIQUE FK)` 与 `platform_legacy_relation_alias(old_id PK,observation_id UNIQUE FK)`。map 无业务字段、无旧表 FK。迁移后两个方向数量、集合与映射都须核对。新提交也分配兼容 old ID 别名，独立序列高于旧最大值，保证现有外部参数仍可用。新内部接口使用版本化 discriminated union，例如 `{version:2,kind:'observation',observationId,collectionId}`；旧 `{queryId,relationId}` 在边界解析为此类型，并验证同 collection，不能只按同整数查找。

| 引用 owner | 转接要求 |
|---|---|
| observation/version/三投影与 difference_reason.evidenceQueryId/evidenceRelationId、record_correspondence.relationId | 重建物理 FK 到 collection/observation；过渡外部字段拼写可以保持，内部类型改名。current references 的值和历史 ID 映射逐项验证 |
| enterprise_alias.sourceKind/sourceRefId、merge lineage.evidenceQueryId | sourceKind 指明旧 namespace 再解析，不能把某个 sourceRefId 当作 observation ID 猜测；归属合并追加 assignment 修订，审计 bytes 不重写 |
| correspondence evidence/audit/provenance、proof、113 revision/114 review、decision requestHash/planHash/sourceFingerprint | 历史序列化 bytes 及 hash 原样保存。resolver 只解引用，不更换所引用观察、角色、owner、event 或 revision；changed source 仍进入原 113/114 重核 |
| import_batch/import_receipt、job.params/result/checkpoint、年度 candidate/final/task refs、导出 artifact metadata | 保留历史载荷，v1 解码只作 namespace→target 解析。可执行的旧任务在切换前排空或以原命令合法重提；不得批量改 JSON 后沿用旧 requestHash |
| 旧 evidence URLs 与 MCP 参数 | 两个别名 resolver 服务相同 target owner。bounded raw bytes 继续64KiB、base64、isNull/totalBytes/offset；relations 列表仍按 sequenceNo 分页；错 query/relation 配对404 |

`evidence-read.ts` 的 relation 接口不是 rawFields 本身，而是 SQLite json_object 的旧 DTO。升级时独立保存原 v1 DTO 字节样本和错误样本；实现目标 evidence serializer 保留旧字段顺序、json(rawFields)、SQL NULL 与 invalid JSON 报错语义。可变企业归属字段从当前 assignment 读取，其他旧列从不可变 legacyRowSnapshot 读取；新观察由本源 writer 生成同契约 snapshot。不得返回 cutover 时的旧归属冒充当前归属。原始 rawFields/sourceText bytes 永远不改。

历史 fingerprint 也不等于归档 sha256。`comparisonQueryFingerprint` 使用固定字段 JSON.stringify；currentSource 的 fingerprint 含 query、queryRows、exportRows、scope、freezeFile。目标为每种现存算法保存原 envelope/rule 的字节与 expected digest，核验时用 target 中同 owner 的字段按旧字段次序投影；需原 JSON 只在证据核验 owner 内解码。新增内部 id、basis、archive FK 不进入旧 envelope。113 capture 的 fact material 原来包含 relation 旧列及 raw rddqrq/whpcyear/whpc/szq，normalized字段无法重现。H2将该material作为版本化证据输入绑定具体观察，保留类型与旧列序；证据hash核验可以按观察读取归档，业务membership、完整性和归属筛选必须使用typed facts。capture partition/coverage 只读typed collection/page/conditions，旧异常条件保持原错误或unknown，不任意字符串化。输入漂移仍拒绝或触发原重核，不返回缓存 digest 冒充重新验证。不得以解析别名扩大 proof 范围。

## 写入、快照与失败

计划调用接口由 Zod 边界 schema 推导类型，ID 在边界验证并区分 CollectionId/ObservationId/VersionId。规划 `platform-collection-write.ts` 接受已验证的采集事实，三个 source writer 接受各自字段与 typed assignment；不接受任意 table/column 字符串。读接口由同源 service 输出 source-specific DTO，HTTP/MCP 共用领域函数。旧 import schema 不能再从被删 schema.platformQuery/platformRelation 枚举派生，迁入领域 schema，保持 coercion/null/extra-field/error 旧契约。

导入一个领域事务内依次完成：重读 source binding、检查自然键及 payload replay → 归档原 bytes → collection/pages/scope/error → record/version/本源投影 → observation/assignment → 113 revision → receipt。使用同步 Drizzle transaction，不把网络或 await 放入事务。任一步冲突必须 throw 或由外层转异常回滚，不能返回 failure 后仍提交前序写入。已存在自然键遇不同 raw/key/sequence/条件仍报原 payload conflict；reuseExisting 缺原采集仍拒绝。同业务同内容的重复采集复用 version，但 observation 和每次采集时间分别保留。

实时与 batch 任务继续只保存传输 segments；导入才承诺业务原子性。batch retry 不重新请求已完成页、不改变 pageSize、不把部分结果合成为完整原采集，凭据仍只在内存快照。目标 job binding 另存 job_id/item_id/attempt/segment_index/collection_id，UNIQUE(job_id,item_id,attempt,segment_index)，不改旧 job.result。最后成功同内容复采的 last_collected_at 按现有 reuse 规则更新，不能更新 queried_at 或原 bytes。

列表 count、page、matched-version 与 record-global aggregates 在同一同步 read transaction。资格和工作簿继续共用同一候选枚举、asOf、评估版本及 request-scoped reader；不引入跨请求缓存。异步 worker 沿用原连接 owner 与 snapshot 规则，不在 worker 自动迁移 DB。读到 schema/文件 owner 漂移仍终止，不静默回主线程或旧 reader。

## 迁移检查点与切换

升级工具位于独立 upgrade 目录，不导入进 server/lib runtime。新增 `platform_migration_run` 保存 run_id、source_snapshot_sha256、source_schema_hash、source_manifest_sha256、target_schema_version、transform_version、state。`platform_migration_checkpoint` PK(run_id,phase,source_table)，含 last_old_id、copied_count、batch_digest。source manifest 包含每表 PK 集、每字段 storage class/字节长度/摘要、引用与页范围，连同一致备份放 Git 外。不能直接 hash 正在写入的 DB 主文件当一致源。

1. 在隔离一致副本冻结源 manifest。先迁 archive+aliases+collection/pages/scope/error/conditions/unfinished，再迁 observation/assignment/三投影 owner 分支，最后转接 references。每批 target insert、映射与 checkpoint 同一事务提交；失败无半批，重放比较原 bytes 和既有映射，不使用 replace。
2. 继续运行前校验 source snapshot/schema/manifest 和 transform_version 完全相同。不同即拒绝并新建 run，不从旧 cursor 继续。源是有序 PK，不能靠 offset；批次范围和 digest 可独立重算。schema expand 必须容许旧 writer，直到切换，不提前启用新 scope writer 与旧 trigger 双写。
3. 无版本历史、失败、无行、未查询、NULL、非法 JSON、补充 provenance、孤立或冲突 refs 全部进入报告。源本已悬空的 ref 保存 explicit unresolved 状态、原 ID 与原因，不能删除、猜造 owner 或伪装已映射；新增悬空必须为0。任何无法保持既有可读行为的 unresolved 是切换阻塞，原本不可解析的历史仍明确 unknown。
4. 双向 anti-join 覆盖所有旧 query/relation、版本、归属、archive 字段、引用 namespace 和 serialized ref；同源同日旧 oracle 与 target 对照。原 API DTO 和历史指纹用独立旧算法核验，不能以新 writer 的 serializer 自证。
5. 实际切换窗口停止 HTTP/MCP 写提交及任务派发，排空或明确终止活动 worker，保留 receipts 和 unfinished；冻结最终一致源，重新迁移或校验 final delta。打开 target-only 二进制之前必须确认全 source binding，不把此前影子副本当最终生产源。
6. 先在副本删除旧 runtime selectors/adapters/triggers/FKs，再物理 DROP query/relation。六正文表 `platform_body_leaf/root/part`、`platform_relation_body_ref/query_body_ref/version_body_ref` 逐表审计，非空先按完整逻辑 bytes 转存并双向覆盖，再删，不能恢复停用共享方案。scope/error/provenance 只允许目标 FK，无旧 table dependency。
7. 目标副本 `sqlite_schema` 无旧表、view、trigger 或 FK；`foreign_key_check` 无新增违例；执行公开入口、重启、取消重试、三份完整下载工作簿、受影响桌面/390px 和受控性能验收后才提交生产切换审批。详见覆盖表各票门槛。

切换前回滚使用一致原 DB/文件备份和原 binary，前提是未开放目标写入。切换后先暂停写入，默认回滚到支持目标 schema 的上一稳定 binary，仍用当前 DB/回执。若该 binary 不存在则停止恢复流量并前向修复；不得启动旧 binary。只有经独立验证的逆向工具完整搬回新 collection/observation/assignment/三投影及 receipt/ref，并通过同样双向 oracle，才允许恢复旧 schema。升级 backup 是事故恢复资料，不是覆盖切换后提交的授权。post-cutover rollback 的实际演练是 Z3 的硬门槛，当前 UNRUN。
