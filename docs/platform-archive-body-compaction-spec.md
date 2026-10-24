# 平台归档正文存储去重（#269）

## 目标与基线

用户已确认：完全相同的正文只存一份，重复副本真正移除；每次采集保留时间、来源与正文引用，确认仍属于原观察。方案见 [ADR](adr/2026-10-24-platform-archive-body-sharing.md)。本票不重判称号/迁入迁出，不改变年度算法、标准化规则或观察级证明。

实现前代码基线为 main `21b80c74c4f5b7e79b2a1e4b472f9e97c97c1f52`。只读完成备份 `d2390b4e8a29bccbec9814904cde82d84c1cd76cc6f0db4a8964646cd3cb6aac`（1,812,062,208 bytes）中：39,303 query、58,310 relation/observation、55,151 business、55,184 version。此为固定备份分布，不冒充实施时的生产现状。

| 基线字段 | 总字节 | 主要实测 |
| --- | ---: | --- |
| relation.raw_fields | 265,951,153 | 57,982行共265,947,252 bytes与既有version逐字节相同；317 NULL |
| version.canonical_raw_json | 250,756,629 | 可共享给原行，不继续两处保存完整正文 |
| query.raw_response | 902,336,692 | 整封套exact多余3,826,044 bytes；嵌套业务对象估计752,886,132 bytes，尚非exact可移除量 |
| query.collection_evidence | 13,036,877 | 整字段无exact重复；有无可共享嵌套片段须由实际编译器逐字节证明 |
| relation.source_text | 189,113 | 未知原文保留原bytes/观察含义；同bytes可物理共享，不补建业务版本 |

跨relation/version与字段内exact重复并集的盘点区间为271,526,763–271,530,664 bytes（含盘点中少量非本票审计桶，**不能作为本票净收益承诺**），未扣引用/索引开销。另11条关系的canonical相同而原bytes不同共3,901 bytes，原表示保留。实际收益以本票四类owner的压缩前后桶统计为准，不把估计嵌套字节直接相加。

## 内部边界

1. 不可变正文叶：摘要、长度、格式/规则版本与原bytes；相同摘要必须完整比对，哈希碰撞/缺叶/错长度显式失败，不用 NULL 掩盖坏引用。
2. 正文根与有序片段：根记录完整逻辑bytes摘要/长度；片段限定引用正文叶，按逻辑偏移可seek。普通正文可为单片根；查询封套只在精确原始对象片段已存在时组合，保留所有字面间隔、未知字段、重复位置和顺序。无匹配/异常原文保留opaque；不声明所有语义相同的不同bytes均已去重。
3. 类型化owner引用：relation的raw/sourceText、version的canonical、query的response/evidence分别有FK；不暴露内部root/blob ID到旧DTO，不让新列进入旧hash。保留 inline 与 pooled 的混合读取期，SQL NULL 与空正文不混。
4. 唯一逻辑读取接缝：旧行字段列表、JSON投影、精确文本与范围读取。池化后旧业务谓词仍作用于逻辑原文；不能把小字段查询变成全库正文送入JS，也不能按物理指针长度绕过4/8MiB读取预算或64KiB proof预算。
5. 写入和恢复：正文去重、类型引用切换、清除内联值和回执同事务。版本旧NOT NULL列的处理、清除合法性和旧索引/触发器须由新增迁移明确约束。首版不做自动GC；事务内生成后未引用的临时叶不能遗留成新副本。

## 必须保真的接缝

- projection inputFingerprint：按旧 position、parsed rawFields、invalidRaw 运行原算法，未知/非法/文本null仍区分。
- version contentHash：原 `platform-row-json-v1` 不变；A→B→A不重建业务/版本/观察ID。
- correspondence sourceFingerprint、currentSource/querySourceFingerprint：旧对象字段集合/顺序及所有原值不变；不重签或自动重确认。
- reverse-reference validity：原JSON/SQL类型比较及64KiB门槛不变，压缩不能让原UNKNOWN变成有效proof。
- query title-scope/error触发器、metadata条件和evidence revision：清除内联collectionEvidence前须适配；表示变化不得制造业务revision/新更正事件。
- public rawResponse/collectionEvidence字节块和relation SQL json_object：分别以各自旧输出作oracle，不能把后者误当原raw_fields文本。保持错误/null/空值/范围/UTF-8边界及脱敏。
- 所有正文读取失败保持显式错误，不能出现原字段有值但页面又显示“未提供”。旧出处、别名、差异、审计及导出事实不改指。

## 五层交付与PR接缝

层级是依赖关系，每个实现PR只承载一个≤M接缝；兼容读取层按读域拆票，禁止一个PR混全仓reader。所有新schema/公共接口先由第一层固定，其他层不并行改共享schema或迁移。

1. **共享正文基础（M，高）**：正文叶/根/有序片段与类型引用附表、exact碰撞复核、范围读取、精确对象片段编译；先不接业务写入，不清内联。真实SQLite证明混合状态、缺引用/损坏、事务失败、UTF-8范围与共享片段；不得建任意词法配方系统。
2. **兼容读取（分成独立M PR）**：
   - 原档full/evidence HTTP/MCP与企业详情/旧对比的字段读取，保持旧DTO、bounded/offmain与分块契约。
   - 决定/proof的fingerprint、reverse-reference validity、候选及record comparison投影；不修改判定规则。
   - 查询metadata/title索引触发器、当前资格与evidence revision的逻辑字段接缝；不修改normalization/annual含义。
   每个消费者必须以真实pooled fixtures验证，不能只让仍inline的老测试继续绿。
3. **新写入复用（M，高）**：现有统一归档/recognized/write/replay/ensure通过同一正文层落库，原业务DTO不变，新采集默认即复用正文。各读取层验收齐备前不启用清空；新query/relations/version和完整正文在同一事务，不建第二份长期双写。
4. **统一历史压缩（M，高）**：沿用 `/api/roster/import/preflight`、`/commit`、receipt与MCP对应工具；新增明确的platform_archive压缩payload，不借用“只投影观察”的旧payload偷偷清正文。客户端只给类型化owner IDs，项数与逻辑字节双限制；预检冻结输入，原body提交，漂移/冲突原子拒绝，未知结果查同key回执。摘要单列处理/复用/内联移除/逻辑字节和剩余，不混旧written计数。恢复到inline同样可校验原文、幂等，不接受任意外部root。
5. **数据收口（运维，不承载混杂源码）**：固定最终SHA、真实备份clone/API压缩/逐owner exact bytes和旧业务指纹/读回对照；新写/重放/并发及中断恢复；真实HTTP/MCP、桌面390px。生产新一致备份、native writer独占、迁移演练、固定镜像部署后API分批清冗余。SQLite页整理另在同namespace独占维护窗口执行并验证文件缩小；任何业务数据内容变化仍只经API。回滚先证明支持引用或经受控还原，禁止恢复旧DB丢提交。

## 完成和范围报告

每个归档桶报告：旧内联逻辑字节、池唯一叶字节、片段/引用/索引开销、共享覆盖、原bytes不同或无匹配的剩余、空闲页、整理前后DB文件与WAL/备份大小。query中估计的对象只有exact span验证后才计为去重收益；无法匹配的HTML/JSON表示保持原文，不能删字段、丢未知键来增加节省量。

只有临时资源清理、增加正文池或在隔离副本移除字段，均不算本票完成。完成需生产受控API压缩后的完整来源/指纹/旧引用/独立决定验证，以及新写入不再重复保存相同正文。不得用单测或截图替代真实HTTP/MCP及浏览器操作。原失败、继承、UNRUN和实际空间回收单列，不以逻辑节省承诺OS回收。

