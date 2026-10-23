# #222：两列来源 JSON 的精确规范化可行性

**结论：局部 `json_tree` 重排 + 分块字符串编码可以精确处理原六类反例，但本轮方案仍不满足完整兼容。停止接入运行时。** 两个额外小数发生 SQLite/V8 舍入差异，1001/2000 层 JSON 被 SQLite 拒绝。没有证明所有历史来源都已经规范化，因此不能仅转发规范化来源。F1、#214 和 #210 保持未验收。

这是 [#222](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/222) 的一次合成研究，承接 [#220 / PR #221](https://github.com/MangMax/ningbo-specialized-sme-platform/pull/221)。只新增本目录报告、合成复现助手及内存测量助手。没有通用解析器、新 driver、算法磁盘溢写、存储迁移、运行时代码、生产访问或业务数据。

## 固定对象和约束

- 研究 checkout：`t3/issue222-json-canonicalization-feasibility`，起点 `70233c3389bfbc349d0f1f7602caf34f9d10e5db`，tree `1017c1de16c812e403ea05b855265c803e7b8815`，包含 #213 proof 修复。
- 前轮文档固定 head `50d775c96bf7a6551eee57f00a2254d2f5457988`，通过 `git show` 读取；没有合并。交付过程中远端 integration 前进到 `48f839271f84e9bd6cffa3b5e6efff2b43497f6d`，仅合入 #221 的五个文档/研究文件；运行时树与研究起点相同。当前 checkout 未合并它。
- 已读新 issue、AGENTS、原 spec/tickets，以及 `/tmp/spec210-handoff/{220,214-bounded-design,214-fixes}.md`。原 #214 测试/配置/失败日志及前轮反例通过 SHA256 manifest 固定，未改写、未重跑为绿。
- 用户契约：**没有恒定总 RSS SLO 或预设预算**。SQLite 可以构造完整 native 值；大字符串、键、对象不能完整经过 JS/UDF/IPC；不新增来源大小排除，不改 SHA 输入或指纹版本。
- 一轮探索开始约 `2026-10-23 05:01 UTC`；初轮实验 `05:06:45–05:07:00`，最终候选复现 `05:08:50–05:09:08`，写入者验证 `05:11:52 UTC`。均属于同一轮，远少于60分钟；随后仅整理和交付。
- Node `24.22.1` / better-sqlite3 `13.0.3` / SQLite `3.53.4` / Drizzle `0.45.4` / Vitest `4.1.11` / macOS arm64。

## 先查实际写入者：局部不变量成立，历史不变量未证

固定起点的应用运行时代码中，两列的新增写入都在 [`roster-import.ts:2754–2818`](https://github.com/MangMax/ningbo-specialized-sme-platform/blob/70233c3389bfbc349d0f1f7602caf34f9d10e5db/server/utils/roster-import.ts#L2754)。`collectionEvidence` 和 `rawFields` 以 JS 值传给 Drizzle，没有 SQL 原样 TEXT 分支。运行时发现的另一处 relation UPDATE 只改 `enterpriseId`。查询载荷适配器构造对象后调用统一导入；实时查询自身不落这两列。

[`db/schema.ts:652,724`](https://github.com/MangMax/ningbo-specialized-sme-platform/blob/70233c3389bfbc349d0f1f7602caf34f9d10e5db/db/schema.ts#L652) 均为 `text(...,{mode:'json'})`。本机实际 Drizzle 实现的 `mapToDriverValue` 是 `JSON.stringify`，读回是 `JSON.parse`。普通 JSON 请求的当前写入链因此会消除重复键、完成 Number 转换、按 JS 属性顺序输出，并规范化 Unicode 转义。这是当前应用写入路径的保证，不是每份历史 TEXT 的证明。JSON.rawJSON、任意 toJSON 等进程内非普通 JSON 对象不在这项保证内。

`writer-probe.test.ts` 的 `current importer canonicalizes JSON and records its existing deep-source commit refusal` 调用**起点真实导入 preflight/commit**，只创建私有合成库：

- 原六反例先经 JSON.parse 成请求值后提交，六份实际 `raw_fields` 都精确等于独立输入的 JSON.stringify，并是 parse/stringify 固定点。
- 一份有效 recognized-list 证据经真实 `recognizedResultToImport` 和导入领域写入，`collection_evidence` 707 bytes，精确等于原输入的 JSON.stringify；含数字键、中文/emoji、NUL 和孤立代理项。
- 1001 层数组位于 rawFields 对象内：**预检 conflicts=0，提交 failed，整批回滚，query 未落盘**。失败发生于导入末尾 `captureQueryRevision113`：[`evidence-impact-113.ts:145–148`](https://github.com/MangMax/ningbo-specialized-sme-platform/blob/70233c3389bfbc349d0f1f7602caf34f9d10e5db/server/utils/evidence-impact-113.ts#L145) 对 raw_fields 调 `json_extract`。本轮最初错误地预期它会提交成功，原 RED 日志/库完整保留；后续诊断准确记录拒绝，不把它当作通过大来源验收。**不能声称当前导入器接受该深度，也不能据此批准新的深度排除。**

历史不变量仍未成立：两列是普通 nullable TEXT，迁移没有“等于 JS 规范化字节”的 CHECK/版本标记；#83 的 collection title-scope trigger 提取 JSON 元数据，没有建立这种字节保证。仓内演示脚本也用 JSON.stringify，但不是所有历史来源的证明；`db/client.ts` 的注释仍提及仓外 pipeline，本轮未认证那个写入来源。没有检查真实库或把合成 SQL 注入反例说成真实历史数据。直接原文拼接只有在历史范围得到正式证明后才成立，不能变成 canonical-only 准入线；本票不进行历史迁移或另开无界调查。

## 最小实验：关系重排与标量分块

`probe.mjs` 分三个车道：合成 seed/oracle 子进程完整建立输入并直接执行 `JSON.stringify(JSON.parse(text))`；候选子进程只读合成库，用 TEMP MEMORY 表构造结果；协调进程以64KiB文件块比较 oracle/candidate 的**全部字节**，同时检查长度和独立 SHA256。SQL NULL 单独映射为 JSON null，与 ORM 的 null 来源结果一致。候选不读 oracle/source 文件；生成的 `.bin` 仅为证据，不参与排序、解析或构造，不是算法溢写。

候选的局部步骤：

1. 在 SQLite 内 `json_tree`，仅把 `id/parent/type` 小元数据分行送 JS。`key` 和字符串 `atom` 留 native BLOB，保留 NUL 和 JSON1 的代理项字节；不使用可能有重复键歧义/巨键开销的 fullkey 作身份。
2. 对 object，按 `(parent, decoded key BLOB)` 求首次/末次位置：保留末次值及其子树，排序使用首次位置。递归 reachability 排除被覆盖对象的全部后代。数组保持原序。
3. 数组索引键仅限与十进制往返一致的 `0..4294967294`；按数值升序，其余键按首次出现顺序。`4294967295`、`01`、`-0`、`1e0` 都不是数组索引键。不能简单 `ORDER BY key`，也不能在重复覆盖时把该属性移到末尾。这符合 [ECMAScript 属性顺序](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinaryownpropertykeys)及[重复键覆盖语义](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.parse)。
4. 每次仅将 native 标量/键的 **4096 bytes** 交给 JS UDF 编码，UTF-8跨块最多留3 bytes、UTF-16最多留一个高代理项。JSON1 的孤立代理项 atom 是 `ED A0 80` 一类 WTF-8/CESU-8 bytes；普通 Buffer UTF-8解码会替换为 U+FFFD，故助手逐码点解码并保留代理项，再对小块调用 JSON.stringify。这不是把整份巨大标量交给 JSON.stringify。转义输出每块最大24576 bytes。
5. 数字只将 SQLite 已转换的 Number 原语交给 `JSON.stringify(number)`，处理整数舍入、-0、指数拼写、Infinity→null；不传完整数字 token。该步骤正是后述小数失真的位置。
6. SQLite 原生拼接完整叶子和容器；最终只通过65536-byte BLOB切片计算 hash/导出证据。JS 不拼完整来源，IPC仅有统计。重复拼接会产生显著 native 分配与非线性时间，不声称它是生产可用的性能方案。

本构建的 `jsonEachNext` 递增 native JSONB 位置，`JEACH_ID` 返回该位置，故本轮可按 id 判断遇见顺序；**这不是公开长期保证**。[SQLite 文档](https://www.sqlite.org/json1.html#jeach)只保证 id 唯一，不能把此实现细节推广成跨版本稳定序。后续方案需要显式、受支持的 encounter ordinal，而非隐含依赖 id 数值。

## 差分结果：40 exact / 2 mismatch / 2 native error

最终 `verified-repro/results.json` 共44例；每例有来源/参考/候选 byteLength、SHA256及 byte-for-byte 比较结果。44例均独立生成，helper 成功退出表示**已保留预期失败**，不是兼容性通过。

- 原六类反例：6/6 exact，且原 #220 JSON1 失败证据未变。新原型的通过不把前轮24个完整 provenance 不兼容结果改成通过。
- 其余 exact：canonical、SQL NULL/JSON null、空对象/数组、嵌套数组、字符串/布尔/数字 primitive、重复对象子树及首次属性位置、escaped等价键、NUL键、`__proto__`/空键/引号键、代理项键/值、全部控制字符、U+2028/U+2029、UTF8及代理项跨块。
- 数值限制组 exact：2^53附近、signed64边界、最大有限双精度、subnormal、舍入边界、正负overflow→null、underflow/-0→0、1e-6/1e-7和1e20/1e21拼写。65536个小数位及65536位 exponent 的两个巨大数字token也 exact，但**不构成所有巨大数字舍入的证明**。
- 深度64/999/1000 exact；1001/2000在 JSON1 报 `malformed JSON`。独立 Node oracle 均可完成 parse/stringify。[SQLite明确1000层限制](https://www.sqlite.org/json1.html#compatibility)。这是 JSON 语义覆盖缺口；结合前述当前 importer 也拒绝深来源的事实，不能宣称它是已提交来源的新增回归。
- 单个大字符串、单个大键、6倍控制字符转义分别在64KiB/1MiB/4MiB测量，9/9全部字节及SHA exact。不是只做 json_each 每次一个可能巨大的 value。

两个新的**有效非规范化 JSON 存储**数值反例（不声称真实库存在）：

```text
input: {"n":6.2305092907852181816129614949256e-271}
Node:  {"n":6.230509290785219e-271}
SQL:   {"n":6.230509290785218e-271}
Node SHA256: 175e282d6576197e524e312a56640d0f59475e81228e161cf86b4eb3fb335b8c
SQL  SHA256: fb99bef7235e890f34f8dd6b1644fab5868a4abbf043aad00b6d513b89b966fd

input: 2.7092189618903812789494983e-44
Node:  2.7092189618903815e-44
SQL:   2.709218961890381e-44
Node SHA256: 25290b103870b51df2a6a9629e95e2a85986bb93fd9c530d2447f2dc5f0969f0
SQL  SHA256: d0b09e5dfadb1ed8dbe2bc7fd8bb1e00ac190dc3caaf93872163c7da779b9f62
```

SQLite已经把不同原始十进制token舍入为 SQL REAL，再交给 JS 改拼写不能恢复丢失的信息。对这两个例子，先用 JS 规范化再存储的字符串重读 SQLite 恰好一致；因此它们不推翻当前普通 writer 的局部固定点保证。两列完整历史保证未证，故不能跳过有效非规范化输入。

## 资源观测：完整 native 值明确允许，但成本不能隐藏

以下均来自最终候选复现，单组单次新进程，不是统计性能/SLO。按64KiB / 1MiB / 4MiB排列；MiB=2^20 bytes。无人工 GC。`resourceUsage.maxRSS` 为进程高水位，heap/external/cache为阶段采样；不是瞬时全量归因。

- 大 scalar：RSS **63.20 / 83.52 / 481.69 MiB**；SQLite pager cache **0.32 / 4.31 / 17.07 MiB**；约 **4.9 / 73.8 / 2294.9 ms**。
- 大 key：RSS **63.48 / 89.84 / 156.31 MiB**；pager cache **0.39 / 5.37 / 21.34 MiB**；约 **4.8 / 76.4 / 1910.2 ms**。
- 6倍转义：RSS **66.92 / 441.13 / 1852.44 MiB**；pager cache **0.98 / 14.94 / 59.61 MiB**；约 **6.1 / 333.2 / 9606.7 ms**。4MiB解码内容输出25165832 bytes，输入TEXT本身也接近24MiB；不把它误标成4MiB存储输入。
- 所有候选阶段 heapUsed最大 **9.12 MiB**；external最大约 **27.62 MiB**。垃圾等待回收和累计Buffer仍会增长；4096-byte UDF/65536-byte driver边界不等于总JS内存SLO。
- 大字段没有完整进入候选JS：最大UDF输入4096 bytes，输出24576 bytes；最大驱动内容65536 bytes，最大候选IPC统计1574 bytes。小于一块的小值可以整体经过该固定块，不设来源大小准入线。
- 合成协调main（不是Nuxt main）结束heapUsed **6.83 MiB**、external **3.85 MiB**，进程高水位 **59.08 MiB**。seed/oracle单独进程故意完整水合，不能混作候选资源证据。
- `sqlite-memory.c` 只通过已加载SQLite的extension API测量，不链接第二份SQLite、不处理来源、不建议作为运行时依赖。`DEFAULT_MEMSTATUS=0` 在该构建为true，导致 `SQLITE_STATUS_MEMORY_USED` current/peak均返回0；**全局allocator峰值是UNKNOWN，0不是零分配**。助手追加实际 `sqlite3_db_status` 的cache/schema/statement观测；schema约3KiB、statement峰阶段约100KiB，不包含所有临时表达式/JSON解析分配，不能与RSS相减推导总native使用。[SQLite统计定义](https://www.sqlite.org/c3ref/c_dbstatus_options.html)、[编译选项说明](https://www.sqlite.org/compile.html#default_memstatus)。

TEMP强制MEMORY，完整JSON1解析树、decoded scalar/key、排序分组、拼接值都可为O(N) native空间。重复UPDATE连接及按深度重建也有非线性成本。**高RSS不是用户未指定SLO的FAIL；字节不兼容本身足以停止接入。** 精确SQLite allocator峰、真实main/worker并发及生产GC均未证明，不为补统计重建driver。

## 最小下一步和停止边界

本票不再扩大实验，不实现通用tokenizer。**没有可以直接接入F1的完整、局部、已证兼容方案。** 这不等于数学上不可能；是当前候选在给定范围的明确失败。

1. **可以独立实施的最小业务切片仍为 #220 的A：领域内部完整audit INSERT SELECT + scalar写回执（M/high）。** 不改schema/API/指纹；#213 candidate改选先保存经校验的comparisonProofIds，再复制新确认evidence。证明字节、proof/actor、回滚、幂等。它减少审计往返，不关闭F1；不把当前仍需的授权来源水合藏起来。
2. **规范化需要具体架构升级（建议L、高难度，由父任务选择/拆票），不能伪装成常规M实现。** 缺口是：为两列保留每个数字的原始token/遇见顺序；使用与ECMAScript一致的十进制到binary64转换（含任意长token，不能把巨大token完整交给JS Number/UDF）；为深输入提供不依赖JSON1深度上限的token/container前端；保持native decoded-key身份和首次/末次成员索引；最终继续native完整拼接和小块hash。现有chunk字符串encoder可作为实验参考，但未证明任意Unicode输入，更不是完整parser。
3. 使用 `fullkey` 回取原文不能直接补缺口：重复键路径不区分出现次数，`json_tree.atom/value`已丢掉REAL原token；巨键路径也必须留native。依赖内部JSONB偏移或自己识别原JSON token需要新的兼容解析职责，须重新定级。单纯把SQLite REAL送JS格式化、提高拒绝阈值、只支持canonical或重算新版本SHA都不满足本票。
4. 如果父任务另行证明**全部历史和未来**输入都是JS规范化固定点，可选择native原文嵌入并省略重解析；这需要真实来源/历史写入者证据及持久保证。本票既没有该证明，也不授权为获得它而迁移/重写历史；不能先发布canonical-only分支再补fallback。

在以上选择前，不实施 #220 的C/D（权威source快照/任务事务），不移除 #214 门槛。后续仍需完整provenance与source SHA oracle、proof/plan绑定、同事务audit/hash、丢ack/checkpoint和大来源manual/readback旅程。此处只测两列值，**没有重新跑完整40例领域provenance、source/plan SHA，也没有让前轮24个失败通过**。

## 复现、失败保留及未验证项

项目依赖正常准备后，在本checkout运行；输出必须是不存在的新目录：

```sh
SPIKE_REPO="$PWD" node docs/spikes/222/probe.mjs /tmp/spec210-222-new
node docs/spikes/222/writer-run.mjs /tmp/spec210-222-writers-new
```

第一条使用macOS clang编译**测量专用**小扩展；不安装包或改driver。第二条复用项目Vitest配置/测试shim，外部最小tsconfig避免要求Nuxt生成目录。两条均不启动应用服务或访问外网/生产。实验实际借用已存在的依赖目录；临时node_modules链接在提交前移除，依赖checkout未修改。

私有完整证据 `/tmp/spec210-handoff/222-evidence`：`round1`为初轮；`verified-repro`为最终helper的44例；`writer-observed`为真实writer的1个聚焦test/8个fixture。最终命令均exit0，44例结果为40exact/2mismatch/2error，writer1/1pass（七个canonical写入、一个既有深输入失败）。`inherited-before.sha256`在结束再次全部OK。

保留两次研究助手错误：`final-repro`试图在better-sqlite3活跃`.iterate()`期间更新同连接，被明确拒绝 `This database connection is busy executing a query`，原日志不变；最终改为每次完成的metadata keyset `.get()`。`writer`最初预期深源能提交，实际失败；`writer-observed`按真实状态诊断，未改运行时、未弱化原F1断言。初轮global allocator全部0的观测也保留，并明确标记为统计关闭，不当作有效零内存结果。

未运行/UNKNOWN：全量测试、build/typecheck、CI、浏览器/390px、REST/MCP端到端、生产/隔离生产副本、完整权威source/domain/job接入、全部边/proof授权、任意输入证明、精确native总峰、crash/lostack/磁盘满。没有委派、自评审轮次、GitHub评论、合并或CI轮询。draft研究PR不授权任何运行时实施或关闭#214。
