# 正式出处行原值存储接缝（#349 / #302 A）

本层只提供 `server/utils/official-evidence.ts` 的领域存取。唯一新表为
`official_evidence_row_revision`；0030 只建空表、约束及三个索引，journal 仅追加。
无 sidecar 的旧出处仍未知，不从 record 首名、企业现名、当前文件元数据补造原值。
没有接入旧 writer、HTTP/MCP、资格、页面、导出或文件替换协议。

## 版本与输入

`OfficialEvidenceCapture` 的所有字段都必须显式提供；nullable 字段用 null 表达未知，
空字符串是确切原文。原名、统代、属地不 trim、不标准化、不补齐，不跨修订继承。
字符串最多 4000 个 JS UTF16 code units，允许空白、NUL、组合字符和合法代理对；
孤立代理码元会被 SQLite 的字符串编码替换，故新输入明确拒绝，不静默改原文。
数字只接受 JS safe integer，不接受数字字符串/小数/布尔值；ID/序号/页码为正，bytes 可为 0。

表与返回行的 `formatVersion=1` 表示本层 shape；每 evidence 的 `revision` 从 1 单调递增，
唯一键为 `(evidenceId,revision)`，不以时间排序。actor 为 `{type:user|agent,id}`，basis 为原文；
命令必须二选一：`{kind:import,batchId}` 或 `{kind:evidence_correction,batchKey}`。
两个命令引用分别 FK 到既有 import batch / correction batch，不把导入 ID 塞入更正 FK。
sourceDocumentId / storedFileId 可空，提供时 FK 必须存在；文件身份的 path/sha256/bytes
是本次捕获的值，不在读取时跟随文件现值变化，也不据当前文件推造历史。

`sourceBindingKnown` 只有一个行级标记。true 要求 sourceDocumentId、SHA256、bytes、
非空 sectionKey、listNo 都明确；attachment=null 在这个已核标记下表示明确无附件，
attachment="" 是另一个确切值；false 的任何 null/现存坐标均不足以组成可匹配的 K。
原值仍可为 null，已核位置不证明原值已核。storedFileId 与 path 不承担发布声明身份。

## B/C 可消费的函数与 DTO

- `appendOfficialEvidenceRevision(executor,capture,expectedRevision)`：expectedRevision=0 表示首次捕获。
  一个 INSERT…SELECT 同时核对 evidence→event→当前 record/enterprise，并 CAS 全修订最大 revision。
  只返回 formatVersion/evidenceId/eventId/revision。捕获 owner 必须是在写入时已核的当前归属；
  它们是历史整数值而非 live FK，之后合法 merge 可以移动事件、删除原 record/enterprise。
  读取不要求捕获 owner 仍存在。新捕获引用不符为 409 reference_mismatch，过时修订为
  409 revision_conflict；FK 原因保存在错误 cause。调用者不得直接写表或改历史行。
- `readLatestOfficialEvidence(executor,evidenceId,{maxBytes?})`：先从该 evidence **全部修订**
  按 revision DESC 取 1，再投影；无 sidecar 为 row=null。不等于已证明“没有正式事实”。
- `readOfficialEvidenceCandidates(executor,OfficialEvidenceSourceKey,{maxBytes?})`：K 严格只含
  sourceDocumentId、sha256、bytes、attachment、sectionKey、listNo。跨 event 查真正 latest，
  更高修订反查不带 K/binding/owner 条件。旧位置移走或最新绑定 unknown 后，旧声称不能复活。
  SQL 取 101，超过 100 为 413 source_limit。候选只返回 evidence/event/revision、捕获 owner、
  raw 三字段及 currentOwner；不作主体冲突/相容、独立发布、重复关联或资格裁定。
- `readOfficialEvidenceHistory(executor,evidenceId,{beforeRevision?,pageSize?,maxBytes?})`：
  默认 20、最多 50，revision 倒序；nextBeforeRevision 为本页最后 revision，下一页使用严格小于。
- `listEventOfficialEvidence(executor,eventId,{afterEvidenceId?,pageSize?,maxBytes?})`：
  仅列该事件已有 sidecar 的真正 latest，默认 20、最多 50，evidenceId 升序；
  nextAfterEvidenceId 为本页最后 ID。先独立查事件旧出处最多 301 条，超过 300 为 source_limit，
  不因游标跳过大量旧出处绕过总限。旧无 sidecar 不伪装已捕获，C 须另外表达其 unknown。

`OfficialEvidenceExecutor` 同时接受本域数据库及 Drizzle transaction。单次 append 的 CAS
是单语句原子的；整批原子性、源文件重核、跨 K 最终集合、合法 merge 映射、event revision/
审计113、幂等回执、同批同 evidence 至多一操作由 B 在一个 IMMEDIATE 事务中协调。
本层不做幂等 no-op，不提前改旧 event/evidence/审计/回执，也不替 B 做最终业务判断。
若 B 同批将归并，须安排新捕获时的归属校验与 merge 顺序；不可用历史捕获 ID 当当前 owner。

当前 owner 从 event→record→enterprise 用 LEFT JOIN 单独读取，缺任一环节返回 null；
不能丢候选或以捕获 owner 猜补。`OfficialEvidenceCandidate` 与 `OfficialEvidenceRow`
均分开命名捕获值与 currentOwner。B 应按合法 merge 最终映射解释 currentOwner。
无 sidecar 或定位未核的历史不能由候选空数组证明“无冲突”；B 仍须保留缺口/ambiguity。
同 SHA 不证明独立发布；不同 sourceDocumentId 的真实性由明确来源依据和 B 写命令负责。

## 预算与错误

新增完整单行（含 latest 封套）写入最大 65536 UTF8 字节，保留未来 currentOwner 的最大 ID 宽度。
超限为 400 input_limit，整行拒绝，不截原文。每个读投影含封套默认 16384、最高 65536 字节，
历史/event 页另取一条作游标探针，但探针的大字段不投影。SQL 内构造限定 shape、逐字段长度及
精确 JSON 字节数，超限只向 JS 返回小状态/长度，projection=NULL。预算拒绝为 413 response_limit；
历史大字段留库，字段超限为 413 field_limit。可以减小页或显式提高预算，不返回部分事实。
SQL 的 Unicode scalar 长度与最多 16000 字节字段闸门先限制值；通过完整响应字节闸门后，
JS 对已有限的小投影再核精确 UTF16 长度，覆盖 supplementary/NUL 与 SQLite length(TEXT) 差异。

非法类型、未知参数、缺失必填值或不完整 K 为 400 invalid_input；新字段超长为 400 field_limit。
OfficialEvidenceError 的 statusCode/code 是 B/C 的错误接缝，底层其他错误继续抛出并由调用者回滚。
候选 101 与事件 301 的 source_limit 优先于响应字节限制，不把截断当无冲突。
旧公开字段/响应预算不受本层追改；所有新增 projection 都是未脱敏的领域事实，C 负责原有鉴权与脱敏。

索引支持单 evidence latest、源行 K 和 event 检索；SQL LIMIT 不代表恒定磁盘或 JSON 运算成本。
真实业务分布、性能、历史覆盖率和来源独立性仍 UNKNOWN。A 的 SQLite 验收不代表 HTTP/MCP
或母票 #302/#296 完成；#350/#351、#303、#311 仍各按其 owner 推进。

## 独立验收

`pnpm exec vitest run tests/official-evidence.test.ts --maxWorkers=1`
使用 `/tmp/issue349-*` 独有合成 SQLite，直接调用上述领域接缝；无公开 API 故不声称 HTTP 验收。
测试关闭全部句柄，保留合成库供失败复查，不读取 checkout 活动 DB/WAL、真实源或凭据。
升级从 journal idx28（0029 前）及 idx29 分别实跑，比较旧业务数据、DDL/索引/trigger 和 ledger 前缀，
确认新表为空、迁移可重入及 foreign_key_check/integrity_check。
Nuxt/worker/transport/typecheck/build/full/UI 未运行；本层没有 UI consumer 变化，桌面/390px 为 NA。
#345/#346 原完整套件 FAIL/UNKNOWN 继承保留，窄测试通过不覆盖它们。原 R2 两轴 P1/P2 只在 R3
设计层闭合的历史也保留，不把本票测试当双轴实现审查回执。
