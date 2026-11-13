# #770 A：reconcile 原重放断言的归属契约

状态：scope:M，docs-only 候选，pending 父级独立固定对象 Standards、Spec 和 LOCAL 接受。本文只裁定表示，不授权 B。#768、#763、#706 仍 NOTREADY，global guards CLOSED。

固定基线 `c261f2cf4c95d36898277d52d1394dc08bbd7ee7`，tree `ecd7087bb6bd2025ecfafd425ce3982357baec83`。2026-11-13 读回 live #770，正文与冻结 `parent768-r2/ISSUE770.json` 相同，评论数为 0。完整要求另见同目录 `REPLAY-CONTRACT-BODY.md`。本候选证据位于仓外 `reconcile-slot-capture/replay-input-contract/`，不复制业务原件进 Git。

本文补充[四槽捕获契约](reconcile-slot-capture.md) §1、§3.2、§5.3、B07/B09，以及[捕获 ADR](../adr/2026-11-13-reconcile-slot-capture.md)。原文把合成 `payloadRows` 称为 exact replay 输入的推论已被检验为假。原文历史状态与证据保留，本补充尚未接受。选择理由见[原断言 ADR](../adr/2026-11-13-reconcile-replay-input.md)。

## 1. 已有事实与本轮证据上限

父级提供的原正常路径已分别保存 SQL NULL 和空对象 rawFields。真实 schema0 和未接受 #768 target 的四槽请求都发送合成 fallback，原 writer 均报 `observation_payload_conflict`。普通主 B1 输入在 R2 已成功闭环；它与两个失败分区分开记录。

父级实际十模块纯函数探针确认：NULL 经过当前 `rawRows?.[index] ?? row` 仍被替换，空对象可以保留，非空对象对照通过。原比较器收到真正 NULL 或空对象均接受。无需放宽比较器。

这些均为 INHERITED。依据为 `parent768-r2/PREMISE-RESULT-FINAL.json`、`premise-probe.cjs`、两份 PREMISExx-RECEIPT 和 `premise01/02.tar.gz`。`AUTHOR-R2-READBACK.json` 记载六 blobs、六 archives 共 461 members 的父级核对；本轮只读取该 receipt，不重新宣称逐成员验收。作者 186 PASS、base 129 PASS、configured 4442→4447 FAIL、controlled 39/39 FAIL 及首次 probe discovery 失败全部保留。本轮 application runtime、DB、fixture、tests、types、build、迁移、HTTP、浏览器、CI、生产均 UNRUN。

## 2. 三种输入各自拥有的事实

| 表示 | 唯一来源与允许用途 | 不能推出的结论 |
| --- | --- | --- |
| 旧比较 projection | schema0 的 `storedRawFields`、`legacyRowOf`；target 的 `slotPayloadRow`、`slotLegacyRow`。保留 truthiness、Object.keys/entries、原赋值和 JS 转换，供旧封套 validator 及既有 builder 映射 | 合成对象不等于持久化原 rawFields，不认证原 key 或源列 |
| 持久化 exact original | 原 query、relation 的坐标、列和 raw cell；target 对应 collection、observation、revision1、sealed rawFields/sourceText/legacyRowSnapshot。每个观察单独保留 | shared version、current assignment、display/history 不拥有这些原值 |
| outgoing replay assertion | 公共 query/relation 上实际存在的 own properties。由下文两种整体编码之一生成 | omitted assertion 既不是 NULL，也不是“原值不存在”；不能据省略创建新原事实 |

`raw_fields` SQL NULL、TEXT `null`、TEXT `{}`、对象中没有某属性、请求 omitted assertion、selected archive unavailable 六者分别保存。SQL NULL 有合法 cell/归档 owner，TEXT `null` 有自己的 bytes。解码后都可为 JS null，但不能互换其 custody。空对象可由当前 writer 原样断言。缺档是错误，不能转换成空对象或合法 reference。

旧 JS 边界还可能读出历史 JSON primitive 或 array。`storedRawFields` 的 truthiness、Object.keys 和 entries 行为照旧，不能加“更合理”的 object guard 改变旧分类或 validator。新的 raw primitive、array、Buffer 命令仍受原输入边界限制。历史解码类型与 fresh 命令类型必须分开；原 decode 错误继续报原错误。

## 3. 完整 producer 与 source owner 矩阵

行号对应固定基线。矩阵中的 target 参照只读 Git 对象 `b6a27136704baf97b8c86b8ccb8f88d988767f6a`，tree `e761d45490328096b982ca866b6951ca8a63651e`，未接受、未合入。本候选不导入它。

| 阶段 | schema0 producer 或核验 owner | target original 或事实 owner | 本契约边界 |
| --- | --- | --- | --- |
| 原四槽选择 | [platform-reconcile.ts](../../server/utils/platform-reconcile.ts) `freshStoredSlotsSnapshot:291` | R2 `server/utils/platform-reconcile-target-slots.ts` 的 `read`、`compareReconcileSlotCollections` | queriedAt 的 JS 字符串排序和 public query alias tie-break；最新先遮挡，再检查状态/freshness；无 title/owner 新筛选 |
| validator 行 | 同文件 `storedRawFields:255`、`legacyRowOf:274`；[client.ts](../../lib/platform/client.ts) `readCompleteLegacySlot:279`；[adapter.ts](../../lib/platform/adapter.ts) `normalizeRow:172` | [reconcile-slot-capture.ts](../../lib/platform/reconcile-slot-capture.ts) `slotPayloadRow`、`slotLegacyRow`，结构化 capture | 原合成、顺序、字符串/coercion 和 own `__proto__` 赋值行为只留在旧 projection |
| 存储原值 | `select(platformQuery/platformRelation)` 的同一同步事务 | [observations.ts](../../upgrade/observations.ts) `transfer:103`、[collections.ts](../../upgrade/collections.ts) `transfer:131` | query alias、relation alias、sequence、sourceRelationKey、三原档、revision1 均保留；不按 raw.id 重写 key |
| 分类 | `normalizePlatformRelation(interface, archived)` 和原 `getComparison`、`decideDifference` | [projections.ts](../../upgrade/projections.ts) `transferObservation:74`、[source-extraction.ts](../../lib/platform/source-extraction.ts)；R2 `comparison` | 每观察 stored/parsed/reconciled/conflict，含无 version、not_indexed、同 version 多观察。版本内容不能覆盖观察冲突 |
| service 输入 | `StoredSlot:357`、`toQueryInput:499` | R2 selected-original helpers 加目标 reader | 将 comparison 与 exact original 分槽保存；`payloadRows` 的旧命名不能成为原断言证据 |
| 字段再映射 | [payload.ts](../../lib/platform/payload.ts) `collectRelations:229`、[identity.ts](../../lib/platform/identity.ts) `relationFromRow:95` | 两路径共用 producer | 当前 rawRows nullish fallback、raw spread、raw.id 映射和 sequence=index+1 只适用于旧映射，不拥有历史原值 |
| 请求行 | [payload.ts](../../lib/platform/payload.ts) `toRelationItem:287`、`platformQueries:441` | 相同公共请求，不新增 transport | C1 `aliasNameRaw:null` 属 fresh 映射。sourceText 当前不发送；重放不得把这两点当作历史原列 |
| immutable 比较 | [query-replay.ts](../../lib/platform/query-replay.ts) `platformQuerySourceConflict:67`、`relationSourceConflict:18` | 同一比较器；[collection-target-replay.ts](../../lib/platform/collection-target-replay.ts) `targetReplaySource:109` | 省略从持久化 original 继承，显式断言继续逐项核对；错误优先级不改 |
| 原输入认证 | [roster-import.ts](../../server/utils/roster-import.ts) `archivedPlatformQuerySource:2966`；[platform-business-record.ts](../../server/utils/platform-business-record.ts) `assertPlatformObservationReplay:37` | `targetReplaySource.relationAt/assertOriginal`、[fingerprint-verifier.ts](../../lib/platform/fingerprint-verifier.ts)、[fingerprint-bootstrap.ts](../../lib/platform/fingerprint-bootstrap.ts) reference 分支 | 原 key/raw、原 fingerprint/source facts/mapping/必要 exact cells；reference 不创建索引或补版本 |
| 历史 raw driver 类型 | 原 ORM JSON decode 与 `readPlatformObservationPlan` | [legacy-fingerprint-raw.ts](../../lib/platform/legacy-fingerprint-raw.ts) | valid JSON BLOB 沿原 decoder；invalid/null JSON BLOB 保留 Buffer invalidRaw 与原 serializer 拒绝，不能替换为 TEXT |
| default writer | `inProcessReconcileWriter:79` → `preflightRosterImport` → `commitRosterImport` | [collection-import-target.ts](../../server/utils/collection-import-target.ts) → `writeCollectionTarget` | 不换捕获 writer，不用 spy commit 冒充成功；公共计划和提交内部重核均保留 |
| receipt 与可变决定 | [import-receipt-ledger.ts](../../server/utils/import-receipt-ledger.ts)、[roster-batch-ledger.ts](../../server/utils/roster-batch-ledger.ts)，原 difference/alias/assignment 工作流 | 原 caller transaction 与相同 ledger | 不改 key/hash/receipt 政策；归属、确认、曾用名、113/114 仍由其原命令拥有 |

### 3.1 每一个显式 immutable assertion

| 请求字段 | 原值 owner | 当前旧 builder 的取值风险与选定规则 |
| --- | --- | --- |
| interface、queryKey、rdjb、queriedAt | 原 query；target collection 与 query alias | 坐标定位，不从 business key 或 lastCollectedAt 造值。整个 reference 仍精确包含这四项 |
| titleCode | 原 query/collection，包括 NULL | #769 已接受的原值修复保持。fresh business 按 RDJB_TITLE，fresh apply 为 NULL。reference 的 omission 保留持久化 title，不能重新映射 |
| status、failureReason | 原 query/collection | 原 status 是采集状态，非 relation.status；failureReason 独立于封套。legacy 编码保持原请求，reference 不发新的 metadata assertion |
| rawResponse、collectionEvidence | 原 query 与 sealed collection 同字段原档；新采集 command request 是独立原件 | 旧 `raw:''` 生成 rawResponse:null，只在原 legacy sentinel 条件下省略正文断言。reference 明确省略两字段，不发字符串 `"null"` 或重传封套 |
| relations、sequenceNo | 原 query 的全部关系集合，原 sequence；target observation.collectionId/sequenceNo 与 relation alias | 合成 index+1 不能代替历史 position。reference 明确列出全部原 sequence，非子集或空数组代替非空集合；重复/新增/缺号在 producer 绑定处拒绝 |
| relationKey | 原 relation_key；target sourceRelationKey，并由 sealed snapshot 对照 | raw.id 可不同、缺失、NULL、空串或空白。既有 optionalString 与原 payload comparator 不改。reference 不发送 raw.id 冒充原 key |
| rawFields | 原 raw cell 与其解码值；target sealed rawFields 和原 snapshot | 不来自 fallback、不 spread nullable 原值。reference 省略 assertion，但原 comparator 仍从 same sequence original 取得真正 key/raw 并调用 assertOriginal |
| nameRaw、usccRaw | 原 relation 原列；target snapshot 及 revision1 原名/统代 | qymc/tyshxydm 映射可能不同。原存值不被现企业名、别名或 current assignment 替换 |
| aliasNameRaw、sourceText | 原 alias_name_raw/source_text；target snapshot、revision1 alias 及 sealed sourceText | 非 NULL 原列合法。fresh C1 的 NULL 不能当历史 assertion；reference 两者均省略，原 cells/独立 sourceText archive 必须可读且同 owner |
| province、status、batch、declareKind、appliedAt、awardBatchLabel、year | 原 relation 七列；target 原 cells 和本源 observation projection | 原 stored、typed raw parser、reconciled 是不同事实。原 trim、declareKind 字典、整数转换、严格非空冲突照旧。reference 不发送合成或 reconciled 值作为 stored assertion |

`relationSourceConflict` 只比较请求 own fields，并按原 normalization 后 optional string/int 比较，不要求请求逐字等于 SQLite cell。`platformObservationPayload` 单独比较 interface/key/raw 的 canonical JSON。两者规则不可互换。query metadata 用原 deep equality 和既有 rawResponse sentinel。producer 兼容判断必须覆盖这些完整规则，不能仅比较 raw hash。

enterpriseId、matchBasis、verificationStatus 不在该 immutable 源字段循环中。既存 query replay 不借 `toRelationItem` 的匹配结果更新归属；这些字段的改变仍走原明确工作流。reference 行省略它们，既不清空原归属，也不添加 revision。fresh 的精确 USCC 匹配、pending、C1 无自动 alias 保持。

### 3.2 target 原输入的 custody 与读取上限

R2 selected reader 在同一同步 transaction 中完成 connection/readiness、最新选择、capture 状态、全部 observation 数及本源 comparison。之后才调用 selected-original helpers。该顺序保持；运行准入不能重跑 `readCompleteLegacySlot`，也不能从 raw、display、history 或 version-first 重建分类。

R2 的 `selectedReconcileObservationInput` 读取 native status 与 raw，但其 row 未返回 aliasNameRaw/sourceText；不能称为完整 immutable source。后续 #768 的 selected-original owner 必须从同一 sealed snapshot 读取完整列，并对照 revision1 的原 name/uscc/alias 和独立 sourceText/raw archive。collection metadata、request/rawResponse/evidence 原档仍由原 collection replay owner 认证。capture digest 的 fallbackCells 不含 alias/sourceText/titleCode，不能被宣称已单独认证这些字段。

每个 snapshot cell 保留 storageClass、hex，REAL 保留原 real64be；native business status 为 `string | Buffer | null`，其余来源不扩大。Buffer 在内部复制 bytes 后只读使用，不能借 `as string`、JSON.stringify(Buffer) 或 toString 替代原 cell。query/relation alias 与物理 IDs 分别绑定，全部观察逐一验证，不按 version 去重。

这是已有 selected-original 恢复与 replay verification 的责任，不新增认证账本、公开 token、DDL 或 capture digest。writer 原 `authenticateOriginal` 仍在显式断言比较之后调用。它现有的 `verifyReconcileSlot → expectedCapture` 会复核 capture 并调用原 validator；本契约不修改或隐去这条已有 writer 核验。它不能被移到 target reader 当 runtime admission fallback，不能用其结果把 miss 升为 verified。

缺 ref、未 seal、owner/alias/sequence 不符、bytes/hash 不符、source projection 缺失或未知规则继续明确失败。不能把这些错误交给“省略 assertion”分支恢复。离线 legacySource custody 的 source hash/schema/manifest、活动生命周期和既有 T04→71613 绑定照旧，不由 runtime selected reader重新构建。

## 4. 两种表示与选择

| 方案 | 可表达性与兼容成本 | 裁定 |
| --- | --- | --- |
| 分离 comparison 与 exact nullable original，再逐字段全量发原 assertion | 可直接发 NULL、空对象、原 key 与合法 TEXT 源列。但 public status 不接收 Buffer；发送原 sourceText 等原来省略的字段会改变已成功请求及 receipt hash | 不选作统一发送格式。内部仍必须保留这种分离 |
| 已有 reference 语义，加整体 legacy 兼容编码 | reference 只定位已认证的原采集及全部原 sequence，writer 取原断言；不用新 JSON Buffer transport。旧成功请求完整保留才能兼容 committed key | 选择。省略范围在本文明确，待独立审查接受，不是遇冲突就删字段重试 |

该选择只适用于 service 自己从合法已选存储源生成的 replay。外部调用者显式给出的错误断言不经本 producer 改写，继续返回原冲突。不能先发失败请求，再自动删字段重试；reference 的选择在调用 writer 前完成。

### 4.1 内部类型与 API 草图

下列是待实现内部签名，不增加公共字段。`Q`、`R` 从现有存储 schema 推导；`ImportQ` 从现有 RosterImportPlatformQuery 推导。解码器在既有 source 边界验证。opaque SnapshotOriginal 仅由同一连接的 selected-source owner 产生，不接受调用者传来的任意 raw bag。

```ts
type Q = typeof platformQuery.$inferSelect
type R = typeof platformRelation.$inferSelect
type ImportQ = RosterImportPlatformQuery
type JsonValue = null | boolean | number | string
	| readonly JsonValue[] | { readonly [key: string]: JsonValue }
type OriginalRaw =
	| { kind: 'sql_null'; value: null; cell: OriginalCell }
	| { kind: 'decoded_json'; value: JsonValue; cell: OriginalCell }
type OriginalCell =
	| { storageClass: 'null'; hex: '' }
	| { storageClass: 'text' | 'blob' | 'integer'; hex: string }
	| { storageClass: 'real'; hex: string; real64be: string }
type TextColumns = Omit<R, 'status' | 'declareKind' | 'rawFields'>
type OriginalRelation =
	| { interface: 'business_list'; columns: TextColumns & {
		status: string | Buffer | null; declareKind: string | null
	}; raw: OriginalRaw }
	| { interface: 'apply_list'; columns: TextColumns & {
		status: string | null; declareKind: string | null
	}; raw: OriginalRaw }
type ExistingReference = Required<Pick<ImportQ,
	'interface' | 'queryKey' | 'rdjb' | 'queriedAt'>> & {
	reuseExisting: true
	relations: Pick<RosterImportRelation, 'sequenceNo'>[]
}
type ReplayEncoding =
	| { kind: 'legacy_compatible'; query: ImportQ }
	| { kind: 'original_reference'; query: ExistingReference }
type ServiceSlot =
	| { kind: 'fresh'; input: PlatformQueryInput }
	| { kind: 'stored'; original: SnapshotOriginal;
		comparison: ReconcileQueryEvidence; legacyRows: PlatformRow[];
		legacyBuilderInput: PlatformQueryInput }
declare function encodeStoredReplay(original: SnapshotOriginal,
	legacyQuery: ImportQ): ReplayEncoding
```

SnapshotOriginal 内含查询原 metadata、完整有序 OriginalRelation、每行原 alias、同 snapshot 的 source binding。unavailable 和 decode error 是读取函数的错误结果，不是 OriginalRaw 分支，不能进入 encoder。TEXT `null` 属 decoded_json；它不丢失 TEXT cell。普通对象 key order 来自原解码顺序，不能以 canonical JSON 重新造它。历史原 bytes 本身不经此类型写回。

`legacyBuilderInput` 明确仅为兼容映射输入。它可以含旧 fallback，但不得供应 `original`。不再用可选 `rawRows` 数组同时表达 fresh row、缺档、NULL 和 exact replay。新分支传完整 original；fresh 分支继续原 `relationFromRow` 和 `toRelationItem`，不改变通用 identity parser。

### 4.2 整条 query 的编码规则

1. source owner 先读取全部原关系及必要原档，完成 §3 的绑定。旧 validator/classification 使用原 projection，不使用 outgoing request。保留 schema0 原 `getComparison → collectReconcileTargets → freshStoredSlotsSnapshot → decideDifference`。
2. 旧 builder 按原代码顺序产生候选 query，不能先修剪、覆盖 rawFields 或补 sourceText。兼容判断覆盖完整 query、全部行、输入可表示性、原请求 normalization 冲突及 §3.1 全部 own assertions。它只读当前已选 originals，不触发 preflight、不作 DB 写入、不捕获原错误后冒称成功。
3. 所有断言按现有规则成立时，选择 `legacy_compatible`，返回该旧对象本身。禁止 spread 重建、排序 key、添加 reuseExisting、补 omitted 字段或改变 undefined/null。该分支保留原普通完整 replay 的索引/版本补齐行为。
4. 若原档合法且完整，但旧合成产生失真 assertion 或不能由 fresh schema 表达原 native 值，则选择 `original_reference`。整条 query 使用固定 §4.3 形状，全部关系只发 sequenceNo。metadata、key/raw、全部源列和可变归属字段均不发。不能按当前失败字段逐项删减。
5. 原 default writer 的 preflight 和 commit 仍核对该 reference 的存在、原输入、mapping、source facts 和 capture。未找到原坐标仍报 `query_reuse_missing`，新增 sequence 仍报 `query_relation_set_conflict`。writer 报错后停止，不切另一编码、不取另一个 key。

兼容判断是 producer 内部有限的表示选择，不能替代 writer 比较器。B 必须用真实原 writer 对判断的两种结果逐项验收，防止其复制的判断规则漂移。若无法在窄 producer 内完整覆盖断言规则，报告具体 owner/反例 NOTREADY；不能增加一套宽松 replay comparator。

### 4.3 literal 请求及原值绑定

以下为完整合法 reference request 的字面示例。坐标为独立示例，不声称来自证据库；运行 B 时用独立固定 fixture 绑定这些值。四槽分别用同一形状，三 business 的 rdjb 为 1、2、3，apply 为空。

```json
{
	"idempotencyKey": "platform_reconcile:literal-case",
	"sourceKind": "alias_evidence",
	"sourceIdentity": "platform/reconcile",
	"payload": {
		"platformQueries": [{
			"interface": "business_list",
			"queryKey": "literal-existing-enterprise",
			"rdjb": "2",
			"queriedAt": "2026-11-13T00:00:00.000Z",
			"reuseExisting": true,
			"relations": [{"sequenceNo": 1}, {"sequenceNo": 2}]
		}]
	}
}
```

该例必须已有精确坐标及 sequence 1、2。original 可以分别为 `relationKey:"stored-key-1", rawFields:null` 和 `relationKey:"stored-key-2", rawFields:{}`，并具有非 NULL alias/sourceText、BLOB status `00FF` 或空 BLOB。literal 请求不携 Buffer，满足现有 input schema。source owner 仍把原 NULL/空对象/key 送给原 payload 认证，native status 由原 snapshot 和 source-facts verifier 认证。metadata omission 使用已有 reference 语义，保留已选原 title/status/failure/body，不给原值赋默认值。

若显式断言原 raw/key，现有 schema 也允许如下 relation 项；这是解释比较器行为的对照，非新分支的字段菜单：

```json
{"sequenceNo": 1, "relationKey": "stored-key-1", "rawFields": null}
{"sequenceNo": 2, "relationKey": "stored-key-2", "rawFields": {}}
```

把第一项 rawFields 改为合成 `{"id":"stored-key-1"}` 仍须 `observation_payload_conflict`。显式错误 aliasNameRaw 或 sourceText 仍须 `relation_payload_conflict`；不能用 reference 编码重写外部错误请求。relation_key 与 raw.id 不同仍保留 identity conflict；source key 为 NULL、空串、空白的历史若触发既有 assertOriginal 的 normalized-key 不一致，继续明确拒绝，不能替换 raw.id 或放宽 key comparator。

静态边界反例为同一已选 query 下 `relation_key` 的 TEXT hex=`206B20`，原 rawFields=`{"id":"k"}`，即原 key 为 `" k "`。合法 reference relation `{"sequenceNo":1}` 继承 key 后仍被比较器 trim 为 `"k"`；schema0 `assertPlatformObservationReplay` 用未 trim 原 key 计算 payload，故不相等。显式发送 `" k "` 也会先被 trim。若这组原 cells 经原 validator/service 选中，本候选在该输入为 NOTREADY，owner 是 `query-replay.platformQuerySourceConflict` 与 `platform-business-record.assertPlatformObservationReplay` 的既有边界。B 要保存真实原准入和 literal 请求证据，不能把“存在 reference schema”当作全域成功证明。

历史 JSON primitive/array 只能在原 reader 已合法选中、原 comparator/认证可核验的既存观察上被引用，不能作为新 raw 输入发送。历史 raw BLOB 的 valid JSON、invalid JSON 和 JSON null 沿原 driver/`legacyFingerprintRaw` 分支及原 verifier 分别处理；本契约不扩大或缩小它们的原准入。fresh Buffer/非 JSON 命令仍拒绝，缺档仍错误，不能把历史 Buffer 转为新 JSON transport。原 raw JSON 子字段中的 number、boolean、null、object、array、own constructor/__proto__ 和属性顺序照旧保存。

## 5. native 值、源冲突与旧成功 key

business status BLOB/空 BLOB 在 fallback 时按原 truthiness 进入 projection，再按原 legacyText 转换。空 Buffer 也为 truthy。这个字符串只属于 validator/mapping；持久化 status 仍为 native bytes。非空 parsed TEXT 与 BLOB 继续严格冲突，不按 UTF-8 文本相等消冲突。source parsed `declareKind` 字典、year 的原 number/string 语法与 stored 归一化分别保持。

reference 没有新增 stored/source assertion，原 source conflict 仍由本源 observation facts 保留，不能产生更积极的分类或资格。显式新断言自身的 `platform_field_conflict`、原 payload、源列、metadata、source-authentication 的原先后次序仍由原 planner/writer 决定。encoder 不吞掉认证错误来选择 reference。

同 version 两观察可以有不同 stored status/year/conflict；reference 每个 sequence 均认证自己的 owner。not_indexed reference 调用原 reference 验证，不造 fingerprint basis、不 bootstrap。缺 projection 或未捕获 exact-stored 仍报原错误，不从共享 version 推导。

| key/receipt 情形 | 必须保留的行为 |
| --- | --- |
| 原普通对象请求成功 | 固定同 now、targets、源、企业匹配与决定输入，legacy_compatible 请求的 JSON.stringify bytes、own 属性存在性和顺序不变。既有 key 公式、差异 recordedAt 和 sourceIdentity 均不改 |
| 同 key committed 或 processing | receipt owner 比较 canonical requestHash。内容改变会在 core 返回摘要之前报 409 idempotency_conflict；单靠 core 的 committed shortcut 不能保全。旧成功分区必须走完全相同的旧编码，不统一切 reference |
| 同 key failed/preflight 的普通 reconcile | sourceKind 为 alias_evidence，没有 historical projection command；沿原规则允许修正请求新建 attempt。保留原 failed receipt/requestHash、原 batch ID 和 first FAIL。不覆盖旧 attempt |
| 不同 sourceKind/sourceIdentity/sourceSha256 | 原 key source binding 冲突保持。platformRecordObservations 的更严格历史命令绑定不在本票 |
| 已 committed 的请求却必须改变编码 | NOTREADY。附旧/新 literal、两 requestHash、原 receipt 和具体 source owner，交父级裁定；本契约没有换 key、改 ledger、调用 repoint 或重写历史的保全办法 |

最后一行是硬边界。例如历史 ordinary-object 原请求成功，后续 target 却只有 paired not_indexed 且 status 为 BLOB；若完整普通 replay 进入 [bootstrapFingerprint](../../lib/platform/fingerprint-bootstrap.ts) 的 `ordinary` 分支，会遇到 `Legacy text class conflict`。改 reference 能避开 bootstrap，但若改变该 committed key 的请求就会冲突。#768 必须用精确源证明此组合不存在或给 literal NOTREADY；本票不改 bootstrap、ledger 或“自动换 key”。无 committed receipt 且旧编码本身已成立的 ordinary replay，也不能为了 target 更方便而偷偷改分支。

## 6. B 的单个 ≤M 边界与实施顺序

B 是“schema0 reconcile 复用输入的整体表示”一个局部候选，A 接受及父级另行授权后才开始。允许的 producer owners 为 [platform-reconcile.ts](../../server/utils/platform-reconcile.ts) 的 StoredSlot、snapshot、toQueryInput 与 request 组合，[payload.ts](../../lib/platform/payload.ts) 的内部输入 union/复用编码接缝，以及一个窄内部 replay-input 模块。[reconcile.ts](../../lib/platform/reconcile.ts) 仅允许 ReconcileQueryEvidence 的来源相关 status 类型透传，business 为 string/Buffer/NULL，apply 保持 TEXT/NULL；其分类函数不变。允许定向测试。不得改 fresh identity parser、通用 builder 输出、getComparison、decideDifference 或 default writer。

B 先固定原 schema0 lawful source 和 literal oracle，再实现分离类型/完整 original snapshot，接上整体编码，最后运行下表。测试必须同时经过真实 original service/default writer；helper probe 或 spy 只可补充，不能代替该路径。测试/类型验证的实施授权属于后续 B，本 A 不执行。

target reader、selected-original 完整列读取、显式 71613 连接与 target 正常服务属于后续 #768。它只在固定、已接受 B 基线上重做 carry，单独固定候选/验收，不导入当前 R2 来完成 B。B 不动 capture、DDL、T04 transform、71613 receipt 或 predecessor custody。

### 6.1 可执行接受矩阵

每项都要保存命令、源码 SHA/tree、输入 hash、原请求/receipt、literal 预期、实际读回及清理映射。下列全部 UNRUN。schema0 行是 B 门槛；target 栏是 #768 后续门槛，不算 A/B 已覆盖。

| ID | 原 schema0 正常路径及独立 literal | #768 后续 target 与保全断言 |
| --- | --- | --- |
| A01 | 用原 lawful producer/统一导入生成完整四槽；独立 seed 保存原 NULL、空对象、非空对象，原 validator/getComparison/service 都真实执行。设置真实可见差异与待写决定，避免 fresh decision/零差异 early return 跳过 writer。先保存旧失败请求和四关系 first FAIL，再跑修正候选默认 preflight/commit/receipt | 从相同固定源实际迁移到受支持 capture71613；沿原服务及 default target writer 成功，不用手写 DTO |
| A02 | 独立 literal 固定 raw SQL storageClass/hex、原 key、每源列。NULL/空对象 reference 与普通对象 legacy 编码分别核完整请求 own fields、顺序和 values，原 comparator 对显式原 NULL/空对象的对照保持 | sealed raw/source/snapshot、aliases、query metadata、sourceRelationKey 与 source cells 完全一致 |
| A03 | relation_key 不同于 raw.id、raw 无 id、无 key、同 query 非连续原 sequence：保留旧合法集合与身份冲突，不重新 index+1；缺/增/重复 sequence 独立拒绝 | public alias 与 physical ID 反序；按 observation.collectionId/sequenceNo，不按 version/raw.id 取成员 |
| A04 | 非 NULL name/uscc/alias/sourceText，与 raw 不同；declareKind 中文字典/未知值、year 原类型、stored/source 一方空或双方冲突逐项 literal；原 classification 和 source conflict 不变 | revision1、原 sourceText archive、全部 observation facts 同 snapshot；revision2/current version 干扰不改旧原值 |
| A05 | native status TEXT/NULL/BLOB00FF/空BLOB、BLOB UTF-8 与 parsed NULL/非空 TEXT，配原 NULL/空 raw fallback；实际旧 validator、service、writer，独立核 bytes/冲突/分类 | 已 indexed 和 paired not_indexed 各走真实 reference/ordinary 路径；保留 §5 NOTREADY 边界，不能伪装 Buffer transport |
| A06 | 历史 raw JSON primitive/array、TEXT null、nested typed 值、own __proto__/constructor、对象 key order：保留原 JS projection/异常。新 primitive/array/Buffer 输入仍按原边界拒绝 | 不能因 source decoder 允许历史值扩大 fresh schema；缺 archive、坏 bytes/hash、wrong owner 原样错误 |
| A07 | 原 ordinary-object 成功请求，候选输出逐字节等于旧 builder；真实 preflight/commit 后同 key 再提交回原 batch/receipt，不增加业务行；另有合法空对象旧成功时同样保留 | indexed 内容和缺版本 projection 的原普通补齐行为独立核，不把全部命令换 reference |
| A08 | 旧 failed batch 同 key 修正后真正 commit 成功；原 failed request/receipt 不变，新 attempt 独立；processing/committed 改请求仍409；不同 source binding仍拒绝 | 同一真实 ledger 在完成迁移后核对 committed readback、failed recovery、原 receipt hash/bytes |
| A09 | 四槽 fresh，用会抛错的 fetchImpl、无凭据/cookie getter 计数，实际 network=0/reused=4；最新失败遮挡、stale、cutoff、public alias 排序及 no_record 空集合均与旧 service/literal 相同 | admission 先 capture/source facts 后 originals；SQL trace 无旧表、无 display/history/version-first、无 validator 准入 fallback |
| A10 | 缺槽用本地 replay fetch，仅按原网络/重试/取消政策补缺；fresh 三 business title 映射、apply NULL、原 #769 NULL/custom saved title 保留，C1 aliases=0 | 新采集原请求/实际旧写物化/capture 保持；不把 reference 模式用于 fresh，新坐标无原件仍拒绝 |
| A11 | 在默认 commit 的业务写入/最终 receipt 前注入失败，独立 before/after 验零半提交，再同源同 key retry；新 attempt可追加，旧失败不可覆盖 | 沿既有事务/savepoint，原 capture、alias、索引/版本补齐、决定和 receipt 原子；真实 retry成功，非假 writer 成功 |
| A12 | 双向核原 query/relation cells、PK、原 bytes/raw/hash、queriedAt、alias、决定/对应/113/114历史、所有原 receipts；普通 bootstrap 与 reference no-bootstrap分别记 | 固定原迁移绑定、完成 replay 与后继合法新写保全单独运行；不要求当前全库等于历史 manifest，不覆盖新写 |

接受报告将 old service、candidate service、独立 literal、default preflight、commit、durable receipt 分列。B 类型检查只报告实际命令/诊断，不用 inherited PASS 覆盖新 FAIL/UNRUN。target 全链、HTTP/MCP、worker、全局 guards、完整 #768/#763/#706 和生产保持各自独立门槛。

## 7. 要求覆盖与交付声明

| 冻结 #770 要求 | 本文责任与静态依据 |
| --- | --- |
| 1 全链全部原断言 owner | §3、§3.1，schema0 与 R2 Git owner 矩阵 |
| 2 comparison/original/outgoing、NULL/空/omitted/unavailable | §2、§4.1，显式 union 与错误边界 |
| 3 比较方案、精确表示和合法 request | §4、§4.2、§4.3，选择 constrained reference + legacy 兼容编码 |
| 4 source capture、snapshot、原行为/guards | §3.2、§5、A09/A12；writer 既有验证和 runtime admission 分责 |
| 5 native BLOB/key/源列/同版本/冲突/新输入拒绝 | §3.1、§4.3、§5、A03–A06，原 source verifier及 literal |
| 6 old success/committed/failed ledger | §5、A07/A08；receipt canonical requestHash 与旧请求 bytes 分开 |
| 7 ≤M B 与 target carry/独立接受 | §6、A01–A12；A 未授权 B，target 归 #768 |

本候选仅三份 Markdown。产品、tests、source、schema、DDL、fixtures、DB、runtime、types 不变。没有新业务状态、tombstone、hash/serializer、capture/T04/71613绑定、qualification、网络、guard、idempotency 政策。完整退役、status、fingerprint、provenance ADR 的原不变量及独立生命周期继续有效。

逐文档静态评价、所有读过 owner 的 Git blob/SHA256、冻结/live正文比对、相对链接、覆盖与 docs-only diff 检查、sole parent、最终 SHA/tree/clean 位于仓外证据。只清理本轮自有临时材料；parent probe、source archives、作者 worktree 和所有历史证据保持原件。本候选没有启动子代理、review loop、tracker mutation、push、PR、merge、primary/main 或生产操作。
