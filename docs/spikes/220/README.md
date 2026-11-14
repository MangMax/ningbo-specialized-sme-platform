# #220: SQL 来源快照可行性 spike

> 历史脚本说明：本文引用的混合表实验/验收脚本已在原生运行切换时退役。复现旧命令须在独立 checkout 固定到 `ab503081dae3e24680afc9b07395a7e3ff21fc9f` 并使用当时的隔离数据库与二进制；这些命令不适用于当前运行库。历史证据与 FAIL/UNKNOWN 保持原样。


> 2026-10-23 最新用户澄清已取代下文的实施方向：保留现有来源快照、指纹与审计算法，允许单个所选来源完整水合，按实际内存/耗时调整任务限额；避免全量归档水合。旧的“不许调整1 MiB、F1必须先建设JSON/SQL/native快照接缝”不再是当前约束。下文保留为历史实验/提案，兼容失败与旧资源观测不撤销，也不授权继续这些切片。当前实现及实测范围见 [候选任务说明](../../candidate-discovery-tasks.md)。


**结论：SQL 快照 + 64KiB 分块 SHA + 服务端审计复制的机制可执行，但现成 JSON1 方案不兼容现有来源指纹，不能进入 #214 修复实施或关闭 F1。** 未证明它不可实现；本轮没有实现通用 JSON 规范化器。独立可推进的最小实施是领域内部审计复制与标量写入回执，仍不解决 F1。

关联 [#220](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/220)、[#210](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/210)、[proposed ADR](../../adr/2026-10-23-bounded-correspondence-snapshot.md)。本票只有报告和合成 helper，不含运行时改动、迁移、来源大小排除或生产操作。

## 固定对象与用户决定

- 实际运行基线：`70233c3389bfbc349d0f1f7602caf34f9d10e5db`，tree `1017c1de16c812e403ea05b855265c803e7b8815`，含 #213 proof 修复。目标 `t3/implement-spec-210` 在交付前远端读回同 SHA。
- #218 的 `f83aad445461a46609fe294cc7a062d2f33ed61c` 仅以 `git show` 查阅任务门槛与事务；未合并，未改 feature。
- 读取 #220 原文、原始 spec/tickets、AGENTS 及 `/tmp/spec210-handoff/214-{bounded-design,fixes,merge}.md`。后者是继承资料，不是本轮验证。
- 用户明确：**没有既定内存预算，先记录 main/worker/SQLite 观测，JS/IPC 不完整水合单份原档，不加固定来源大小排除；没有恒定总 RSS SLO。** O(N) 原生分配本身不是本轮否决条件，也不能隐藏。
- 一轮探索，初始实验窗口 2026-10-23 04:49:26–04:54:13 UTC（约 5 分钟），随后只验证可复现 helper 的最终包装，总窗口约8分钟，仍在同一轮60分钟timebox内。完整私有记录 `/tmp/spec210-handoff/220-evidence`；未读取生产或备份数据。

## 差分 oracle 与兼容性结果

`domain-probe.test.ts` 调用**基线真实领域** preflight/commit，读取真实落盘 provenance/sourceFingerprint/audit 作 oracle；候选 SQL 从 schema 的实际属性顺序构造完整 event/interface 来源。覆盖 `event_process`、`event_recognized`，revision 1/2，倒序插入的官方证据 ID、存在/缺失 storedFile、全部 nullable 来源节点。不是另写一个 JS 模型自证 SQL 正确。

40 例（2 边类型 × 2 revision × 10 值）：16 例快照字节、持久 provenance、源 SHA、计划 SHA 一致；24 例均不一致。失败覆盖原 probe 的六类反例，各重复四次：

- `escaped-unicode`：JSON1 保留 `\u0061`，JS 重新输出 `a`。
- `integer-key-order`：输入键 10、2，JS 输出 2、10。
- `duplicate-keys`：JSON1 保留重复成员，JS 仅保留最后值。
- `number-spelling`：1.0 / 1e+02 / -0 与 JS 的 1 / 100 / 0 不同。
- `rounded-integer`：9007199254740993 经 JS Number 舍入为 9007199254740992。
- `lone-surrogate`：孤立代理转义的大小写不同。

每例同时把值放入 collectionEvidence 和 rawFields。上述六项是**有效非规范化 JSON 存储的合成反例**，不声称真实数据包含它们，也未证明所有历史行/写入者都保证规范化。普通规范化 JSON、JSON null、数组、空对象各四例一致。helper 成功退出表示反例被保留，**不是 SQL 兼容通过**。

另 4 例验证 SQL NULL 与空 TEXT、JSON 原文仍为 TEXT、JSON primitive、中文/emoji/NUL及跨 64KiB UTF-8 边界；快照与分块 SHA 一致。rawResponse 从未 JSON.parse。字符串切片使用 BLOB 字节直接更新 hash，不逐块解码，不重新拼成完整字符串。

40 例 TEMP 表 `INSERT SELECT provenance` 与领域已有审计字节相同；TEMP 复制回滚无残留。revision 1 省略 revision，2 保留；事件 revision 在 preflight 后变化，真实 commit 拒绝 `plan_mismatch`。SQL 计划比较只替换真实领域 target 的 sourceFingerprint，**targetIdentity 本身由 oracle 提供，没有独立证明 SQL target 构造和授权**。

新跑基线 `record-correspondence-core.test.ts`：33/33 通过，包含 #213 对已有 candidate 原子改选时 proofIds 写入 provenance/audit、缺失/撤销 proof 拒绝、幂等及回滚。它证明固定基线行为，**不证明候选 SQL 已支持 recognized_export/proof 路径**。该路径、其他四类边、历史 unlink/reconfirm 的 SQL 实现均 UNKNOWN。

## 分进程规模观测

Node 24.22.1 / better-sqlite3 13.0.3 / SQLite 3.53.4 / Drizzle 0.45.4；macOS arm64。每组先用独立进程创建合成库，再分别启动全水合 oracle 子进程与 SQL 子进程。SQL 使用完整来源构造→TEMP TEXT→64KiB BLOB substr hash→TEMP 审计复制，仅标量/分块经过驱动；未使用完整快照 JS UDF。

以下数值来自初轮 `memory-results.json`，不是最终包装重跑的混合统计。每轴负载依次为 64KiB、1MiB、4MiB、16MiB，其他两字段为小值或 NULL。每个值单次冷进程观察，非统计性能试验。RSS 为该子进程 `resourceUsage().maxRSS` 的进程高水位（含加载/打开），不是 SQLite allocator 的精确计数；heap/external 是阶段采样最大值，非连续峰值。独立 oracle 不在 SQL 子进程内。SQL 子进程每 32 块显式 GC，以便把 helper 的 Buffer 生命周期与 SQL 原生工作区分开；不能据此保证生产 GC 行为。

- rawResponse：SQL 峰 RSS **56.5 / 64.0 / 93.2 / 174.5 MiB**；构造+hash+copy **1.4 / 3.3 / 23.4 / 800.0 ms**。
- collectionEvidence：**56.5 / 65.8 / 101.6 / 206.5 MiB**；**1.2 / 3.3 / 21.6 / 731.6 ms**。
- rawFields：**56.6 / 66.1 / 101.7 / 207.1 MiB**；**1.5 / 3.6 / 20.5 / 722.6 ms**。
- rawResponse 转义混合 NUL/引号/反斜杠/换行，输出约 3 倍：**56.7 / 81.9 / 142.3 / 335.6 MiB**；**1.2 / 14.0 / 167.2 / 7366.0 ms**。16MiB 原文产生约 48.002MiB 来源 JSON。
- 全部 18 组 SQL 快照字节数和 SHA 与独立 oracle 一致；仅覆盖这些规范化合成形状，不能抵消上述 24 个语义失败。
- SQL 子进程阶段 heapUsed 最大 **5.77MiB**、external 最大 **4.53MiB**，最大驱动块 **65,536 bytes**。全水合 oracle 的 16MiB raw / collection / fields / escape 阶段 heapUsed 最大分别 **53.8 / 69.7 / 69.8 / 117.8MiB**，峰 RSS **153.0 / 169.5 / 169.8 / 440.6MiB**。
- 合成协调 main（不是运行中的 Nuxt app）阶段 heapUsed 最大 **7.08MiB**、external **2.42MiB**、RSS **54.88MiB**；最大串行 IPC 观测消息 **4,419 bytes**，只含标量/统计，不含来源正文。未测量真实 app main。
- 1MiB raw / escape 各加入 **32份无关1MiB归档**后，SQL RSS **64.5 / 80.9MiB**，耗时 **4.9 / 18.9ms**；此前 **64.0 / 81.9MiB**、**3.3 / 14.0ms**。所选字节、SHA、驱动边界未变，只支持本例没有水合无关正文；不证明所有规模/查询计划。

观察支持“这个 SQL 测量车道没有把整档穿过 JS/IPC”；**不证明真实领域改造后的全流程边界**。SQLite JSON1 构造完整值，substr 之前仍可加载完整 TEXT/BLOB，INSERT SELECT 仍可使用完整行缓冲；O(N) 原生内存和重复 substr 的非线性时间清楚保留。heap/external 无法用于精确反推 native bytes。没有 RSS 合格线、任意大小保证或并发容量结论。

## 可行性判断与最小后续切片

**当前可直接实施的 ≤M 切片只有 A；B 是进一步收敛的独立 spike。C/D 为通过 B 后才可执行的条件切片，不能现在一揽子领取。** 不把通用流框架、存储迁移或整个 correspondence 重写塞进 #214。

- **A（M，高）：领域内部审计复制 + 标量 insert receipt。** 保留原 provenance TEXT；新建/重提/重验写入完成后按确定的行或事务内快照复制，不把整行 RETURNING 到 JS。历史解除复制旧 evidence，#213 替换先持久化经有效 proof 校验的新 provenance，再复制新确认审计。验收：exact bytes、actor/basis/rule/revision、proof、审计失败回滚、原 receipt 和幂等。同步去除只为审计而发生的 reread；仍需的授权读取如实保留。无 schema/API 变更；不关闭 F1，不承诺领域整体有界。
- **B（≤M，独立 spike，无运行时代码）：只验证两个大 JSON 列的精确规范化接缝。** 固定六反例和既有 canonical/null/array/primitive oracle；检查所有写入者能否证明存储不变量，或 SQL/native 能否在不把完整字符串/对象交给 JS 的情况下输出完全相同字节。数字词法、Number 舍入/非有限值、成员顺序/重复键、孤立代理都必须覆盖。任一失败就停止，不实现通用框架、不改指纹版本、不加“仅规范化来源可用”条件。若需要外部排序/溢写/新 driver，先重新定级为架构事项；没有被证明的简单 M 规范化实现。
- **C（M，高，依赖 B + 用户选择采用）：仅两个 event/interface 边的私有 SQL 来源观察/持久化。** 复用领域授权；按实际源字段顺序输出，SQL 内做版本/文件/证据与可缩小的验证投影，完整 raw/JSON 不穿 JS。同事务分块 SHA、现有 request/plan hash 与漂移重验证；provenance 加 comparisonProofIds 但 source SHA 不加。验收真实领域 oracle、完整来源字节、NULL/逃逸/大字段、revision/文件变更拒绝、回滚。先做这两个边，其他边保持既有路径并单独验证不回归；若无法维持这个局部接缝，停止重新拆票。
- **D（M，高，依赖 A/C）：候选行 native 命令 + checkpoint。** 原有 all-role prior 查找、领域 preflight+commit、checkpoint 必须在同一子进程 immediate 事务；小 ID 请求/标量回执。不能主进程持写锁等待子进程。未知 acknowledgement 先读 durable receipt，不盲重放。保留取消边界/人工竞态/崩溃恢复。以真实处理替代 1MiB 来源排除。重跑原 F1、保留先前成功行、重试完成、超过200事件续片，并量测真实主/子进程 JS/IPC 与原生资源。

#213 大来源人工确认和公开读回/审计当前仍有全水合读路径；如果同一“不水合单档”契约涵盖该完整旅程，需另一个 **≤M、依赖 C 的公开读回切片**，先锁定响应兼容和完整证据传输接缝再实施。没有证明它已可由本候选满足；不替换成截断 DTO。最终 #214/#210 的隔离副本、HTTP/MCP、真实桌面/390px完整旅程验收另行承担，子切片通过不能替代。

## 复现、失败保留与 UNKNOWN

依赖需已按项目正常方式准备；helper 不安装包，不修改应用文件。先从固定基线运行：

```sh
SPIKE_REPO="$PWD" node docs/spikes/220/run.mjs /tmp/spec210-220-new-run
```

输出路径必须不存在，避免覆盖原证据。helper 在外部生成最小 TS 配置（不要求 Nuxt scaffold），运行领域差分、基线33例与18组分进程规模观察。JSON 完整差分、阶段样本、私有合成 DB 和日志留外部；提交不含这些产物。diff probe 的成功表示**预期兼容失败被观测**，不是 F1 修复。内存 oracle 复用已由真实领域输出的固定小元数据，仅替换三字段和 revision；它不是第二份完整领域授权实现。

最终包装验证 `final-repro`：差分probe 2/2、基线core 33/33、18组字节/SHA/审计复制及驱动边界均通过各自断言/产物检查；仍观测24个预期SQL兼容失败。该重跑的16MiB逃逸组RSS335.2MiB、6536.5ms，与初轮335.6MiB、7366.0ms分别保留，不消除波动。

原 F1 `merge-budget-valid-archive-retry` 的测试/配置/失败日志 SHA256 校验仍 OK，复制件保存在私有 evidence/inherited；未改断言或重新跑成绿色。继承 `external-after.log` 仍为 F1 FAIL、F2 PASS。基线不含 #218，因此本轮没有声称重跑 #214 job 验收。

保留 setup 失败：最初 pnpm 包装器自动校验依赖遇到临时 node_modules symlink，随后 Vite 因缺少 `.nuxt/tsconfig.json` 在收集前失败（0测试）；改用直接 Vitest runner + 外部最小 tsconfig。一次 core 命令沿用只包含 probe 的配置，0测试，exit1；随后专用 core config 才跑到33例。包装 helper 初次引用未导出的 vitest 子路径失败，改为已导出的 package.json 定位；这些不是业务失败或通过证据。借用现成依赖链接在提交前移除，不修改其他 checkout。

未实施/UNKNOWN：兼容的非规范化 JSON adapter、所有 provenance 字段任意规模与深度、全部六边的 SQL 授权/proof/targetIdentity、真实 worker/主进程集成、SQLite allocator 专项峰值、无人工 GC 的生产 Buffer 生命周期、并发/冷OS缓存、业务读回的字节边界、进程丢ack/崩溃/磁盘满、CI/build/typecheck、浏览器、生产、#214与#210验收。**F1保持未解决。**
