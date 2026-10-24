# 年度决定读取的当前 target（#263）

`readAnnualDecisionRefs(db, relationIds, target?)` 的可选内部 target 取现有 `AnnualWriteScope` 的 eventId、enterpriseId、titleCode、declareKind。已知 target 时，将原 `assessStep` 的条件提前到 SQL：event_process 类型、当前事件/企业/称号，以及 context_only 或当前事项支持角色。支持角色沿原表达式：apply 为 supports_award，其他值为 supports_review；本片不改变年度事项算法。

只有 SQL 返回的当前 target 对应进入原 `correspondenceRefValidity`。有效性、native title、来源指纹、proof、状态及返回排序的判断保持原样。`assessStep` 仍输入完整 current/protection relation 集合，保留同事件历史版本 rejected/unlinked；没有过滤旧版本或只查当前 relation。创建后的决定读回和 qualification enricher 传入已有 scope；receipt 的只读资格计算通过同一 assessStep 消费 scope。

不传 target 的独立读取保持原完整 observation-local 契约；共享 `readPlatformBusinessGroups` 仍包含其正式契约要求的已有决定元信息。本片不缓存 source/proof，不改变共享分组、年度/版本算法、UI、DTO、role、schema 或任务超时。

专项 `tests/annual-decision-scope-263.test.ts` 使用实际 SQLite、projection 和 typed correspondence domain。有效性钩子透传原函数，记录实际被校验 IDs；规模从0到401其他事件时，当前target仅1行进入校验。完整读取与原“无scope读取后按同条件过滤”的输出对照，另验证完整 qualification、receipt 和 enrichment 输出、历史人工保护、新版本/异stored状态独立决定及当前来源失效仍需复验。

原 parent 全套的401归档续片 body60s+afterEach10s FAIL及既有两个timeout FAIL保留。一次新的原路径测量只能说明该环境下的时延和成本变化，不证明父超时根因全部定位、已修复或无性能回归。
