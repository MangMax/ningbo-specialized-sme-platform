# 企业详情平台业务历史（#246 第二项）

`GET /api/roster/enterprises/{id}` 保持旧 `platform.queries`、`platform.relations` 的字段及归档语义，新增 `platform.businessRecords: PlatformBusinessDetail[]`。类型在 `lib/roster/platform-business-detail.ts`，可供下一层 comparison 复用；不改变 comparison 输入和 proof 语义。

读取先由已有 enterprise scoped snapshot 确定展示观察（含已认定查询的未匹配原行），在同一个详情事务、同一个 offmain 执行器内调用共享 `readPlatformBusinessGroups`。只读取这些 relationId 的轻量 canonical 映射和原决定引用，不读取 canonicalRawJson、不扫描全库原文，不另开数据库快照。

每条业务返回：

- `businessRecord`、`representativeRelationId`：同接口+canonical record 的最近实际 queriedAt 观察；时间相同时用 relationId 决定稳定顺序。版本 ID、索引时间不作采集时间。
- `versions`：每个已核实内容版本的 metadata、代表原行、全部 `observationRefs`。相同原文复用版本；A→B→A 为 2 个内容版本、3 次观察。版本按最近实际采集时间展示，观察仍保留原行引用。
- `versionCount`、`observationCount`、`unknownContentObservationCount`：当前选中观察的已核实内容版本数、采集次数、内容未核实观察数（contentState 为 unverifiable/not_indexed）。未知内容观察不增加版本数；未投影只表示尚未核实其内容版本，不表示归档原文一定缺失。
- `observationRefs`：原 relationId/queryId/queriedAt、身份/来源称号、轻量 metadata、该观察自己的 conflicts 和 existingCorrespondenceIds/existingCorrespondences。raw 仍从旧 `relations` 按 ID 取，source reader 仍按原 relationId 读取。
- 业务层 `existingCorrespondenceIds/existingCorrespondences/conflicts` 只作并列引用/冲突提示，不产生业务级确认、不将一个观察的决定复制给其他观察或版本。明确称号/身份冲突跨版本保留，决定冲突按 type/role 比较。

业务身份和内容版本独立：`identityState=resolved` 且有 recordId 的观察，即使 contentState=unverifiable/versionId=null，仍按同接口+recordId 汇入一条已知业务。未知内容观察在历史中逐次单列，不挂到任何已知版本、不假定其内容相同、不造不同版本节点。若整条业务只有未知内容，`versions=[]`、`versionCount=0`，同时保留全部原观察和未知内容观察数。

未投影、缺编号、编号冲突导致无可用业务身份时，才按 relationId 独立退回身份待核原行。页面的已知业务数不包括这些原行。共享候选 helper 的未知版本隔离是候选安全边界，详情使用其观察引用后，按上述业务身份重新汇总。

UI 保留称号 Tab、来源筛选、表格横向滚动、原字段和对应事件/出处入口。筛选先作用于原观察，再调用 `groupPlatformBusinessDetails` 重组，默认代表、计数、历史和冲突均来自所选观察。最新版本的称号不会删去旧称号的历史。无称号申报沿用同编号关联称号的展示筛选口径，界面明确说明其不作为认定事实；DTO 不将其升格为来源称号。

历史使用已有 `DisclosurePanel` 内联展开。原字段 Dialog 与 source reader Dialog 是并列入口，不在历史 Dialog 内嵌套第二个 Dialog。
