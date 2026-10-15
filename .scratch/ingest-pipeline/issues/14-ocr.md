# 14 — OCR 三通路 + 结果入库 + markdown(带页码)

**What to build:** 把页图变成**可解析的文本**:三条通路都支持,**API 优先(异步、可批量)**;结果**写入新表**并关联页图;导出 **markdown**(带页码)。

**Blocked by:** 13

**Status:** ✅ done。后端三通路、图片优先并行 OCR 和 `/ocr` 工作台已合入本地 `main`（`5be3e60e3fd94cfd37929f79f07d692decf555ee`）；独立代码复核无阻断，生产构建独立 UI 六组关键路径全部通过。全新隔离清理流程验收仍由票 12 跟踪。

## 当前流程（2026-10-15）

最终验证：app 主线 28 文件 / 517 测试通过，typecheck 与生产构建退出码均为 0。独立 UI 在隔离生产服务 `3472` 验证桌面/390px 亮暗主题、逐页 CRUD 与 JSONL 导入、切文件读写及渲染竞态隔离、读取失败与重试、跨文件状态清理，六组通过，无阻断。报告及截图归档于 `acceptance/20261015/evidence/ui-final/independent-ui-final.md`（项目目录下）。父代理另核对构建源码归档等于上述提交，并核对测试库恢复为 baseline。缺图态本轮未测；浏览器受控故障注入不代表真实 Paddle 故障。四条非阻断观察保留在独立报告中。

PDF 先渲染增强 PNG（默认 300 DPI，按原件可选 400 DPI），每份 PDF 独立 OCR 任务，文件和页请求均并行；当前最多 4 个 OCR 任务，共享 8 个 Paddle 页图请求槽。单张 PNG 遇 5xx 最多尝试 3 次（含首次），4xx 不重试。已有完整结果直接复用；一份完成就交清理代理，不等待全批。

代理先用逐页 OCR 匹配三张导出表，只视觉核验未匹配、歧义或冲突行所在页。尚未核验项及已知未修正 OCR 错误为 0 后，经文件域接口回填并执行 pipeline 导入。核验后仍未匹配的名单照原件全部保留。原 PDF、页图、raw 和最终出处一起保留。

`/ocr` 提供逐页图片/正文对照、单页增读改删、JSONL/Markdown 导入。正文由 `GET /api/ocr-results?markdown=1` 逐页返回；读取失败显示错误并禁用基于空正文的编辑。切文件时读写绑定目标，JSONL 导入保留 raw，Markdown 重传不抹已有 raw。

票 12 使用既有 `set_file_category` / `save_parse_result` 回填分类和名单段，无程序分类推断。下文的一份样本、直接 PDF OCR、页面未做等内容为 2026-10-14 阶段记录，不能作为当前状态；以本节及最终验收汇总为准。

## 三条通路(用户明确:都支持,**不本地部署**)

| 通路 | 触发 | 说明 |
|---|---|---|
| **a. 在线 API** | 页面按钮 | 调 PaddleOCR **API**,**优先**;异步、可批量。凭证由页面/环境变量给(`PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN` 一类)。 |
| **b. 上传识别结果** | 页面按钮 | 用户已在官网跑完,把结果文件(带页码的 markdown/json)**上传**,直接入库。 |
| **c. 代理经 MCP** | 代理 | 走用户给的 MCP 配置(`uvx --from paddleocr-mcp paddleocr_mcp`),代理取图解析并**写回**。 |

> API 与 MCP **通用同一 token**;MCP 配置见用户给的那段。**token 不入库**,只进环境变量/页面配置(票 09 的凭证约定)。

## 结果入库(新表)

`ocr_result`(建议名):`page_image_id` / `file_id` / `page_no` / `markdown` / `raw`(原始响应) / `engine` / `model` / `created_at`。
**关联到页图**(票 13),`page_no` 是回填锚点。

## markdown 为什么好

用户原话:识别率更高、**结果导出 markdown 便于处理**、**带页码好读取**。⇒
- 解析器**优先吃 markdown**(按页切、按标题切段),比重抠 docx 表格稳;
- 页内表格在 markdown 里是标准表格,`| 序号 | 属地 | 企业名称 |` 直接可切。

## 要做的

1. 三个入口(页面两个按钮 + 代理通路)。
2. **异步任务**:一批页图提交后轮询/回调;**页面要能看到进度**(按文件或按页)。
3. `ocr_result` 落库 + 导出 markdown(整份 / 单页)。
4. **与票 11 汇合**:`.md` 结果作为 pipeline 的**新解析源**之一(与 `.docx` 并存),按 `page_no` 给 `record_evidence` 补**页码**。

## 测试

- [x] 上传一份**(b) 通路**的样例结果 → 入库、`page_no` 正确、markdown 导出一致。
- [x] 失败重试幂等(同页不重复写)。
- [x] 解析 markdown 的解析器单测(带页码、表格、多段)。

## 验收

- [x] 一份扫描 PDF 经 **API** 识别后,**按页码**入库;出处能显示页码。
- [x] 一份 OCR 结果文件经**上传**通路入库。
- [x] app / pipeline 测试全绿。

**分支**:`feat/ocr`。

## 交付记录(2026-10-14 实施)

### 做了什么

| 层 | 文件 |
|---|---|
| 迁移 `0005_strong_khan` | 建 `ocr_result`(唯一索引 `(file_id, page_no)`);`record_evidence` **加 `page` 列** |
| 表 | `db/schema.ts` 的 `ocrResult`;`recordEvidence.page` |
| 页标记契约(纯) | `lib/ocr-markdown.ts`(`assembleMarkdown` / `splitMarkdown` / `pageNoOfMarker`)—— **app 与 pipeline 共用同一个文件** |
| 结果读写 | `server/utils/ocr-result.ts`(写幂等、按页读、导出 markdown) |
| 通路 a | `server/utils/ocr-api.ts`(PaddleOCR HTTP 客户端)+ `server/utils/jobs/ocr.ts`(`ocr` job kind)|
| 通路 a 接线 | `server/utils/job-specs.ts` 的 `ocr`:`todo` → **`ready`**;`JobContext` 增 `db` |
| 通路 b | `server/api/ocr-results/index.post.ts`(上传)+ `index.get.ts`(清单)+ `markdown.get.ts`(导出) |
| 通路 c | `server/mcp/tools/save_ocr_result.ts` / `get_ocr_result.ts`:501 空壳 → **真实现** |
| pipeline | `src/ocr-markdown.ts`(markdown → 块,认**行内 HTML 表**)+ `src/ocr-store.ts` + `src/inputs.ts`(有 OCR 结果优先走 markdown)+ `src/import.ts`(写 `record_evidence.page`) |
| 凭证 | `NUXT_OCR_TOKEN` → 回退与 MCP 同名的 `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`;`.env.example` 只留占位名 |

### 三条通路的证据

- **a. 在线 API —— 真跑了外网,用了用户给的真 token**(PaddleOCR-VL-1.6):
  对真文件 **甬经信中小〔2024〕72号**(12 页扫描 PDF)提交 `POST /api/jobs {kind:"ocr"}`:
  `202 + jobId → running → done`,**耗时 ~2.5 s(job 全程 10 s)**,`pages: 12` == 票 13 渲染出的
  页图数 12(产出的 `renderedPageImages: 12`)。12 页全部落库,curl 得到
  `p001.png … p012.png`。导出 markdown 65957 字节、12 个页标记。
  > 实测发现:PaddleOCR-VL 的 `markdown.text` 里表格是**行内 HTML**(`<table><tr><td>`),
    不是管道表 —— pipeline 的解析器据此两种形态都读。
- **b. 上传结果 —— 真跑,零外网、零凭证**(也是单测里那条端到端):
  同一份导出 markdown `POST /api/ocr-results` → `written: 12, pages: [1..12]`;
  再 `GET /api/ocr-results/markdown` 导出 → 与上传内容 **`cmp` 逐字节 IDENTICAL**;
  重传一次仍 `count: 12`(幂等);单页导出 `page=3` 正常;缺引用 400 / 文件不存在 404 / 页无结果 404。
- **c. MCP —— 真跑**:未带 token 调 `save_ocr_result` → **HTTP 401**;带 token 写第 12 页 →
  `written: 1, pages: [12]`;只读的 `get_ocr_result`(不带 token)读回那一页的 markdown。
  `tools/list` 里两个 tool 已不是 501 占位(`readOnlyHint` 分别 true / false)。

### 页码进库的证据(pipeline 对真库跑 `db:import`)

`record_evidence.page` 非空 **258 条**(72号 的 258 家企业),`page` 分布 3–11(正文 1–2 页无表格,
末页空白),抽样:

```
page=3  序号1  宁波倍特瑞能源科技有限公司  specialized_sme/award/2024/1
page=3  序号5  可之（宁波）人工智能科技有限公司
...
page=11 序号258 宁波韵升电驱动技术有限公司
```

`source_file` 是那份 PDF;同一次导入里 **`.docx` 那条路(票 11)的 9768 条 `page` 全为 `null`**
—— 两条阅读器各写各的,**没有归并规则被改动**。

### 测试

- app:`pnpm typecheck` 通过;`pnpm test` **343 passed**(基线 308 + 新增 35;三个新用例文件
  `tests/ocr-result.test.ts` 22 项、`tests/ocr-job.test.ts` 13 项)。
- pipeline:`vp check` 全绿(42 文件);`vp test` **112 passed**(基线 98 + 新增 14)。

### 独立评审后的修正(评审发现 7 条,已全部修掉并复跑)

| # | 问题 | 修法 |
|---|---|---|
| 1 | **页码乱序被静默接受**:`splitMarkdown` 只排页号、不重排正文,「第 2 页标记在前」的输入会被入库、导出时又变回原序 —— 下游按页号升序摊平块,于是**甲被标成第 1 页**(它是第 2 页)。 | `splitMarkdown` **直接报错**「页码乱序」,不自动重排(重排 = 替调用方猜页序)。 |
| 2 | **`pageRanges` 让页码静默错位**:只识别 3–5 页时服务端只回 3 段,我们按 1..3 落库 —— 第 5 页的名单被写成 `page_no=3`。 | `parseOcrParams` **显式拒掉** `pageRanges`/`pages`/`range`(400 带理由),不再透传。 |
| 3 | **`save_ocr_result` 能把带页标记的正文当一页写**:导出后再传回自己的上传口会得到「页码重复」。 | `pagesFromInput` 给了 `page` 时**校验正文里没有页标记**,有则 400 并说明二选一。 |
| 4 | **整份 PDF 读两遍进内存**(`readFile` + `Blob`),上百 MB 的扫描件在单进程里会拖垮渲染与 HTTP。 | 改用 `fs.openAsBlob` **流式**上传。 |
| 5 | **上传口不校验目标是不是 PDF** —— 往 `.docx` 挂结果会**静默换掉**那份文件的解析来源(pipeline 的 `rank()` 把「有 OCR 结果」排到最前)。 | 上传路由加 `isPdfPath`,非 PDF 回 **415**。 |
| 6 | 页数不一致时只记 warning(页码已错却仍算成功);「探测失败」与「没渲染过」混为一谈。 | 改成与**源 PDF 实际页数**核对:不一致就**回滚写入 + 记 failed**;页图数降为另一个独立信号,探测失败回 `null` 而非 0。 |
| 7 | 常规重传会把通路 a 花过钱的 `raw` 抹成 null。 | `raw` 改成「这次没给就保留上一次」,给了才覆盖。 |

修完复跑:app **343 passed**、pipeline **112 passed**;三条通路的重跑证据与上面一致
(`pageRanges` 实测 400、乱序上传实测 400、非 PDF 实测 415、`save_ocr_result` 带标记实测 400)。

### 已完成 / 未完成 / 已知缺口

**已完成**:`ocr_result` 表 + 迁移 0005;三条通路;markdown 导出(整份/单页);pipeline 优先吃
markdown 并按页补 `record_evidence.page`;`ocr` job kind 变 `ready`;两个 MCP tool 落地。

**未完成**:

- **页面的两个按钮**(票 14 原「要做的 1」):本批按主代理的约束**不碰 `pages/**` / `components/**`**
  (另一个会话正在 `/files` 页做 UI 验收)。触发入口只有 API / jobs / tool;页面接入留给后续票。
- **17 份扫描 PDF 只跑了 1 份**:其余 16 份没提交识别(每份要花 API 额度与分钟级时间;
  验收只要一份。要补齐就按同一份 job 的 `files` 数组批量提交)。
- **三个 OCR 路由没有路由级单测**:它们只是「解析参数 → 调 `server/utils/` 的纯函数」的薄壳,
  语义全在下面那层被测住了;分支(400/404/415)**用真实服务实测**并记在本票里。
  要做路由级单测,本仓已有现成手法(`tests/curation.test.ts` 用 `vi.stubGlobal` 打桩 h3 的全局),
  但那属于「补测试」,不在本票范围内。
- **`.docx` 无页码**:票 11 那条路产不出页码,其 9768 条记录 `page` 仍为 `null`(有意的:空值优于错误值)。

**已知缺口**:

1. **72号 要先手工设 `title_code` 才导得进去。** 文件库里 `stored_file.title_code` 为空的文件,
   即使 OCR 出了名单也只能进「跳过」清单(交票 12 回写)——本票的端到端是靠 `PATCH /api/files/12`
   设了 `specialized_sme` 才跑通的。**不是回归**:票 11 起就是这个行为,只是现在有 16 份 PDF 会撞上。
   **这是 17 份扫描件补 OCR 时最先会撞到的那堵墙**(票 12 未做)。
2. **单页 OCR 的结果不进 pipeline。** pipeline 只有「整份文件」这一个粒度,一页 markdown 到不了
   `ParsedEntry`。通路 c 整份写(带页标记)可以进;单页写只对「回看某一页」有用。
3. **一份文档有多个表示时,只有挂 OCR 结果的那一份参与解析。** 这是有意的(免重复),但意味着
   另存的 `.doc` / `.docx` 会进「跳过」清单 —— 看报告时别误以为它们被漏掉了。
4. **轮询期间取消要等「提交到服务端的那一份」跑完。** 取消检查点在「每份文件之前」与轮询循环里;
   已经提交出去的 API 任务不会被撤回(尽力而为,与票 19 的取消语义一致)。
5. **上传口与 MCP 写口都不鉴权**(上传口)/ 只认 MCP token(MCP 口)。上传口与
   `PATCH /api/files/:id` 同属「页面背后的文件域写口」那一档,是有意的分法(见
   `server/utils/api-auth.ts` 三档说明);但在**本机上的别的程序**确实可以往里注入 OCR 文本,
   而 pipeline 会把它解析成权威 `record` 行。`docs/adr/2026-10-14-ocr-results-and-markdown.md`
   记了这条边界。

