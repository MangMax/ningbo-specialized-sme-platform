# 正式事实精确读回（#351 C，父 #302）

C 消费已合 A/B，不新增存储或写入裁定。以下三个既有入口提供显式 opt-in；
HTTP 与 MCP 使用同一领域读取、校验、脱敏和预算。原不带 opt-in 的字段与匿名读取保持。

| HTTP GET | MCP | 新请求字段 |
| --- | --- | --- |
| `/api/roster/evidence/:id` | `get_roster_evidence` 的 `id` | `official=latest` 或 `official=history`；history 才可用 `beforeRevision/pageSize`；`maxBytes` |
| `/api/roster/events/:id` | `get_official_event` 的 `eventId` | `official=latest`；`afterEvidenceId/pageSize/maxBytes` |
| `/api/roster/import/receipts/items` | `list_roster_import_items` | `projection=snapshot` 或 `projection=eventIds`，完整 selector；eventIds 可用 `cursor/pageSize`，两者可用 `maxBytes` |

新增 official 和 snapshot/eventIds 投影分别需要原 REST API token 或 MCP token。
旧精确读仍可匿名；items 原先就是受保护读取，未授权仍不展示工具。
两个旧精确工具继续公开发现可选字段，middleware 在任何敏感查询前校验本次 MCP token。
未知字段、重复 HTTP 参数、错组合、非安全整数和越界游标拒绝；不依赖 SDK 丢弃额外字段。
不新增 route/tool 名，不改变全局鉴权/日志机制，原三工具名的登记继续适用。

## 逐出处事实

原响应只增 `official`，其新封套包含 `formatVersion=1`、`source=official_evidence`、
`responseRedacted=true`、`uncaptured=unknown_legacy`、`availability`，以及 A 的 row/rows/游标。
latest 的 `row=null,availability=unknown_legacy` 明确表示无捕获事实，不证明原件无该列。
history 首次空页同样 unknown；带 beforeRevision 的空页是 empty_page。
event 是 captured_rows：只列有 sidecar 的出处；原 evidence 仍列全部旧出处，未列入新事实的
出处是 unknown_legacy，不把它们消失或填成企业现名。分页不会嵌套全部修订。

行保留每次捕获的 `nameRaw/usccRaw/districtRaw`、sourceDocumentId、storedFileId、path、
sha256、bytes、attachment、sectionKey、listNo、page、sourceBindingKnown、actor、basis、
command、createdAt 和 revision。capturedRecordId/capturedEnterpriseId 是历史 origin；
currentOwner 单独来自当前 event→record→enterprise，缺链为 null，不能用捕获 ID 猜填。
不跟随当前文件更新 hash/path，不把 record 首值或现名反填历史。

只调用 A 的 readLatestOfficialEvidence/readOfficialEvidenceHistory/listEventOfficialEvidence。
history 默认20最多50，revision 倒序、严格小于 beforeRevision；event 默认20最多50，
evidenceId 升序、严格大于 afterEvidenceId。事件总scope超过300以301探针拒绝，游标不豁免。
单行 latest 与历史页的原值均独立，不跨内容 typed correction 继承原文。

## 旧容器快照 selector

必须明确二选一：

```text
projection=snapshot&source=private_batch&batchId=123&itemIndex=2&oldRecordId=9
projection=eventIds&source=redacted_receipt&receiptId=456&itemIndex=2&oldRecordId=9
```

不可同时给 batchId/receiptId，不接 idempotencyKey，不默认最新 receipt，不由 receipt 回退 batch。
快照只来自原 batch 私有 item_results 中成功 committed merge 的
`detail.lineage.recordsFolded[].fromRecordSnapshot`；历史 receipt 分支只读指定 receipt 留存值。
B 新 receipt 已公开投影，通常不含这些字段，故明确 not_retained，不补造原文。

SQL 先用 source 主键限定、验证源/关联 batch 均 committed、成功 merge 项及合法历史 from/into ID，
按 oldRecordId 在 SQL 取至多两条 fold，重复即 ambiguity。snapshot.id 必须等于 oldRecordId 和
fold.fromRecordId；snapshot.enterpriseId 必须等于 lineage.fromEnterpriseId。into IDs 必须正安全整数。
不要求历史 record/enterprise 仍 live，不按现 owner 变化否定历史。只返回固定八字段
`id/enterpriseId/titleCode/source/nameRaw/usccRaw/district/qualityFlags`，另有 origin 中的原 from/into 引用。
item/fold/selected_json/完整 item_results 都不进入 JS，不调用 readMergeLineage/findBatchByKey。

source/storedRedacted/responseRedacted/availability 总是明确：private_batch=false/true，
redacted_receipt=true/true。storage 未脱敏不代表公开绕过脱敏，容器快照也不等于逐出处公布事实。
source 不存在为404 missing；历史缺 snapshot 或 eventIds 为200 availability=not_retained；
错误项/非merge/类型或归属矛盾/没有该fold为409 selector_mismatch；重复fold为409 ambiguity。
既有无 projection 列表继续原 not_found/分页/最新 receipt 语义。

eventIds 单独分页，默认20最多50；SQL 验证完整数组均为正安全整数，再按 array index 严格大于
游标 afterIndex、ORDER BY index、取 size+1 判下一页。snapshot 不嵌套大数组。cursor 是完整
source/sourceId/itemIndex/oldRecordId/afterIndex 的 base64url JSON 绑定，不是授权凭据；换任一选择器
拒绝，越界拒绝。缺数组不从 live events 重建，空数组返回空页，非法尾项也不能被小页掩盖。

## 长度、预算与错误

新字段最多4000 JS UTF16 code units，不 trim、不截原文。SQL 先检查类型、scalar长度和最多16000
字节字段闸门，完整新 JSON 封套默认16384、最高65536 UTF8字节，超限仅小状态/requiredBytes，
大值不进入 JS；通过 SQL 完整预算后再核精确 UTF16 长度。Zod 的字符上限不代替 JS .length。
SQL 固定数字投影 CAST INTEGER，避免 JSON 里的 0.0 与 JS 重序列化产生长度差。
逐出处读调用 A 时为 C 新封套预留最长 availability 的固定开销，因此边界预算可能保守拒绝，
可缩页/提高 maxBytes；不通过重试水合大值来试探预算。snapshot 的 SQL 预算含全部新封套。

之后复用 importReceiptRedactor，遮盖已配置凭据、敏感键/编码/Bearer 值；最终 JSON 字节再核，
脱敏变长仍拒绝。event 旧字段照原流程脱敏，再附已独立校验的新投影，不二次处理新投影。field_limit/response_limit/source_limit 是413，不剪旧 response 冒充符合新预算。
已知错误只回静态消息/码和必要字节数，未知数据库错误不向新读口公开 SQL/原文/凭据。
原私有 batch、receipt、初次 commit/同key retry/outcome 纯投影规则不变。

LIMIT 与限定投影不代表 JSON 解析/磁盘成本恒定；生产分布、历史覆盖和真实发布依据仍 UNKNOWN。
#303 后续详情/导出只消费这里的读 seam，尚未接线；资格/UI/#311/#281/#282 不在本票。
无新增 UI 或 reader consumer 切换，桌面/390px 为 NA；不是浏览器验收通过。

专属测试：`tests/official-evidence-reads.test.ts` 使用生产 H3 routes、独有 `/tmp/issue351-*` SQLite，
基础 catalog 外的正常领域状态由 B 公开命令建立，损坏/极端旧数据反例明确标注。
真实 Nuxt/MCP JSON-RPC 专属验收必须父唯一 heavy slot；小 H3 不是实际 MCP transport。
历史 #345/#346 full FAIL/UNKNOWN 和 A/B 原失败/清理未知不因 C 窄绿消失，不宣称母票或部署验收。

## #399：旧 items 错误封套兼容

用户已批准恢复 `list_roster_import_items` 旧请求的 SDK 错误封套：HTTP 200、
`result.isError=true`。鉴权仍先行，缺失、错误或未配置 MCP token，以及误用 API token，
均为 HTTP 401、顶层 `error.code=-32001`、无 result。

兼容分流仅识别非 null、非数组的 arguments 对象，全部 own 键须属于
`batchId/receiptId/idempotencyKey/page/pageSize`。空对象和 partial 对象也分发，
但不因此成为合法 selector。旧字段的 null、错误类型及 page 0/1000001、pageSize 0/51/2.5
交给 SDK 原 raw shape 校验；middleware 只允许分发，不构造 tool error。
SDK shape 不含组合 refine，因此 handler 在 `useDb()` 前复用完整 `importItemsReadSchema`，
保留原三选一及 trim-empty key 判定，用原 `ImportReceiptError` 和 `importReceiptMcpResult`
产生领域错误。合法 key 不 trim、不改写；缺省 page 1/pageSize 20 仍由既有 reader 决定。

任一 `projection/source/itemIndex/oldRecordId/cursor/maxBytes` 或未知 own 键均走严格 raw gate；
`projection='legacy'`、`source='default'` 不是枚举值。新字段孤立、错配、null、非法边界或未知键
仍为 HTTP 400、顶层 `error.code=-32602`、无 result。缺 arguments、undefined/null/primitive/数组
容器不扩为 `{}`。own 新键为 undefined 也不走旧分流，但原 optional schema 可能接受合法其余
shape；未知键即 undefined 仍拒绝。undefined 仅是 JS helper 边界，不是 JSON wire 值。
handler 只移除已知 optional 字段的 undefined，保留未知键以供严格校验。

零 DB 保证限于 schema/selector/空白 key 拒绝前不获取 DB、不调用 reader。
cursor 解码、已绑定 cursor 越界、source 不存在或状态不符仍由后续领域 reader 处理，
不能把全部领域错误或原 27 请求矩阵宣称为零 DB。其它工具、REST 和旧匿名 exact/root-extra
读取兼容保持原路径。

本次 small 用新增 `399 ` 用例，冻结测试字节后取得 RED 82 FAIL/75 PASS → GREEN 157 PASS/0 FAIL；
原 62 用例被过滤。raw helper 的 null 只证明分发；真实 handler 使用 useDb/reader spy 和原错误封套，
正常 content 的 spy 结果不代替真实 reader 默认值或 wire 验收。SDK schema adapter 用实际安装包，
仅证明字段校验。新增 Nuxt dev+fetch transport 用例、本 head type/build、compiled raw+SDK 及
原 receipt 27 分区/full 均 UNRUN，交父另授。原 R10 HTTP400/id103/-32602/noresult、100B、
SHA256 `0fcec0993e58fa570fd813f921484d6061eda69ca3774090d67bee8b4aea38f2` 保留为历史观察；
原 full 5058 PASS/34 FAIL/19 SKIP、exit 1 及其它 FAIL/UNKNOWN 不改标。
