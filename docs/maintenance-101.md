# #101 正式出处精确更正与页码兼容

范围：#98 的正式出处切片；不更改原母票 #34，不操作生产，不部署、不合并 main。事件字段更正由 #100 负责。企业、记录、事件、证据 ID 和源文件字节保持不变。本操作不自动判断业务事实。

## 公开使用步骤

1. `GET /api/roster/evidence/:id`（MCP `get_roster_evidence`）精确读回 `evidenceId,eventId,recordId,enterpriseId,coordinate,file,revision,version,sourceHref`。来源缺少注册文件身份时 `file=null`，不会猜文件。
2. `POST /api/roster/evidence/corrections/preflight`（`preflight_roster_evidence_corrections`）提交下述 request。返回 `targets` 的旧/新坐标、旧/新文件身份及实际 PDF 页数、相关对应数量、影响和 `planHash`；预检不写业务或计划账本。
3. `POST /api/roster/evidence/corrections/commit`（`commit_roster_evidence_corrections`）提交 `{request,planHash}`。提交前重读文件并重新规划，在 SQLite immediate 事务内整批校验、写坐标、追加审计、保存回执。任一条失败全部回滚。
4. `GET /api/roster/evidence/corrections/batches/:key`（`get_roster_evidence_correction_batch`）恢复精确回执；或重放原 request/planHash，返回同一回执。同键不同请求或计划为 409。已提交重放不依赖源文件仍可访问。
5. `GET /api/roster/evidence/:id/audit?page=1&pageSize=50`（`get_roster_evidence_audit`）读取追加历史，按审计 ID 升序，默认 50、最大 200，page 最大 1000000。越界空页保留 total；不默认读取文件/平台原文。

读回和审计公开只读；预检、提交、回执恢复需要配置的 REST `NUXT_API_TOKEN` 或 MCP `NUXT_MCP_TOKEN`。未配置即关闭。MCP 未授权时隐藏受保护工具并对强行调用返回 HTTP 401。所有新响应 `Cache-Control: no-store`。新工具描述和开发期 OpenAPI 均公开完整请求字段；生产 OpenAPI 隐藏策略沿用现有实现。

```json
{
  "idempotencyKey": "verified-evidence-correction-1",
  "actor": { "type": "agent", "id": "reviewer-identity" },
  "basis": "已逐页核对公布原件，附件二名单序号22实际位于第2页",
  "operations": [{
    "evidenceId": 123,
    "eventId": 456,
    "recordId": 789,
    "enterpriseId": 90,
    "expectedVersion": "从精确读回取得的64位小写SHA256版本",
    "coordinate": {
      "sourceFile": "jxj/announcement/verified.pdf",
      "attachment": "附件2",
      "listNo": 22,
      "page": 2
    }
  }]
}
```

`operations` 为 1–100 条。每条必须给完整坐标，未知附件/序号/页码显式 `null`，不把缺值猜成 1。`sourceFile`、actor.id、basis 最长 4000 字符，key 最长 200。ID 必须对应同一既有 jxj 正式证据/事件/记录/企业。裸名单序号不能定位证据，重复证据 ID 拒绝。版本绑定既有坐标、事件与所属记录信息、注册文件身份、最新更正审计 ID，因此本服务的改回旧值也不会恢复旧版本。

目标必须是同称号（文件称号已知时）、在用、注册的 jxj announcement 文件，核对实际字节数与 SHA256。哈希流式读取，只读指定文件；PDF 页数复用现有 `readPdfPageCount`，PDF 引擎仍会物化所选原件，不能把流式哈希声称为整个 PDF 路径恒定内存。非 PDF 页码只能 null；PDF 非空页必须有可读原件页数，且位于 1..pageCount。

附件沿用 `normalizeAttachment`，不把“附件”推成“附件1”。已声明段存在时，附件必须唯一匹配称号、事件类型、所涉年份、批次且无段冲突。无已声明段时只保存显式人工依据，不自动造段。按文件、附件、名单序号及事件类型/年份/批次检查库内和同批坐标冲突；多年份分节的重复序号仍合法。每文件最多检查 1000 个声明段、每目标最多 100 个既有同序号候选，超过上限明确拒绝，不能截断后猜测。

错误：400 请求不完整/不合法；401 鉴权；404 目标/回执不存在；409 `stale_version`、`file_changed`、`plan_mismatch`、`idempotency_conflict`；422 归属、附件、文件类别、页码、重复目标或坐标冲突。异常 500 不返回 SQL 或文件系统详情；整批坐标/审计/回执均不留部分结果。

## 旧入口兼容与对应重核

`POST /api/roster/evidence/pages` 保留 `entries,dryRun` 输入、`applied/dry_run`、summary/assignments/pending 输出、裸序号拒收、歧义待核和逐行部分应用，不改成全批原子。旧协议不要求注册文件或新增 actor/key/version；审计以明确的 `legacy` actor 标记适配器，缺 basis 时记录“未提供依据”，不伪造核对人。既有相同页码重放仍为空操作，不新增审计。

旧定位规划继续使用原规则；已接受条目转成稳定证据 ID 后调用与新入口同一个坐标写服务。PDF 页数、实际文件身份校验共用源读取/校验服务；dry-run 与 apply 一致检查注册身份漂移，失败保持旧 pending 信封。本请求每个源文件复用一次哈希/页数检查；原定位规划仍按来源范围读取候选，未在本票替换其兼容协议。旧页码规划还会先读一次 PDF 页数以保留原 page_invalid/page_count_unknown 原因；没有宣称旧路径只解析一次 PDF。

不直接修改对应状态或历史。复用 #100 的 `advanceOfficialEventRevision(tx,eventId,expectedRevision)`：新原子批次每个实际改变的事件只加一次修订，旧入口每个实际改变行在其独立事务内加一次；空操作、幂等重放和 dry-run 不加修订。修订与坐标、审计、回执同事务，失败一起回滚。新修订进入 #100 已接入的直接事件及前序事件来源指纹，坐标 A→B→A 仍保持待重核。证据自己的审计修订只足以拒绝旧更正计划，单靠它不能防止旧对应确认复活。#100 的 revision=1 适配保留升级前的旧来源指纹；后续修订只增不减。现有动态来源指纹包含正式事件、全部出处坐标和文件身份；更正后已确认边保留历史 confirmed 值，但 `requiresRevalidation=true`，不得当作仍有效的确认。复核后通过现有对应预检/提交的同边 `action:correct` 和 expectedRevision 显式重核，追加来源审计；不能对 confirmed 边直接重复 `decide:confirmed`。新旧页码更正均有真实接口测试证明此行为。范围证明的既有动态来源校验同样不绕过。

## 存储与性能边界

迁移 `0017_evidence_corrections.sql`；集成 journal `idx=19,when=1792380000023,version=6`（追加在既有0021/0022后）。只新增：

- `evidence_correction_batch`：主键幂等键，保存请求哈希、计划哈希和有界回执。
- `evidence_correction_audit`：证据/事件 ID、入口、actor、basis、时间、旧/新坐标和文件身份，追加历史；索引 `(evidence_id,id)` 支持最新修订及分页。
- 非唯一 `record_evidence_coordinate_idx(source_file,list_no,attachment)`：缩窄冲突候选，不改变旧数据唯一性。EXPLAIN 证明命中覆盖索引。
- 前序影响计数复用 #100 迁移0016已有的 `record_correspondence_predecessor_idx(predecessor_event_id)`，与原 event 索引组成 OR 范围计数；#101不重复创建索引，不物化 provenance。

不生成无关 migration snapshot，迁移不回填或改写既有业务事实和源文件。集成 journal 按追加顺序执行，SQL 文件编号不是执行顺序；保留4586bf0既有条目的idx、顺序及timestamp，0017以大于既有最大值的新idx/timestamp追加，确保中间版本数据库升级。两个读入口在只读事务快照内组合坐标、修订和分页总数；提交不使用共享缓存；成功写后旧动态指纹读取立即可见。

`tests/evidence-correction-101-bounded.test.ts` 在真实 HTTP 适配器和隔离 SQLite 下观察真实驱动 `get/all` 返回值，不替换结果。固定目标、210 条历史，第5页/pageSize50。无关数据按 0/200/1000 个事件+出处+平台查询+关系+对应逐步增加；每个增量行有 raw_response=12288B、raw_fields=12306B、provenance=12306B，总原文字段 36900B。1000 行总 36,900,000B 原文字段。每级每入口 1 次，仅验证物化不随无关数据增长，不推算可靠尾分位。

测量来源 SHA 和原始结果在下述验证记录中。结果三档一致：精确读 3 次 SQL、3 行/241B，响应667B；单条预检 7 次 SQL、5 行/354B，响应1099B；第5页审计5次SQL、14行/3329B（含10条历史），响应4125B。这里的字节为驱动实际返回值的字符串UTF-8+数字8B估算，不是 SQLite 读页/I/O 或堆/RSS。raw_response/raw_fields/provenance 的查询投影与物化次数均为0；不代表调用方显式请求原文的开销为0。大历史/深页仍有索引计数和 offset 遍历成本，本票未宣称任意深度恒定时间。

未跑完整业务分布2x/5x、受控1vCPU/4GiB、长时混合负载、生产、浏览器视觉/交互验收。本票无UI改动，不新增桌面/390px验收声明；来源导航通过实际 href 参数及原文件 HTTP 字节哈希验证。

## 验证与证据

全部日志位于 Git 外 `/tmp/ningbo-spec98/ticket-101/`。四组主要红绿：

| 切片 | Red | Green | 可观察失败与结果 |
| --- | --- | --- | --- |
| 精确读取/预检 | red-exact.log | green-exact.log | 原URL返回HTML；新增JSON精确目标、旧新坐标/文件/页数 |
| 原子提交/审计/回执 | red-commit.log | green-commit.log | 原提交入口不存在；稳定ID、追加审计和幂等读回 |
| 真 MCP 工具调用 | red-mcp.log | green-mcp.log | 原tools/list缺工具；鉴权、发现和REST对等 |
| 旧入口审计适配 | red-legacy.log | green-legacy.log | 原旧入口写页但审计为空；部分应用和统一审计 |

另有 red-contract/green-contract（可用 OpenAPI；重核用例初次误用旧API状态转换，按现契约修正为same-edge correct）、red-legacy-validation/green-legacy-validation（dry-run注册身份校验）、red-attachment-conflict/green-attachment-conflict（冲突段不得当有效附件）。另有 `red-aba-after-100.log` / `green-aba-after-100.log`：真实接口证明新旧坐标恢复A时直接和前序确认曾错误复活，接入共享修订后保持待重核，并证明once/event、noop/replay/dry-run规则。保留全部历史失败，不用最终通过覆盖原始证据。

| Requirement | Evidence |
| --- | --- |
| 精确目标、旧新坐标、文件身份/页数 | `preflights the exact evidence and event with old and new coordinates and file identity` |
| 裸序号、归属和依据拒绝 | `rejects bare locators mismatched owners and missing basis without changing evidence` |
| 文件、页数、附件、四字段更正与来源字节 | `validates PDF limits file identity and declared attachments and changes all coordinate fields` |
| 库内/同批冲突、不唯一目标整批拒绝 | `rejects database and same batch coordinate conflicts and duplicate evidence IDs atomically` |
| 版本/并发与幂等冲突 | `serializes competing commits and detects external connection changes and key reuse` |
| 中途写失败整批回滚 | `rolls back every coordinate audit and receipt if a later write fails` |
| 稳定ID、actor/basis/时间/前后审计、回执恢复 | `commits atomically with stable IDs and durable audit receipt and replay` |
| MCP/REST对等与权限 | `exposes equivalent authenticated correction tools and bounded audit over real MCP` |
| 旧部分应用、重放及共享审计 | `keeps legacy partial application and records the same coordinate audit`；原17个旧页码HTTP用例 |
| 新旧来源校验一致 | `shares registered source validation between legacy dry run apply and exact correction` |
| 对应失效和显式重核 | `marks confirmed related correspondences stale and permits explicit revalidation` |
| 坐标ABA后直接和前序确认不得复活 | `keeps direct and predecessor confirmations stale after atomic coordinate ABA`；`keeps direct and predecessor confirmations stale after legacy coordinate ABA` |
| 每事件一次修订；空操作/重放/dry-run不变 | `advances one event revision per changed atomic batch and never for noops replay or dry runs` |
| OpenAPI、异常JSON、限额、401/no-store | `publishes actionable OpenAPI coordinates and rejects unauthenticated or malformed requests` |
| 全新库与从0013升级后公开读写、ID/修订/索引保留 | `executes evidence correction migration and public writes on fresh SQLite`；`executes evidence correction migration and public writes on upgrade SQLite` |
| 无关数据增长、SQL行/字节与原文排除 | `bounds fixed evidence preflight and history materialization across unrelated source growth` |

合入 #105/#106 前的执行代码和公开契约验证 SHA：`dd6e3e2282a27d8a39ee4eb3ac722ace94041454`，已合入集成 `f31f57b5a097223f15e7d596961af9d4ea8c6693`（含 #96/#99/#100），该来源只证明当时集成状态，不升级为后续合并证明。分支 `t3/ticket-101-evidence-legacy-compat`，worktree `/Users/mang/.t3/worktrees/app/t3-e3bb583b`。

- `verification-dd6e3e2.log`：`pnpm test` 显式运行本票2文件、旧页码API/页码规则/出处收敛、MCP面、对应API/core/bounded及#100事件更正，共10文件/150测试通过，无跳过。所有测试 `--maxWorkers=1`，Nuxt独立构建目录/随机保留端口。
- `typecheck-dd6e3e2.log`：`pnpm typecheck` 退出0；`build-dd6e3e2.log`：`pnpm build` 退出0。
- `materialization-dd6e3e2.json`：内嵌测量来源完整SHA；0/200/1000分布的SQL行/字节、响应字节、原文字段投影及两个EXPLAIN计划。与上文报告一致，未运行重型容量基准。
- 本票最终15个真实Nuxt HTTP/MCP用例、1个有界HTTP/驱动物化用例；原17个旧页码HTTP用例也包含在最终150测试中。原9用例历史绿日志 `validation-initial.log`，原17用例早期证据 `green-legacy.log`（该次同跑4个本票用例，共21）；另保留最终独跑 `legacy-17-dd6e3e2.log`。
- `verification-4cb3440.log` / `build-4cb3440.log` 是合入#100前的旧候选证据，只代表当时136测试/构建，不是ABA修复后证明；`verification-4adb6f7.log` / `typecheck-4adb6f7.log` / `build-4adb6f7.log` 为代理说明补齐前的后ABA候选。保留各自SHA边界。

没有创建PR、部署、生产数据变更、main合并或关闭母票。父代理负责集成审查和全量/容量验收。


## 冻结集成交接补充

按父代理明确要求，停止追逐验证期间继续前进的集成分支。实际 `includedIntegrationTip=4586bf09db80320855bf5f2c4fb8597b8b55364a`（含请求的3bdc7a4/#105及调用合并时已纳入的#106），执行候选 `a2d50dbf02027a8f6163ec8e056ff79abb3f9986`。交接后继提交只补本文档；未来交叉冲突由合入代理负责。

合并时将record_evidence的事件索引、#105来源索引和#101坐标索引保留在同一个schema回调；0017 timestamp仍1792380000017，journal按tag去重和timestamp排序，idx保留17/21/22并允许间隔，18/19继续保留给#102/#103；pre0014不变。验证从0013既有业务行升级及全新库，均实际执行全部迁移并通过HTTP完成精确读回、预检、更正、修订+1、稳定ID和外键/三索引检查。不声称可把较早timestamp的0017补跑进已经执行0021/0022的实验库；新迁移尚未部署，最终timestamp编排由父集成merger统一。

聚焦命令为 `pnpm test tests/evidence-correction-101-migration.test.ts tests/evidence-correction-101-http.test.ts tests/evidence-correction-101-bounded.test.ts tests/roster-event-correction.test.ts tests/roster-evidence-pages-api.test.ts tests/mcp-surface.test.ts --maxWorkers=1`。6文件覆盖15个本票Nuxt公开用例、2个fresh/upgrade、1个有界读取、11个#100、17个旧页码、28个MCP面用例；MCP真实tools/call穿过合并后的parse/OCR/鉴权联合校验器。本次不重复全150测试或构建，保留dd6e3e2的原始证明边界。最终原始日志 `focused-a2d50db.log`、`typecheck-a2d50db.log`，物化结果 `materialization-a2d50db.json`（嵌入完整源SHA），均在 `/tmp/ningbo-spec98/ticket-101/`。通过结果见该SHA对应的原始日志；未将历史dd6e3e2的150测试/typecheck/build/物化升级为本次merge证明。

## 最终集成纠正：追加执行顺序

本节覆盖上文历史冻结交接中的数字顺序/idx17/21/22建议。4586bf0已有条目（含0021 idx17、0022 idx18及其时间戳）全部原样保留。新0017追加为idx19/when1792380000023；随后0020必须以更大idx和when追加。SQL文件名保持0017/0020，编号不是执行顺序。即使尚未部署，也必须支持已运行4586bf0或合入0017后实验库的升级。新增永久回归 `executes evidence correction migration and public writes on integration-upgrade SQLite`，验证已应用0021/0022后新增0017的公开读写、原ledger保留及迁移重复执行无变化。原错误顺序的失败日志在 `/tmp/ningbo-spec98/merge-101-104/red-101-intermediate-upgrade.log`。完整联合升级证据见最终集成文档。
