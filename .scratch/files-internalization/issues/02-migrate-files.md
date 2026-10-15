# 02 — 迁移脚本:把来源文件按规则拷入文件库

**What to build:** pipeline 内新增脚本 `build:files`,读 `--root` 下的源文件,按规则复制/改名到文件库,幂等可重跑。

**Blocked by:** 01

**Status:** ✅ done(2026-10-14)

- [x] 经信局:扫 `经信局名单/**` 的 **PDF 与 .doc**(排除 `*.docx`),按 `jxj/announcement/<year>/<batch>/<原文件名>` 落库。—— 实现见 `pipeline/scripts/build-files.ts`；其中「排除 `*.docx`」子句**已被用户后续口径取代**（DOCX 现为权威源之一），当前 `.docx` 不再排除。
- [x] 工信部:三份 Excel 按 `miit/export/<原文件名>` 落库
- [ ] year/batch 取自公布文件(文件名/段标题),**非目录名**。—— **与实现不符，保持未勾**：文件库落位用的 `resolveJxjParts`（`pipeline/src/files.ts`）是**目录优先、文件名兜底**，`tests/build-files.test.ts` 亦写明「takes year from the directory, not the filename」。**要点**：该 helper 只服务**历史物理落位**（把源件按规则放进 `files/`），**路径里的 year/batch 是「存储坐标」，不是记录年份**，且**不在**当前「本地 register / tus → 代理读正文 → API 回填 → `readInputs`」流程里。现行流程中台账的年份/批次由**代理读源件正文后经 API/MCP 回填**（票 12），`pipeline/src/inputs.ts` 按**段声明**写入 `record_event`；**程序不推断年份/批次**。故本项按旧写法（程序从正文/文件名定 year/batch）**不勾为已实现**，legacy 脚本的限制按现状保留，本轮不新增代码。
- [x] 幂等:重复运行不产生重复文件。—— `tests/build-files.test.ts`「…and is idempotent」断言二次 `written=0`。
- [x] 打印清单:各来源落库文件数、跳过(含 .docx)数。—— `build-files.ts` 打印「经信局/工信部/合计落库·跳过·排除(含 .docx)·转文件」。
- [x] 测试:小型 fixture 目录 → 断言目录结构与文件名符合规则

> **收口（2026-10-15，docs-only）**：除「year/batch 出处」一项与实现口径不同而未勾外，其余按脚本与测试实物已满足。
