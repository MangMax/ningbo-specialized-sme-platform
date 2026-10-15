# 11 — 代理只从「已上传文件」解析(不再扫数据根)

**What to build:** pipeline 的**输入源**从「数据根目录扫描」改为「app 的文件库 + `stored_file` 表」。

**Blocked by:** **17**(按段建模)

**Status:** done — pipeline 88bc536 与 app 00423f8 已合入本地主线。当前正式导入从文件库21条有效来源读取，按代理已回填段元数据落库；不引入业务推断引擎。全新双入口验收由票12跟踪。

## 现状与要改什么

- 现在:`src/inputs.ts · readInputs(root, filesDir)` 用 `discoverAnnouncements(root, subdir)` **扫数据根**(`经信局名单/**`、`工信部名单/**`)。
- 改成:从 **`app/files/`**(+ `stored_file` 表给的元数据)枚举,`.docx/.doc` 走 parser,`.xlsx` 走 miit parser。
- **`--root` 扫描降级为「离线校验用」**(`check:jxj` 仍可用),**导入路径不再依赖数据根**。

## 关键设计点

- **按「段」取元数据,不按文件取**:一个文件可含**多年份、多事件**(见票 17)。从 `stored_file_part` 读每一段的 `(title_code, event_kind, year, batch)`,写进对应的 `record_event`;**文件级的 `year`/`batch` 是「公布批次」,不能拿来当记录的年份**(192号 就是「公布于 2024 第2批,另含 2021 第2批复核」)。
- **分类从表里读,不从路径猜**:`source/kind` 取 `stored_file`;**未分类的(`unset`)跳过并报出**,不猜(交票 12)。
- pipeline **要读 app 的库** —— 这加深了耦合。已在 `src/db.ts` 复用 app 的库结构;此处再读 `stored_file` 表即可,**不新增第二个连接**。
- `.doc` 仍依赖本机 LibreOffice(既有约束),找不到时**逐文件报错、不整批失败**。

## 测试

- [ ] fixture:文件库里放两份文件(一份已分类、一份 `unset`)→ 只解析已分类的,`unset` 出现在「跳过」清单。
- [ ] 元数据里的年份/批次进 `record_event`,不靠文件名推理。

## 验收

- [ ] 把一份新 PDF 放进 `files/` 并在 `stored_file` 标好分类 → 跑导入 → **库里有新记录**。
- [ ] 数据根目录**不参与**导入(可故意改名数据根验证仍能导入)。
- [ ] pipeline `vp check && vp test` 全绿。

**分支**:`feat/agent-reads-uploads`。

## 2026-10-15 当前验收记录

本地 app 代码主线 `5be3e60e3fd94cfd37929f79f07d692decf555ee`（后续8be仅文档），pipeline `4eb396f74f4ac75738dbe47ab9f09b4e1da2a95a` 已集成；app 28文件/517测试、类型检查及生产构建通过，pipeline 9文件/144测试和check通过。正式21个有效文件、55段、21443源行已重建并用两个独立CLI进程验证五张账表hash不变。证据在项目 `acceptance/20261015/{main-integration-ancestry.json,final-ledger-run3-audit.json,final-source-fact-integrity.json,runtime-production-smoke.json}`。3470生产服务已实际验证8个MCP工具列举、文件19读取17页OCR及457行。此段补充当前证据，不将下方旧快照中每个未勾选交互项一律冒充本轮重测。全新清洗验收仍由票12单独跟踪。
