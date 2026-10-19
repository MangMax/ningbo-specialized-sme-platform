# #116 第四轮资格修复

本轮只修改当前名录导出读投影，规则为 `current-roster-116-v5`；历史 v1–v4 任务摘要原样显示。共享 lifecycle、Refs、UI、三入口路由及 #108 边界不变。第三轮历史交接与测试日志保持原版本归属。

## 证据适用与消解

原认定 `(year,batch)` 确定事件关联；`award.decidedYear ?? award.year` 确定真实授予时间，`review.decidedYear` 确定延续或终止时间。原周期与实际决定时间分别比较。

私有裁定器先把完整授予/通过/失败事实与日期、结果、批次缺口分开。只有严格更晚、且能消解缺口全部可能作用的事实，才令旧缺口不再阻断当前结论。重新授予可消解旧潜在失败；同批次最终明确失败可消解更早未知结果；passed 只延续，不能消解潜在失败或失败后的恢复疑点。同年不证明顺序，缺时间不补时间。未知批次保留为该原年份的适用性缺口，不凭空新增批次，也不猜成某一已知批次；另批终止不能自动消解它。

全部事实和缺口继续进入工作簿依据/出处。已消解缺口的备注说明消解事实，未消解缺口指明事件及受影响的日期/结论/批次。逐周期处理失败、恢复及三年期限后，当前原年份的全部批次作一致性聚合；全部 eligible 或全部 excluded 保留该结论，混合或未决才 pending。跨周期同年恢复疑点只比对当前批次最后真实 award，不重新扫描已经被更晚 award 消解的旧 tie。当前周期已明确终止时，也不再依赖旧认定是否完成恢复，不能把排除重新降为待确认。

无出处旧认定仍留引用，首次依据缺失仍留空。旧原年晚决定不等于当前原周期：独立正式延续能确证当前资格时，补旧出处前后集合一致；当前原周期或无法关联的出处缺口仍待核。

## 判定表

Y 为执行年；下列具体年份在测试夹具中按 Y=2026 等价表达。

| 事实 | 字面结论 / 当前缺口 |
| --- | --- |
| 原2022两batch均 passed2025 | eligible，全部事件及出处保留 |
| 原2022两batch均 failed2025，无后award | excluded |
| 两batch均 award2025，未到期 | eligible |
| passed与failed、无复核、缺结果或缺结论年组合 | pending，具体批次的混合/未决说明 |
| 原2010 failed2022，原2022 award2022及再award2025 | eligible，首次历史2010 |
| 旧同年恢复疑点后，当前周期明确failed2025 | excluded，较晚终止不依赖旧恢复疑点 |
| 上例只有award2022，或后续只有passed2025 | pending，尚未消解的同年恢复顺序 |
| 原2018 unknown2022 → failed2025，同一batch | excluded，旧缺口及引用保留 |
| 同周期 unknown2020 → award2025 | eligible，真实授予消解旧缺口 |
| unknown2021、failed2022 → award2025 | eligible，不猜旧结果 |
| 缺batch的review2020 → 明确award2025 | eligible，新授予在旧潜在终止之后 |
| unknown2020 → 仅passed2025 | pending，旧结果可能为失败，passed不构成恢复 |
| failed2022 → 仅passed2025 | pending，恢复矛盾 |
| unknown与award/failed同年，或unknown更晚/无日期 | pending，无法证明消解顺序 |
| 旧passed缺batch + 当前另一明确batch的passed | pending，缺口可能对应另一已到期batch，不能猜归属 |
| 旧unknown缺batch + 另一明确batch的failed | pending，不能以一批终止推断另一可能批次终止 |
| 无出处award原2018/结论2023，独立review原2022/结论2025 passed | eligible，首次空，旧event引用保留 |
| 上例补旧出处；旧award时间在独立延续之前/同年/之后 | eligible集合不变，正式首次历史按共享生命周期表达 |
| 只有独立review，无award | eligible，首次空 |
| 当前原周期award/review无出处，或award原周期/日期无法确定 | pending，保留具体出处缺口 |
| 已知旧周期review即使结论较晚且无出处 | 不冒充当前原周期，独立有效延续保留 |
| 不同原周期failed与passed恰同结论年 | 新周期正式延续仍eligible |
| 无award独立周期failed后仅passed | pending，不能伪造恢复 |

## 公开验证接缝

`tests/fixtures/current-qualification-r4.ts` 保存独立字面场景，不导入裁定器；`tests/current-export-cycles-r4-http.test.ts` 经真实 Nitro HTTP 提交202、查询终态、鉴权下载、ExcelJS读取字节，核对三称号精确集合/计数、首次年份、全部正式事件和出处、无出处引用、缺口备注、说明及任务摘要规则版本。整表再做反向插入与事件/出处ID置换并检查外键和业务摘要。没有私有函数断言，也不替换SQL返回值。

第三轮矩阵继续运行，仅纠正“一致passed仍pending”的错误期待；原混合batch和failed→passed边界不改。版本摘要测试同时保留v1、v2、v3、v4、v5和未知版本，不重标持久任务或产物。执行证据、红绿及失败日志和最终SHA/tree由本轮 `/tmp/spec116-review-fixes-r4-handoff.md` 归档，本文不借历史绿灯声称当前验收。
