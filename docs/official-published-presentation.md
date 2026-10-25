# 逐出处名称展示与当前资格工作簿（#355 / #303 A）

`lib/roster/official-published-presentation.ts` 只消费 A 的事件 latest reader，
不拥有侧表 SQL、写裁定、资格或 C 权限。输入为 caller 已选定且已核归属的
`{eventId,evidenceId}[]`；事件与出处在本次调用内去重，返回以 evidenceId 为键的
ReadonlyMap。重复来源引用复用这份 Map；没有跨事件批量 SQL、全局缓存或消除所有 N+1
的保证。后续 #356 可复用该函数，本票不接匿名 API、MCP 或页面。

每项只含 `evidenceId,eventId,revision,availability,nameRaw,sourceBindingKnown`。
`captured` 保留本次真正 latest 的名称与绑定标记；`unknown_legacy` 只表示成功读完所有页后
仍无该出处捕获，其 revision/nameRaw/sourceBindingKnown 为 null。captured 的 nameRaw=null
展示“已捕获出处，名称原值未知”；legacy 展示“未逐出处核实”。空串和空白是确定原文，
不 trim、不回填；Excel 用 JSON 字符串表示名称，使空串、换行与首尾空白明确可辨。
绑定 false 单独标注“出处绑定未核实”，不因名称有值宣称位置已核。

读取或预算失败抛 `OfficialPublishedPresentationError`，只公开稳定安全码
`invalid_scope/source_limit/field_limit/response_limit/read_failed`，不返回部分 Map，
不把读取失败记作 legacy。#356 可将失败映射为 availability=unavailable、其余 nullable
字段为 null，错误码放在展示状态封套；不能降为 unknown_legacy。完整原统代、原属地、
捕获身份/hash/origin、actor/basis/command 仍仅走 C 已有鉴权封套。

每个 distinct event 按 pageSize=50、maxBytes=65536 调 A，沿游标每页一次；
事件完整旧 scope 上限300、原字段4000 UTF16及 A 的 SQL 前置预算保留。
50行不保证装进64KiB；超限直接失败，不缩页重试、不截原文。消费时只保留最小事实和
当前页，复用 importReceiptRedactor 脱敏新增 DTO，最终 UTF8 再计预算。
单企业×称号的新增 DTO 与新增名称/说明文本合计最多65536字节，包含重复展示与转义开销。
旧引用 locator、旧 raw/hash 和资格摘要不被脱敏重写。

工作簿在原 `JSON.stringify(row)` hash 之后、当前 sheet 命中之后才水合正式认定/复核出处。
非枚举 workbookFacts 只增加保留 evidence.id；新事实以独立参数传给 formatter。
CurrentRow 的 publishedNames、notes、basis、references、资格分区、身份缺口、周期、计数、
firstYear、witnesses、过滤及 CURRENT_RULE_VERSION 全部沿用原口径。
dataVersion **仍是旧资格摘要**，不是包含逐出处展示的新版本摘要；artifact.sha256 仍由
既有发布路径计算实际新 XLSX 字节。仅改变 sidecar 且固定旧输入与时间，dataVersion 不变、
文件内容与 SHA 可以变化。普通 B raw-only correction 还会递增 event.revision，旧 basis
包含该 revision，因此普通更正不能直接被称为“仅 sidecar 改变”。

企业名称列取现名，已确认曾用名列只取原 confirmed alias；不从公布名反推别名或更名。
公布名称与来源列按同一事件标签、文件、附件/页/序号逐条对应，保留独立佐证，不按名称去重。
复核标签用 decidedYear 表述结论年，year 另作原认定年；未知不从文件名猜填。
formatter 仅移除旧首名推断的“现已更名为”句，原 row.notes 保留。
列序12列、三个分区加口径说明四 sheet 不变；没有新增统计页。
单元格32767字符、行高409、原行数及失败回滚/禁止发布不完整 artifact 的路径保持。

专属测试 `tests/official-published-presentation.test.ts` 通过 B 公共预检/hash/提交、明确
append/correction/merge 建合成正常事实，C 精确 HTTP handler 逐值对照，ExcelJS 独立解析文件。
仅基础 catalog、明确历史损坏/极端 legacy 边界使用直接 fixture 写入；sidecar-only 实验
在公共更正后明确固定旧 event revision，只作隔离变量控制，不是业务写法。
`tests/current-workbook.test.ts` 保留文本、分区、限额、背压及脱敏断言，仅将旧首名展示断言
调整为 legacy 未逐出处核实。

小 SQLite/HTTP handler 和直接工作簿测试不代表实际 Nuxt HTTP/MCP transport、独立异步 worker
POST→终态→下载验收。后者及 typecheck/build/full 等待父唯一 heavy 调度；真实一致性副本
尚未分配，覆盖缺口保留，不能用合成结果替代。A 无 UI 接线，desktop/390px 对本片 NA；
#303/#356 的 UI 仍 UNRUN。历史 #345/#346 full FAIL/timeout UNKNOWN、上游 A/B/C 的
FAIL/UNKNOWN/errno48 和 copy/清理偏差均保留；本票不声明母票、集成或生产通过。
