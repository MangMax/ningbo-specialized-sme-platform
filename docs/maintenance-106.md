# #106 OCR 页结果生命周期对等

实现范围：派生 OCR 页结果。文件稳定 ID 与显式页号定位；正式出处、台账、来源文件和页图不是本能力的修改对象。单页重做由调用方读取页图、识别/校对后按页写回；不调用整份在线 OCR、不清空其他页，不新增自动业务判断或 UI。

本文继续说明既有页级 REST/MCP 的版本、鉴权、响应与 legacy 兼容协议。在线 OCR 任务的发布与恢复由[在线 OCR 发布与恢复（#309）](ocr-publication-309.md)承接：提交时冻结目标页输入与版本，发布前重核，全部目标可写才发布该文件，未列出的历史页保留；持久检查点 `job.result.publication` 与恢复账本 `job.result.ocrRecovery` 保留采集和尝试记录，unknown 不自动重复付费。具体恢复条件与边界见后继文档；#309 不替代本页的页级接口协议。

## 当前公开契约与代理用法

代理 REST 入口：`/api/files/{id}/ocr-pages/{page}`，`id` 为 `stored_file.id`，`page` 为 1–2000 的整数。

- `GET`：无需 token，返回与 MCP `get_ocr_result {fileId,page,includeVersion:true}` 相同的 `file/page/pages/markdown/results`。`results[].version` 为不透明页版本，`markdown` 是规范页标记导出；不存在结果为 404。
- `PUT`：需要 `Authorization: Bearer <NUXT_API_TOKEN>`（或 `X-API-Token`），请求 `{markdown, expectedVersion, engine?, model?}`（版本必填）。只覆盖路径指定的一页；拒绝额外字段/查询参数；页体不能再含整行页标记。返回实际写入页、源 PDF 页数/页图探测与 warning。
- `DELETE`：同上鉴权，请求体 `{expectedVersion}` 必填。返回 `{file,page,deleted,remaining}`；`remaining` 是本文件剩余 OCR 页数。不存在页用 `expectedVersion:null` 删除为 200 / `deleted:0`。

MCP 复用 `get_ocr_result` / `save_ocr_result`，新增 `delete_ocr_result`（必填 `expectedVersion`）。现代读取显式给 `includeVersion:true`；旧 get 默认保留原元数据形状，不自动新增版本字段。写入和删除需要 **MCP** token (`NUXT_MCP_TOKEN`)，未鉴权在 `tools/list` 中隐藏，强行 `tools/call` 为 HTTP 401；API/MCP token 独立。两种引用 `fileId` 与兼容 `relPath` 恰给其一。删除 `page` 必填；写入省略 `page` 时必须在 markdown 中显式列出页标记，且只覆盖列出的页。覆盖率可读既有 `GET /api/ocr-results?fileId=ID` 的 `count/pages`；精确读回给 `page`，不会读取其他页正文或 raw。

调用顺序示例：

1. `get_ocr_result {fileId:7,page:3,includeVersion:true}`，取得 `results[0].version`；页不存在时先核对页图。
2. `save_ocr_result {fileId:7,page:3,markdown:"校对正文",expectedVersion:"读回版本"}`；需重识别时仍只提交这一页。
3. 删除用 `delete_ocr_result {fileId:7,page:3,expectedVersion:"最新读回版本"}`；删除不触发任何台账撤回或文件操作。
4. REST 代理可使用相同页号与版本向上述 PUT/DELETE 提交；写入通路分别记录 `upload` / `mcp`，正文与护栏相同。

OpenAPI 的新路径声明请求白名单、独立 token、安全响应及版本字段；MCP 的工具说明和 server instructions 同步本流程。开发环境 `/_openapi.json` 可发现，生产继续按原策略隐藏文档。

## 并发、幂等与错误

新 REST PUT/DELETE 与新 MCP `delete_ocr_result` 必须提供 `expectedVersion`，缺失即拒绝。仅既有 REST POST/DELETE 与 MCP `save_ocr_result` 的旧载荷适配允许省略，保留原来的较弱盲写语义；字符串必须使用读回值。显式 `null` 表示“预期这一页不存在”，可用于防覆盖创建。带预期版本的写入必须显式给 `page`，不能把它作用到整份 markdown/JSONL。版本不符（包括带旧版本访问已删除页）为 409，整次请求不变更；重新读取后决定是否重试。现代删除以 `null` 表示预期不存在，可重复返回 0；旧入口无条件删除不存在页也返回 0。旧入口无条件重传同页不新增重复行，并会推进修订，使此前读回的现代编辑版本失效。成功覆盖会推进版本，因此带旧版本重放不会静默覆盖后来结果。

迁移 `0022_ocr_page_revision.sql` 仅为 `ocr_result` 添加 `revision INTEGER NOT NULL DEFAULT 1`，保留已有行、ID、正文、raw、约束和索引。版本由自增行 ID 与递增修订构成，调用方须当作不透明字符串。页级写入更新推进修订；删除重建产生新 ID，防止同页重建后旧版本重新命中。版本核对和修改在同一个 `BEGIN IMMEDIATE` 事务；多页写入失败整体回滚。历史上的“完整在线 OCR 成功替换”不再作为当前在线任务的发布说明，当前目标页校验、发布与恢复以 #309 为准。

当前 `ocr_result.raw` 按 [#309 的来源封套说明](ocr-publication-309.md)使用 `ocr-provenance-v1` 保存 `captures` 与 `revisions`：原始载荷保留在 `captures[].raw`，文本修订引用采集。页覆盖未提供新 raw 时保留已有采集，不表示存储列仍是未封装的旧原 raw。旧行仅在被写入时封装，旧 raw 原值完整保留，采集来源和原 markdown 为 null（unknown），不从最后修改的 channel/model 倒填；行上的 markdown/channel/engine/model 仍表示当前文本修订。封套细节及直接 raw 消费者的回滚兼容边界见后继文档，既有页 DTO、页版本和 ID 保持。

错误分类：400 为字段/引用/页号/版本形状错误或越出已知 PDF 页数，401 为写入未鉴权，404 为目标文件不存在/已移出（读取已移出文件仍允许）或精确读的 OCR 页不存在，409 为版本冲突，415 为写入非 PDF。MCP 业务错误通过 `isError` 文案保留同一状态分类，传输级未授权为 HTTP 401；MCP schema 校验使用框架标准参数错误。源页数探测失败时沿用原服务 warning/null 规则，不虚构页数。

兼容入口：`GET/POST/DELETE /api/ocr-results` 与 markdown 导出保留；默认请求/响应键保持基线，REST GET 仅显式 `includeVersion=1` 才增加 `version`，MCP get 仅显式 `includeVersion:true` 才增加版本。旧 MCP save 通过适配器严格返回原 `file/channel/written/pages` 四个键，不附上传通路的 source/页数探测字段。POST 单页支持可选 `expectedVersion`，DELETE 在 query 支持版本字符串。既有写入口也可显式 `mode:"versioned"` 请求现代保护（REST POST/MCP save；旧 REST DELETE 的 query 也支持该模式），此时预期版本与显式页号必须齐备；字段形状非法、缺版本或仅有现代模式标记均拒绝，不回退盲写。没有新增必填幂等键、审计字段，亦不编造“用户已确认”的依据。页面原有 HTTP 写口按既有 ADR 保持本机页面直调政策；这不是新代理 REST 入口的鉴权策略。需要受 token 保护的程序使用新稳定 ID 页路径。文件路径别名歧义与非法页号统一为 400。没有新增物理删除文件或整份清空能力。

## 验收证据

以下验收、性能边界与收尾记录保留 #106 各源码快照的历史证据，不代表本次文档澄清重新执行了 SDK、Paddle 或并发验收，也不代替 #309 的验收边界。本次仅做静态文档检查，运行时验证为 UNRUN。

公开接缝：真实 Nuxt/Nitro HTTP、真实 MCP `tools/list` / `tools/call`，独立临时 SQLite 与合成 PDF/PNG。测试 `tests/ocr-page-lifecycle-106.test.ts` 不调用私有业务函数；DB 仅建合成夹具、注入事务故障和坏 raw。

| 验收项 | 具体测试 |
| --- | --- |
| REST/MCP 删除等价、缺页幂等、覆盖数 | `MCP single-page deletion matches REST and missing-page deletion is idempotent` |
| 版本覆盖/删除冲突，删除重建防旧版本命中 | `read versions reject stale overwrite and delete across transports and survive delete-recreate` |
| 独立鉴权、读回一致、工具发现 | `authenticated stable-ID REST pages share MCP write validation and exact readback` |
| 显式页范围、非法字段、PDF 与页数护栏 | `explicit page scope and invalid fields cannot widen OCR writes or deletions` |
| 并发仅一个成功，其他页不变 | `two writers with one expected version admit exactly one change and retain other pages` |
| 事务失败不留下部分内容/版本 | `failed multi-page overwrite rolls back every page and its version` |
| 页图/文件字节、解析段、正式事件/证据不变 | `page redo and deletion preserve source bytes, images, file parts, formal events and evidence` |
| 精确读不加载 raw/无关正文，覆盖数限定文件 | `exact page reads and deletes exclude unrelated text and raw while coverage stays file scoped` |
| OpenAPI/MCP 实际 schema 可发现 | `public OpenAPI and MCP schemas discover page lifecycle and expected versions` |
| 兼容引用/页号错误分类 | `legacy OCR aliases distinguish malformed references and invalid pages from missing targets` |
| 已移出文件可读，禁止写/删 | `removed files remain readable while both write transports reject them` |
| 原始基线 REST/MCP 载荷与默认响应完全兼容，旧写使新版本失效 | `exact baseline REST and MCP payloads retain legacy response shapes and invalidate modern versions` |
| 新命令必填版本，现代载荷不完整时拒绝降级 | `new commands require versions and partial versioned legacy envelopes never downgrade to blind writes` |

红绿原始日志在 Git 外 `/tmp/ningbo-spec98/ticket-106/`：`red-delete.log` 缺 MCP 删除工具、`green-delete.log` 通过；`red-version.log` 缺版本、`green-version.log` 通过；`red-auth-route.log` 缺新鉴权路径、后续公开入口通过；`red-reference.log` 错误将歧义引用归为 404、`green-reference.log` 校正后通过。早期夹具字段/启动输出格式修正和规范 markdown 预期修正不作为业务 red 证据。

兼容红绿：`red-legacy-compat.log` 真实基线载荷发现 MCP 旧响应多余字段，且新命令无版本仍成功；`green-legacy-compat.log` 恢复旧响应适配与严格新命令后 13 项公开测试通过。此兼容修正是当前实现的一部分，首次候选的 310 测试不充当修正后的验证。

最终验证命令、来源提交与日志见本页收尾记录。所有数据均为合成，未读写生产数据、部署、创建 PR 或合并 main。

## 性能与未运行边界

版本核对只查 `(file_id,page_no)` 唯一索引上的 ID/revision 两列；删除剩余数使用限定文件的 SQL `count(*)`，不为计数加载页号列表。MCP 精确读复用一次投影，不再为导出和元数据重复读取正文；raw 从不默认读取。来源文件定位及懒回填沿用原服务，没有新增全库历史读取/缓存。

票级有界性夹具包含 128 页无关结果，每页 `UNRELATED` 重复 2048 次（18,432 UTF-8 字节/页，共 2,359,296 字节），另有目标文件页和故意坏 JSON raw。目标页 HTTP 响应 <2KiB、MCP/HTTP 精确正文成功、覆盖数不计无关文件。此样本验证投影/定位与解码边界，不测可靠尾延迟、heap/RSS、事件循环或 2x/5x 全业务分布。没有并行运行重负载基准。

不宣称 #93/#95 大文件/OCR/MCP 容量、#81–89 尚未验收的混合负载/部署预算、生产吞吐或真实 Paddle 调用已通过。既有全文件导出/旧清单正文读取与请求体限制保持原边界；超大正文能力仍由那些性能票跟踪。未改 Vue，无新增浏览器像素门禁。

## 收尾记录

首次候选（兼容修正前）的完整票级回归：`pnpm test tests/ocr-*.test.ts tests/mcp-surface.test.ts tests/files-openapi-contract.test.ts tests/agent-http.test.ts --maxWorkers=1`，10 文件 / 310 测试通过（其中本票公开接缝 11 项），退出 0，日志 `final-precommit.log`。`pnpm typecheck` 与 `pnpm build` 均退出 0，日志分别 `typecheck.log` / `build.log`。上述运行只验证本地代码与合成资料，不升级为生产或父级集成验收。

兼容修正后：相同回归命令 10 文件 / 312 测试通过（公开接缝 13 项），退出 0，日志 `compat-final-regression.log`；`pnpm typecheck` 与 `pnpm build` 退出 0，日志 `compat-final-typecheck.log` / `compat-final-build.log`。新命令严格版本、旧载荷适配与部分现代载荷拒绝均在本轮公开调用中验证。

源码与集成快照记录：

- 实现提交 `315b63fe76e73ed488d9ea95050fb5c43c06dd4c`及兼容修正 `969e2543677b5bc68fe62266f19c8c5215ba07c6`；旧 payload 回归按功能基线 `4f910f612cfdf6915758f39522f0ff9874f96d7a` 的实际入口与响应字段编写，没有新必填字段。
- 合入 #100 后源码 `e8706f9ed818bd52fd53f2351509abcabbac2cff`：11 文件 / 323 测试通过，`final-integrated.log`；typecheck 通过，`final-integrated-typecheck.log`。
- 合入 #96 后源码 `f1c471cd9ab4f46644c741fd63b636abe109bdde`：OCR + MCP + 企业资料 3 文件 / 73 测试通过，`final-tip-focused.log`；typecheck/build 通过，`final-tip-typecheck.log` / `final-tip-build.log`。
- 最后合入的集成快照 `f31f57b5a097223f15e7d596961af9d4ea8c6693`（含 #99/#96/#100），执行源码 `cff15c7f3270218da934253ceade6ffa86c9550f`：OCR + MCP + 别名 HTTP 3 文件 / 56 测试通过，`final-alias-tip-focused.log`；typecheck 通过，`final-alias-tip-typecheck.log`。最后的文档收尾提交不改执行源码。此前 323 测试绑定各自源码，不能转称最后快照跑了 323 项。

迁移 journal 的合并保留 `0014/0015/0016/0022`，按 idx/when 递增；只在与 #100 交汇时手工保留双方追加项。没有重生成旧 snapshot。共享修改点为 schema/journal、MCP server instructions、写工具名单及其既有白名单断言；OCR 服务和旧适配入口属本票。下游集成迁移排序仍由父级 merger 统一，不在生产执行。

`cff15c7f3270218da934253ceade6ffa86c9550f` 的 `pnpm build` 亦退出 0，日志 `final-alias-tip-build.log`。票级有界性样本与 13 项 OCR 公开测试已在该源码快照重新执行。另保留 `mutation-version-red.log`：在 `9d88c99` 源码临时移除版本核对时，真实并发测试从预期 `[200,409]` 变为 `[200,200]` 并退出 1；恢复后公开测试通过，变异未入 Git。
