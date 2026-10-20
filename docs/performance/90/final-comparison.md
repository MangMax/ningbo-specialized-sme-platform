# #90 最终对照：窄读结果与后续全应用清单

**最终窄读路线已执行：** [fresh 96a0bd9 结果](final-96a-results.md) / [脱敏聚合](final-96a-results.json) 记录全新 1x 和 query/relation 合成 2x 的九例、每组 20 cold-process 与 20 hot c1/c2/c5、真实 Node oracle、实际总资源包络、全部超标及完整字段恢复核验。旧 pre-JSON5 准备产物未复用。结论为 defer 生产迁移；下文更广的正式 API/MCP、混合写和完整域验收仍按各自边界保留，不由窄读结果替代。

**状态：窄读路线已执行；全应用通用 runner 尚未执行。** 早期小型 PoC 数字不能替代最终对照。现已用实际应用 oracle 证明窄工作负载在完整保留分布上的 SQLite/PG 语义一致，并完成同总资源包络矩阵；**不以前置完成整个应用 PG 移植为本票调查门槛**。步骤及边界见 [retained-workload.md](retained-workload.md)。下文的全应用通用 runner/清单留作后续迁移实施验收，#91 综合验收另行跟踪。

## 固定输入与环境记录

- 记录两个应用的 commit SHA、镜像 digest、Node/驱动/Drizzle/PG/SQLite 版本、配置差异；对外 HTTP/MCP 版本、权限和响应语义必须一致。不要把 `compare_public.py` 参数 `--candidate-sha` 当作服务实际 SHA 证明。
- 同一宿主机、同架构、同 cgroup CPU/RSS 与 Node `--max-old-space-size=2048`；PG 服务资源和连接池单独记账；SQLite WAL/连接策略单独记账。轮换 A/B 次序、避免其他重负载，保留失败/超时/重启/离群值。固定 1/2/5 并发与读写混合比例。
- 同一完整分布的隔离、一致副本或可审的脱敏生成集：至少覆盖 #82 观测的企业/记录/事件/查询/关系/导出行数量及大字段分位数；另测 2x/5x。源 DB、原文与凭据只在仓库外，源库只读；两个候选使用同一语义输入和相同完整 ID/关系。复制放大时若嵌入 JSON 身份不能同步重映射，则不得用其做语义等价断言。
- 先冻结病例清单与 `docs/performance/82/budgets.md`；随后核对当前 OpenAPI/MCP 版本。覆盖空库、单 ID、小/深页、含大原文请求、查询状态四/五态、导入 preflight/commit/replay、失败/部分历史、correspondence/decision/proof、任务/文件/OCR/导出、并发读写、取消/断连。写入只在两个**独立隔离副本**。
- 每个接口先新启动进程的首测，再热轮；“首测”不等于 OS 冷缓存。记录每样本 HTTP 状态、语义哈希、body 字节、耗时、SQL/解析/聚合/序列化/传输分段、SQL 行/字节、Node RSS/heap 峰值与事件循环延迟，PG 连接/锁等待/WAL 与 SQLite WAL/锁等待。分别给 p50/p95/p99、吞吐和失败率，样本少时只写观察、不写 SLO 接受。

## Runner 接缝

`scripts/spike-90/compare_public.py` 是**不启动服务**的 loopback 黑盒 REST/可直接 JSON 调用 MCP 采样器：限制两个 URL 为 `http://localhost`/`127.0.0.1`，不保存响应体；比较 HTTP 状态和去除清单声明动态字段后的 JSON SHA-256，记录响应大小、首测与 1/2/5 热样本。所有非 GET 或标记 `write` 的病例均需显式 `--enable-isolated-writes`（包括只读 MCP POST，按保守开关处理）；重定向不跟随，避免离开声明的本地接缝。MCP 若使用 Streamable HTTP 会话/流式响应，须先接上应用现有 MCP harness 完成 initialize/session；不能把本采样器的通用 POST 当作 MCP 验收。MCP 工具清单、读写鉴权、回执要用实际公开 MCP 链独立复核。

先根据实际 OpenAPI/MCP、隔离数据中的稳定 ID 和两边相同的合成写入 key，生成**私有** manifest：

```json
{
  "cases": [
    {"name":"platform-summary-page", "method":"GET", "path":"/api/platform/queries?view=summary&page=1&pageSize=25", "expectedStatus":200, "samples":20, "concurrency":[1,2,5]},
    {"name":"synthetic-receipt", "method":"GET", "path":"/api/roster/import/receipts?idempotencyKey=<isolated-key>", "expectedStatus":200, "samples":20, "concurrency":[1,2,5]}
  ]
}
```

占位 key 必须替换，且对应隔离写入已成功。用户私有 token 只通过命令行指定的**环境变量名**读取，不写进 manifest/日志。示例执行方式：

```sh
PYTHONUTF8=1 uv run python scripts/spike-90/compare_public.py \
  --manifest /tmp/ningbo-perf-83-90/postgres-poc/final-manifest.json \
  --sqlite-url http://127.0.0.1:<sqlite-port> \
  --postgres-url http://127.0.0.1:<postgres-port> \
  --sqlite-auth-env SPIKE90_SQLITE_TOKEN \
  --postgres-auth-env SPIKE90_PG_TOKEN \
  --candidate-sha <verified-integration-sha> \
  --output /tmp/ningbo-perf-83-90/postgres-poc/final-compare.json
```

通用采样器**不**测 OS 冷缓存、Node heap/RSS、SQL 阶段、锁、备份/恢复或应用镜像真实 SHA；这些由同场观测器和既有公开写入/MCP harness 补齐。采样器在私有 JSON 中保留每样本状态/哈希/时延/错误类别；断连、非 JSON、超出 16 MiB 采样上限会使语义比较失败，不中断后续样本。分位数包含失败请求的耗时，必须同时看失败数，不能当作成功请求 SLO。保持 REST/MCP 原始错误与异常样本，不用只成功请求的分位数隐藏失败。`ignoreKeys` 会递归删去同名字段，必须逐项审查，只能忽略已证明无业务含义的动态字段；不得忽略状态、范围、证据、ID、指纹或审计字段。冻结预算达不到时写明 endpoint、负载、重现与归属，不提高堆/预算来制造通过。

## 完整性与切换前核验单

1. 导入前/后每表行数、主键集合、外键缺失、unique 冲突、sequence 当前值；逐行稳定身份/hash 而非总数即可。尤其 `enterprise`、`record`、`record_event`、`record_evidence`、`stored_file_part`、`platform_query`、`platform_relation`、`platform_export_*`、正式决定/更正、proof、任务与审计。
2. 原文字段按**原始字节** SHA-256 对比：平台 HTML/JSON、collection evidence、关系 raw fields、文件 hash/路径、OCR/解析结果；JSON 投影另测结构等价，不能让 `jsonb` 重新序列化掩盖原文字节变更。
3. 所有原始接口段、页、查询条件/范围、每条关联及原顺序；queryCoverage、status `not_queried/failed/no_record/partial/success` 与历史失败/partial、batch122 回执和跨源证据一致。任何未查询/认证失败不得变 `no_record`。
4. `import_batch`/`import_receipt` 的 idempotencyKey、requestHash、原源身份、processing/failed/committed、旧 `not_retained`、replay 和逐项错误；correspondence/proof/alias/event/evidence 的修订、指纹、审计历史及来源引用。并发同键/异载荷、事务中断、重连读回必须可解释。
5. 只在上述全部通过、冻结窗口与恢复演练通过后讨论单写切换。切回后的 PG 新写入需明确隔离/导出/人工审核或可证重放计划；未定义前不得切换，且不默认双写。
