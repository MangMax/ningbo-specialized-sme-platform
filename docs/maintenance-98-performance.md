# #98 性能对照记录

功能审计基线为 `4f910f612cfdf6915758f39522f0ff9874f96d7a`；集成分支 `t3/implement-spec-98-perf`。执行源码不变的词汇校准提交 `a0e0164` 上取得下列性能基线。新增能力未完成，不代表规格验收。

## 冻结输入与预算

沿用 `docs/performance/82/budgets.md`，不提高预算。历史完整分布临时快照在本会话已不可用，因此使用现有 `scripts/verify-enterprise-read.mjs --prepare-only` 生成的合成夹具，固定企业 ID=1。它覆盖少量企业、别名、正式事件与平台记录，不代表历史完整分布、2x/5x 或容量验收。对应列表为空，不能用其延迟证明大量对应查询通过。

基线数据库和原始日志在 Git 外 `/tmp/ningbo-spec98/`。Node24.22.0，macOS，本机无容器资源限制；同机存在并行子代理负载。新进程冷态不等于冷 OS 缓存。执行源码与输入相同的后续对照须单独记录，不把历史报告升级为本次证据。

```
node scripts/verify-enterprise-read.mjs /tmp/ningbo-spec98/synthetic-seed.sqlite --prepare-only
node scripts/perf-82/run.mjs --db=/tmp/ningbo-spec98/synthetic-seed.sqlite --work=/tmp/ningbo-spec98 --out=/tmp/ningbo-spec98/baseline-read.jsonl --scenarios=platform_page,enterprise_page,enterprise_id,sources,correspondence_page,event_id --concurrency=1 --rounds=20
node scripts/perf-82/summarize.mjs /tmp/ningbo-spec98/baseline-summary.json /tmp/ningbo-spec98/baseline-read.jsonl
```

## 基线实测

真实 h3/loopback 路由诊断接缝，非完整 Nitro/MCP 性能验收。每入口冷样本1、热样本20，126/126 HTTP200。20样本的观测p95不代表可靠尾延迟。

| 入口 | 冷请求 ms | 热观测 p95 ms |
| --- | ---: | ---: |
| 平台摘要页 | 25.31 | 6.35 |
| 企业第一页 | 277.43 | 7.37 |
| 企业精确详情 | 557.70 | 7.09 |
| 来源目录 | 17.14 | 6.16 |
| 对应列表（空） | 16.79 | 4.16 |
| 精确事件 | 38.34 | 14.69 |

企业查询在独立子进程运行，诊断父进程SQL字节为0不代表实际没有SQL。新增历史/回执路径还须验证范围索引、有界分页、原文按需读取、提交后缓存失效及冲突回滚。

## 基线功能检查

`4f910f6` 上 `pnpm test --maxWorkers=2`：149文件通过、2跳过，2136测试通过、12跳过。`pnpm build` 退出0。构建产物的 `node scripts/verify-enterprise-read.mjs` 退出0，验证HTTP/MCP企业列表与详情契约。日志保留于上述外部目录。

## 待完成

待全部切片合入后，以相同输入重新测量并运行新增公开契约验证。既有 #84 冷请求超预算、#93/#95 容量、受控资源环境和长期混合负载边界仍按原票保留，不能由本记录宣称完成。
