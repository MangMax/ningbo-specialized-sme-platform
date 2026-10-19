# Spec #98：九个切片的本地集成交接

本轮共享 checkout `/Users/mang/.t3/worktrees/app/t3-c2a8481c`，分支 `t3/implement-spec-98-perf`。最终功能合并提交 `a9409cb9a3676aa92b37078c13313587dbee1bb0`；其后本文件为文档提交。原始日志、最终 gate 的准确源码 SHA/tree/状态和外部交接报告保存在 Git 外 `/tmp/ningbo-spec98/merge-101-104/`（目录名沿用最初队列，现包含102/103）。以 `source-sha.txt`、`gate-results.json`、`handoff.md` 为最终运行结果，不把早期候选日志提升为最终验收。

## 保留的叶提交与顺序

父线程已集成五票，本轮依次 no-ff 合入101、104、102、103；九个叶提交均保留：

- #100 `8b55dfec23fd6eae60378dd3007bc2845290525e` → merge `92f694e8e0cdcfda56a246b521d010ca90330d2f`。
- #96 `905c5bb0ef8b28fda268397ae60c0c424c81294e` → merge `7950c6fdedc5d869eb4c0406e854a481739e1f95`。
- #99 `84a0637c26641f88c918c83d884cdd6ed81203d9` → merge `f31f57b5a097223f15e7d596961af9d4ea8c6693`。
- #105 `62291bdcdefa7094fbaebf3c88b10ec7ed01d5d6` → merge `3bdc7a482c430631806e42de54d99743d76a3541`。
- #106 `f9c9ed592f966896ac7d56d0ed63ddcf0fb62ba7` → merge `4586bf09db80320855bf5f2c4fb8597b8b55364a`。
- #101 `519f98eacfebbd90304d78af92fb816ceb9f6863` → merge `1e0c45ea6b20f2e455be2b9eba576d6f31736090`。
- #104 `b3738c85b45d292b46f97c5f4cfdfb80e180d7a5` → merge `29e46102bc9be1f7e001a96d351a8a69c4ee978a`。
- #102 `3ab2f3a779f3a7a4e67f0bf68f4c7d0e236c31a6` → merge `5a0e3f0880d259a1a5e49b6f818f30f6d5d204cb`。
- #103 `c1f4465a9200f49a533de00b745dcb91e21dcc40` → merge `a9409cb9a3676aa92b37078c13313587dbee1bb0`。

## 执行顺序纠正

本节明确覆盖早期 brief、coordination 和101冻结交接中“按数字tag排序/idx17、21、22”的建议。虽然未部署，也须支持已经执行中间版本迁移的本地数据库。Drizzle 用已应用的最大 `created_at` 与 journal 的 `when` 判断新迁移；将新0017/0020放回旧0021/0022前会直接跳过，不能用“未部署”排除此升级路径。

保留4586bf0的全部19条 journal 对象，包含原顺序、idx、when、tag、version、breakpoints。保留SQL原文件名与内容，不重生snapshot。追加顺序如下：

- 既有0021：idx17，when1792380000021。
- 既有0022：idx18，when1792380000022。
- 新0017：idx19，when1792380000023。
- 新0020：idx20，when1792400021001。
- 新0018：idx21，when1792400021002。
- 新0019：idx22，when1792400021003。

SQL编号不是执行顺序。以后新迁移同样追加到当前末尾，并使用大于当前最大值的idx/when。既有条目不得重排或改时间。0017和0020各自晚于0021/0022，且0020晚于0017。

`red-101-intermediate-upgrade.log` 是本轮新增永久升级回归在错误0017顺序下的失败：已经应用0021/0022后，公开精确读取得到internal_error。`green-101-intermediate-upgrade.log` 为修正后fresh、baseline、integration-upgrade三项通过。104原mutation日志在其票据目录，父线程已检查；本轮真实文件维护13项在集成0017后通过。

`migration-smoke.mjs` 用真实 Drizzle migrator 与隔离SQLite，覆盖fresh、4f910f6、4586bf0、post101-before20、post104-before18/19、post102-before19。旧迁移SQL逐字从对应Git提交提取。升级前种入旧正式出处、对应/证明审计、文件/解析段/OCR、差异、96/99/100审计；适用时再种入解析回执、event revision=5、OCR revision=7、101审计/回执、104维护审计和102已接管元数据。逐表比较所有原列/原行与ID，旧ledger逐条相同、旧索引/trigger不变；最终23迁移齐全、完整性/FK通过、无相同索引键；再次运行migrate时所有业务行及ledger不变。不补造旧导入原文或历史回执。

## 共享冲突与行为证据

- 101的修订helper保持 `advanceOfficialEventRevision`。`keeps direct and predecessor confirmations stale after atomic coordinate ABA`、同名legacy变体，以及 `advances one event revision per changed atomic batch and never for noops replay or dry runs` 验证直接/前序对应防ABA、每原子批次每改变事件一次修订、旧入口每改变行事务一次、noop/replay/dry-run不变。失败回滚由 `rolls back every coordinate audit and receipt if a later write fails` 验证。
- recordEvidence同一个schema回调保留event、105 source、101 coordinate三个索引；前序索引仅保留100已有的一份。升级烟测查真实索引列和重复键。
- 104保留exact baseline REST/MCP载荷及返回体，现代封套部分缺失不能降级。直接证据是 `accepts exact baseline REST and MCP payloads and invalidates modern revisions after legacy writes` 与 `rejects partial modern envelopes without downgrading to legacy blind writes`。恢复/引用字节保护覆盖在同文件其余公开用例。
- 102的未接管旧curated协议和原返回体保留，已接管及撤回后409，同名歧义409。证据为 `preserves the public legacy PATCH payload output and note omission semantics without creating a decision`、`rejects ambiguous legacy identities without selecting or adopting an enterprise`、`blocks only the explicitly adopted legacy coordinate even after withdrawal and preserves both stores on conflict`。原curation路由回归保留。
- roster-import.ts自动合并同时保留102规划/执行期接管守卫、103 processing和终态回执事务包装、99 alias-safe executeMerge。没有将原提交体改成request/planHash。
- 新组合回归 `rechecks lifecycle ownership inside legacy import execution and preserves failed receipts across atomic rollback and retry`：执行期触发接管，整批平台写入与接管行回滚，真实REST/MCP读取failed回执和decision_lifecycle_required逐项结果；解除故障后同键提交成功，旧failed回执逐字不变，历史failed→committed，已提交重发不追加回执。
- MCP instructions冲突取并集：差异生命周期、正式事件/出处、文件维护、解析/OCR和回执说明都保留。保留decision/parse/event/platformQuery原始RPC严格校验及enterprise admission；protected名单保留所有旧/新增工具。回执四个read工具需凭据并保持readOnlyHint=true。
- 103原黄金只增加99/100的7个默认值；本轮又因102新增8个nullable字段，仅追加旧differenceReason行的8个null。首次联合运行54过/1失败，失败仅该黄金差异。修正后逐字段去掉这8项与103原黄金深比较相等，证明原值、outcome、行数和摘要未变，见 `golden-delta-proof-102.json`。未修改记录器、删除断言或重生其他黄金。

## 最终本地 gate 与边界

最终joint命令记在 `commands.json`，限定event/evidence/legacy-pages/file-maintenance/parse/OCR/lifecycle/curation/receipts/import/alias/MCP相关文件，始终 `--maxWorkers=1`；不是全套测试。typecheck优先正常命令；若出现已有VueRouter插件解析警告，追加 `NODE_PATH=$PWD/node_modules/.pnpm/node_modules pnpm typecheck`，使用现有插件，不改依赖。准确SHA、命令、退出码和统计以Git外gate-results/handoff为准。

未运行本轮fullsuite、build、重型性能、浏览器、生产、部署、push、PR操作、main合并或额外委派。PR107仍由父线程负责。冷enterprise样本1120ms的归因仍未完成；本轮未调性能或预算，不把小夹具有界性当容量/SLO验收。最终全套、构建、review与串行性能测量由父线程继续。
