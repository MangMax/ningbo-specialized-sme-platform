# #671 验收记录

工作树：`/Users/mang/.t3/worktrees/app/t3-c6394828-4f89addabfe489cf`。
起点 `919bc0f539f7c260f9df5670729031bd18beb15f`；实现提交 `425c0e21`，
随后合入最新 integration `4d7f3f76a8cd55addd1d1b7482d2584ec6aaed4a`（#668 / PR674），
merge `d1a33a642b0d4c00857f6dddc32b589ebe2e29f7`。两者 ancestry 已验。
冲突只在 pages/files.vue 的 import 和相邻行内入口，保留两套独立组件；未改 #668 编辑器。

## 已记录的新鲜证据

- TDD：red-1 为缺少公共路由；green-1 为最初错误表引用导致预检500；green-3 为修复后通过。
  文件名为执行时原名，green-1 不代表 PASS。typecheck-1 为同一错误引用 FAIL。
- red-replay：后续块完成后旧块返回累计回执 FAIL；green-replay 为每块保存不可变回执后 PASS。
- red-failure-count：整块回滚后失败条数仍0 FAIL；green-failure-count 为失败/未执行分开且原键续跑 PASS。
- browser-pagination-fail 为模板多语句分页事件语法 FAIL，已改具名 handler；
  typecheck-pagination 还记录 OpenAPI 类型不接受 string minLength/maxLength，改用运行时严格校验及文字契约。
- final-candidate-tests：5文件124项 PASS，包括本票24项、正式更正、304约束、407读回和已合入668。
  继承 #669/#668 的历史证据只用于理解契约，不替代本票新鲜执行。

| Requirement | Evidence |
| --- | --- |
| 未知值补齐、稳定ID与审计幂等 | `preflights and atomically fills only unknown formal coordinates over public HTTP, preserving IDs and replay` |
| 100/101块、第二块失败续跑、旧块不可变回执 | `replays each completed chunk as its original immutable receipt after later chunks` |
| 已知值/同页歧义/无页/多出处冲突/坐标/原认定/未知段/相同值/其他称号 | `isolates known/ambiguous/missing-page/multi-source/contradictory-sources/coordinate/origin/unknown-segment/same/other-title without guessing or changing raw sources`（参数化名称各自执行） |
| 完整成员新增/移除、增出处、事件或声明修订、SHA及坐标变化 | `rejects a stale whole plan after new-member/removed-member/new-source/revision/declaration/source-sha/coordinate-added`（各自执行） |
| 整块回滚、失败计数及原键恢复 | `rolls back a whole chunk on a storage failure and safely resumes the same request` |
| API鉴权、同源门控、服务端actor | `requires public auth and browser origin plus explicit write capability, without taking actor from the page` |
| 容量超限拒绝、不截断 | `rejects 3001 source members explicitly instead of truncating the plan` |
| 已知年月及statementPages保留 | `fills only the missing batch without overwriting known year or formal validity statement pages` |

## 同一真实隔离库公共HTTP及浏览器

库 `/tmp/sync671-z6Npzh/test.db`，源目录同名，只有合成 PDF 与企业；开发服务3671。
所有 public HTTP、页面同步、名单/详情、导出 worker 共用这份库。
真实 #669 `/api/files/20/parse-result/preflight`（PDFium）→ commit 已返回200，
登记同页但附件唯一的两个组合：附件1 2025/2，附件2 2022/1；范围都是物理页1。
没有使用公告年份猜填原认定年。

桌面1280：搜索 sample-19.pdf → 同步独立抽屉 → 填核实依据 → 预检，
显示事件125/126两个未知年月的前后值，以及127其他称号/128缺页两条冲突 → 确认。
返回 updated2/conflicts2/unexecuted0。来源PDF字节、事件/出处ID、有效期来源保持。

390px：sample-18.pdf → 填依据 → 预检 → 确认，同步事件124，updated1/unexecuted0。
抽屉 clientWidth/scrollWidth 均372，实际 CSS viewport390，未横向溢出。
后来对 sample-19.pdf 增加独立合成事件129，再跑窄屏与重开（补充结果见最终 browser 记录）。
开发代码热更新改变指纹形状时，旧预检被409拒绝，草稿保留；该次不冒充同步成功。

事件125有事先明确录入的正式有效期2025-01-01至2027-12-31和结论年2025，
同步前只缺原认定年月；事件126为独立2022/1组合。事件128因缺页保留年份待核。
现有有效资格并非本同步命令创建或推断。

公共名单（titleCode=specialized_sme&q=反例19）及详情121前后读回：
事件125 year/batchSeq null/null → 2025/2，completeness.fieldGaps 中这两项消除；
公布名称未留档仍保留，另一称号127未改。事件128仍缺year/batchSeq。

经真实 POST `/api/roster/exports/current/specialized-sme` →202 job → GET进度done →
下载 XLSX；分别保存同步前后原始工作簿。ExcelJS 独立读取实际字节，字面量oracle
`scripts/acceptance/file-event-sync-671-workbook-oracle.mjs` PASS：
- 反例19：原认定年份待核认定 → 2025年第2批认定；公布名称未留档仍保留。
- 同步第二组合2022：2022年第1批认定，没有2022/2或2025/1交叉组合。
- 同步未解决缺页：仍为原认定年份待核认定。

原始SQLite、PDF及XLSX均留在Git外；本目录只提交合成JSON读回、文字日志及证据索引。
HTTP响应时刻不完全相同，不宣称同一个数据库历史快照；资格评估日均为2026-11-09。

## 限制与未运行

- 跨文件多出处即使可能一致也保守待核，需要单独正式出处核实；不假称自动闭合。
- Office无可靠物理页定位拒绝；文件检查沿用既有#311的外部文件替换边界。
- 浏览器真实断网/响应丢失注入 UNRUN；公共HTTP原键重放及实际SQL失败回滚/续跑 fresh PASS。
- 全仓测试、远端CI、独立审核、生产数据/生产回填与部署 UNRUN；本票未写生产。
- #670 的页码编辑页面不在本票；本次通过公共API登记范围，不代表母票整体验收完成。

## 冻结代码复验补充

`browser-frozen.json` 绑定实现 head `1e46ed23228fe312cbc1604b6ed532ff0a29185f`，
保存最终390px与1280px的预检、成功回执及关闭重开实际页面文字。
事件129/130是分别为最终窄屏/桌面新增的独立合成未知年月样本（不重置已有事件或抹掉历史），
两端分别 updated1，既有2025/2、2022/1无需变更，跨称号和缺页两项仍冲突。
最终390px clientWidth=scrollWidth=372，桌面558；重开仍保留成功回执。
本次后续变化仅为测试增加出处原始公布行逐字段不变与同键不同依据拒绝断言，以及证据文档。
业务实现与该浏览器绑定 head 相同；没有把前一个热更新期间409当成功。

frozen-tests / raw-history-tests 均5文件124项 PASS；后者额外独立保存并比较
`official_evidence_row_revision` 的历史原名、原统代、原属地、unknown绑定及来源，不通过现用企业资料回填。
frozen-typecheck PASS；frozen-build PASS（14.4s）；frozen-prod-openapi 本地生产产物
验证三个文档端点404、health/job kinds 200。这不是生产部署。
frozen-workbook-oracle 为冻结代码重新下载工作簿后独立解析的 PASS。
最终文档提交后的精确HEAD gate 日志继续保存在 `/tmp/671-evidence/final-head-*`，
最终报告提供确切 SHA 和结果；此处旧日志的候选身份与历史 FAIL 保持不变。

## integration 后续推进

发布 draft PR676 前后，integration 又合入 #670 / PR675，tip推进到
`8877c3d42ebfb11c8a5b821401a4e1a999710d74`。本分支随后合入该 tip；唯一冲突是
pages/files.vue 的 import，保留 FileEventSync 与 SegmentRangesSummary，两者入口与显示均保留。
没有修改 #670/#668 的组件、writer 或测试；这些文件来自 integration 的原样合入。
先前 e5f7a2e480fc18a993f52845f91980338faa65bb 的124项/typecheck/build/OpenAPI完整PASS
原始记录存于 `/tmp/671-evidence/head-e5f7a2e4/`，不再当作最终集成候选证据。
最终合并后的精确HEAD重新执行受影响HTTP/UI测试、typecheck、build及本地生产OpenAPI，
并在实际生产构建的隔离实例复验页面，日志见最终报告。
