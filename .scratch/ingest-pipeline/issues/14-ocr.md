# 14 — OCR 三通路 + 结果入库 + markdown(带页码)

**What to build:** 把页图变成**可解析的文本**:三条通路都支持,**API 优先(异步、可批量)**;结果**写入新表**并关联页图;导出 **markdown**(带页码)。

**Blocked by:** 13

**Status:** ready

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

- [ ] 上传一份**(b) 通路**的样例结果 → 入库、`page_no` 正确、markdown 导出一致。
- [ ] 失败重试幂等(同页不重复写)。
- [ ] 解析 markdown 的解析器单测(带页码、表格、多段)。

## 验收

- [ ] 一份扫描 PDF 经 **API** 识别后,**按页码**入库;出处能显示页码。
- [ ] 一份 OCR 结果文件经**上传**通路入库。
- [ ] app / pipeline 测试全绿。

**分支**:`feat/ocr`。
