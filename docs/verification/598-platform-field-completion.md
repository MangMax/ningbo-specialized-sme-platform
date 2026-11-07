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
