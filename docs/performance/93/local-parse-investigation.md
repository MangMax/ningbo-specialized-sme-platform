#93 第二切片：文件按需读取与本地解析调查（2026-10-20）

范围：#88 下 #93 已拆出的第二个 scope:M 切片。起点 `fc37375eb35ecd175a5746d93dc22129d2a2ffe3`。只检查文件、PDF 页数/渲染、OCR 正文元数据读取及 JSONL 本地解析；不改 OCR 文件调度器、业务阈值或生产数据。冻结目标见 [#82 budgets](../82/budgets.md)：本地处理工作堆 ≤256 MiB，交互事件循环最大停顿 <500 ms。此处为找热点的轻量诊断，不是吞吐或容器验收。

## 当前接缝

- 文件正文 `GET /api/files/[...path]` 用 `createReadStream`，文件库扫描和 SHA-256 也流式读取（`server/api/files/[...path].get.ts`、`server/utils/stored-files.ts`）。没有发现这两处整文件 JS 缓冲。
- `readPdfPageCount` 和无清单时的 `listPdfPages` 会 `readFile` 整份 PDF 后送入 PDFium；`renderPdfPages` 重渲染时也如此。已有清单时只查文件和页图尺寸，不加载 PDF 正文。PDF 渲染逐页 `page.close()`，清单最后原子写入；按路径的并发请求串行/去重（`server/utils/pdf-pages.ts`）。页数读取被入库页码校验、证据页码和 OCR 导入调用。
- `GET /api/ocr-results` 的默认元数据响应不含 markdown，但 `listOcrResults` 仍选择全部 markdown，用于计算 `chars`；它已不选择 `raw`。显式 `markdown=1`、MCP OCR 正文及 markdown 导出确实需要正文（`server/api/ocr-results/index.get.ts`、`server/utils/ocr-result.ts`）。
- 手工 JSONL 导入经 `decodeOcrImport` → `pagesFromJsonl` 做 `split`、逐行 `JSON.parse` 和页序编号；这一入口与 PDFium 渲染不是共同处理接缝（`server/utils/ocr-import.ts`、`server/utils/ocr-api.ts`）。

## 冻结输入与原始证据

运行环境：Apple M4、24 GiB RAM、Node `v24.18.0`，无 1 vCPU/4 GiB 容器限额；原始代码 SHA 如上。命令为 `pnpm exec vitest run tests/perf-93-ocr-demand.measure.test.ts tests/perf-93-local-parse.measure.test.ts --maxWorkers=1 --reporter=verbose`，诊断夹具在运行后移到 `/tmp/ningbo-perf-83-90/93-{ocr-demand,local-parse}.measure.test.ts`，避免无断言测量用例进入正常测试集。两份夹具的 SHA-256 分别为 `543f69f31c734a706af551520ce8fc39b3a4505505e100f67d722d0738875c0f`、`b4b643d90c5f5d62ba3056cd4da036d372fe4a5c0202422046d6017ca2902d44`。完整原始 stdout/stderr：`/tmp/ningbo-perf-83-90/93-local-parse-raw.log`，SHA-256 `1392ad41b7589b5cc7e7be47d588540ecac3f7d9b85537aba8e2dfc5315c89f2`；2 文件、4 个诊断用例退出 0。所有 PDF/SQLite/JSONL 均为合成数据，SQLite 写入只在临时库。

| 场景（相同输入） | 观测耗时 | 事件循环最大停顿 | 观测内存变化 |
| --- | ---: | ---: | ---: |
| 3 页 A4 958 B PDF，页数读取，首次/再读 | 43.0 / 0.3 ms | 14.0 / 11.1 ms | 首次 RSS +16.9 MiB（含 PDFium 初始化） |
| 同份 PDF，300 DPI 冷渲染 / 幂等再跑 | 1293.9 / 3.6 ms | 25.5 / 11.8 ms | 冷渲染 RSS +150.3 MiB；堆差值受 GC 干扰 |
| 16,777,667 B、1 页有效 PDF，页数读取两次 / 72 DPI 渲染 | 5.4 / 4.1 / 98.3 ms | 12.1 / 12.1 / 43.9 ms | 再读 RSS +16 MiB；渲染 +18 MiB |
| 97 页 × 13,667 B JSONL 正文，解析 3 次 | 1.7 / 1.3 / 1.4 ms | 12.1 / 13.2 / 12.0 ms | 约 0–1.4 MiB 堆差值，GC 干扰 |
| 97 页 × 128 KiB JSONL 正文，解析 3 次 | 16.1 / 13.8 / 15.9 ms | 12.1 / 12.0 / 11.6 ms | 两次约 +10.7/+12.2 MiB 堆，第三次 GC/复用 |
| 97 页 × 13,667 B OCR markdown，当前完整投影 / 仅 `length(markdown)`，各 3 次 | 0.6–1.4 / 0.5–0.6 ms | 两者约 10–12 ms | 完整投影约 +1.7 MiB 堆；长度投影约 0 |
| 97 页 × 128 KiB OCR markdown，当前完整投影 / 仅长度，各 3 次 | 5.2–5.5 / 5.3–5.4 ms | 两者约 10–12 ms | 完整投影约 +12.5 MiB 堆、+14.5 MiB RSS；长度投影约 0 |

输入 SHA-256：3 页 PDF `6101d0a896db6d328890ff226b763d2be786e12a3dd5865f1224044343020d2b`；16 MiB PDF `7fc225d9a3e70755c5618dd743fd0eb9ec831f014063cf31d69033f19e907c8e`；13,667 B/页 JSONL `6381f298959ee5bf73017c652fc41952b50d790db3efb42428d51b3905d13942`；128 KiB/页 JSONL `d664fa9cc148ef30df2f7a8e9b0825e1a980b63a003fb493ea25f5a820e2775d`。大 PDF 的 16 MiB 内容是无操作注释，专为分离按需整文件读取成本；不能代表实际扫描件解码或复杂排版。13,667 B/页按 #82 OCR markdown 已观察 p99 字节数设定，但 97 页全处于 p99 是合成放大，不是实测分布。

## 判断与未满足条件

确有可见的多余正文物化：OCR 默认元数据读取整份 markdown，尤其放大输入时占用约 12.5 MiB JS 堆。可是当前同输入对照未量出延迟收益，真实量级的额外耗时也只有毫秒级。PDFium 读取和渲染虽有整文件缓冲及明显 native RSS，样本中的最大事件循环停顿为 43.9 ms；本地 JSONL 解析也没有逼近冻结阈值。因此本切片**没有已证实、需要进程隔离或生产代码更改的热点**。不以合成放大、静态 `readFile` 或单次 RSS 增量推断生产容量；不为避免一次已量出很小的复制改写公开契约。

重新实施前需要：

1. 从授权的隔离文件副本取得脱敏分布：PDF 大小/页数/页面像素与 DPI、OCR 每页 markdown/JSONL 字节数及文件级极值；核对目前基线缺失的 4 份源文件。保留文件哈希而非正文。
2. 对确实落在高分位的同一组输入，在编译后的公开 `GET/POST /api/pdf-pages`、`GET /api/ocr-results` 默认/正文参数、手工导入与 `render-pages` 任务上做冷/热及并发 1/2/5 读数，同时量主请求事件循环 p95/max、工作堆、native RSS、响应完整性。同步 PDF 渲染的业务耗时和交互请求阻塞要分开判断。
3. 仅当某个接缝越过冻结预算或重现明确容量故障时，为它单独冻结失败样本；先在该公开接缝写失败行为测试，再做最小修复。涉及 worker 时必须验证中途取消、任务重试、旧清单/成功页可恢复、原文及页序逐字节一致；不能借用另一代理正在做的 OCR 文件级调度验收。容器、生产与外部 OCR 仍为独立未跑车道。

本调查不关闭 #93/#88/#91，也不声称 OCR 文件调度或 Excel 背压切片完成。
