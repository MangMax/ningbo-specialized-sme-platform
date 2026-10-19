# #106 OCR 页结果生命周期对等

实现范围：派生 OCR 页结果。文件稳定 ID 与显式页号定位；正式出处、台账、来源文件和页图不是本能力的修改对象。单页重做由调用方读取页图、识别/校对后按页写回；不调用整份在线 OCR、不清空其他页，不新增自动业务判断或 UI。

## 当前公开契约与代理用法

代理 REST 入口：`/api/files/{id}/ocr-pages/{page}`，`id` 为 `stored_file.id`，`page` 为 1–2000 的整数。

- `GET`：无需 token，返回与 MCP `get_ocr_result {fileId,page}` 相同的 `file/page/pages/markdown/results`。`results[].version` 为不透明页版本，`markdown` 是规范页标记导出；不存在结果为 404。
- `PUT`：需要 `Authorization: Bearer <NUXT_API_TOKEN>`（或 `X-API-Token`），请求 `{markdown, expectedVersion?, engine?, model?}`。只覆盖路径指定的一页；拒绝额外字段/查询参数；页体不能再含整行页标记。返回实际写入页、源 PDF 页数/页图探测与 warning。
- `DELETE`：同上鉴权，可无请求体，也可给 `{expectedVersion?}`。返回 `{file,page,deleted,remaining}`；`remaining` 是本文件剩余 OCR 页数。不存在页无条件删除为 200 / `deleted:0`。

MCP 复用 `get_ocr_result` / `save_ocr_result`，新增 `delete_ocr_result`。写入和删除需要 **MCP** token (`NUXT_MCP_TOKEN`)，未鉴权在 `tools/list` 中隐藏，强行 `tools/call` 为 HTTP 401；API/MCP token 独立。两种引用 `fileId` 与兼容 `relPath` 恰给其一。删除 `page` 必填；写入省略 `page` 时必须在 markdown 中显式列出页标记，且只覆盖列出的页。覆盖率可读既有 `GET /api/ocr-results?fileId=ID` 的 `count/pages`；精确读回给 `page`，不会读取其他页正文或 raw。

调用顺序示例：

1. `get_ocr_result {fileId:7,page:3}`，取得 `results[0].version`；页不存在时先核对页图。
2. `save_ocr_result {fileId:7,page:3,markdown:"校对正文",expectedVersion:"读回版本"}`；需重识别时仍只提交这一页。
3. 删除用 `delete_ocr_result {fileId:7,page:3,expectedVersion:"最新读回版本"}`；删除不触发任何台账撤回或文件操作。
4. REST 代理可使用相同页号与版本向上述 PUT/DELETE 提交；写入通路分别记录 `upload` / `mcp`，正文与护栏相同。

OpenAPI 的新路径声明请求白名单、独立 token、安全响应及版本字段；MCP 的工具说明和 server instructions 同步本流程。开发环境 `/_openapi.json` 可发现，生产继续按原策略隐藏文档。

## 并发、幂等与错误

`expectedVersion` 省略保留旧调用方的无条件覆盖/删除；字符串必须使用读回值。显式 `null` 表示“预期这一页不存在”，可用于防覆盖创建。带预期版本的写入必须显式给 `page`，不能把它作用到整份 markdown/JSONL。版本不符（包括带旧版本访问已删除页）为 409，整次请求不变更；重新读取后决定是否重试。无条件删除不存在页幂等返回 0；无条件重传同页不新增重复行。成功覆盖会推进版本，因此带旧版本重放不会静默覆盖后来结果。

迁移 `0022_ocr_page_revision.sql` 仅为 `ocr_result` 添加 `revision INTEGER NOT NULL DEFAULT 1`，保留已有行、ID、正文、raw、约束和索引。版本由自增行 ID 与递增修订构成，调用方须当作不透明字符串。所有既有写入（包括完整在线 OCR 成功替换）沿用同一写服务，更新推进修订；删除重建产生新 ID，防止同页重建后旧版本重新命中。版本核对和修改在同一个 `BEGIN IMMEDIATE` 事务；多页替换失败整体回滚，覆盖时未提供 raw 保留原值。

错误分类：400 为字段/引用/页号/版本形状错误或越出已知 PDF 页数，401 为写入未鉴权，404 为目标文件不存在/已移出（读取已移出文件仍允许）或精确读的 OCR 页不存在，409 为版本冲突，415 为写入非 PDF。MCP 业务错误通过 `isError` 文案保留同一状态分类，传输级未授权为 HTTP 401；MCP schema 校验使用框架标准参数错误。源页数探测失败时沿用原服务 warning/null 规则，不虚构页数。

兼容入口：`GET/POST/DELETE /api/ocr-results` 与 markdown 导出保留，读回增加 `version`，POST 单页支持 `expectedVersion`，DELETE 在 query 支持版本字符串。页面原有 HTTP 写口按既有 ADR 保持本机页面直调政策；这不是新代理 REST 入口的鉴权策略。需要受 token 保护的程序使用新稳定 ID 页路径。文件路径别名歧义与非法页号统一为 400。没有新增物理删除文件或整份清空能力。

## 验收证据

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

红绿原始日志在 Git 外 `/tmp/ningbo-spec98/ticket-106/`：`red-delete.log` 缺 MCP 删除工具、`green-delete.log` 通过；`red-version.log` 缺版本、`green-version.log` 通过；`red-auth-route.log` 缺新鉴权路径、后续公开入口通过；`red-reference.log` 错误将歧义引用归为 404、`green-reference.log` 校正后通过。早期夹具字段/启动输出格式修正和规范 markdown 预期修正不作为业务 red 证据。

最终验证命令、来源提交与日志见本页收尾记录。所有数据均为合成，未读写生产数据、部署、创建 PR 或合并 main。

## 性能与未运行边界

版本核对只查 `(file_id,page_no)` 唯一索引上的 ID/revision 两列；删除剩余数使用限定文件的 SQL `count(*)`，不为计数加载页号列表。MCP 精确读复用一次投影，不再为导出和元数据重复读取正文；raw 从不默认读取。来源文件定位及懒回填沿用原服务，没有新增全库历史读取/缓存。

票级有界性夹具包含 128 页无关结果，每页 `UNRELATED` 重复 2048 次（18,432 UTF-8 字节/页，共 2,359,296 字节），另有目标文件页和故意坏 JSON raw。目标页 HTTP 响应 <2KiB、MCP/HTTP 精确正文成功、覆盖数不计无关文件。此样本验证投影/定位与解码边界，不测可靠尾延迟、heap/RSS、事件循环或 2x/5x 全业务分布。没有并行运行重负载基准。

不宣称 #93/#95 大文件/OCR/MCP 容量、#81–89 尚未验收的混合负载/部署预算、生产吞吐或真实 Paddle 调用已通过。既有全文件导出/旧清单正文读取与请求体限制保持原边界；超大正文能力仍由那些性能票跟踪。未改 Vue，无新增浏览器像素门禁。

## 收尾记录

首次完整票级回归：`pnpm test tests/ocr-*.test.ts tests/mcp-surface.test.ts tests/files-openapi-contract.test.ts tests/agent-http.test.ts --maxWorkers=1`，10 文件 / 310 测试通过（其中本票公开接缝 11 项），退出 0，日志 `final-precommit.log`。`pnpm typecheck` 与 `pnpm build` 均退出 0，日志分别 `typecheck.log` / `build.log`。上述运行只验证本地代码与合成资料，不升级为生产或父级集成验收。
