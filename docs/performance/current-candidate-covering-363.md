# 当前资格候选双覆盖索引（#363）

本票从 `b3bb4fad0f6ece1b7a0ea47d3a4097d263109240`（tree `a8600b0aa3f5f5c4e337bb22a2b7d73b5444a396`）增加两条物理索引。当前资格 list/count 与工作簿 count/eligible cursor 共用 `currentCandidateSqlFor(db)`；资格计算、公开 DTO、分页后 hydrate、工作簿列和原始业务值不变。

```sql
CREATE INDEX platform_relation_current_candidate_cover_idx ON platform_relation(query_id,sequence_no,enterprise_id,uscc_raw);
CREATE INDEX platform_query_current_candidate_cover_idx ON platform_query(id,rdjb,title_code,collection_evidence);
```

`currentCandidateSql` 保留原 CASE/UDF/UNION、四候选来源与绑定。覆盖路径仅给 `r`、`q` 加固定 `INDEXED BY`，不引入 PR360 的 CTE/window 重写。固定 list wrapper 的原 SQL 为 3279 bytes、SHA-256 `90c4d25b4c53595410e6a3d4a27e391c84aff42ba254fef43831e443b4c13c48`；双 hint 为 3390 bytes、SHA-256 `c4ab7561a48d41aa9a7de6b776520aaed8926432bf1c542c6220bc833f672d19`。

每次请求在自己的连接/读事务中检查两索引：所属 table、完整有序 key 列、非 partial 必须同时匹配。缺失、仅一个、列或 table 不符、表达式 key、partial 均选原 SQL。没有跨请求判定缓存；后续请求可见索引新增或删除。旧只读库不迁移也可读取。workbook 在同一事务内选择一次，count 与 eligible cursor 复用该 SQL。

迁移 0031 只创建这两条索引并追加 journal 项；旧项及时间戳不改。正常可写启动沿用 `db/client.ts` 的 Drizzle migrator，事务失败回滚与重启由既有 migrator 处理，不增加 executor。当前 migrator 只需 journal/SQL，无需 snapshot 增量。索引增加存储及相关行写入维护成本；原响应、raw_fields、历史身份/指纹/证明/审计/任务/回执均保留。

两份专属测试使用新建的小合成 SQLite（含真实文件、只读连接、关闭重开）与普通单 worker：

```sh
pnpm exec vitest run tests/current-candidate-covering-index-363.test.ts tests/current-candidate-covering-migration-363.test.ts --maxWorkers=1 --no-file-parallelism --reporter=default --reporter=json --outputFile.json=/tmp/issue363-results.json
```

- C01–C05：双 COVERING 计划、结构兼容、连接隔离、后续索引可见与冻结 SQL/绑定。
- C10–C22：独立 literal 检查三称号/四来源/归属与规范化/去重、single-rdjb 短路、page 状态与序号、unknown、坏 JSON/page、空集合、缺企业 join、字符串/大数/小数计数。T05 三称号集合固定为 `[1,2,6,7]` / `[3,6,7]` / `[4,5,6,7]`，保留未覆盖序号回退。
- C30–C36：真实 consumer 接线，固定时间完整计数/筛选/选项/见证/依据/引用/来源指针、只读兼容；小工作簿由 ExcelJS 独立解析，核对四表、列、文本/公式隔离与 dataVersion。独立 literal 为主，旧/新完整对象比较补充保护。
- M01–M05：新库、旧库数据与旧 schema 保全、二条索引失败时事务回滚/重启、只读字节不变与外部建删可见、schema/DDL key 契约。

#362 的继承证据仅是一次固定 I-B-B-I：I 首条 id23 约 707/701ms；B 两次均在原 5000ms 内未交付，native 耗时 UNKNOWN。索引构建约 13.08s，文件增长 35,008,512 bytes，都是该副本单次数据；共享块/cache 预热混杂保留。不能据此声称稳定性能、OS disk cold、物理 IO 根因或生产规模成本已知。#361 单 r 索引约 4.8/4.94s 的负结论及 PR360/f790 无收益保留。

本轮不启动 Nuxt/app native worker、HTTP/MCP、type/build/status、浏览器、full，也不接触真实 DB/历史 clone/archive/原文件/凭据。实际公开 HTTP 原 5s、真实 MCP、公开异步 export 下载、历史全量候选与独立工作簿验收仍 UNRUN，由父线程授独占 slot 后另行执行。小工作簿不能代签历史导出。#359/#356、PR358、#345/#346/full 与历史 FAIL/UNKNOWN 均不因此完成或消失。PR358 同 consumer 的冻结展示变更由父后续 delta 集成；本票不跨写其工作树，不自评审/watch/merge/deploy。
