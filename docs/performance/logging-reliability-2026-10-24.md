# SQLite 运行日志可靠性专项验证

基线：`871aa4638b4b65fb4178826cd9f1603bbd6eecd5`。本轮保持 SQLite、原有容量/超时、业务返回和最新策略授权语义；没有增加第二套缓冲、数据库或依赖。

实现：仅在待写队列内汇总同一安全上下文的原生 Drizzle 查询尝试；达到批次或出现 warn/error 时安排一次异步排空；将失去提交确认的记录单独计为 `writeUnknown`。聚合键保留所有安全事实，UUID/时间前缀布局不匹配时放弃汇总。计数表示尝试，不表示执行成功。

## 固定输入丢失对照

脚本：`scripts/benchmark-logging-reliability.mjs`。同一进程、相同预算、相同依赖、每格独立真实 SQLite，先预热 worker；四轮交替 A/B，共32格。基线服务和 worker 从上述 commit 提取，仅改临时服务的 worker import 路径；逆变换核对原文，结束后删除两个临时源文件和每格数据库。最终原始数据：`/tmp/implement-spec-180/sqlite-reliability/paired-final-v2/results.json`，包含代码 SHA256、逐格计数和清理结果。

| 每轮输入 | 基线确定丢弃 | 优化后确定丢弃 | 优化后汇总的额外尝试 | 任务终态 |
| --- | ---: | ---: | ---: | --- |
| 600条普通HTTP事件 + 60条任务终态 | 0 | 0 | 0 | 两者60/60 |
| 600次查询尝试 + 60条任务终态 | 0 | 0 | 540 | 两者60/60 |
| 10,000次重复查询尝试 + 100条任务终态 | 9,076 | 0 | 9,900 | 两者100/100 |
| 10,000次不同请求的查询尝试 + 100条任务终态 | 9,076 | 9,076 | 0 | 两者100/100 |

每个结论均在四轮成立；所有格 `writeUnknown`、`drainFailures` 为0。不同请求不能为了降低丢弃数字而合并，超量仍真实受限。汇总记录若丢失，不能宣称其中的查询尝试已经保留；普通 dropped 按记录计，本脚本另外通过完整分页读回尝试次数核对缺失量。

## 耗时与边界

下表是入队到显式 flush 完成的中位数，单位毫秒；不包含 worker 冷启动，也不是 HTTP 响应延迟。

| 输入 | 基线 | 优化后 |
| --- | ---: | ---: |
| 普通HTTP事件 | 42.39 | 39.57 |
| 普通重复查询 | 40.70 | 9.59 |
| 重复查询突发 | 70.30 | 32.97 |
| 不可合并查询突发 | 63.12 | 64.53 |

汇总减少了持久化记录和 worker 批次，但本身需要比较键。不可合并突发的入队阶段，中位数由16.92ms变为25.77ms，即每10,100次调用多约8.85ms；这个开销保留在报告中。普通HTTP事件入队约多0.39ms/660条。不能据此宣称所有负载无性能回归，也不能把排空耗时下降直接称为业务加速。四轮小样本、单机未做CPU资源分区；RSS仅为单进程结束时采样，不是全进程峰值。

早期双序列化版本的 `paired-1`、`paired-business`、`paired-final` 结果均保留，不能混成最终版本结果。最终实现复用单次序列化，并有计数跨9/10、99/100的字节边界回归。

## 真实管线与故障验证

| Requirement | Evidence |
| --- | --- |
| 突发查询与任务终态全部保留，尝试数精确 | `coalesces ten thousand query attempts while preserving every task terminal without overflow` |
| 四个真实进程共用SQLite，40,000次尝试与400条终态完整 | `keeps all query attempt counts and terminals from four real processes sharing one SQLite store` |
| 原生201条记录、候选续跑和年度子任务，4个任务均完成且各有一条真实关联终态 | `carries a native archive submission through continuation and annual child jobs with each own task id`；保留原生Drizzle observer，不再移除可选日志钩子 |
| 提交成功但ACK丢失/超时不冒充确定丢失，不自动重发 | `marks a real committed batch with a lost exit acknowledgement unknown and never replays it`；`marks a real committed batch with a timed out acknowledgement unknown without claiming a drop` |
| 获取BEGIN锁失败明确未写入，解锁后不重放旧记录 | `counts a real BEGIN write lock rejection as known noncommit and never replays it after unlocking` |
| 关闭期限终止在途确认，保留已确认批次 | `classifies the in flight commit at the close deadline as unknown while preserving acknowledged batches` |
| 同步发送失败清理pending和旧timer | `counts a synchronous unsent message as a known drop and clears its pending timer`；删除唯独clearTimeout的测试副本会红，原文/变异hash和逆变换凭据保留 |
| 聚合计数增长不突破实际字节预算、不修改在途记录 | `keeps exact UTF8 byte accounting across interleaved summary digit boundaries`；`does not mutate an in flight summary and removes drained and evicted index entries` |

提交后丢ACK测试仅在测试侧对完整 worker 源码进行单锚点转换，仍执行真实 SQLite 事务；不在产品中提供故障开关。Open/策略/BEGIN/SAVEPOINT前置拒绝与可能提交后的未知结果分开。原有真实 ABORT/ROLLBACK/FULL、字段策略、背压、权限及公开 REST/MCP/TUS 回归继续执行。

UI沿用现有结构，显示连接用途与查询尝试次数，未知数独立于丢弃数。1280×800与390×844使用私有合成实例、真实原生Drizzle查询和实际保护接口读回；未在用户50055服务执行配置写入。非零unknown的界面分支由组件测试验证，不把它说成浏览器里制造过真实故障。

## 证据范围

原始失败和修正记录均在 `/tmp/implement-spec-180/sqlite-reliability/`：初始队列红测、BEGIN锁分类红测、timer变异红测、早期回归失败、两轮静态审查、最终回归/构建/公开接口报告及临时资源清理凭据。

这份报告验证日志链路专项；没有执行全仓测试、真实业务快照的最终应用p50/p95/p99对照、生产、CI或SLO认证。进程强制终止、磁盘故障或长期超过消费能力仍可能失去未持久化记录。运行日志继续不代替业务数据库中的审计与回执。
