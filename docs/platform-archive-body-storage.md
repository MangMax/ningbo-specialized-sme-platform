# 平台共享正文基础接缝（#278）

基于 #276 的 [设计](platform-archive-body-compaction-spec.md) 与 [ADR](adr/2026-10-24-platform-archive-body-sharing.md)。本层仅追加基础能力；旧业务读写未调用本模块，旧字段、NOT NULL、触发器与 API 均不变。下列函数是后续消费层使用的公共内部接口，不是 HTTP/MCP 能力。

## 数据与事务

`0029_platform_archive_body.sql` 新增六表：不可变 `platform_body_leaf`、`platform_body_root`、`platform_body_part`，以及 relation/query/version 三类引用附表。原表不增加私有字段。摘要固定 SHA-256，编码规则固定 `utf8-v1`；digest 命中同时比较完整字节和长度，碰撞拒绝，不以 JSON 语义合并。NULL 不建根；空字符串有一个空叶与已封存根。

叶 bytes 明确为 BLOB，内容是严格 UTF-8 文本。根记录完整逻辑字节长度和摘要。每片是一个完整叶，不引用根，也不含任意 JSON 词法指令。片段以 `(root_id, logical_start)` 唯一且索引有序，必须从零连续追加。根先构建、后 seal，seal 后根/叶/片段均禁止修改、删除或追加。引用附表以 `(owner_id, field)` 唯一，并以 FK 区分三类 owner；只能引用 sealed 根。没有 GC。

存储层硬上限为 **64 片/根**，由 SQLite trigger 与 `MAX_PLATFORM_BODY_PARTS` 双重执行，超限原子拒绝。这只是基础层安全上限，不是未来 compiler 的策略；compiler 应另行固定更低上限并验证净收益。本层不扫描 JSON、不访问真实库，也不将 canonical 估算当 exact 收益。

模块只接收调用者已有的 SQLite handle，不调用 `useDb` 或自行打开数据库；要求 foreign_keys=ON 且数据库 encoding=UTF-8。`intern`/`internParts` 使用事务，嵌套调用成为 savepoint。未来 writer 必须在**同一个外层事务**内完成 intern、setReference、内联处理与回执；任何失败须逃逸外层事务，使已新增叶/根/片段与引用一起回滚。独立成功调用 intern 可有未绑定根，首版不会自动清理它。

## 存储深模块

`createPlatformBodyStore(sqlite)` 位于 `lib/platform/body-store.ts`：

| 函数 | 契约 |
| --- | --- |
| `intern(text: string \| null)` | 原 UTF-8 bytes exact 复用，返回 opaque `PlatformBodyRoot` 或 null；不解析或重序列化 JSON |
| `internParts(texts: readonly string[])` | 1–64 个显式叶文本按序组成根；重复文本叶共享；空片归并，整文为空时保留单空叶；整文相同而分片不同仍复用旧根 |
| `readText(source)` | source 可为 opaque 根、类型化 owner 或 null；返回精确文本。owner 无引用时读旧 inline，有引用时只读根，不用 inline 掩盖坏引用 |
| `readRange(source, offset, length)` | 非负安全整数的 UTF-8 **字节**偏移，半开范围、EOF 截断，超 EOF/零长度返回空 Buffer；SQL NULL 返回 null。允许在多字节字符中间截断，返回 Buffer 而非静默解码 |
| `logicalLength(source)` | UTF-8 字节长度或 null；pooled 只读取 sealed 根元数据，不取叶/聚合全文，也不按指针大小计费 |
| `setReference(owner, root)` | 类型化内部 writer 接缝；不清空旧正文，不触发旧业务更新；null 删除 override、恢复 inline fallback，不表示空字符串 |

owner 为 `{kind:'relation', id, field:'rawFields'|'sourceText'}`、`{kind:'query', id, field:'rawResponse'|'collectionEvidence'}` 或 `{kind:'version', id, field:'canonicalRawJson'}`。根 ID 不进入 source object、DTO 或指纹；读取者可直接传 owner，不需要理解池和片段结构。读取在独立事务/嵌套 savepoint 内，保持 owner 解析和实际读取的快照一致。

`readRange` 先索引 seek 前驱片段，再索引取相交片段；SQLite `substr(BLOB)` 只返回相交字节，单个大叶也不整叶送入 JS。`readText` 校验完整片段布局、全根摘要和严格 UTF-8。范围读取检查相交片段/叶存在性、存储类和长度；不会为验证整根摘要而读取范围外正文。metadata 预算读取信任封存时已校验且不可变的根长度。SHA/UTF-8 在 intern 时校验，既有叶复用时重新核验；恶意绕过 trigger 后的等长内容篡改不属于 metadata/范围读取的全根验真承诺。

旧 inline 值必须是 SQLite TEXT 或 SQL NULL，BLOB/整数等存储类显式拒绝，不能偷偷转码。`readText(owner)` 从 TEXT 的实际 UTF-8 BLOB bytes 严格解码；BOM/NUL 保留，非法 UTF-8 和 JS 孤立 surrogate 均拒绝。TEXT→BLOB 的范围截取和 BLOB→TEXT 的 SQL 聚合均只在 UTF-8 数据库执行，不声称支持 UTF-16 数据库。

## SQLite 与旧对象 hydration

`lib/platform/body-sql.ts` 提供：

- `logicalTextSql(kind, field, ownerId, inlineColumn)`：可组合的原生 SQLite TEXT 表达式，支持 json_valid/json_type/json_extract、多路径 JSON 投影与旧 SQL json_object；不装 JS UDF、不将全库正文搬到 JS。聚合的 WHERE 在子查询**内部**按根主键限定；不使用可能先物化全池的聚合 view。完整 JSON 解析仍可能聚合整根，应在同一投影内复用结果，summary 不选此表达式。
- `logicalByteLengthSql(kind, field, ownerId, inlineColumn)`：pooled 只读取根长度，inline 按 UTF-8 BLOB 字节计量，SQL NULL 返回 null。可在取正文前保持 64KiB/4MiB/8MiB 预算判断；重复 source 的计费次数仍由原消费者决定。
- `legacyBodySelection(kind)`：作为 opt-in `getTableColumns` selection，用原 key 插入顺序原位替换正文表达式，并 `mapWith` 原 column decoder。rawFields/collectionEvidence 保持旧 JSON decoder；文本 null、SQL NULL、非法 JSON 的旧 decoder 行为不被吞掉。需要精确非法原文时用 readText 或未 mapWith 的 logicalTextSql。

SQL 表达式的 ownerId/inlineColumn 显式传入，便于使用别名；本层默认 selection 针对原表。不存在引用时才 fallback inline。缺根、缺叶、未封存、坏长度、非连续片段或不支持的存储类走故意非法 JSON 的 SQLite 错误分支（`malformed JSON`），不返回 NULL。原生 SQL 无 SHA-256/严格 UTF-8 UDF，信任经过本模块验证且不可变的叶；越过数据库 guard 的等长字节/摘要篡改由 readText 全文校验发现，不冒称每个小投影重验所有正文。

旧 title-scope/evidence-revision/proof/metadata 读域尚未适配。本层不启用业务引用写入，不清空正文，不能用新表存在或本层测试绿声称这些读域已支持 pooled 数据。

## 真实 SQLite oracle

全部位于 `tests/platform-body-store.test.ts`，仅合成隔离 SQLite：

| Requirement | Evidence |
| --- | --- |
| 跨五个字段 exact 共享、键序/空白分开、旧数据不覆盖 | `shares exact bytes across typed owners without collapsing observations or representations` |
| NULL/空/文本null/非法 JSON/中文emoji/BOM/NUL exact、禁止隐式输入转换 | `preserves NULL empty text-null invalid JSON Unicode BOM and NUL exactly` |
| 根/叶摘要碰撞完整比较、不同长度及事务无遗留 | `compares full bytes after root and leaf digest hits and rolls back collisions` |
| 多片/重复叶、逐字节所有 offset×length 边界、UTF-8 中间截断、seek 与局部 BLOB 查询 | `composes ordered repeated leaves and exhaustively reads half-open byte ranges with indexed seeks` |
| 64/65 片上限、连续/非递归叶约束、封存和不可变性 | `bounds explicit fragment inputs and seals contiguous leaf-only immutable roots` |
| 类型字段/FK/缺根/未封存/owner 删除保护 | `enforces typed owner foreign keys and rejects missing or unsealed references` |
| 叶/片段/引用写失败外层全回滚、原 guard 保留 | `rolls back leaf root part and owner writes at injected failure points without weakening guards` |
| 长度预算不读取叶/片段，超 proof 预算保持不满足 | `uses immutable root metadata for byte budgets without reading leaf text` |
| SQL JSON 类型/多路径、小投影、原字段/顺序/JSON decoder/私有 ID 不泄漏 | `keeps SQL JSON types small projections and legacy hydration field order and decoders` |
| 缺叶/坏长度/错布局/缺引用根/摘要及非法 UTF8 全文报错；存储转换拒绝 | `fails explicitly on corrupt refs leaves lengths layouts and unsupported storage conversions` |
| pre-0029 升级/幂等，旧 schema/data/triggers/NOT NULL/unique/FK 原样 | `upgrades pre-0029 SQLite without changing legacy schema data triggers or NOT NULL` |
| owner inline/pooled 混读、NULL、超 EOF、缺 owner、存储类 | `reads mixed owner sources through one seam and keeps inline range and NULL semantics` |
| SQL NULL、64KiB/4MiB/8MiB 前/等/后边界、仅聚合被选根的反例与 EXPLAIN | `keeps native SQL aggregation confined to the selected root and preserves SQL NULL and UTF8 budget edges` |

该矩阵不代表扫描 compiler、真实大库净收益、历史压缩、新 writer、HTTP/MCP、UI、生产或页回收验收。
