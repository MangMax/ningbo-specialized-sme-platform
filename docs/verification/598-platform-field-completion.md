# #598 平台字段双入口验收

## 验收范围与状态

基线 `681217505fe9a13c4bc26b4d539e86aa2277d0d4`，tree `45a7d859cfa3508bb2204195c10ede2d673abb34`。本报告不宣称 #598 全部 AC 完成；剩余项和失败必须随候选交付。未修改生产数据库、原档、main 或部署，未重做 7579 修复。

新增可复现用例：`normal replay and retained relationId repair expose the same literal fields without changing archived identities`（`tests/platform-dual-entry-http.test.ts`）。通过公开 HTTP 预检/提交及三张实际查询路由，以磁盘 SQLite 验证三来源混合入库、同接口编号隔离、完整原行重放补缺、保留 relationId 补齐和同键重试。认定目录的有效期原值、维护批次及未知年份/属地/认定说明均有独立字面断言；申报与办理事项、年份、状态、称号同样使用字面期望。未导入生产 parser 生成 expected。

缺投影仅在隔离库一致备份后删除，原库不动。前后逐行比较 query/relation/business identity/version/observation，包含 raw/canonical/hash/指纹；比较企业、正式记录/事件、别名、对应及差异表。合成库中的人工决定为空，这不证明真实非空决定不变。

复现：

```sh
pnpm exec vitest run --root "$PWD" tests/platform-dual-entry-http.test.ts --maxWorkers=1
# 可选保留模式：指定新建的空外部目录，保存 SQLite、一致备份与原文/回执。
ACCEPTANCE_598_DIR=/absolute/new-empty-directory pnpm exec vitest run --root "$PWD" tests/platform-dual-entry-http.test.ts --maxWorkers=1
```

## 新鲜证据

证据目录 `/tmp/598-acceptance`（不提交数据库、源原文、回执或凭据）。

- 定向回归：15 文件 / 100 项 PASS，含新增双入口、三来源投影 HTTP、源漂移/冲突/回滚、writer contention、MCP 提交/发现、补齐 MCP、三独立列表 HTTP、版本详情 UI。`focused.log`。
- `pnpm typecheck`：退出 0，`typecheck.log`。
- `pnpm build`：退出 0，`build.log`；保留既有 es2019 bigint 提示，不将提示改称失败。
- 隔离库运行生产产物：OpenAPI/Scalar/Swagger 均 404，health/jobs kinds 均 200；`prod-openapi.log`。未访问生产 HTTP。
- T3 preview：同一合成隔离 SQLite，三张独立页面，1280px/390px 列表、版本详情、称号筛选分别操作成功，原文未提供与原值均可读；页面无横向溢出。`browser.json`。只有单版本，不能称多版本切换已验收；其他筛选组合不能借称号筛选冒称通过。

## 历史失败与未完成项

- 新测试初次失败为夹具漏提供认定目录封套 status、原名及 titleCode。修正输入满足原契约后通过，未放宽生产校验。
- #596 原报告的初始缺完成证明、收尾丢投影仍 committed 等历史 FAIL 继续保留于 `596-atomic-platform-fields.md`；#597 早期 UI/typecheck FAIL 继续保留于 PR601。
- 新鲜全套运行已观察 `platform-comparison-input.test.ts` 6 项失败；定向复现 124 PASS / 6 FAIL / 1 SKIP。包含 `budget428_raw7_4096`、`fee428_source_U_65536`、`fee428_policy_W_16777216` 及三个 closure441 边界项。`comparison-diagnostic.log` 保留细节；实际 uniqueScalarBytes 67517 与冻结期望 67487 不符。未改测试期望或资源上限来消绿。
- 全套另观察 `annual-process-load-more-266.test.ts` 两项 readback/reset 意图失败，保留全套原日志。其余全套结果待运行结束核实，不能称全套 PASS。
- 五家实际来源材料已按用户补充授权只读定位；真实来源验收、非空人工决定前后核对、真实样本三列表多版本及完整筛选、外部原档保留的同批故障证据尚未全部闭合。
- 运行库位于 Docker 卷，约 11GB；宿主剩余空间不足完整复制。只读有界原文提取不等于全库一致备份。未删除其他文件或清理 Docker 来腾空间。
- 真实厂商重新采集、生产写入/部署、最终独立 code-review、CI 均 UNRUN，由父安排后续审查；本候选不关闭票据。

## 后续入库操作者完成检查

1. 留存本批原档、来源身份、查询时点、幂等键及预检；先处理冲突，提交一次正常完整原行批次。
2. 读回提交回执，分别记录 `written` 与 `summary.platformFields`。只有本批适格版本 `projectionsChecked == eligibleVersions`、零冲突且 `status=ready` 才有本批同步证明；不是所有字段非空。
3. 隔离观察另列，不能用总行数相等替代适格版本核对。缺编号/不可核实仍保留隔离；不猜填编号、年份或资格。
4. 在申报、关联办理、认定目录三个独立 API 按业务编号读回精确版本，逐项核对原文期望、关键筛选和版本详情。真正空值显示原文未提供；缺 ruleVersion 是业务字段未同步，需要维护。
5. 已提交旧键只返回历史回执；没有同步证明即历史未记录。纯 `reuseExisting` 是引用，不是 fresh 同步。历史修复用新键完整原行重放或保留的 `platformRecordObservations:[{relationId}]` 预检/提交；不直接写业务 SQL。
6. 补齐接口保持鉴权、批量边界、来源指纹与不可变冲突保护。失败先保留原回执和原档，修复根因后按约定重试，不覆写旧 canonical/hash、不改正式事件或人工决定。发现本批零缺口不能据此宣称全库零缺口。

## 实际原文有界验收补充

只读定位范围：当前 worktree `.env*`（仅 example，无本地 .env）、README/数据库路径配置、主检出 data、用户工作区 `production-docker` 的备份指针/compose 原生卷覆盖、运行容器 Mounts。旧 latest-backup-path 指向的文件已不存在；没有将旧宿主库当当前库。当前源为容器 `spztx-main-49133834-app` 的卷 `spztx-import-repair-20261107-state:/roster.db`，使用 Node SQLite `readOnly:true` 与单一 BEGIN/ROLLBACK 只读事务提取，时间 `2026-11-07T09:39:52.352Z`。没有备份整个源库；下面只是一致有界提取及重建的隔离样本，不等价于带原 ID/非空决定的整库副本。

`real-source.json` SHA-256 `dbce9f2d9229769005ffd6d6e98be5902f214a210f8bb060bd752ce66742ca74`；手写字面预期 `expected.json` SHA-256 `70e20cf46c39a9d7a3cd27ea7d094968e40f663c95f08f35bc07bb5e910a34cf`。二者均在外部证据目录。初次“隆兴”搜索匹配光隆兴业，已另存 `initial-ambiguous-source.json`，最终按宁波隆兴焊割全名收窄；不静默替换搜索事实。

| 企业简称 | 办理 relation/version | 目录 relation/version | 申报 relation/version |
| --- | --- | --- | --- |
| 隆兴 | 84612/326 | 58342/7799 | 58341/330 |
| 凯普 | 84605/46 | 58337/7793 | 58336/50 |
| 德业 | 102628/35265 | 73589/35267 | 73587/35257 |
| 固安力 | 114141/1489 | 83575/56078 | 83574/1490 |
| 博汇 | 84583/36 | 58323/7708 | 58322/39 |

复现脚本 `scripts/verify-598-platform-fields.mjs` 使用外部 source/expected/receipt 文件，要求 loopback 与隔离 token。对从原始行组装的受控 replay 封套执行真实生产产物 HTTP preflight/commit，再按业务编号读三张查询及精确版本详情；不是重新访问厂商，也不把受控封套当原采集完整性证明。办理空业务年全部保持 null。初次真实回放因把原 query 的多称号范围当单行 scope 被拒，保留 `real-http-initial-fail.log`；明确将受控 replay scope 限定为该行称号后通过，生产校验未改。

新鲜 PASS：一次混合入库 15 个适格版本；一致备份后构造 15 个缺投影，完整原行新键重放补齐；再次构造相同缺口，relationId 维护入口补齐；二者均逐项对照同一手写字面预期。最终脚本正常入口与维护入口各自同键重试回原回执。`real-readbacks.json`、`real-normal-repair.json`、`real-maintenance.json`、`real-normal-final.json`、`real-maintenance-final.json` 保留证据。

隔离样本使用 SQLite backup API 生成 `real-before-gap.sqlite`，SHA-256 `e661b750a9168e63f2dd5ecc455658983e9ff475236d4312cd752eaaeb88220d`。隔离库 query/relation/业务身份/内容版本/观察的前后完整快照 SHA-256 同为 `2a3cc0fd0cb9a8c30f35b5001a0433231a38b391caa44c3d515687d568136679`。重建样本获得新本地 ID；原 relation/version/hash 只在提取清单中保留追溯，不宣称已证明原库非空人工决定不变。

T3 preview 对这五家实际 raw 重建的三张列表分别在 1280px/390px 查看并操作称号筛选，证据 `real-browser.json`；单版本局限仍在。原库整库备份/原 ID 与非空人工决定的完整不变量、真实多版本浏览器、故障时外部原档保留、完整筛选组合仍阻断最终 AC 签收。

## 全套发现的范围内窄修

全套发现 `platform-declarations-ui.test.ts` 的 `keeps unknown values explicit instead of guessing a year or declaration kind` 仍精确要求旧文案“未提供”。独立复现 1 FAIL / 3 PASS：实际“原文未提供”，夹具 ruleVersion 非空，符合 #597。将三项精确断言更新为新契约，并增加状态列、移动卡片及排除“业务字段未同步”的断言，未降低覆盖或修改生产行为。最终重跑双入口 HTTP、申报 UI 与投影详情 UI：3 文件 / 8 项 PASS（`final-ui-fix.log`）。

全套还发现 logging-usability/field-policy HTTP、platform-business-record-candidates、record-comparison-evidence-ui 等范围外失败，具体用例和错误保留 `full-suite.log`。全套在验收文件增补期间启动，不能作为最终提交的不可变绿灯；最终定稿用例另有单独重跑证据。不将工作区诊断签成最终 SHA 全绿。

## 全套最终结果

`pnpm exec vitest run --root /Users/mang/.t3/worktrees/app/t3-683b7ec8 --maxWorkers=1` 最终退出 **1**，耗时 1496.66s：

- Test Files：7 failed / 456 passed / 2 skipped（465）。
- Tests：13 failed / 6927 passed / 52 skipped / 60 todo（7052）。

完整失败分组：comparison-input 六项、annual-process-load-more 两项、logging-field-policy HTTP 一项、logging-usability HTTP 一项、business-record-candidates 一项、record-comparison-evidence-ui 一项、declarations-ui 一项。最后一项已按上述窄修并在定稿后重跑通过；其余 **12 项仍未解决**，不推断重跑全套后的通过数。未再次运行 25 分钟全套，最终提交全套绿色认证 **UNRUN/阻断**。全套发现的日志 route catalog 差异、资源费用常量/上限、年度 reset 和对应证据链接均未在本票扩大修改。

最终新增/修正测试验收：15 文件 / 100 PASS 的定向批次，加定稿后 3 文件 / 8 PASS（有重叠，不相加冒称唯一项数）。生产源码未变，typecheck/build/生产 OpenAPI 退出 0 的证据来自本轮相同生产源码；没有把后续文档/测试提交伪称重建产物。

## 续作：固定候选与独立基线（2026-11-07）

在干净的 `/Users/mang/.t3/worktrees/app/t3-c4309b86` 从 integration `68121750` 快进到 PR605 `111568886a3ffed9b4a04a9db9be90c9eae589a7`（tree `b5c5af6f0a4e1362d0645b9c445cf208eabeec06`），再合入远程 integration，结果 Already up to date；未丢弃先前候选。续作证据目录 `/tmp/598-acceptance/completion`。先前报告中的 PASS 均为继承证据，以下才是本次新鲜运行。

- `normal replay and retained relationId repair expose the same literal fields without changing archived identities` 新增非空差异、人工对应及对应审计各一行，明确为独立受控决定，绝非原生产决定。正常重放、relationId 修复、同键重试及故障后逐行核对全快照；成功重试后再次核对三个决定表。非空断言先 RED（`nonempty-red.log`），夹具最初遗漏 audit.batch_id、故障封套时点未同步的 FAIL 均保留，未修改生产约束。
- 同用例把**实际提交的完整失败请求**保留为外部 `original-submission.json`；第三来源投影触发硬失败，验证新查询/关系/版本/观察无部分提交，三投影表均为零，数据库失败回执仍在。去掉隔离触发器后原键重试成功；外部原档逐字节不变、外部 failed-receipt 保持原失败内容。`final-controlled/` 保留 SQLite、一致备份、原档、失败回执及最终回执。它是本批受控采集原档保留证明，不冒称厂商原采集文件或 TUS 上传链证明。
- 最终定向 10 文件 / 68 PASS（`final-focused.log`）；typecheck、生产 build 和隔离产物 OpenAPI 检查 PASS（`final-typecheck.log`、`build.log`、`prod-openapi-2.log`）。OpenAPI 初次因不存在的隔离 DB 路径失败，保留 `prod-openapi.log`；改用已初始化隔离 DB 后重跑通过。没有改测试或生产校验。

### 实际样本与受控多版本浏览器

只读 SQLite backup API 将已有实际原文重建样本备份到独立 `browser.sqlite`，保留原验收库不变。五家企业 × 三来源各追加一个**明确标识的受控第二版本**，原始厂商版本保持；新增状态/有效期 `598-controlled-second-version`、年度 2027、事项复核是受控测试输入，不能当真实厂商事实。新增请求及 HTTP preflight/commit 均在外部 `second-version-*.json`。独立字面期望通过 30 个组合查询，核对每条业务两个版本、原版本与受控版本各自字段（`check-filters.mjs`、`combined-filter-http.json`）；初次用了错误的目录查询参数得到 400，未改生产契约，按现有 rddqrq/whpc/szq 契约重跑。

T3 preview 独立操作三页面、1280/390：逐项操作申报称号/事项/年度/状态，办理称号/事项/业务年/办理状态/维护批次，目录称号/有效期/维护批次/属地；打开各自版本详情，核对两个版本与不同字段原值。当前详情是同时列出各版本，未虚构不存在的版本下拉切换。各页又组合四个筛选：申报命中固安力/德业两条，办理命中固安力一条，目录命中固安力一条；窄屏卡片和桌面结果一致、无整页横溢。`browser-multiversion.json`、`browser-combined.json`。

在隔离样本再作一致备份 `browser-before-gap.sqlite` 后移除投影，三页各自1280/390均明确显示“业务字段未同步”（`browser-missing-projection.json`）；随后经公开 relationId 提交恢复（`browser-maintenance.json`），不是页面自动写回。真实原空字段及原版本见原始 expected 和详情证据。未改原生产库、原档、原15行验收库；无厂商重新采集。

### 十二项全套失败的独立对照

规格前主线固定 `c14ccb339c19b606b70c14c52a4d01fb859802ac` 独立 git archive 到外部 baseline（依赖复用，但源码、数据库及运行独立），先 nuxt prepare；首次缺生成 tsconfig 的基础设施失败保留。主线与 PR605 分别运行相同六文件，均 **12 FAIL / 231 PASS / 1 SKIP**（`baseline-failures-2.log`、`candidate-failures.log`）。未放宽断言或修改范围外生产代码；已有原票编号足够定位，本轮不制造重复跟进票。

| 文件/精确用例 | 两对象均复现的有界原因 |
| --- | --- |
| platform-comparison-input: budget428_raw7_4096；fee428_source_U_65536；fee428_policy_W_16777216；closure441_remaining_ID_M_isolated_A_W_charge；closure441_remaining_W_exact_16777216；closure441_remaining_W_one_over_16777217 | 相同计费边界漂移/资源上限；67517 对67487、7521对7491及两个W边界差额均在规格前主线存在 |
| annual-process-load-more-266: independent review: readback retry preserves refresh reset intent；keeps reset intent through repeated readback failures without submitting another job | 同一 undefined.trigger，年度 reset/readback 路径，不是三来源字段同步 |
| logging-field-policy-http: uses policy argument budget rather than the JSONRPC envelope and preserves production OpenAPI guards | 同一四条 /api/statistics/{annual,districts,movements,published} route catalog 差异 |
| logging-usability-180-http: accepts exactly the built application route templates and no other spelling | 同一 route catalog 集合差异 |
| platform-business-record-candidates: handles malformed raw and empty selection without reading unrelated archives | 同一候选查询 malformed JSON 异常 |
| record-comparison-evidence-ui: links the actual stored PDF page and saves comparison scroll before detail navigation | 同一 undefined link 断言，PDF出处跳转路径 |

### 整库备份容量阻断

本次只读核实 `/state/data/roster.db`：page_count=2833035、page_size=4096、freelist_count=1，即 11,604,111,360 字节。宿主初始仅余4.7GiB，后续约4.1GiB；无外接可写卷（只有 Macintosh HD/Recovery）。Docker df 的366GiB为虚拟磁盘可增长上限，不能据此认为宿主有足够物理空间。容器总内存约8GB，亦不能容纳完整内存备份。不尝试可能耗尽宿主的11.6GB写入，不删除用户文件，不修改源库。**仍需要提供至少12GiB可用的外部隔离目标路径，或释放足够容量，才能通过 readonly SQLite backup API 完成整库一致备份及完整原ID核对。**已有有界提取及小样本备份不替代此项。

### 每项 AC 当前处置

| #598 AC（按票面顺序） | 处置 |
| --- | --- |
| 1 有备份隔离旧版本缺投影 | 小样本 PASS；完整原库备份仍因容量 BLOCKED |
| 2 正常入库三来源/API/列表/筛选/版本 | 继承15行双入口事实；新鲜30组合API及六种页面视口 PASS |
| 3 relationId 原契约/上限/鉴权/重试与ID不变 | 继承原契约覆盖；新鲜双入口及浏览器恢复 PASS |
| 4 同组字面预期/幂等/漂移冲突 | 继承已冻结原预期及冲突回归；新鲜定向 PASS |
| 5 硬失败回滚与外部原档/失败回执/重试 | 新鲜受控批次 PASS，原文件逐字节保留，不等同厂商重采/TUS证据 |
| 6 并发重复/纯引用/旧回执 | 先前相应 focused 证据继承，最终回归另记，不冒称新鲜并发浏览器 |
| 7 身份/历史/非空人工决定不变 | 新鲜独立非空受控决定 PASS；原生产非空决定完整副本核对 BLOCKED于AC1 |
| 8 五家反例三页desktop390/多版本/关键筛选 | 新鲜实际原版本+明确受控第二版本 PASS；不是实际厂商多次采集证明 |
| 9 精确SHA/tree、证据及历史FAIL/UNRUN | 本报告和外部 final-test-input/final-candidate 回执；历史失败不删除 |
| 10 最终受影响/全套/typecheck/build/OpenAPI | 定向/typecheck/build/OpenAPI PASS；全套结果另记，不能称全套PASS |
| 11 如部署先备份/版本读回 | 未部署、未受控生产写入，条件未触发 |
| 12 操作者完成检查 | 上文清单保留，补齐入口继续存在 |

CI、厂商重新采集、生产写入/部署、父代理独立审查均 UNRUN。未 merge、close、改main或启动子代理。

进一步将受控非空决定明确复制进**实际五家原文与受控第二版本同一隔离库**，一致备份后构造缺投影，经公开 preflight/relationId commit 修复；查询/关系/raw/canonical/hash/业务ID/版本/观察、企业/正式事件/别名、人工对应/差异及审计完整快照前后相同（`actual-decisions-before.json`、`actual-decisions-after.json`）。这些决定仍明确来自 independent controlled fixture，不能宣称为生产既有决定。脚本 `actual-with-decisions.mjs` 和回执、修复前一致备份留在外部目录。

新增并发/MCP定向回归：`import-writer-contention`、`import-mcp-submission`、`platform-business-record-mcp-http`、`mcp-surface`、`platform-business-projection-mcp`、`platform-recognized-projection-mcp`，6文件/46 PASS，`additional-focused-2.log`。与10文件/68项分开计数。首次命令误用不存在的文件名得到 No test files found，`additional-focused.log` 保留，不计PASS。原始容量与哈希回执：`original-backup-capacity.json`、`host-capacity.txt`、`invariant-hashes.txt`。

最终全套固定测试输入提交 `b8b35b4c0e480724b6e8a65010f1d18c8fba8f03`、tree `9546ea1c4e64a259afe421f036f58eeba273d9ac`；后续仅报告变化，不冒称该提交包含未来报告。修改期间的诊断全套以130终止，`full-suite.log`保留；最终完整运行另存`final-full-suite.log`。

实际原文封套又执行同批外部文件硬失败链：`actual-file-failure.mjs` 将五家15行受控第二版本的完整请求先落外部原档，SQLite一致备份后注入第三来源硬失败，逐行核对业务快照不变、三投影零部分提交、失败回执仍在；移除隔离触发器后从**同一文件**以原键重试成功，文件与外部失败回执逐字不变，非空决定仍未改。`actual-original-submission.json`、`actual-original-failed-receipt.json`、`actual-original-success-receipt.json`。文件是含实际原文的受控回放封套，绝非重新从厂商下载的文件。

### 最终全套的实际结果与容量阻断

固定输入全套第一次退出1，但没有正常汇总，尾部大量文件为0 test，且额外报告 comparison-offmain HTTP FAIL；不能据此编造通过数。该HTTP及一个0-test文件 `file-parts` 定向重跑2文件/30PASS（`final-runner-diagnostic.log/json`），未复现，根因仍UNKNOWN，不能抹去全套FAIL。

随后同固定输入、同单worker、不排除测试，改JSON报告器再跑（`final-full-suite-2.log`）。运行约6分钟时宿主余量降至约434MiB，而本轮外部completion目录仅141MiB。为防止继续测试耗尽宿主磁盘，向本轮精确Vitest进程56992发送SIGINT，保留原日志；不删除用户文件。该次完整套件完成状态为**BLOCKED/未完整执行**，不是PASS。最终全套完整汇总与整库备份都需要先有足够可用容量；提供至少12GiB的外部备份目标并恢复测试磁盘余量后可续跑。`final-host-capacity.txt`保留容量证据。上轮6927PASS/13FAIL及其后窄修一项的历史事实原样保留；12项相同基线失败已有本轮独立对照，不推算最终全套通过数。

## 磁盘恢复后最终续作（2026-11-07）

本轮在 `/Users/mang/.t3/worktrees/app/t3-558b83c8` 干净隔离 checkout，将 `68121750` 安全快进到既有 PR605 `aa297387b7a806ebe11e8205dce46e6419b484d4`，tree `59448105138460281d6d32eaae94f799bb34d05d`；fetch/merge 最新 integration 为 Already up to date。未丢弃旧候选。原报告及 `/tmp/598-acceptance/completion` 均存活；外部 `evidence-inventory.json` 登记现存非数据库证据字节数与 SHA-256。浏览器 JSON 可解析，多版本38条、组合筛选6条、缺投影6条，均覆盖三页面1280/390；本轮无生产源码、UI或测试变更，沿用前轮准确对象和受控第二版本边界，不重跑浏览器、不冒称新鲜交互。

新证据目录：`/Users/mang/Workfile/598-resume-20261107`，在 Git 外。磁盘初始58GiB可用，解除上轮容量阻断，不抹去其 FAIL/UNKNOWN/中断事实。

### 完整原库一致备份及原ID核对

原源容器 `spztx-main-49133834-app`，卷 `spztx-import-repair-20261107-state`，路径 `/state/data/roster.db`。Node `node:sqlite` 的 `DatabaseSync(...,{readOnly:true})` + `backup()`，UTC `2026-11-07T13:18:47.622Z` 至 `13:20:17.781Z`，2833035页；导出为外部 `original-consistent.sqlite`，11,604,111,360字节。宿主只读 `PRAGMA integrity_check` = ok，SHA-256 `e7c36cba6b2afc3b424b0322756c4454c4dd69a8aa5daf43d28b5e41204f570b`；验证时间13:21:30–13:23:15 UTC，逐表行数保留 `backup-integrity.json`，包括 difference_reason=1449、record_correspondence=46682、record_correspondence_audit=58139。未写原源或生产服务，未复制裸活动DB替代备份API。

以 APFS `cp -c` 建立独立 `repair-isolated.sqlite`；已验证备份保留不变。`full-original-repair.mjs` 冻结前述五家15个原 relationId/versionId，按这些版本仅删除隔离副本投影，再通过 loopback 生产产物公开 preflight/relationId commit、同键重试恢复。原ID映射与请求/回执见 `full-original-mappings.json`、`full-original-{request,preflight,commit,commit-retry}.json`。12张表全部按 rowid 流式 JSON 行加换行计算 SHA-256 和行数，前后逐表完全一致：query、relation、business record/version/observation、enterprise、record/event、alias、correspondence、difference、correspondence audit（`full-original-before.json` / `full-original-after.json`）。本轮因此覆盖真实非空既有决定与完整原ID，不再仅靠受控决定夹具。入库批次/维护回执是预期新增，不在不变量表中。

`full-original-readback.mjs` 从三独立查询API及版本详情定位原 versionId，对原 `expected.json` 的15条独立字面预期逐字段核对 PASS（`full-original-readbacks.json`）。初次脚本把 DTO versionId 误写为 version.id 的 TypeError 保留 `full-original-readback-initial-fail.log`，修正脚本后通过；未改生产契约。没有将这一历史补齐操作冒称正常采集或厂商重新采集；日常完整原行双入口/失败回滚仍由前述固定样本证据支持。

### 本轮检查与AC处置增量

同一固定 aa297387 源码新鲜 typecheck/build 退出0（`typecheck.log`、`build.log`）。生产 OpenAPI 首次误用 DATABASE_URL，启动因目录不存在失败（`openapi.log`）；改用既有隔离库 NUXT_DB_PATH 重跑退出0（`openapi-2.log`）：三文档端点404、health/jobs kinds 200。未访问生产HTTP。

AC1 的全库备份容量阻断已解除，原ID隔离副本负例和修复PASS；AC7 新鲜全量不变量含真实非空决定PASS。AC2–6沿用已冻结的实际/受控双入口、并发、MCP、失败回滚证据，原ID维护入口与精确版本读回为本轮新增PASS。AC8沿用前轮三页六视口的实际原文+明确受控第二版本交互；AC9证据存活与精确对象如上；AC11未部署/未生产写入，条件未触发；AC12操作者清单继续有效。AC10最终全套结果在下文单列，不把已知基线失败签成全套绿色。

### 最终全套正常完成与有界交付

命令：`pnpm exec vitest run --root /Users/mang/.t3/worktrees/app/t3-558b83c8 --maxWorkers=1 --reporter=default --reporter=json --outputFile=/Users/mang/Workfile/598-resume-20261107/full-suite.json`。固定生产/测试输入 aa297387 / tree59448105；运行期间仅追加本报告。退出 **1**，1564.60s，**6 failed / 457 passed / 2 skipped files（465）；12 failed / 6928 passed / 52 skipped / 60 todo tests（7052）**。`full-suite.log/json/exit` 和精确 `final-failures.json` 保留。双入口HTTP与申报UI本轮全套均PASS。先前 comparison-offmain 额外全套FAIL本轮PASS，不追溯抹除其UNKNOWN或中断历史。

精确12项与上文独立规格前基线 `c14ccb339c19b606b70c14c52a4d01fb859802ac` 的六文件12FAIL逐项一致：comparison六项、annual两项、logging-field-policy一项、logging-usability一项、business-record-candidates一项、record-comparison-evidence-ui一项。本轮未引入新测试失败；不是全仓绿色保证。保持原错误/断言，未修范围外资源预算、年度读回、日志路由目录或PDF链接。前轮baseline与candidate各12FAIL/231PASS/1SKIP为继承证据，本轮全套为新鲜证据，不混称baseline全套也重跑。

AC10 规定检查均已执行完成；全套红灯由上述确认的基线失败阻断无条件绿色签收，交父代理决定是否按有界已知失败接受，不由实现者豁免。其余本票可执行验收已具证据：AC1/7原容量和原ID/真实非空决定缺口已补齐；AC8保留实际原文加受控第二版本的真实浏览器边界。厂商重采、CI、父代理独立审查、生产写入/部署仍UNRUN；后两项不在本轮授权。没有merge/close/main/deploy，也未启动子代理。

收尾再次 fetch并merge `origin/integration/595-atomic-platform-fields`，仍 `681217505fe9a13c4bc26b4d539e86aa2277d0d4` / Already up to date。最终新提交仅本报告；最终head/tree写入外部 `final-candidate.txt` 并随PR605交付，不把报告提交冒称已重新执行所有测试。操作者仍须逐批按前述清单读回，不能把本次选定15版本维护或历史整库备份当未来批次完成证明。
