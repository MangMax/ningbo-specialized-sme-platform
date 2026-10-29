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

扫描完整候选进行计数，仅保留有效页和待核页的轻量 ID/见证；迭代 statement 释放后，在同一外层读事务内 hydrate 两页完整 T2。请求内 prepared handles 复用不缓存结果或有效性，不跨请求累积全候选。完整 secret 集合、#391 批页、公开名称 1 DTO / 2 文本预算保留。64 KiB 为 IPC 单 chunk，不能据此声称总响应体上限；最大 200 × 两组、真实 SQL/heap/IPC/native 容量仍须专门授权验证，不能放宽 timeout/预算或削掉 T2。

冻结 owner 共 13 路径：

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

不增加 DB schema、资格事实表、全局 cache、共享组件或第二裁定器；超 owner/新 scope/破坏兼容/新架构须先交父裁定。

## 当前证据边界

父已运行的核心集合为 89/89 PASS（本票 50 + 共享 406 的 36 + 原性能 3）；当时三文件集合 typecheck exit 0。这些结果只覆盖其对应源码/测试快照，不覆盖后续 HTTP/UI 新文件或本次页面/元数据/文档。

首 UI guarded RED 已实际成立：原有效名称、total=3、原 q/page=2/pageSize=1、captured query 和 pager=3 先通过，随后缺“已公布待核企业”分区失败。该结果是组件/transport 证据，不能冒充真实浏览器。历史 busy iterator、display reads 9 对 3、prepare 119 未小于 100、fixture revision oracle 及两轮类型 FAIL 均保留于 Git 外父回执；后续 PASS 不删除这些事实。

本次仅静态接入。新页面 GREEN、其余 UI case、HTTP/真实 SDK 八例、实际 dev OpenAPI 生成、desktop/390px、compiled、最大 200 × 两组和真实容量、全量测试/CI/build 均 UNRUN。aggregate 未捕获字段仍 UNKNOWN。后续由父分别授权最窄窗口，不宣称 whole #408 ready。
