# #89 缓存矩阵与准入决策

> 历史脚本说明：本文引用的混合表实验/验收脚本已在原生运行切换时退役。复现旧命令须在独立 checkout 固定到 `ab503081dae3e24680afc9b07395a7e3ff21fc9f` 并使用当时的隔离数据库与二进制；这些命令不适用于当前运行库。历史证据与 FAIL/UNKNOWN 保持原样。


**第二轮状态：#87 索引之后，已实现一个有限场景的缓存候选。** 仅公开 REST 的无筛选摘要第一页（pageSize<=50）。MCP/no-store、凭据、原文、筛选与深页全部绕过；不扩大到相邻票。下方第一轮矩阵、no-cache 决定和失败样本保留为历史证据；第二轮实现与实测见文末，不把 #87 的索引收益算作缓存收益。#89 保持未关闭。

## 测量前冻结（2026-10-19）

冻结源码：集成 `39fb7bad30b3c1cefe48c9af249334c689128a4f`，含 #83 `57cc58ac9a410a4e7f3f973982a9b069bb284832`。已读 #81–89 规格及实时 issue comments（均为空）。#82 的 `/tmp/ningbo-perf-81-89/baseline.md` 是冻结预算，本票不改变它。只测独立 SQLite 副本或合成库；不连接生产、不访问外部平台、不改 schema/migrations（#87 所有）。本文件先冻结矩阵和准入条件，再补充结果。

“未设”是现状缺口，不是无限容量已获批准。浏览器内存缓存、HTTP 缓存、磁盘派生物与数据库连接必须分别理解；`no-store` 不会自动清理 JavaScript 对象。下面的现状均为源码/锁定依赖检查，尚不是运行验收。

## 现有缓存矩阵

| 层 / 位置 | 实际键与结果 | 版本 / 失效来源 | 容量、TTL、淘汰 | 权限、敏感性与提交边界 |
| --- | --- | --- | --- | --- |
| 浏览器 Colada：`pages/index.vue` | `['ledger-enterprises', listQuery]`；含视图、筛选与分页的响应 | 无 DB 提交版本；切键/重取 | 无条目数/字节预算；依赖 1.4.8 默认 staleTime=5s，未使用后 gcTime=300s；mount/focus/reconnect 重取，不是强制 5s 轮询 | 当前公开读；无凭据/数据源 epoch；外部提交不主动广播 |
| Colada：`pages/platform-queries.vue` | `['platform-queries', {enterpriseId?,queryKey?,pageSize:50}]`；默认完整关系与 collectionEvidence | 无提交版本；手工 refetch/默认重取 | 同上，无原文字节上限；placeholderData 保留前值 | 包含归档原文；不扩大为共享服务缓存；placeholder 不是当前查询证据 |
| Colada：`pages/comparison.vue` legacy | `['comparison', {title,direction,q,district,page,pageSize,showCurated}]` | 当前页面操作后 invalidate `['comparison']`；无跨进程版本 | 同上 | 名称/解释/原档可能敏感；不能据旧缓存提升候选/确认状态 |
| Colada：`pages/files.vue` | `['files', {source,categoryState,parseState,q,page,pageSize}]` | 页面操作后 invalidate `['files']` | 同上 | 文件目录元数据；没有其他写入者的提交通知 |
| Colada：`pages/stats.vue`、首页统计、`pages/quality.vue` | `['stats']` / `['quality']` | 无提交版本 | 同上 | 当前公开读，不能承诺提交即刷新 |
| Colada：企业详情/面板/抽屉 | `['roster-enterprise', id]` / `['ledger-drawer', id]` | 只有 ID，无身份归并/别名/事件/对应/证明版本 | 同上 | 可能带原档；当前 miss 仍涉及全表快照，禁止以新缓存遮盖 |
| 组件 `useRetainedQuerySnapshot` | 一个 settled-success 响应及 `JSON.stringify([namespace,capturedParams])` | 只接受匹配活动键的成功请求；错误不替换成功值；组件销毁释放 | 一个响应，无字节预算/TTL；不是服务端缓存 | 旧请求有来源标签/交互限制；不是当前结果或提交版本 |
| `useEnterpriseCorrespondences`、`useRecordSource`、OCR workbench / proof picker | 组件 refs；企业/显式 source IDs/asOf/证明 ID；请求序号防竞态，picker 暂存 pending promise | reload/切对象/销毁；非全局查询结果表 | 无统一字节预算；对应关系按页 200 收集企业全部结果；无 TTL | 不与其他浏览器共享；未确认的结果不能成为判定；#85/#86/#88 另管 miss |
| 浏览器 PDF 栅格 `usePdfPageImages` | 每个 document 实例内 `pageIndex:scale:dpr` → Blob URL + promise | document 作用域、失败删除、卸载 revoke | 活动租约 + 最多两个空闲图，LRU；未设字节预算/TTL | 文档隔离；释放不发布业务结果 |
| 浏览器高亮 `lib/content-highlight.ts` | 单 highlighter promise；固定 12 语言 + 2 主题的加载 promise | bundle 版本；加载失败删除 | 固定键集合；不缓存输入/高亮结果；输入最多 100000 字符，无 TTL | 不保存商业文本；非业务查询候选 |
| 浏览器导航/上传恢复 | sessionStorage：证据返回路径/展开键；tus localStorage 恢复记录 | 单次消费/手工清理/会话；非查询结果缓存 | 无统一字节预算；不存查询原文或凭据 | 只作导航/续传，不能作为名录事实 |
| 凭据 `useCredentialSettings` / credential HTTP core | 组件 raw/replacement/status；服务端从当前配置库/部署回退读取，无全局结果缓存 | 保存/清除即重新读；pagehide/unmount 清 raw、abort；bfcache 恢复重取 | 请求 `cache:'no-store'`，响应 no-store；无磁盘/Colada 缓存 | 不缓存 reveal、失败或原凭据；不把有效 Cookie/token 放键或日志 |
| 通用服务端业务读取（REST + MCP） | **无跨请求业务结果缓存**；局部 Map 是一次调用的索引 | 每请求读 SQLite；事务读取保持单次响应一致 | 新增共享结果容量为 **0B**，TTL/淘汰不适用 | MCP、record-comparison、对应/证明、live platform、credentials 既有 no-store 保留；普通 platform list 当前未显式设置 cache-control，不擅自新增可缓存头 |
| SQLite 连接 `db/client.ts` | `resolve(path) + NUL + readonly/readwrite` → Drizzle / native connection | 进程生命周期；不带 migrationsFolder；连接不是结果/提交版本 | 无连接数上限/TTL/close 淘汰；配置固定时每路径每模式一个 | readonly 与 readwrite 分键；不缓存行/凭据；DB 原子替换后旧连接重开问题未解决，不改变此生命周期 |
| SQLite pager / OS page cache | 数据库文件页、WAL / OS 文件页 | SQLite 自身事务/WAL 一致性；非业务结果版本 | 应用未设 cache_size/mmap_size；运行值另记；OS 自动管理 | 不能将热 OS 页称为业务缓存收益，不能把 data_version 当全局递增 commit ID |
| PDFium `server/utils/pdf-pages.ts` | 单 library promise；每绝对 PDF 路径的 chains / inflight，参数 dpi+force | init 失败复位；队列完成删除；文档句柄单独释放 | 单 engine；并行文件无全局字节限额；pending 生命周期无 TTL | 只合并同进程同参数 render；现状不保证多实例写磁盘协调 |
| PDF 页图磁盘 + HTTP | 文件根/相对 PDF → 隐藏 pages 目录；清单校验源 sha256、DPI、页图尺寸/增强参数 | 源 hash/渲染参数变化重建，删除目录；清单版本 | 无磁盘配额/TTL；文件回吐与 pdf-pages GET `private,max-age=3600` | 不能共享/CDN；同 URL 更新的浏览器旧页风险未测；不改现有 header；业务 DB 事务不管理派生目录 |
| OCR 成功页磁盘 `ocr-page-cache.ts` | 文件根/页目录 + H(image SHA256,NUL,模型及有效选项 variant) | 条目 version=1；形状/身份不符 miss；原子 tmp→rename | 无磁盘配额/TTL/LRU；删页目录清理；一页完整 JSON 读取 | 缓存 provider 成功页原文，不是正式结果；不存 token；无 credential namespace；成功页可在整份任务失败前暂存，正式 OCR 仍全成功事务替换；不扩张本票场景 |
| reconciliation / curation JSON | 配置路径上的持久业务解释/人工修订，每次 readFile/parse；不是进程 memo | 文件替换、业务写入；无通用提交 epoch | 文件无通用缓存容量/TTL；EMPTY 常量不是结果缓存 | 不能用 TTL 把人工结论/失败抹成 no_record；非本票优化 |
| job registry / activeJobs、请求内 Map | job kind / active ID 或一次调用的 ID 索引 | 任务/请求生命周期 | 非可复用查询结果；不声称有全局内存界限 | 不改任务调度/写幂等/审计 |

## 候选键、成本与失效矩阵（先冻结，再选择）

所有未来可准入的查询缓存都须使用：`cacheFormatVersion + datasetIdentity + committedGeneration + permissionScope + canonical(normalized request)`。datasetIdentity 不能只用数值 ID，必须隔离不同库/数据源与备份替换；permissionScope 必须按有效权限和凭据配置版本隔离，**不能放凭据原值**。没有可信版本就不缓存。格式/投影/业务规则更新更换 cacheFormatVersion。错误响应、认证失败、partial/failed 的推断性负缓存、敏感 raw 和既有 no-store 响应不准进入共享结果缓存。

| 候选 | 请求键必须覆盖 | 成本 / miss 前置条件 | 提交后的失效来源 | 本轮准入门 |
| --- | --- | --- | --- | --- |
| 平台摘要列表（首选调查场景） | interface/titleCode/uscc/queryKey/queryId/enterpriseId/status/view/includeRawResponse/page/pageSize；固定排序 `queriedAt DESC,id DESC` 及其版本 | 只接 `view=summary`、pageSize<=50，不得缓存完整原档。miss 必须符合 #82 500ms p95/1s p99、256KiB、heap增量64MiB/硬预算；不能隐藏 counts/sort 全扫描 | query/relation 变更、企业归并或 alias/归属变化、原档替换和 titleScope 修订；提交后所有实例可观察版本 | 尚无测得的缓存收益；先测冷/热和并发。若有实现，预设总8MiB、单条64KiB、最多128条、LRU、TTL<=5s，键和值都计 UTF-8 字节；超额不缓存，不改变输出 |
| 平台完整列表 / 原档块 | 上述字段 + queryId/field/relationId/offset/length/page/pageSize | full 最大单项4MiB/页8MiB；chunk最多65536原字节；均可能含敏感原文 | 同上 | 原档块 no-store；共享缓存拒绝。完整列表不复制原文进新缓存，容量0B |
| 企业、对应、来源、对比 | 所有筛选/排序/分页/显式 queryIds/exportBatchIds/officialSourceDocumentIds/asOf/proofIds/证明修订或指纹/身份版本 | #84–86 尚未合入有界 miss；基线部分全表/OOM | 归并、confirmed alias、记录事件、原档、导出替换、对应决定/解除、证明创建/撤销、判定规则版本 | 未满足冷 miss，容量0B；不得借缓存绕过相邻票 |
| live platform / credentials | 有效 credential/data-source namespace + 完整输入 | 远端失败/部分/未完成不得当 no_record；当前政策 cache disabled/no-store | 凭据变更、远端状态变化，无法以本地提交版本代替 | 容量0B，禁止新增缓存 |
| static capabilities / 词表 / 高亮引擎 | bundle/schema version、固定能力名称 | 数据小，尚无重复计算可测收益；现有 engine 复用已存在 | 部署替换 | 不制造无收益场景；不改原 no-store |
| OCR/PDF 派生物 | 内容hash、版本、全部有效参数、文件根/文档隔离、必要凭据作用域 | 已有磁盘缓存，缺全局字节配额；非 SQLite 查询用户场景 | 源/参数/版本变更、删除；不等同业务事务提交 | 本票不重写，与 #88 分界；容量/多实例缺口登记，不宣称满足 #89 |

## 提交一致性规则

新业务结果只能从已提交快照填充；事务内不能向进程共享 Map 发布。rollback 不改变可见 generation、不发布值；commit 后读到新 generation 才允许命中。归并/别名/事件/原档/导出/对应/证明任一影响结果的写入都须同一事务更新版本，不能只在某个 HTTP handler 清 Map。多个进程、MCP、任务和外部写入者必须遵守同一协议。当前没有这个协议；schema/触发器/版本表归 #87，本票不私加。

`PRAGMA data_version` 只对同一连接前后比较其他连接提交有意义；本连接提交不会使它变化，跨连接数值不能比较；重开、备份替换也不能当持久版本。因此不能直接拿它作通用全局 cache key。TTL 只是资源回收，不能容许提交后五秒陈旧。进程内 single-flight 也不解决跨实例失效；失败 promise 必须移除且不能发布 empty/no_record。

## 本轮验证计划

优先调查平台摘要列表一个完整场景：`view=summary,page=1,pageSize=25`；在 #82 完整分布的**另建副本**上测真实生产构建 HTTP 与 MCP。记录 fresh-process（不清 OS 页）/重复读取、并发1/2/5、线传字节、采样 heap/RSS 和事件循环；只保存统计，不保存响应/业务键。用临时合成 SQLite 对同一摘要接口验证 committed/rollback、失败/partial/no_record、两进程及重启后的公开结果。没有缓存实现时，淘汰/TTL/single-flight 命中/未命中等价是未实施项，不能把“无缓存”测试冒充缓存验收。

决策以安全性和实测为门槛：如果 miss 或版本/权限条件不满足，交付本调查报告，**不新增缓存、不声称提速**；其他读取优化的收益仍归其原票。

## 源码盘点补充与写入依赖

冻结 v1 文本 SHA256 `11d0dd03440e6a4f06d87460143f4fb300e53058d4d0e276aca77d588913abf2` 保存在 `/tmp/ningbo-perf-81-89/89/matrix-frozen.sha256`。随后核对组件发现以下条目需要比上表“组件 refs”更精确的记录；这是盘点补全，不改变候选、预算或准入门槛。

| 层 / 位置 | 实际键 / 版本 | 容量、TTL、失效 | 安全 / 提交缺口 |
| --- | --- | --- | --- |
| `ComparisonSourcePicker.vue` | `${kind}:${id}` → 已读来源；页面参数 scope/query 不在缓存键中 | 组件内 Record，无字节预算/TTL；分页读到的行更新，已选来源只补未读 ID；卸载释放 | 无内容修订/提交版本，非跨实例协议；涉及 #86 来源替换时必须重新核验 |
| `ComparisonProofPicker.vue` | proof ID → proof；proof ID → basis 文本 / pending promise；scopeKey 另含 selection/asOf，但不在 proof/basis 缓存键内 | 无容量/TTL；读列表覆盖 proof，hydrate 跳过已有 ID；basis 错误提示也保存在 basis Record；pending 完成删除 | eligible 校验 status/valid/source/asOf，但已读对象没有提交后主动失效；不能把撤销通知能力视为已实现；不改业务判定 |
| `useRecordSource` | 一个 `${kind}:${id}` 响应、显示键与 request serial | 单响应，无字节预算/TTL；切目标/重试读取，失败保留旧成功且单独显示 error | 来源 ID 不等于内容版本；不含 asOf/proof（这些属于上层选择），不与其他组件共享 |
| PDF/Text preview | document 实例内已载文档/文本；Text preview loadedSrc/name/format/language 与重试序号 | 卸载/切源/取消释放；文本使用默认浏览器 HTTP 缓存，重试 `cache:'reload'`；无应用统一字节预算 | 延续文件接口 private,max-age=3600；不是 query 缓存，未验证同 URL 原档替换立即可见 |

已有缓存的无容量限制、缺失提交版本、多实例磁盘协调以及上述 UI 旧对象问题均为本次登记的缺口，**没有在本票顺带修复，也不因没有新增缓存而自动消失**。

| 已提交变更 | 需要失效或重算的视图 | 现状与本票边界 |
| --- | --- | --- |
| 企业归并 / confirmed alias / 企业关系归属变更 | 企业列表/详情/统计、query enterpriseId 筛选与 matchedName、对应候选、来源对比/证明有效性 | `roster-import.ts` 事务写入；没有全局提交 epoch 或浏览器广播 |
| 记录事件 / 证据 / 正式来源文件修订 | 生命周期/首次认定/企业统计、候选/对应、正式覆盖证明、来源对比 | 多个写接缝，不能只监听一条提交路由 |
| platform query / relation / 原档或 titleScope 替换 | 平台摘要 counts/relationCount/筛选/分页、full/chunk 原文、候选/对比/证明指纹 | 本票合成事务验证状态和关系数；不扩张为其他业务写验收 |
| export batch / row 替换 | 来源目录/当前平台状态、企业差异、对应/对比、同范围版本证明 | ID 相同不代表原文与版本相同；缓存需 dataset + committed version |
| 对应 candidate/confirmed/rejected/解除及追加审计 | 对应列表/详情/审计、企业事件行出处、候选、记录对比 | `record-correspondence.ts` 事务；不能缓存 candidate 为 confirmed |
| 证明确认/撤销或依赖指纹变更 | proof list/detail/audit、来源 picker、来源对比及任何依赖 matched 的展示 | `comparison-scope-proof.ts` 事务；proof ID/asOf 不足以独立作缓存版本 |
| credential / 文件根 / 数据库路径 / 部署规则版本变化 | 对应权限/来源 namespace 下全部可复用值；旧连接/组件对象须重新隔离 | 当前新查询缓存容量0B；不存 token/cookie，不改变 no-store |

## 实测与决策

**决定：本轮不新增/调整查询结果缓存。** 当前没有同时完成安全准入与实测缓存收益的候选。平台摘要的 miss 已避免原文进入 Node，但 counts/sort 仍扫描，冻结时延与事件循环门槛未通过。将其热点变成 warm hit 会掩盖冷启动、淘汰后与击穿时的同一问题。其他业务候选的有界读取尚未合入；原档/实时接口/凭据的共享缓存受敏感性/no-store 门槛限制。小型静态数据没有测得需要新缓存的重复成本。不声称不存在未来可行的缓存设计。

本地环境 Node v24.22.0、SQLite 3.53.4、Darwin arm64、Apple M4 10 CPU / 24GiB。进程 `--max-old-space-size=2048`，V8 total heap limit 2348810240B（含 young generation），单 worker。**未施加 1vCPU/4GiB 容器限额、主机不独占**；OS 页缓存未清空。实际 SQLite cache_size=-16000（KiB）、page_size=4096、mmap_size=0、journal_mode=wal；未改这些配置。

数据来自 #82 的私有完整分布快照，仅用文件 clone 建立另一个 `/tmp/ningbo-perf-81-89/89/private/roster.db`。该副本 1342353408B、39303 query、58310 relation，服务均以 NUXT_DB_READONLY=1 打开。原快照测量前后与副本 SHA256 相等，私有校验日志在同目录上层；从未对共享快照开 SQLite 连接或进行恢复/迁移/写入。仅统计进入报告，不存响应/名称/查询键/凭据/商业原文。

测量产物源码为 `39fb7ba`（#83 合入后的同一集成源码）。新增内容仅本调查文档及合成 verifier，未改应用执行路径。每一行独立新服务进程：1 个首请求 +20 个热请求；并发列仅应用于热请求，首请求始终单个。总计126个请求均成功；20样本的 p99 是最大值，只是观察值，不能建立可靠尾部保证。CPU/IO 争用影响时延，但不剔除超预算样本。

| 入口 / 热并发 | 首请求 ms | 热 p50/p95/p99 ms | 线传 B | 采样 heap/RSS MiB | OS峰值RSS MiB | loop p95/max ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| HTTP / 1 | 3475.4 | 74.5 / 92.6 / 123.4 | 7344 | 80.8 / 236.9 | 264.6 | 3479.2 / 3479.2 |
| HTTP / 2 | 11847.1 | 109.6 / 251.3 / 10906.8 | 7344 | 80.6 / 231.9 | 260.4 | 11853.1 / 11853.1 |
| HTTP / 5 | 69.0 | 315.5 / 1532.1 / 1532.1 | 7344 | 81.3 / 261.1 | 263.2 | 564.7 / 968.9 |
| MCP / 1 | 963.7 | 72.7 / 367.6 / 1077.3 | 12373 | 85.4 / 239.2 | 261.8 | 968.4 / 968.4 |
| MCP / 2 | 416.5 | 108.4 / 345.1 / 1158.5 | 12373 | 86.4 / 236.8 | 262.0 | 814.7 / 814.7 |
| MCP / 5 | 1008.6 | 244.9 / 602.5 / 823.1 | 12373 | 85.6 / 239.8 | 263.3 | 1009.8 / 1009.8 |

这是**无新缓存的候选基线**；after/cache-hit/cache-miss 对照为 **N/A（未实施）**，没有性能改善声明。响应体在256KiB内；本次有限运行未 OOM，采样 heap/RSS 在硬上限内；不等于证明每请求 heap 增量<=64MiB、长期稳定、2x/5x内存斜率或受控容器验收。同步 SQLite 可能在采样之间达到更高瞬时 heap；OS 峰值 RSS 另列。loop 是整个服务测量窗口（含首请求）的延迟分布，不与请求时延 p95 混用。HTTP c2 热 p99、HTTP c5 热 p95/p99、MCP c1/c2 热 p99 超预算；多个首请求与全部 loop 窗口也超预算，不能通过 warm hit 宣称合格。

驱动补充测量6样本（首读+5热读，带 --expose-gc，非 HTTP）：每请求 SQL 送入 Node **2864B**，序列化 **7344B**；首读 8275.4ms，其中 SQL+驱动行物化8264.3ms；热 p50/p95/p99=62.2/187.4/187.4ms，SQL53.0–185.5ms。采样 heap峰值26.0MiB、RSS257.5MiB、OS峰值303.7MiB。残余包含 JSON/业务映射/序列化和观测开销，未虚构聚合/传输分段或物理读取字节。HTTP/MCP测量与驱动测量是不同运行，不相减造分段。

真实副本 EXPLAIN：counts=`SCAN platform_query` + `USE TEMP B-TREE FOR GROUP BY`；page=`SCAN platform_query USING COVERING INDEX platform_query_identity_uq` + `USE TEMP B-TREE FOR ORDER BY`。索引/迁移决策留给 #87。HTTP bytes 小与 SQL 返回字节有界不代表扫描成本有界。

## 可复现证据及验收边界

先写公开接口的合成 characterization verifier，再运行当前实现；**没有改生产缓存，因此没有生产代码 red→green 修复声明**。初版测试夹具把 summary 的省略字段误写为 null，后续原生 SQL fixture 漏了 ORM 才提供的 created_at 默认值；按既有 #83 省略契约/真实约束修正夹具，未修改应用/约束/预算。它们不是应用缺陷或缓存提速证据。

`node scripts/verify-platform-cache-safety.mjs` 通过临时合成 SQLite、两个本地生产构建进程、真实 HTTP/MCP 验证下表。事务 fixture 用独立 SQLite writer 控制事务；**不冒称业务写 API 或所有七类写入路径已验收**。脚本不访问远端、不保存响应；凭据全部是字面 synthetic 值。仅一个摘要用户场景，不扩张测试为相邻业务模块。

| Requirement | Evidence |
| --- | --- |
| 冷/重复摘要保持全部状态、稳定顺序、明确省略，HTTP=MCP | `cold_and_repeated_summary_preserves_five_states_http_equals_mcp`：同查询5态逐一计数；failed 字面断言；摘要字段不出现 |
| 事务提交前不可见，rollback 不发布 | `uncommitted_and_rolled_back_changes_are_never_published`：持有 writer 事务时两实例两协议仍返回旧 committed 结果；rollback 后再次逐字段等价 |
| 提交立即更新状态与完整关系数 | `commit_is_immediately_visible_in_both_instances_and_transports`：failed→partial、relationCount1→2；状态计数符合新提交，no_record仍独立 |
| 不误用 data_version 作全局版本 | `data_version_is_connection_local_not_a_global_commit_generation`：own connection 提交后值不变，另一个长期连接的值变化，rollback 不变 |
| 敏感原文/no-store 与凭据隔离 | `raw_no_store_and_synthetic_credential_isolation_are_preserved`：raw块为新提交原文且 no-store；两个进程 reveal 返回各自 synthetic 配置且 no-store；所有 MCP读响应 no-store |
| 并发读取外部结果等价（不是 single-flight 验收） | `concurrent_repeated_reads_match_the_committed_result_without_a_cache`：20个并发请求、两个实例及 HTTP/MCP，逐字段等价 |
| 进程重启正确 | `restarted_instance_reads_current_committed_result`：重启后与持续存活实例及两协议逐字段等价 |
| 数据源隔离 | `same_ids_and_parameters_in_another_database_do_not_share_results`：另一DB同ID/参数为no_record/0关系；原DB仍partial/2关系 |

运行命令与 Git 外日志：

- `pnpm build` → `/tmp/ningbo-perf-81-89/89/build.log`。
- `node scripts/verify-platform-cache-safety.mjs` → `safety.log`。
- `node scripts/bench-platform-query-http.mjs /tmp/ningbo-perf-81-89/89/private/roster.db http summary 1`；transport=http/mcp、concurrency=1/2/5 → `full-{transport}-c{concurrency}.json`，不重新生成/修改快照。
- `node --max-old-space-size=2048 --expose-gc scripts/bench-platform-queries.mjs read /tmp/ningbo-perf-81-89/89/private/roster.db 1 summary` → `driver-summary.json`；参数1仅为规模标签，实际计数见环境证据。
- `environment-plans.json`、`snapshot-before.sha256`、`snapshot-after-and-copy.sha256` 是机器/计划及只读来源校验。

**未实施/未通过的缓存验收**：容量/字节计账、TTL边界、LRU淘汰后 miss、single-flight击穿合并与失败清理、缓存命中/未命中等价、共享版本跨实例失效、持续 churn 内存稳定。无新增缓存时这些是 N/A/未实施，不是 passed。上述“并发读/重启正确”仅指当前无新结果缓存的路径；不证明既有浏览器或 OCR/PDF 缓存正确。

其他未运行：2x/5x完整分布副本、本票真实业务副本的写压力、受控容器、真实生产、UI桌面/390px（无UI改动）、外部OCR/平台请求、所有依赖写类型的浏览器失效。#81/#82/#83/#87/#91 和其他票的状态/验收不受本报告决定。

## 收尾验证

- `pnpm exec vitest run tests/platform-read.test.ts tests/platform-query-evidence.test.ts tests/platform-query-http.test.ts --maxWorkers=2`：退出0，3文件/19测试通过（`tests-narrow.log`）。
- `pnpm typecheck`、`pnpm build`：均退出0（`typecheck.log` / `build.log`）。
- `node scripts/verify-platform-query-read.mjs`：退出0，真实生产构建 HTTP/MCP 的全筛选、五态、完整原档、分段、400/401/413契约通过（`platform-contract.log`）。
- `node scripts/verify-prod-openapi.mjs --skip-build --port 34989`：退出0，生产OpenAPI不可达、业务路由可用的既有策略保持（`openapi.log`）。
- `pnpm exec vitest run --maxWorkers=2`：**退出1**；138 passed /1 failed /2 skipped文件，2071 passed /1 failed /11 skipped测试。失败是未改动的 `tests/roster-import-api.test.ts:1457`，用例 `单条 name-only 记录命中多家同名企业时预检与提交均结构化拒绝` 报 `Test timed out in 5000ms`（`tests-all.log`）。同用例原超时设置、单worker重跑：退出0，1 passed /105 skipped，测试60ms（`roster-failure-isolated.log`）。主机同期有其他全仓测试在运行，但未确认超时根因；**不能把单例重跑或范围内通过称为全仓通过**。未修改测试/超时/应用来消除此失败。
- `git diff --check`、`node --check scripts/verify-platform-cache-safety.mjs`：退出0。提交前再次 `git merge t3/implement-spec-81-89` 返回 Already up to date，集成仍为 `39fb7ba`。

本票交付为调查决策及复现脚本，未创建PR、未推main、未关闭任何issue、未委派。提交后的 exact-head verifier 证据另存 `/tmp/ningbo-perf-81-89/89/`，由交接消息给出提交SHA；不在文档内伪造自引用SHA。

## 第二轮：#87 之后的单场景实现（2026-10-19）

起点 `71cc7bf351523c3ac5b9a4eb892cc362dcf0d189`，包含 #87 的索引和第一轮 `aa1ef84`。冻结预算仍为原 `/tmp/ningbo-perf-81-89/baseline.md`。本轮只选择 **公开 REST `/api/platform/queries?view=summary&page=1&pageSize=1..50`，无其他筛选**。这与真实生产构建上的重复首屏读取对应；不改变默认 full，不将界面迁移到 summary。MCP 的 no-store 入口维持每请求读取，也作为结果等价对照。其余企业/对应/来源/对比缓存容量仍为0，#85 后来的读取修复不自动准入缓存。

### 键、资源与准入

- `server/utils/platform-summary-cache.ts` 为此场景提供独立只读 reader。键包含 `platform-summary-v1`、真实绝对路径+设备/inode、该 observer 生命周期内的 generation、固定权限 `public-rest-v1`、固定排序/投影版本，以及全部已归一化的 queryId/interface/queryKey/titleCode/uscc/enterpriseId/status/view/page/pageSize/includeRawResponse。当前不支持 asOf/显式来源列表/proof 参数；相关场景从未准入此缓存。新增影响结果的输入/规则必须升级键和准入设计。
- 8MiB 总计账、128条、单条64KiB、5秒 TTL、LRU；最多4个 source reader，淘汰 source 时关闭连接并删除其全部条目。预算可在测试中降低，不可超过这些上限。条目保存 UTF-8 Buffer，计账为 payload字节+2×UTF-8键字节+256B保守开销；不保留调用方对象图。命中重新解析，调用方修改不能污染后续响应。这是应用计账上限，不是精确的 V8/native RSS 估算；SQLite pager/连接独立计量。
- TTL 从填充完成起计算，命中不续命；到期在下一次准入读取时清除，不在空闲时启动 timer。即使空闲，应用保留量仍受硬容量限制。source reader 最多4个并保持到 source 淘汰/进程结束；已有 `useDb` 连接缓存的历史缺口不在本次扩大修复。
- 有筛选、page>1、pageSize>50、full/raw、原连接事务内、内存库、显式关闭开关均直接调用原读函数。REST 带 Authorization/Cookie、请求或已有响应 no-store/no-cache 时也绕过；不保存这些 header 的值、不修改响应缓存头。MCP 不调用 reader。原文分段、reveal、实时平台、proof 等 no-store 接口不变。
- 读取异常直接抛出，没有失败/empty/no_record负缓存；带非空 failureReason 的成功摘要也不存，以免保留敏感错误文本。成功摘要仍逐项保留 failed/partial/no_record/not_queried/success 的真实档案状态和同范围 counts，不把档案里的 failed 状态当作“请求失败”或“无记录”。
- 同步 SQLite 填充在一个请求调用内完成；Node 同一进程不会出现跨 await 的并行 miss，不需要保留 promise/single-flight 队列。不同进程各自承担一次安全 miss，不声称跨进程合并请求。

### 提交、回滚与多实例

每个 reader 使用它自己从不写入的长期只读 SQLite 连接，比较 **该连接自身** `PRAGMA data_version` 的前后变化。它是变更观察值，不是全局提交 ID；generation 仅为本 reader 内部键版本，绝不跨连接比较数值。观察到变化便清除此源的全部条目，因而应用原连接、其他实例和外部 SQLite writer 的所有提交都会失效，不依赖逐条改写 import/merge/alias/event/archive/export/correspondence/proof writer，也不加版本表、trigger 或 migration。对本场景无影响的提交同样粗粒度失效。

原连接已有事务时不消费/填充共享条目；事务调用者仍经原函数读取自己的写入。独立 reader 只见 committed snapshot。外部未提交写入/rollback 不改变 observer 可见版本或发布条目。填充后再次检查该连接版本及文件身份；填充期间发生提交/换库时可以返回本次已提交快照，但不发布为可复用条目；下一次请求重算。命中的线性化点是本次版本检查，已开始请求与并发提交可交错，提交完成后开始的读取必先验证版本。

真实路径或设备/inode变化时关闭旧 observer、丢弃条目并打开当前文件；另一个库同 ID 不共享。普通进程重启没有持久条目，必冷读。**这不授权在线替换仍有 writer 的 SQLite/WAL 文件**；部署仍需停写、checkpoint、备份和重开连接。原有 full/其他业务的 `useDb` 换库生命周期问题不因摘要 reader 的替换检测而自动解决。

### 第二轮 TDD 与公开接缝

先以原读实现作为 reader scaffold，记录 `red-01-behavior.log` 的真实行为失败，再逐片实现；初始缺模块失败单独保留，不拿 import error 冒充行为红。随后容量、TTL、事务隔离、绕过、源淘汰/替换、配置边界都有对应 red/green 日志。公开 REST 接入先失败于未命中计数，再加入 adapter。两次新测试夹具类型错误及第一次归一化键顺序失败均保留，未改业务断言或预算规避。测试均用合成临时 SQLite，不接触共享快照/生产。

| Requirement | Evidence |
| --- | --- |
| 归一化命中、五态/顺序/投影、可变对象隔离 | `normalized repeated summaries hit without retaining mutable results or original evidence` |
| LRU条目数/淘汰后安全miss | `entry eviction uses least recently read order and evicted requests safely refill` |
| 总字节/单条字节的恰好/差1边界与字节淘汰 | `byte and per-entry limits count encoded data and admit only at the exact budget` |
| TTL前/恰好/之后、命中不续期 | `TTL expires at the boundary and hits do not extend the committed value lifetime` |
| 本连接事务读取不发布、rollback、commit后两reader更新 | `same-connection commits invalidate both independent readers while rollback never publishes` |
| 外部writer未提交/rollback/commit与新实例 | `external commits, pending writes, rollback and restart preserve committed public results` |
| 数据源隔离、source淘汰、相同路径新inode、关闭释放 | `source eviction and same-path replacement isolate identical IDs and close old readers` |
| 筛选/原文/no-store/敏感错误不进入缓存 | `unsafe filters, raw reads, no-store and sensitive failures bypass result storage` |
| SQL异常不会变空结果、恢复后可填充 | `read errors are not cached as empty and recovered schema reads refill normally` |
| 冷突发只有一次同步填充、1000次容量churn | `synchronous burst has one miss and bounded churn releases every retained entry` |
| 预算拒绝0/负/无穷/超上限及undefined默认 | `invalid or increased capacity options fail before any database opens`; `explicit undefined limits use the bounded defaults` |
| 真实REST接线、响应头、Cookie/Authorization/no-store/no-cache绕过 | `public REST opts into summary storage while credentials and no-store bypass it`; `an existing response no-store policy prevents summary storage` |
| 编译后REST命中与MCP不进入缓存 | `rest_repeats_hit_and_mcp_no_store_does_not_touch_cache`，`scripts/verify-platform-cache-safety.mjs` 的 IPC 聚合计数与完整结果断言 |
| 两个生产构建进程+真实HTTP/MCP的事务、重启、数据源隔离 | 同 verifier 的 `uncommitted_and_rolled_back_changes_are_never_published`、`commit_is_immediately_visible_in_both_instances_and_transports`、`restarted_instance_reads_current_committed_result`、`same_ids_and_parameters_in_another_database_do_not_share_results` |
| 编译后冷突发/错误/凭据/no-store/原文 | `cold_rest_burst_has_one_synchronous_fill`、`credential_no_store_and_invalid_requests_do_not_populate_cache`、`raw_no_store_and_synthetic_credential_isolation_are_preserved` |

变异验证 `mutation-stale-version.log`：临时把 observer 的每次真实版本检测替换为复用旧值，本连接提交/外部提交/错误恢复三用例均变红（退出1），随后恢复源码。没有保留变异、没有扩大超时。未提供 code-testing-extensions 目录，测试约定取自当前仓库的真实 SQLite/Vitest 接缝；按用户要求全部 inline，不委派、不增加独立审核轮。

### 第二轮规模证据与限制

私有产物统一在 `/tmp/ningbo-perf-81-89/89-r2/`。从冻结 #82 文件 clone 到本轮独立 `private/roster.db`，只在该副本执行现有 #87 migration；完整性ok、FK0、39303query/58310relation。共享快照只做文件clone/hash，没有 SQLite 连接。原始字段、DB、凭据和响应不入 Git；基准只保存完整响应hash和聚合度量。

候选前测 `before-http-c{1,2,5}.json`：新服务首请求17.50/24.35/25.28ms；20热请求 p95=5.99/10.88/25.81ms，无OOM。但c1包含启动的loop p95/max=247.99ms，p95超过100ms目标，保留为未通过样本。不能从请求时延反推事件循环通过。

`scripts/bench-platform-summary-cache.mjs` 在相同构建、同一私有只读副本、相同输入下切 `NUXT_PLATFORM_SUMMARY_CACHE=0/1`，每格新服务进程，1首请求+100热请求，HTTP/MCP×c1/2/5；逐一比较完整响应hash、响应头和缓存计数。统计 **启动至health窗口** 和 **health之后包含首个列表miss的交互窗口**，不将二者相减，也不删除历史全窗口失败。每个实例 old-space2048MiB、单worker、OS页缓存不清、主机不独占；未施加1vCPU/4GiB容器限额。MCP为无缓存对照，差异不能归为缓存收益。

首轮 candidate-v1 同时有本地 typecheck，保留其12格及8000次churn全部样本；不是最终exact-head证据。最终结果与精确SHA由本轮 handoff 及后续验证日志给出。500ms/1s/256KiB/64MiB增量与全局硬预算未改变；没有测量物理读取字节，不把成功hit计数说成零磁盘IO，版本检查仍访问SQLite。

开关 `NUXT_PLATFORM_SUMMARY_CACHE=0` 使REST立即走原读取；回退代码不涉及schema/业务数据恢复。没有新增可缓存响应头、凭据日志或公开诊断端点；diagnostics_channel `ningbo.platform-summary-cache` 只有计数/容量，默认无人订阅不输出。缓存不能解决 interface/title 扫描、启动期/其他请求事件循环阻塞、默认full过大响应或相邻业务热点。

尚未验收：受控容器、清空OS页缓存、完整分布2x/5x及无关raw增长斜率、小时级内存/混合业务写压、全部业务写API/浏览器失效、生产与UI桌面/390px（无UI变化）、#81/#91母票验收。8千次有限churn和合成事务测试不替代这些lane。保留此前 #89/#87 的所有失败样本；#89不关闭，也没有PR/main/生产操作。

第二轮第一轮全仓回归 `tests-all-candidate.log` 为退出1：4文件/18失败，138文件/2069测试通过、20跳过。根因是adapter对默认full读取也执行新增HTTP头检查，旧的直接路由调用夹具没有原生H3 event；独立复现 `getHeader({})` 抛 `Cannot read properties of undefined (reading 'req')`。将策略检查限定到显式summary后，未修改旧夹具/断言/超时，受影响6文件/80测试通过（`green-default-boundary.log`）。最终全仓重跑另记，不把这轮红结果抹掉。

提交前集成源码 `5c9ab8e` 加本轮候选：`pnpm exec vitest run --maxWorkers=2` 退出0，143文件通过/2跳过、2099测试通过/11跳过（`tests-all-integration.log`）；`pnpm typecheck`、`pnpm build`、新缓存verifier、原完整平台HTTP/MCP契约verifier、`verify-prod-openapi --skip-build` 均退出0。`tests-all-fixed.log` 的2文件失败/1测试失败（HTTP就绪、旧比较用例5秒超时）保留；该轮跨集成源码合入且使用较早构建，不绑定为最终exact-head。未修改这些相邻测试或timeout，重建后整套回归通过。

### 已提交实现的串行最终对照

运行源码与生产构建均为 **`c8e3fc66d93bbfd1d365340efbce95023be7e7a2`**，`benchmark-exact-c8e3fc6.json` 和 `protocol-exact-c8e3fc6.log` 的 Git diff hash 均为空diff的 `e3b0c442…b855`。这轮没有并行启动本地测试/typecheck；主机仍不独占。SQLite3.53.4，副本1347248128B、cache_size=-16000KiB/page_size4096/mmap0/WAL；没有更改配置或堆/timeout来过关。共享快照前后SHA256仍为 `19c25412…df1f`，本轮副本因仅应用#87索引而变为 `ae748f5b…293e`，不能要求迁移后与迁移前DB文件hash相等。

| REST并发 | 缓存关闭首请求ms | 缓存开启首个miss ms | 关闭热p50/p95/p99 ms | 开启热p50/p95/p99 ms |
| --- | ---: | ---: | ---: | ---: |
| 1 | 15.65 | 12.05 | 1.69/2.84/4.19 | 0.28/0.79/1.08 |
| 2 | 9.55 | 8.96 | 2.70/4.32/6.86 | 0.42/0.88/1.20 |
| 5 | 9.82 | 8.21 | 6.29/8.23/9.65 | 0.62/1.23/1.62 |

每格100热请求；开启时恰好1miss/100hit，关闭时0miss/0hit且全部bypass（这里miss专指缓存填充，不是原函数执行计数）。REST p95减少约72%/80%/85%，绝对节约约2.05/3.44/7.00ms；这是已经很快的首屏摘要重复计算收益，不是全站用户体验或#87索引收益，也不是冷读加速保证。12格全部成功，HTTP7344B/MCP12373B，完整外部结果SHA256均为 `11fbe01c66a00b29ad0923625420003b8b927ce289f3442bf7cc1219be590966`。MCP缓存开关两组始终没有缓存调用；其热p95关闭8.22/8.07/14.76ms、开启6.26/7.29/14.69ms，只是非独占主机上的无缓存对照波动。

12格就绪后（含首个列表miss）交互事件循环p95最大17.40ms、max最大20.84ms；本次启动窗口max232.39ms，不能据此删除第一轮/前测或#87保留的启动/其他查询窗口超预算。整个基准及churn采样heap峰88.15MiB、OS/采样RSS峰271.84MiB；首屏窗口相对health采样heap最大增量20.11MiB。V8实际heap limit2348810240B（old-space2048MiB加young等区域），没有容器资源等价声明；采样增量不等同于逐分配捕获的瞬时峰值证明。

TTL后真实REST重填充16.53ms，完整结果hash不变，miss计数从1增至2。随后4组×2000次、pageSize1..50轮转，强制GC后的heap29.02–29.25MiB，最终50条/408309计账B/1source；期间TTL使累计miss从51增到101，保留量不随请求总数线性增长。这是有限8000请求证据；该基准没有因容量触顶淘汰，容量淘汰由真实SQLite服务测试单独验证，不能混称生产REST容量淘汰压测。计账上限不是RSS上限。

最终测试质量补充：字节边界夹具增加400组Unicode字符，区分UTF-8字节和UTF-16字符数；临时变异为字符数计账时 `byte and per-entry limits count encoded data and admit only at the exact budget` 真实失败（`mutation-utf8-byte-budget.log`），恢复实现后通过。外部writer持有未提交事务时也增加一个全新reader的cold miss，断言只能得到旧committed结果。这两项只加强合成测试，不改变c8e3fc6的应用源码/构建/测量。交付HEAD与该实现的应用代码差异须为空，最终验证SHA/命令/未运行lane集中在 Git 外 handoff。
