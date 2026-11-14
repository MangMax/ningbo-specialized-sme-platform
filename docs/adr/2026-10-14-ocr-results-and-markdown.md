# OCR 结果落在 `app`,**markdown + 页码**是产物形态;API 走 PaddleOCR 托管服务

票 14把扫描 PDF 变成可解析的文本。这份 ADR 冻住三个决定。

## 1. 结果表在 `app`,不在 pipeline

OCR 结果的**生产者是 app 的三条通路**(代理经 MCP 写、用户从页面传、任务面调 API),
**消费者是 pipeline** 的导入(它按页给 `record_evidence` 补页码)。表建在 `app/db/schema.ts`
的一条理由就够:**写者拥有契约**。放进 pipeline 的话,app 的两个写入口(HTTP / MCP)都要反向依赖
pipeline —— 而两仓的分工是 `pipeline ──写──▶ app/data`,反向依赖会把这条线拧成双向。

这与 [ADR-页图是派生缓存](./2026-10-14-page-images-as-derived-cache.md)不冲突:页图**不入库**
(它可由源 PDF 随时重建),OCR 结果**入库**(一次识别可能要花钱、花几分钟,重建代价高)。
「能不能重建」是这两者该入库与否的分水岭。

## 2. 产物是**带页码的 markdown**,不是纯文本或 HTML

用户原话:识别率更高、导出 markdown 便于处理、带页码好读取。落到接口上:

- **页码写在文本里**:每页前一行 `<!-- page: N -->`(`lib/ocr-markdown.ts`)。用 HTML 注释而不是
  「第 N 页」这种标题,是因为它**渲染时不可见、且不占标题层级**(真正的结构是 `### 附件1`)。
- **入口宽、出口窄**:导出只用规范形式;上传**两种都认**(`<!-- page: N -->` 与外部工具常见的
  `## 第 N 页`),归一后一律按规范形式存。
- **导出与回传闭环**:拿导出的文件再 `POST /api/ocr-results` 传回来,切出的页与导出前**逐字节相同**。
  这是「上传识别结果」(通路 b)能成立的前提,也是它**不需要任何外网凭证**的原因。
- 表格实测是**行内 HTML**(PaddleOCR-VL 的 `markdown.text` 给的是 `<table border=1 …><tr><td …>`),
  所以 pipeline 侧两种形态都读(`pipeline/src/ocr-markdown.ts`)。

## 3. 识别走 **PaddleOCR 托管 API**,不本地部署

SPEC 明写「不本地部署」。用的是与用户那份 MCP 配置
(`uvx --from paddleocr-mcp paddleocr_mcp`)**同一个服务、同一颗 token** 的 HTTP 端点
(`POST/GET {base}/api/v2/ocr/jobs`),提交**单张增强 PNG**、轮询到 `done` 后取 JSONL 结果。

- **2026-10-15 修订：图片先行、页面与文件并行。**用户明确要求 PDF 先转图片再 OCR；
  本段原来直接提交整份 PDF 的决定由此替代。一份 PDF 的所有页图属于同一份本地任务，
  页号取页图清单，不取 Paddle 单图结果里的页号。多页与多份 PDF 均并行，进程统一限制
  最多 8 个未完成 Paddle 单页请求、最多 4 个 OCR 任务；其他任务独占执行。
- **增强与已有结果复用。**默认 300 DPI，允许选择 400 DPI，并复用完整、最新的已有
  400 DPI 清单。图片合到白底、转灰度、归一化并轻度锐化；识别前要求完整页图已生成。
- **按单张 PNG 的完整请求重试。**5xx 后最多尝试三次，4xx 不重试；整份 PDF 全页成功后
  才在同一事务中替换 OCR。失败或取消保留原结果，成功页的原始响应与本地页号一并入库。
- **模型取文档解析类**(`PaddleOCR-VL-*`,默认 1.6),它**直接出 markdown**;纯 OCR 模型出的是
  逐行文本 + 坐标,要再自己拼版面。
- **凭证不入库、不入仓库**:从 `NUXT_OCR_TOKEN`(或与 MCP 同名的
  `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`)读;`ocr_result` 的任何列与任务的 `params` / `result`
  都不放它。仓库里只有 `.env.example` 的占位名。

**已考虑但未选:**

- **直接提交整份 PDF**：已被上述用户明确要求替代；生产入口只提交页图 PNG。
- **把 OCR 结果当页图的兄弟列存进 `stored_file`**:结果**按页**多行,塞进文件行就得存 JSON 数组 ——
  按 `page_no` 查、按页幂等覆盖、单页重跑全都做不了,而这正是本票的全部意义。
- **`pageRanges`(只识别某几页)**：当前任务面明确拒绝该参数，只识别一份 PDF 的完整页图清单；
  每张 PNG 的结果必须只有一页，再绑定回本地清单页号。

## 4. 写入口的分档(与 `PATCH /api/files/:id` 同一档)

`POST /api/ocr-results`(通路 b)**不鉴权**,与「页面背后的文件域写口」同档
(见 `server/utils/api-auth.ts` 顶部的三档说明);代理的写口在 MCP 那一侧
(`save_ocr_result`,票 18 已带 token)。

这意味着**本机上的别的程序**可以往里注入任意 OCR 文本,而 pipeline 会把它解析成权威的 `record` 行。
本仓是**单机开发工具**(SPA + 本地 Nitro,无跨用户会话、无 CSRF 防护),这条与既有的
`PATCH /api/files/:id`(分类回写)风险同量级,不是本票新开的口子。要在更暴露的环境部署,
得先给这一档加鉴权 —— 记在这里免得被误以为「上传口是安全的」。
