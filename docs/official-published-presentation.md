# 逐出处名称展示与当前资格工作簿（#355 / #303 A）

`lib/roster/official-published-presentation.ts` 只消费 A 的内部事件完整页 batch reader，
不拥有侧表 SQL、写裁定、资格或 C 权限。输入为 caller 已选定且已核归属的
`{eventId,evidenceId}[]`；事件与出处在本次调用内去重，返回以 evidenceId 为键的
ReadonlyMap。重复来源引用复用这份 Map；#391 按最多40个 distinct event 完整分片和活跃
cursor 波次读取，没有全局缓存，也不宣称消除所有消费者的 N+1。

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

每波按 pageSize=50、maxBytes=65536 调 A 的 `listEventsOfficialEvidencePages`；
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

## 现有详情、来源和当前查询消费（#356 / #303 B）

`getRosterEnterpriseDetail`、`sourceReader` 和 `listCurrentQualified` 复用同一
`readOfficialPublishedPresentation`，匿名新增 `publishedPresentation`：
`{availability:"available",error:null,facts:[...]}`。每个 fact 严格只有
`evidenceId,eventId,revision,availability,nameRaw,sourceBindingKnown` 六项。
详情 evidence 增补原稳定 `id`；来源旧 evidence/officialEvidence 保持原字段，
其 `publishedName` 按 evidence.id 关联同一份最小事实。record.nameRaw、旧
publishedNames/basis/identityGap、来源 fingerprint/proof/raw/hash 不作展示事实回填。

读取或预算失败返回 `{availability:"unavailable",error:<稳定安全码>,facts:[]}`，
旧详情、事件、出处与 locator 仍在；不输出部分名称、不冒充 legacy。
页面及原 useRecordSource 在替换成功内容前识别该 typed scope，沿用现有失败/重试，
保留上次成功内容；首次失败保持未知。serial 防护先于 scope 检查，旧晚响应不能覆盖
当前内容或错误状态；显式 readback 失败仍返回 false。缺新字段的旧响应兼容。
平台 relation/export_row 的原始名称、raw 内同名字段与文件 HEAD 可用状态不参加判定。

详情只水合已选企业的出处；来源只水合 caller 选中的 event/reference scope，按事件
去重，同一请求直接来源与重复对应引用共用一个 Map。当前查询完成资格、所有条件、
计数与选项之后才水合 retained 页；不持有跨请求/跨写名称缓存。A 每页50/64KiB、
完整事件300、4000 UTF16 的边界不变。新增事实、重复序列化副本、scope 封套及格式化
名称文字的最终 UTF8 总量按每企业或已选来源 scope 限65536字节；超限明确 unavailable，
不截原文、不缩页重试。保守预算包含所有新属性键及重复显示文字。

现名、已确认曾用名、各出处公布原名分别展示；公布名不推断别名或合法更名。
同名独立出处不合并；current 每条提示链接到该 event 的详情，详情展开后保持文件、
附件、名单序号与 PDF 页码配对。复核以 decidedYear 为结论年，year 另列原认定年。
空串/空白用 JSON 字符串保真；captured null 与 legacy 分别用前述文字表达。

完整 C 捕获封套、actor/basis/command、文件内容身份/hash 及原统代/属地仍走原 token
权限，前端不保存或发送服务器 token。A/B/C 写面和资格规则、witness、计数、筛选、
分页、dataVersion 与三称号异步工作簿的原摘要范围保持。旧 /api/enterprises/:id、
同步 export、台账/recognitions/归并快照等未点名入口不在 B 富化范围。

R1 修正：current 的桌面表与移动卡片按既有 CSS 断点隐藏，两个文字分支仍同时挂载。
预算分别计算一份 API DTO 和两份格式化名称文字，不把两份文字等同两份 DTO；
source/detail 的原 copies/envelope/default 单份文字规则保持。移动卡片从原 row.aliases
独立显示已确认曾用名；不消费待核别名，也不从公布名推断别名。

## 内部批量消费与完整 context 一次脱敏（#391 / #381-B）

事件按 scope 首次出现顺序切为最多40个一片，片内只续读仍活跃的 cursor。
全部波次使用 caller 传入的同一连接/事务；不另开 snapshot、不缩页重试。
A 仍校验完整300/301出处、完整页和非名称字段、true latest 与当前 owner；
createdAt 仍沿 A 已批准的旧 SQL guard，精确 JS UTF16 字段集不扩大。
SQL 完整页的数字表示/预算保持原义，不改成 JS 重序列化字节。

每片仅保留脱敏后最小事实的有界 prefix、cursor 和错误位置，不累积原完整行/页。
每事件 prefix 最多64KiB；整片成功读取后按 event-major/page-major 提交事实与预算检查。
较晚 event 的首个错误不能遮盖较早 event 的后续页或前页累计超限；
任何后片/回调/读取失败都不发布 partialMap。只有成功读完且无捕获的出处才公开 legacy。

ReceiptRedactor 的秘密顺序为 additionalSecrets（API 的 context.apiToken）→runtime API/MCP
→env API/MCP→已解析 miitCookie/ocrToken，沿原 truthy 过滤及 Set 去重，不排序或 trim。
两凭据各解析一次；只读 knownRedactors 与 callable 使用同一闭包列表。
API 在原鉴权/方法守卫后、敏感读取和写副作用前构造一次。
list/get/source/discover 首次水合即透传同一 callback，包含 discover 事务闭包和 source 三个 alias；
read/detail 闭包只复用已完成的 Map。无 context 的详情/current/workbook/job 仍走完整默认集合，
非空水合工厂一次，空 scope 不创建 presentation 工厂，不引入跨请求缓存。

每唯一 captured 六字段 DTO 只调用一次 callback；副本复用最终值。
仅在已定义类型的 event.publishedPresentation、evidence/officialEvidence.publishedName
槽位隔离旧 sanitize 后附回。任意旧 raw/candidate/audit 内的同名键仍照旧脱敏，
没有修改全局 sanitizer 或公开 skip/alreadyRedacted 参数。
最终 UTF8 继续计属性键、封套、重复 DTO、转义和格式化文字；current 为1DTO＋2texts。
短秘密替换扩张也拒绝超限，不裁旧字段；工作簿继续沿原失败禁止发布路径。

本片只授权两专属测试中的 `391` 小合成目标；实际 HTTP/MCP、原40事件 HTTP预算链、
默认 native executor、独立异步导出→artifact→XLSX、type/build/full 由父另授，未跑均 UNRUN。
原 full5058 PASS/34 FAIL/19 SKIP exit1、40事件51SQL strict<30 FAIL、#345/#346/stage03/errno48
及 A/R1/R2 文书、环境、计量、预算的全部历史 FAIL/UNKNOWN 保留。15/21 仍为设计估算；
小合成直接 API 的40事件控制实测10 statements（含两次凭据读取）、28,853 bytes driver物化，
需与原 HTTP/SDK 链分别记录，不能抵销原51SQL失败。

### 显式名称脱敏与稳定 typed 结构

presentation 从已验证的存储行和 caller scope 构造完整 captured 输入，显式调用
`redact(capturedFact, 'official_published_name')`。callback 仍收到含 evidenceId 的完整对象，
每唯一 fact 一次；内部模式只返回脱敏后的 nameRaw（string/null），使用原请求同一秘密闭包。
JSON 字符串、敏感 JSON 键、转义及 Bearer 继续原字符串规则；不额外解析凭据或重建工厂。
presentation 拒绝其它返回类型并整体 read_failed，再由 verified storage 构造固定六字段。
六个键、ID、revision、availability 和 sourceBindingKnown 不经过 generic 文本替换；
nameRaw=null、空串与字符串各保原义，不用旧名称或 legacy 状态兜底。

省略 mode 的公共 ReceiptRedactor 调用继续原 generic 函数体，不按字段名或对象形状识别 DTO。
任意 raw 中同名、同六字段形状的字典及 JSON 内部键仍按旧策略过滤、改键和脱敏。
API 的旧 evidence/officialEvidence 容器使用 sanitizer 返回的实际键附回 typed 值；
不恢复被秘密改名的旧键。两键发生碰撞时保持原插入顺序的 last-entry-wins。
该 mode 只属于内部调用能力，不进入 HTTP/MCP 参数或公开 skip/alreadyRedacted 协议。

本次回归包含六个字段名和 captured 枚举作为合法 secret、Map 真实 key/size、同形 raw、
null/empty/JSON/Bearer、完整 context/默认秘密集合、多次调用仍仅两次凭据读取、
callback 非文本返回无 partialMap。原 evidenceId=2 真 throw、非幂等 REDACTED、
40事件波次、预算膨胀与资格/hash 断言保持。binding=true 控制只在 fresh memory fixture
补齐 source_document/FK/SHA/bytes/section/listNo 合成数据，不代表真实 capture 或文件核验。

本轮冻结测试 RED 为27 PASS/25个产品行为 FAIL；随后唯一 GREEN 为89 PASS、29 filtered、exit0。
原R5的8 PASS/26 FAIL及63 PASS/8 FAIL、R7的27 PASS/25 FAIL（其中7个fixture约束错误）
原件分别保留；R7七项不计产品RED，本轮补齐合法fixture后才触达行为断言。
未导出的signal/aggregate unhandled继续UNKNOWN。新head的type/build、原40事件HTTP链、
MCP SDK/default native、独立异步导出与full均UNRUN。本段文档在GREEN后补写，属于
运行源码到提交映射的唯一文档例外，不冒充与测试运行时全文件字节相同。

### 旧容器键与有序碰撞（#391 R13）

API 按水合对象原有的 `Object.entries` 顺序处理旧字段。每个旧键通过既有
`sanitizeEvidence({ [key]: null }, redactors)` 获取过滤或改名结果；保留的旧值继续原
sanitize，可信 event/evidence 子对象才进入明确的 typed 接缝。最终使用
`Object.fromEntries`，保留原同名覆盖的 last-entry-wins；不按兄弟字段拆组后重新附加。
full list 仍先构造 `{ ...result, rows: details(...) }`，覆盖 rows 不改变原属性位置。
旧 event/predecessorEvent/rows/source/correspondences 即使为空或 null 也继续改键；
只有既有新增 publishedPresentation/publishedName 槽的最终 DTO 值隔离二次脱敏。
任意 raw 同名/同形字典、敏感键过滤及 own __proto__/constructor 数据仍走旧 generic 规则。

R12 新增60个独立 literal 分区，原118个 case 的完整字节区域保持；产品未改时一次 RED
为8 PASS/52个预期行为 FAIL/118 skipped。R13 沿父独立核验直接应用精确 API 提案，
同字节测试唯一 focused GREEN 为149 PASS/29 skipped、exit0，逐 assert failureMessages 为空。
新分区覆盖三类来源旧键、空/非空/前驱 null、summary 对照、完整12字段反向对应、
双秘密碰撞的最后赢家、原属性顺序及 raw/prototype 负控制。
R12 记录器将 filtered 误记0的文书错误原件保留，不修改或重跑；R11 btoa 与R10临时根错误
同样保留。R5/R7及全部更早 FAIL/UNKNOWN 继续按原对象归属，不因本次 GREEN 消失。

9b91 的父 type/build 和原29 focused（含原40事件 HTTP strict<30）通过只归该旧 head；
本次新候选仅有上述149个小合成通过，原29被过滤。直接 API 小测仍实测10 statements/
28,853 driver bytes，不等同 compiled HTTP、MCP SDK/default native 或独立异步导出。
新 head 的 type/build、真实 SDK/native/异步 artifact→XLSX、full 等仍 UNRUN，交父另授。
本节为 GREEN 后授权文档补记，是本轮运行源码→提交映射的唯一文档差量。
