# 当前资格查询兼容契约（#408）

当前资格 HTTP、MCP 与页面消费同一共享评估；本片范围为 M／高、一个纵向 PR。本文描述候选实现与已有证据边界，不表示整片验收完成或生产已修复。导出由 #409 继续负责，差异引擎、对应页、全库审计及母组合验收分别留给 #410–#413。

## 资格与执行范围

`GET /api/roster/current-enterprises` 与 MCP `list_current_qualified_enterprises` 复用相同输入校验和只读执行器，返回 `responseVersion: current-qualified-408-v1`。共享评估仍为 `enterprise-qualification-407-v1`，规则仍为 `current-roster-116-v8`。正式有效资格不得仅因平台无记录、不通过、查询失败或未查询而被排除；不同称号的状态不互借。注销、迁出和明确复核失败等排除事实沿共享评估处理，不包装成补齐资料即可有效的待核企业。

每个保留页行的 `qualificationAssessment` 都含完整三称号 `titles`。scope 是顶层 `enterpriseId`、`asOf`、`ruleVersion`、`assessmentVersion` 四字段；`snapshotId` 为 `SHA256(JSON.stringify([scope, titles]))`，每个称号保留自己的事实、来源、决定、观察版本和引用。完整对象沿 wire 保留，页面只展示本次响应所选称号已有的正式资格说明、资料缺口和公布事实，不生成另一套资格或年份判断。

`asOf` 等于本请求 `snapshotStartedAt`，评价年取该执行时点的 UTC 年。它与来源行的 `validYear`、首次认定年份及用户认定时间窗口分离。这是当前数据库事实在同一快照内的评估，不是用当前库重演某年的历史数据库。跨真实请求的执行时点和 digest 可以不同；比较同事实时应分别核各自 scope/digest，再比较事实与输入版本，不伪称不同 asOf 的完整对象深等。

## 旧字段与新增分组

| 字段 | 保持的含义 |
| --- | --- |
| `rows` / `total` | 所选称号 eligible 且确定满足已选条件的企业页 / 分页前完整计数 |
| `uncertainTotal` | 旧认定时间精度语义：年份事实与窗口部分重叠或缺少日期事实；不包含资格 pending |
| `options` | 所选称号当前有效行的可查询见证；不从 pending 补造选项 |
| `page` / `pageSize` | 同一请求页码 / 每组页大小；上限仍为 200 |
| `publishedPending` | 稳定对象 `{ requested, rows, total, page, pageSize }`，独立于有效计数 |

只有通过原输入校验且名称或信用代码规范化后非空的 `q` 才请求待核定位。定位使用现名、统一社会信用代码、已确认曾用名和已选区县，并要求本称号有适用正式公布依据且共享 T2 为 pending。待确认别名不是已确认曾用名；平台快照或其他称号不能替代正式公布依据。

无 `q` 时 `requested=false, rows=[], total=0` 表示未请求，不是全库待核总量为零。直接 reader 的规范化空查询也不触发全量待核；公开协议仍保持原校验，纯空白 `q` 不合法。`requested=true` 且 `total=0` 才表示此次定位范围没有待核结果；有总数但越界页为空不表示不存在。两组使用相同 sort、同名 ID tie-break 和同一 `page/pageSize`，各自完整计数与分页，不互相扣减或跨页补位。

每个待核行的 `filterMatch` 只解释已选字段，不裁定资格：

| `status` | 页面说明 |
| --- | --- |
| `matched` | 符合已选筛选 |
| `not_matched` | 不符合已选筛选 |
| `not_established` | 尚不能确认满足已选筛选 |

`checks` 只含实际选择的 `recognitionRange`、`validYear`、`maintenanceYear`、`maintenanceBatch`；未选字段时 `checks=[]`、`matched`。同周期同来源行 AND 见证沿旧逻辑使用，不能把不同行、不同周期或不同称号的各自命中拼成满足全部条件。待核企业即使不匹配或不能确认，仍可展示其身份/地域对应的公布事实，且不计入有效或日期精度不确定计数。`matched` 也不代表资格已确认有效。

认定时间闭区间须完整覆盖正式决定年份才确定命中，不补造月日。来源事实白名单不变：仅 observed `innovative_sme` 的 `queryBusList` 返回行支持 date-only `rddqrq` 的有效年份；返回 `whpcyear` 为空时，`YYYY-N` 型 `whpc` 仅提供维护年份。批次后缀、datetime、非空 `whpcyear`/plain batch、其他称号及未验证格式保持未知。查询条件不是返回行事实，也不是生命周期 dueYear。

## 页面状态与失败

页面用同一个 `useRetainedQuerySnapshot` 的 `displayed` 持有有效页、待核页和 captured request。切换目标加载或失败时，两组继续显示原成功范围、完整长条件、原页码及原详情 `currentBack`；失败说明同时列出原范围和失败目标，重试仍请求当前目标。迟到的旧请求不能替换已成功的新目标。

两组各用原 `TablePagination` 显示自己的 total，使用相同 captured page/pageSize。加载、失败或显示旧范围时均禁用分页；分页事件只从当前成功 captured params 导航，详情及公布出处链接也来自同一 displayed request。原有效表与导出入口保留，不改导出行为。

“已公布待核企业”是有名称搜索时的定位分区。选中称号的 `completeness.fieldGaps` 使用事项年份、结论年份、认定批次、复核结论等业务标签；不显示其他称号的缺口作为本称号结论。未请求不显示假零总量；旧响应缺少扩展时明确说明不能据此判断是否存在待核企业。两组任一公布名称投影不可用都进入查询失败，不能静默删除行或假作空集。首请求失败没有成功计数；成功空结果与不可用状态分开。

公开输入 schema、400、MCP 原参数校验、503、原预算/admission/native/chunking 均未改变。API 新增 OpenAPI 响应扩展元数据，MCP 实际工具描述同步；静态元数据不是已生成 OpenAPI 或真实 SDK 验收证据。读取失败应重试，不能解释为无企业。

## 资源与 owner 边界

扫描完整候选进行计数，仅保留有效页和待核页的轻量 ID/见证；迭代 statement 释放后，在同一外层读事务内 hydrate 两页完整 T2。请求内 prepared handles 复用不缓存结果或有效性，不跨请求累积全候选。完整 secret 集合、#391 批页、公开名称 1 DTO / 2 文本预算保留。64 KiB 为 IPC 单 chunk，不能据此声称总响应体上限。旧 source-bound D 已验证 201 有效 + 201 待核的 200/200、1/1、0/0 页及完整计数；该容量结果不冒充本次核心接缝改动后的 fresh 容量验收。native SQL plan、逐 message IPC 和 binding load 等未观测指标保持 UNKNOWN，不为补指标新增观察框架，也不放宽 timeout/预算或削掉 T2。

父 Gate3 批准 allowlist 共 16 路径；其中 406 与原 performance 测试为未改动的可选 owner，本票实际手写差量为 14 路径。前置共享投影提取和详情标题分别独立交付，不并入本票 owner：

1. `lib/roster/current-qualification.ts`：共享评估与请求 prepared/read 接缝。
2. `lib/roster/current-qualified-query.ts`：旧筛选见证、双组计数和有界 hydrate。
3. `server/utils/record-correspondence.ts`：固定 enterprise/title prepared refs；旧任意 filters/sources 路径保留。
4. `server/api/roster/current-enterprises.get.ts`：HTTP 入口和响应元数据。
5. `server/mcp/tools/list_current_qualified_enterprises.ts`：MCP 工具入口和描述。
6. `pages/current-enterprises.vue`：同 DTO 展示与保留成功范围。
7. `tests/current-qualified-read-performance.test.ts`：原读取/prepare 预算回归。
8. `tests/current-qualified-408.test.ts`：独立 literal 核心矩阵。
9. `tests/current-qualified-408-http.test.ts`：真实 Nuxt/Nitro、隔离合成 SQLite、真实 SDK。
10. `tests/current-qualified-408-ui.test.ts`：实际 page 与 transport 层组件控制。
11. `tests/helpers/current-qualified-408.ts`：本票专属真实 schema 合成 fixture。
12. `tests/enterprise-qualification-assessment-406.test.ts`：默认共享 T2 完整等价回归。
13. `docs/current-qualified-408.md`：当前契约与证据边界。
14. `tests/current-qualified-154-http.test.ts`：严格跨执行时点行比较适配。
15. `tests/current-qualified-155-http.test.ts`：同上，保留旧输入和错误 guards。
16. `tests/official-published-consumption.test.ts`：加法完整 T2 兼容与来源修正 oracle。

不增加 DB schema、资格事实表、全局 cache、共享组件或第二裁定器；超 owner/新 scope/破坏兼容/新架构须先交父裁定。

## 当前证据边界

证据按运行输入区分；后来的 PASS 不改写原 FAIL、INCOMPLETE、STOP 或 UNKNOWN。本次源码基线是 HEAD `127e29706f69aca000cb444680c59ce2ac005a01` / tree `01ae03ff4ce82a6559422adb8bd3d1dc28ce4153`，在其上仅两核心文件和原 consumption 测试为运行时 dirty 候选。本文证据更新发生于 B4 完全收尾并释放 slot 之后，是单独的文档差量，未作为 B4 运行输入。

### 本次核心与构建输入的 fresh 证据

`/tmp/issue408-resume-b03-b10-c_353oq0` 保留 consumption 完整 17/17 PASS、391 focused 11 PASS / 51 filtered、逐例 failureMessages=[]。B03 原 count=1、精确事件 scope、pageSize=50/maxBytes=65536 断言未放宽。B10 分别验证完整三称号 scope/default parity/独立 digest，以及 evidence2/event2 capturedRevision 1→2 和两个独立来源版本 literal，再保持旧 enumerable 字段严格相等；真实来源修正不是可删除的时间差异。

保留页仅在同 enterprise/asOf/事务及精确有序来源 scope 时复用已验证官方事实，分别供完整 T2 与最终展示投影使用。scope 不同仍独立读取；不缩 T2 scope、不把所选称号事实灌给其他两称号，不跨请求缓存结果。最终展示 response_limit 不删除 T2 的 capturedRevision/nameKnown。旧默认 read/readTitle/options 保持，未改变全 secret 或批页校验。

同一窗口真实加载 locked vue-router 5.4.0 插件 SHA `0186b559341b0cfebf9c3f3faf0595ca173e934ea0db73fc0e462ebbcc9c15d1`，显式仅向 type 子进程传入 `NODE_PATH=<WT>/node_modules/.pnpm/node_modules`，完整 typecheck 自然 exit0，raw log 无插件加载/解析或 TS 诊断；随后普通 build 自然 exit0。默认环境历史 exit0 但插件加载失败的 typecheck 仍是 INCOMPLETE，未改依赖或配置来宣称默认命令已修。tests/build/app/native 不继承该 NODE_PATH。生成物完整 2091 项及新的四入口/dependency/sourceMap SHA 已封存，build warnings 原样保留；不拿旧 worker pin 当当前产物。

391 的 secret union、fault、typed union 及最终 65535/65536/65537 和 escaping 证据来自受控合成上下文、runtime/env 与 credential 值；这是实际工厂/投影路径的合成控制，不是扫描真实凭据的认证。未选中的 51 case 不称本次执行通过。

### B4 真实浏览器与当前 compiled smoke

`/tmp/issue408-b4-runtime-once-m6oum8la` 使用上述实际构建入口、default native 256/16，隔离合成 2 有效 / 3 待核 / 3 排除，一个 agent TaskSpace48/page，实际 1440×900 / DPR1。未重复移动端、分页、日期或详情操作。

真实传输失败时，旧有效/待核两组、原请求范围、计数与详情链接保留。阻断状态下真实重新加载点击对应新失败请求 `52439.159`；第二次真实点击唯一对应透明暂停请求 `52439.161`，放行后同 ID HTTP200/loadingFinished 且 DOM 更新，手动 attempt 与 success 分别取证，未把自动恢复当手动成功。

旧 pending 请求 `52439.165` 在真实 HTTP200 Response 阶段暂停；新目标 `52439.166` 完成且 DOM 已显示 eligible_001 后，透明放行旧请求。同旧 ID 的 response200/dataReceived/loadingFinished 事件随后返回，未取消，最终两组/source/counts/currentBack 保持新目标。该事件投递/DOM 隔离证据与底层时间字段分开：旧 `loadingFinished.timestamp=484432.154057` 数值早于新请求完成 `484432.623744`，因此不声称底层传输完成时间也晚于新请求；该数值顺序及原因保持 UNKNOWN，原始字段不归一化。

本轮追加读取三个已完成请求 body 的 CDP 调用均返回 `No resource with given identifier found`，未补发请求或伪造 DTO；本 B4 的完整 wire T2/asOf/digest 追加校验为 UNRUN。页面/真实网络行为是当前 compiled smoke，不能提升成 actual SDK 或完整 HTTP 协议矩阵。SDK NOT_STARTED。截图均保留 PNG/SHA 并实际查看。

本轮合成库全表 DDL/content hash 零写；root/native 实际 PID+birth observedGone、listener0、registered/whole owned0，runner 自然 exit0，stdio/logger 收尾完成。普通 rawbind 单次成功，release-first 同 grant byteCAS/readback 为 FREE。这只描述本轮；原 C3/D 的 Err48false / STOP_OPERATIONAL_REBIND 及原因 UNKNOWN 永久保留，不以新 bind 成功覆盖。app/native DB closeReturned、binding load、未观测 handles、aggregate unhandled 缺字段继续 UNKNOWN；自有 seed/reader DB closeReturned 单列已证。

B4 原静态 own-mock 的顶层 config.port 断言 FAIL 保留；父仅修正为真实 stages.B.port 后的独立 7 PASS 收据作为附加 prerequisite，未修改或重跑原 FAIL 原件。

### 最后七文件定向联合回归

`/tmp/issue408-final-related-seven-iqoci9ir` 在同一候选核心/页面/协议/测试字节上，用一次无 filter/bail/retry 的 `maxWorkers=1` 完整运行以下七文件。实际原始 JSON 注册 **177/177 PASS**，0 FAIL/skip/filtered/todo，逐 case `failureMessages=[]`，自然 exit0/null；未按估算总数补造通过。

| 完整文件 | 实际 PASS |
| --- | ---: |
| `tests/current-qualified-408.test.ts` | 86 |
| `tests/enterprise-qualification-assessment-406.test.ts` | 36 |
| `tests/current-qualified-read-performance.test.ts` | 3 |
| `tests/current-qualified-408-ui.test.ts` | 11 |
| `tests/current-qualified-408-http.test.ts` | 8 |
| `tests/current-qualified-154-http.test.ts` | 7 |
| `tests/current-qualified-155-http.test.ts` | 26 |

后三文件使用其原真实 dev HTTP/MCP fixture：408 HTTP 包含真实 SDK Client/transport，旧154/155保留原 MCP JSONRPC transport，不冒称全部是 SDK 调用。实际8例同时逐响应验证完整三称号 scope/versions/digest、跨执行时点完整 facts 一致及全表 DDL/contenthash 零写；这不补造 B4 中三个 NoResource body 捕获。核心86包含原50、严格跨时点 adapter36；共享406与原3性能断言未放宽。

运行源码1810首尾 exact，生成物2091无 delta；最大 sampled known aggregate RSS 为2676228096bytes，5GiB/900s总/870s active/30s reserve 均未放宽。samegrant raw-byte CAS release-first FREE，outer owned0/signals0。aggregate unhandled 缺字段保持 UNKNOWN；原 UI router warning/raw log 与 HTTP fixture rolling-log、内部 app/native close 可观测性边界保留。消费17/39111/显式插件完整 type/build 没有重跑，除文档外源码字节一致，按原收据继承。

本节发生于七文件 runtime 释放之后，是独立文档差量，不作为该177例或 B4 的运行输入；不把定向回归写成 full/CI。

### 继承范围与仍未覆盖

原核心89、adapter36、HTTP8+旧33及UI23历史快照均保留；本次已将其中核心86、共享36、性能3、UI11、HTTP8+旧33作为上述177例 fresh 运行。未选的原154/155 UI12及桌面/390列表/分页/currentBack/日期仍按各自原源码快照继承。旧浏览器详情标题问题由独立前置交付，不能据合并倒签旧失败。本 B4 不重复这些矩阵，也不把旧 D 容量提升为当前源码的 fresh 容量运行。

401 confirmed runtime、native SQL plan/逐 IPC/binding load 等保持精确 UNKNOWN/UNRUN；父已接受 unchanged idChunks400/有效性 body 及实际小 confirmed drift/performance 证据覆盖本票 delta，不把 405 家企业当作 401 条 confirmed。原 busy iterator、display reads 9 对 3、prepare119、fixture oracle、类型/插件错误及浏览器 STOP 原件均保留。

全量测试、CI、母 #413 组合验收、真实业务库/3481 环境与部署未运行；本文不声明 whole #408 ready，也不授权提交、PR、合并或部署。


### PR424 R1 待核原因展示窄修（后置证据补记）

R1 Standards 静态 0 finding；Spec 发现一项 P2：正式资格有效、事件字段已记录，但主体或地域事实仍待核时，查询页未显示共享评估的具体原因。仅在原页面的桌面／移动待核区域展示所选称号已有 `subject.message`、`region.message` 和 `notes`，去重后按普通文本换行；不新增资格条件、不借其他称号、不改计数、筛选或 DTO。

`/tmp/pr424-pending-reasons-parent-sw62cl7r` 保留四例组件业务 RED 原件：桌面／移动各覆盖主体未决和地域未决，在正式资格 eligible、completeness recorded、fieldGaps 空等 guard 后，缺少地域说明断言失败。原监督器误漏 Vitest 名称引号而 STOP 的记录保留；父只读核验原始四例 JSON，没有重跑 RED。随后三文件 UI 回归 **27/27 PASS**（原23＋新增4），显式 locked5.4.0 插件完整 typecheck、普通 build 均 exit0，源码首尾 exact；默认类型环境历史 INCOMPLETE 不改写。

`/tmp/pr424-pending-reasons-resume-zxebxi8_` 使用本次实际构建和隔离合成库，在桌面1440×900及390×844各确认主体、地域待核说明和 notes，名称／长说明正常换行且无横向溢出，eligible/pending 计数仍2/3。真实 HTTP200 完整 body 独立校验三称号、scope/versions/digest、整体 pending 与正式 eligible、fieldGaps 空及零写。该真实 fixture 的来源／名称完整性仍 incomplete，不能冒称实页复现了 completeness recorded；后者仅由四例组件控制证明。SDK NOT_STARTED。所见 owned/listener 释放、单次 rawbind 成功、samegrant CAS release-first FREE；未观测 handles/app-native close 等 UNKNOWN 保留。

这次仅页面、原408UI测试及本节文档差量；原177例仍绑定623266fc，核心/协议逻辑未变且未重复执行。R1 Spec 记录保留，独立 R2 关闭与否由新固定候选复审核定。上述两次运行后的本文补记不冒充运行输入；full/CI/母413/真实环境及部署仍 UNRUN。
