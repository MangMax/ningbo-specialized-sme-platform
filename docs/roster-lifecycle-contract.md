# 名录生命周期契约(冻结)

> **状态:冻结(2026-10-16,RL-01)。** 本文件是并行实现票(RL-02…RL-11)**唯一**的实现依据:
> 表名列名、枚举取值、接口形状以此为准,照此写代码不必回头再问。
> 决策与理由见 [`docs/adr/2026-10-16-roster-lifecycle-model.md`](adr/2026-10-16-roster-lifecycle-model.md);
> 机器级定义见 [`db/schema.ts`](../db/schema.ts)(与本文**逐字一致**),
> 迁移见 [`db/migrations/0007_premium_sinister_six.sql`](../db/migrations/0007_premium_sinister_six.sql),
> 验收样例见 [`tests/lifecycle-contract.test.ts`](../tests/lifecycle-contract.test.ts)。
>
> 平台接口字段与真实响应形态的**已核实证据**见
> `/Users/mang/Workfile/宁波/专精特新/20261013/orchestration-notes/04-EVIDENCE-91330211255994457P.md`
> (原始响应与凭证**不进仓库**;本文只引用其结论与该文件路径,不复制全文)。
>
> 本票(RL-01)**只冻结契约、只落最小 schema、只写验收样例**:
> 不实现页面(`pages/**`)、不改项目外 `pipeline/`、不迁移任何生产数据。
> 文中标注了每个接口/能力**由哪张票实现**。

---

## 0. 三条不可违反的边界

1. **公布文件 = 权威历史。** 称号、年份、批次、认定/复核事件只由经信局公布文件及其附件决定,
   落在既有 `record` / `record_event` / `record_evidence` 上。平台快照**永不改写**它。
2. **平台导出 = 采集时点现状。** 三张工信部导出表是「某年某天平台长什么样」的快照,
   落 `platform_export_batch` / `platform_export_row`,与公布事件**分开存储、分开查询**。
3. **接口记录 = 证据。** 两个平台接口的返回落 `platform_query` / `platform_relation`。
   软件提供**证据查看、确认、回填、查询**;不建设**模糊推断 / 原因自动猜测引擎**。
   证据不足、关系冲突、同名多主体 ⇒ `待核实`,**不自动合并、不猜填**。

三层的关系:

```
公布文件 ──解析──▶ record ──▶ record_event ──▶ record_evidence
                    (权威历史)      (认定/复核…)

工信部导出表 ──快照──▶ platform_export_batch ──▶ platform_export_row
                        (采集时点现状,只作对照)

平台接口 ──查询──▶ platform_query ──▶ platform_relation ──▶ enterprise_alias(曾用名证据)
                                     │
                                     └──▶ difference_reason(差异原因 + 后续措施)
```

---

## 1. 表定义(与 `db/schema.ts` 逐字一致)

> 约定:`PK` 主键;`UQ` 唯一键;`FK` 外键;`NN` 非空;`?` 可空。
> 既有表(`title` / `enterprise` / `record` / `record_event` / `record_evidence` /
> `source_document` / `stored_file` / `stored_file_part` / `ocr_result` /
> `reconciliation_result` / `job`)**列语义一律不动**;本票只**新增可空列**与**新表**。

### 1.1 `record_event` —— 新增两列(补能力缺口)

| 列 | 类型 | 空 | 枚举 / 默认 | 说明 |
|---|---|---|---|---|
| `review_outcome` | text | ✅ | `passed` \| `failed`;默认 NULL | **复核结论**。只有 `event_type='review'` 才有意义。NULL = 不适用(认定/维护/培育)或结论未知 —— **未知不猜成通过**。 |
| `decided_year` | integer | ✅ | 默认 NULL | **结论年份**(事件公布/结论的年份)。与既有 `year` 分工:`year` 是事件**所涉**年份(复核事件记**被复核的原认定年份**),`decided_year` 是**结论发生**年份。缺失时锚点退回 `year` 并标待核。 |

> 为什么加这两列:现有 `record_event` 只能记「有一次复核」,**表达不了「复核未通过」**;
> 而三年复核语义(未通过后不再进入当前有效资格的复核队列)完全依赖它。
> 见 ADR「复核结果与锚点」。

### 1.2 `enterprise_alias` —— 企业曾用名 / 别名

`UQ(enterprise_id, name_norm, source_kind, source_ref_id)`

| 列 | 类型 | 空 | 枚举 / 默认 | 说明 |
|---|---|---|---|---|
| `id` | integer | | PK autoincrement | |
| `enterprise_id` | integer | | FK→`enterprise.id` ON DELETE cascade | 归属企业 |
| `name` | text | | | 别名**原值**(来源里的写法) |
| `name_norm` | text | | | 归一化别名(与 `lib/domain.ts` 的 `normalizeName` 同规则) |
| `source_kind` | text | | `platform_business` \| `platform_apply` \| `announcement` \| `manual` | 来源类别 |
| `source_ref_id` | integer | | 默认 `0` | 来源证据行 id(如 `platform_relation.id`);**`0` = 无具体来源行引用** |
| `valid_from` | text | ✅ | 默认 NULL | 来源给出的生效时间;**未给出留空,不推测** |
| `valid_to` | text | ✅ | 默认 NULL | 来源给出的失效时间;未给出留空 |
| `verification_status` | text | | `confirmed` \| `pending`;默认 `pending` | 核验状态;**`pending` 不参与搜索/归并** |
| `note` | text | ✅ | 默认 NULL | 备注(如关系原文摘录) |
| `created_at` | text | | 默认 `new Date().toISOString()` | |

索引:`enterprise_alias_name_norm_idx(name_norm)`、`enterprise_alias_enterprise_idx(enterprise_id)`。

**唯一键为什么是这四个**:同一企业、同一别名、同一来源(**含具体来源行**)只有一条;
**不同来源行(如两条平台关系各自报出的同一别名)各自成条** —— 逐条留证。
`source_ref_id` 用 `0` 而非 NULL 表示「无引用」:SQLite 把 NULL 视为互不相等,
用 NULL 会让重复行漏网。

### 1.3 `platform_query` —— 平台查询记录

`UQ(interface, query_key, rdjb, queried_at)`

| 列 | 类型 | 空 | 枚举 / 默认 | 说明 |
|---|---|---|---|---|
| `id` | integer | | PK | |
| `interface` | text | | `business_list` \| `apply_list` \| `recognized_list` | 三个独立来源（新来源见 #59 扩展） |
| `query_key` | text | | | 查询键:统一社会信用代码 或 `name:<nameNorm>`(与 `lib/reconcile.ts` 同构) |
| `rdjb` | text | | 默认 `''` | `businessList` 的 `rdjb`(认定级别):`1` 创新型 / `2` 专精特新中小企业 / `3` 小巨人;`''` = 该接口不用此参数 |
| `title_code` | text | ✅ | FK→`title.code` | 本次查询针对的称号;不按称号查时留空 |
| `queried_at` | text | | 不默认 | 查询时点(ISO) |
| `status` | text | | `success` \| `failed` \| `no_record` \| `not_queried`;默认 `not_queried` | 见 §3 |
| `failure_reason` | text | ✅ | | 仅 `failed` 有意义 |
| `raw_response` | text | ✅ | | 原始响应 / HTML 原文(供回溯,不参与查询) |
| `created_at` | text | | 默认 now | |

索引:`platform_query_key_idx(query_key)`。

**唯一键为什么是这四个**:同接口 + 同查询键 + **同 `rdjb`** + **同一时点** = 同一次查询(重放幂等)。
**`rdjb` 必须进键**:实测同一 USCC 下 `rdjb=3` 返回 6 条、`rdjb=1`/`rdjb=2` 各返回 0 条 ——
它们**是三次不同的查询**,不能互相覆盖。不同时点**各占一行**,满足「不丢历史证据」。

### 1.4 `platform_relation` —— 平台接口关系记录

`UQ(query_id, sequence_no)`

| 列 | 类型 | 空 | 枚举 / 默认 | 说明 | 平台字段(`businessList`/`queryList`) |
|---|---|---|---|---|---|
| `id` | integer | | PK | | |
| `query_id` | integer | | FK→`platform_query.id` cascade | 所属查询 | |
| `sequence_no` | integer | | | 关系序号(同查询内第几条,从 1 起) | |
| `relation_key` | text | ✅ | | 平台关联主键 | `id`(如 `SQ332022062212391`) |
| `enterprise_id` | integer | ✅ | FK→`enterprise.id` | 匹配到的企业;**无法判定时留空** | |
| `raw_fields` | text(json) | ✅ | | 原始字段(整行/整块原样) | |
| `source_text` | text | ✅ | | 源文本 | |
| `uscc_raw` | text | ✅ | | 统一社会信用代码 | `tyshxydm` |
| `name_raw` | text | ✅ | | 企业名称 | `qymc` |
| `alias_name_raw` | text | ✅ | | 源文本中明确给出的曾用名(若有) | |
| `province` | text | ✅ | | 所属省市名称 | `szsfmc` |
| `status` | text | ✅ | | 存续状态 | `cszt`(如 `终审通过`/`省已审`/`待审核`) |
| `batch` | text | ✅ | | 维护批次 | `whpc`(如 `2022-1`/`2025-1`) |
| `declare_kind` | text | ✅ | `apply` \| `update` \| `review` | 申报类型(申请/更新/复核) | `sblx` |
| `applied_at` | text | ✅ | | 申报时间 | `sqsj` |
| `award_batch_label` | text | ✅ | | 认定批次(如 `第四批`) | `personuuid`(列头为**认定批次**) |
| `year` | integer | ✅ | | 申报记录年份 | `queryList` 的 `year` |
| `match_basis` | text | | `uscc` \| `alias` \| `manual` \| `none`;默认 `none` | 匹配依据 | |
| `verification_status` | text | | `confirmed` \| `pending`;默认 `pending` | 核验状态 | |
| `created_at` | text | | 默认 now | | |

索引:`platform_relation_enterprise_idx(enterprise_id)`、`platform_relation_relation_key_idx(relation_key)`。

**唯一键为什么是这两个**:关系身份是「**哪次查询的第几条**」。
**同一信用代码返回的多条关联必须逐条保留** —— 实测 `businessList` `rdjb=3` 对该 USCC
返回 **6 条**,必须全部落库(不是折叠成 1 条),所以**不按企业或信用代码去重**。

> **平台没有独立的「曾用名」列。** 同一 `tyshxydm` 下 `qymc` 不同的历史关联行**本身**
> 就是曾用名的原始证据:`SQ332022062212391.qymc = 宁波上航测绘有限公司` 与
> `SQ332024052128274.qymc = 宁波上航测绘股份有限公司`(同一 USCC),逐字段比对后
> **唯一与名称有关的差异字段就是 `qymc`**。代理据此判断,确认后回填 `enterprise_alias`。

### 1.5 `difference_reason` —— 差异原因与后续措施(成对)

`UQ(enterprise_id, title_code, direction, recorded_at)`

| 列 | 类型 | 空 | 枚举 / 默认 | 说明 |
|---|---|---|---|---|
| `id` | integer | | PK | |
| `enterprise_id` | integer | | FK→`enterprise.id` cascade | |
| `title_code` | text | | FK→`title.code` | |
| `direction` | text | | `missing_in_miit` \| `extra_in_miit` | 与 `lib/comparison.ts` 同值 |
| `status` | text | | §3 的六个取值;默认 `not_queried` | 状态机 |
| `reason_code` | text | ✅ | `moved_out` \| `deregistered` \| `renamed` \| `platform_stale` \| `pending_review` \| `moved_in` \| `other` | 已知原因;`confirmed_no_diff` / `needs_review` 时可为空 |
| `reason_note` | text | ✅ | | 原因说明;新原因写这里(配 `other`) |
| `measure_code` | text | ✅ | §2.9 的措施取值 | **与原因成对**的后续措施 |
| `measure_note` | text | ✅ | | 措施说明 |
| `evidence_query_id` | integer | ✅ | FK→`platform_query.id` | 证据:平台查询 |
| `evidence_relation_id` | integer | ✅ | FK→`platform_relation.id` | 证据:平台关系 |
| `moved_in_city` | text | ✅ | | 迁入原城市;**缺项留空待核** |
| `moved_in_title_code` | text | ✅ | FK→`title.code` | 迁入原称号 |
| `moved_in_year` | integer | ✅ | | 迁入原年份 |
| `moved_in_batch` | integer | ✅ | | 迁入原批次 |
| `verification_status` | text | | `confirmed` \| `pending`;默认 `pending` | 核验状态 |
| `recorded_at` | text | | 不默认 | 该解释的登记时点(时态化排序键) |
| `created_at` | text | | 默认 now | |

索引:`difference_reason_lookup_idx(enterprise_id, title_code, direction)`。

**唯一键为什么含 `recorded_at`**:**时态化 —— 旧解释不丢**。同一差异的新解释形成**新行**,
「当前解释」= `recorded_at` 最新那条。

### 1.6 `platform_export_batch` —— 平台导出快照批次

`UQ(title_code, year, sha256)`

| 列 | 类型 | 空 | 枚举 / 默认 | 说明 |
|---|---|---|---|---|
| `id` | integer | | PK | |
| `title_code` | text | | FK→`title.code` | |
| `year` | integer | | | 快照所属年度 |
| `collected_on` | text | | | 采集日期(YYYY-MM-DD) |
| `original_filename` | text | | | 原文件名 |
| `sha256` | text | | | 文件内容 SHA-256(版本身份) |
| `row_count` | integer | | 默认 `0` | 快照行数 |
| `import_status` | text | | `pending` \| `imported` \| `failed`;默认 `pending` | 导入状态 |
| `source_document_id` | integer | ✅ | FK→`source_document.id` | |
| `import_batch_id` | integer | ✅ | FK→`import_batch.id` | 写入它的统一批次 |
| `replaced_batch_id` | integer | ✅ | FK→`platform_export_batch.id`(自引用) | 本批**替换**了哪一批;首版 NULL |
| `created_at` | text | | 默认 now | |

索引:`platform_export_batch_title_year_idx(title_code, year)`。

**唯一键为什么是这三个**:**同文件重放幂等**(同称号+同年+同内容 ⇒ 一批)。
**替换文件形成可区分的新版本**:换了内容 ⇒ `sha256` 变 ⇒ 新的一批,
用 `replaced_batch_id` 记替换关系,两版**并存**(旧快照不因替换而消失)。

### 1.7 `platform_export_row` —— 平台导出快照行

`UQ(batch_id, source_row_no)`

| 列 | 类型 | 空 | 说明 |
|---|---|---|---|
| `id` | integer | | PK |
| `batch_id` | integer | | FK→`platform_export_batch.id` cascade |
| `source_row_no` | integer | | 源行号(在源文件里的行序,从 1 起) |
| `uscc_raw` / `name_raw` / `district` / `province` / `city` / `reg_status` | text | ✅ | 平台字段 |
| `raw_fields` | text(json) | ✅ | 整行原始字段 |
| `created_at` | text | | 默认 now |

索引:`platform_export_row_batch_idx(batch_id)`。

**唯一键为什么是这两个**:同批内源行号唯一 ⇒ 同文件重放不重复落行。

### 1.8 `import_batch` —— 统一导入批次

`UQ(idempotency_key)`

| 列 | 类型 | 空 | 枚举 / 默认 | 说明 |
|---|---|---|---|---|
| `id` | integer | | PK | |
| `idempotency_key` | text | | **UQ** | 幂等键;**同一来源重复调用必须给同一个值** |
| `source_kind` | text | | `announcement` \| `platform_export` \| `alias_evidence` | 来源类别 |
| `source_identity` | text | | | 来源身份:文件相对路径 / 逻辑标识(**不含凭证**) |
| `source_sha256` | text | ✅ | | 源文件内容 SHA-256;给不出留空 |
| `status` | text | | `preflight` \| `committed` \| `failed`;默认 `preflight` | **预检 ≠ 提交** |
| `preflight_result` | text(json) | ✅ | | 预检结果(新增/更新/移除/待核计数) |
| `item_results` | text(json) | ✅ | | 逐项结果 / 失败(可逐条修复) |
| `summary` | text(json) | ✅ | | 提交摘要 |
| `error` | text | ✅ | | 失败原因 |
| `created_at` | text | | 默认 now | |
| `committed_at` | text | ✅ | | 提交时间;未提交 NULL |

索引:`import_batch_status_idx(status)`。

**凭证不进这张表**(见 `.env.example` 与 SPEC「凭证不入库」):来源身份是路径/哈希,不是 token。

---

## 2. 枚举取值 ↔ 中文标签

> 全表在 `lib/labels.ts` 有对应的 `Record<string,string>` 常量(页面/查询/导出统一从这里取文案)。

| # | 枚举 | 取值 → 中文 | labels 常量 |
|---|---|---|---|
| 2.1 | 复核结论 `record_event.review_outcome` | `passed` 复核通过 / `failed` 复核未通过 | `REVIEW_OUTCOMES` |
| 2.2 | 别名来源 `enterprise_alias.source_kind` | `platform_business` 平台业务接口 / `platform_apply` 平台申报接口 / `announcement` 公布文件 / `manual` 人工登记 | `ALIAS_SOURCE_KINDS` |
| 2.3 | 核验状态(别名/关系/差异共用) | `confirmed` 已确认 / `pending` 待核实 | `VERIFICATION_STATUSES` |
| 2.4 | 平台接口 | `business_list` 业务接口(businessList) / `apply_list` 申报接口(applyList) | `PLATFORM_INTERFACES` |
| 2.5 | 平台查询状态 | `success` 查询成功 / `failed` 查询失败 / `no_record` 无记录 / `not_queried` 未查询 | `PLATFORM_QUERY_STATUSES` |
| 2.6 | 关系匹配依据 | `uscc` 按统一社会信用代码 / `alias` 按曾用名 / `manual` 人工确认 / `none` 未匹配 | `RELATION_MATCH_BASES` |
| 2.7 | 差异状态 | 见 §3 | `DIFFERENCE_STATUSES` |
| 2.8 | 差异原因 | `moved_out` 外迁 / `deregistered` 注销 / `renamed` 更名 / `platform_stale` 平台未更新 / `pending_review` 待审核 / `moved_in` 迁入 / `other` 其他 | `DIFFERENCE_REASONS` |

> **原因由代理逐案确认（2026-10-18 用户裁定）**：上述枚举用于表达经核实的结论，不是自动判断规则。
> `platform_stale` 可表达正式公告与平台审核/在册信息尚未同步，但不能仅凭“有接口记录”就当作原因兜底。
> 原因调查应同时核对正式公告、实际使用的导出版本、申报记录、关联记录、已认定列表及必要的公开来源，并保留各自时点。
>
> - “已退回待审核／撤回／终审不通过”是具体申报记录的流程状态，不能直接推出正式称号作废、企业注销或“其他”。
> - 省、市、区字段按各自层级和来源解释；“浙江省”不等于“宁波以外”。代码前缀、公司名中的城市或申报时间也不能单独确定迁移方向。
> - 旧注册地与平台当前属地可能不同；迁入/迁出要有同一主体的起点、终点证据。缺少原城市、称号、年份、批次时保留为空。
> - 同码不同 `qymc` 先作为原始关系留存，由代理确认身份沿革。曾用名与差异原因分别取证和提交，不能由代码顺带确认。
> - `other` 只记录已查明且现有词表不能表达的具体原因；没有查清时是 `needs_review`，原因码为空。
>
> 查询事实和业务原因分开：完整零记录见 §3.2；`confirmed_no_diff` 需要明确两侧已对齐的证据，不能从一次请求成功推出。实际提交仍走统一导入 API。

| 2.9 | 后续措施 | `keep_history` 保留正式公布历史 / `mark_platform_snapshot` 标明平台时点,不覆盖历史 / `mark_moved_out` 记录迁出状态 / `mark_deregistered` 记录注销主体状态 / `update_current_name` 更新当前名并保留旧名为曾用名 / `record_moved_in` 记录迁入来源(城市/称号/年份/批次) / `follow_review` 保留正式公布历史并跟进审核 / `manual_review` 转人工核实 / `none` 无需措施 | `DIFFERENCE_MEASURES` |
| 2.10 | 导出批次导入状态 | `pending` 待导入 / `imported` 已导入 / `failed` 导入失败 | `EXPORT_IMPORT_STATUSES` |
| 2.11 | 统一批次状态 | `preflight` 预检 / `committed` 已提交 / `failed` 提交失败 | `IMPORT_BATCH_STATUSES` |
| 2.12 | 导入来源类别 | `announcement` 公布文件 / `platform_export` 平台导出 / `alias_evidence` 别名证据 | `IMPORT_SOURCE_KINDS` |
| 2.13 | 平台申报类型 `platform_relation.declare_kind`(`sblx`) | `apply` 申请 / `update` 更新 / `review` 复核 | `RELATION_DECLARE_KINDS` |
| 2.14 | `rdjb` 认定级别(接口参数) | `1` 创新型中小企业 / `2` 专精特新中小企业 / `3` 专精特新“小巨人” | `PLATFORM_RDJBS` |

**原因与措施的默认配对**(写侧建议,不是硬约束):

| 原因 | 默认措施 |
|---|---|
| `moved_out` 外迁 | `mark_moved_out` |
| `deregistered` 注销 | `mark_deregistered` |
| `renamed` 更名 | `update_current_name` |
| `platform_stale` 平台未更新 | `mark_platform_snapshot` |
| `pending_review` 待审核 | `follow_review` |
| `moved_in` 迁入 | `record_moved_in` |
| 证据不足(任何原因) | `manual_review` |
| `confirmed_no_diff` 无差异 | `none` |

---

## 3. 状态机(全部取值,必须彼此可区分)

### 3.1 平台查询状态 `platform_query.status`

| 取值 | 中文 | 含义 |
|---|---|---|
| `not_queried` | 未查询 | **还没查过** —— 不是「没有」 |
| `failed` | 查询失败 | 查询**没成功执行**(网络 / 会话过期 / 结构异常) |
| `no_record` | 无记录 | 查询**成功执行**,平台**返回空** |
| `success` | 查询成功 | 查询成功且返回 ≥1 条记录(逐条落 `platform_relation`) |

> **`failed` ≠ `no_record`** —— 这四态必须彼此可区分,是本票的硬要求。
> 实测:会话过期时两个接口都回 **HTTP 200 + `{"statusCode":"301","message":"登录超时,请重新登录"}`**
> —— 这是 **`failed`**;而 `businessList` `rdjb=1`/`rdjb=2` 对该 USCC 返回 **0 行**、请求成功且会话有效,
> 这是 **`no_record`**。两者绝不能合并成一句话。
> (原始响应体与凭证**不进仓库**,依据见 `04-EVIDENCE-91330211255994457P.md`。)

### 3.1b 关于第三个接口 `YzzxqyApplayBLH/showView`(2026-10-16 结论:**不接**)

用户发现的第三个接口(`POST .../YzzxqyApplayBLH/showView`,`data: id=<申报记录 id>&rdjb=<1|2|3>`)
返回**该条申报当时的填报详情**,其中 `qymc` / `companyname` = 填报时的名称。

**结论:当前不接。它的角色只能是「补充证据」,不参与差异集合计算。** 理由(可复核):

1. **证据已在手上**:`applyList`(`queryList`)的 `pageData[].pageSet[]` **每条申报本来就带 `qymc`**
   —— 实测 426 个真实 `queryList` 响应 / 715 条申报行,**全部**带非空 `qymc`(缺失 0 条);
   `businessList` 同样 1103/1103。这些名称差异可直接供代理核查，
   **不需要 showView** 才能发现；它们本身不自动确认更名或名称先后。
2. **成本**:showView 是**每条申报一次**请求。按本轮全量的目标数与每个目标的申报条数**估算**
   (不是实测),不应据此默认全量请求；是否能增加证据由代理按具体页面核实。
3. **同一事实不是独立证据**:填报详情与申报行可能展示相同 `qymc`；代理应核实详情是否补充了实际所需信息，而不是套用原因优先级。
4. **触发条件(将来需要时再按需接)**:若实测出现「申报行 `qymc` 缺失或被覆盖」而该条又是
   判定关键证据,才考虑**按需**抓 showView(仅对那条申报),并把它的证据落成独立的补充证据行。
   今天的实测值是**缺失 0 条**,所以现在接属于凭空增加一倍请求量。

---

### 3.1c 全量核查的**单批规模**(`limit` / `offset` 现只是可选上限)

一次全量核查是 ~1100 个统一社会信用代码 × 4 次请求(实测 0.3–1.1 秒/次)⇒ 查询阶段约十几分钟。

**写入侧的计划阶段曾经是瓶颈**:对**每条**平台查询都要在已存在的查询里找同键的行
(`import_batch` 的 `preflight`/`commit` 各一遍),用的是整表读进内存再线性找
(`.select().from(platform_query).all().find(同键)`),于是 ① 复杂度是 O(批内查询数 × 表行数)
（表随本批增长时即**批内查询数的平方**)、② 每次都把 `platform_query` 整行(含 `raw_response`
那几十 KB 的 HTML)读出来比一个根本用不到它的键 —— 实测 1096 个 USCC(≈ 4400 条查询)的单批
在 plan 阶段跑 90 秒只推进约 160 KB WAL,**实质上跑不完**。

**RL-18(#19)已修掉根因**:「找既有行」改为**按键定位** —— 谓词下推到 SQL 的 `WHERE`,不再把
整表读进内存再线性找。**按索引强度分两种**,别混:

- **四类实体是唯一键**:查询 / 关系 / 别名 / 差异的谓词**正好是所属表那条唯一索引的全部列**
  (`platform_query_identity_uq` / `platform_relation_query_seq_uq` / `enterprise_alias_identity_uq` /
  `difference_reason_version_uq`),于是**至多命中一行**,一次索引查找即可。它们只 `select { id }`
  (判定用不到别的列),平台查询**不再读 `raw_response`**。
  - 其中平台查询**还有一条**路径(按自然键解析证据指针)允许不给 `queriedAt`,那时只覆盖索引的
    前三列,是一次**索引区间扫描**且**本来就可能命中多行**(「引用不唯一」正是靠这个数条数);
    它同样只取 `id`,不读 `raw_response`。
- **企业侧是按索引列定位,索引不唯一**:统代 / 主键两列分别是唯一索引与主键;而
  `enterprise_name_norm_idx`(`name_norm`)**不唯一** —— 同名多主体正是本模型要如实保留的。
  所以那三个查找是「命中既有索引 + 取第一行」,不是「唯一键查找」;「第一行」的口径与改前
  逐字一致(见下)。

**写入语义一字未改**:有逐字回归用例 `tests/roster-import-semantics.test.ts`,它冻结了改前
代码在整套批次序列上的**全部可观察写入结果**(各表所有行 + 每步逐项结果 + 归并血缘),
改后逐字相同。

> 「取第一行」为什么没变:改前是 `.all().find(...)`(全表扫描 ⇒ **rowid 序**的第一行),
> 改后 `.get()` 走 `enterprise_name_norm_idx`(索引项是 `(name_norm, rowid)` 序 ⇒ 命中行内
> 仍是 **rowid 序**的第一行),两边取到同一行;`findEnterprisesByNorm` 同理返回同一集合、
> 同一顺序。把查询计划逼成 `SCAN enterprise` 也仍取到同一行(独立审核方实测)。
> 这条口径**有常驻探针**:`tests/roster-import-semantics.test.ts` 的「同名多主体」那一步 ——
> 两个**同名不同统代**的企业(这正是本模型要如实保留的同名多主体),再有一条**不带统代**的
> 记录只按名定位;它落到哪家企业(黄金文件里是 rowid 最小的那条)就是这个口径的可观察结果。
> 一处**已知且不可达**的例外:SQL 绑定经 UTF-8 编码会把**落单的代理对**换成 U+FFFD,
> 于是理论上可能匹配到 JS `===` 匹配不到的行 —— `nameNorm` 一律来自 `normalizeName` 的
> 真实企业名,取不到落单代理对。

修后实测(同一台机器、同一夹具 `tests/roster-import-scale.test.ts`;存档 = 库里已有的查询行,
每条 `raw_response` 24 KB;批次 = 本批查询条数。**表里的数字是 `commitRosterImport` 一次的
端到端耗时**(计划阶段 + 写入阶段都在里面;卡死发生在计划阶段,而实测取的是这个入口):

| 规模(存档 / 单批) | 改前 | 改后 |
|---|---|---|
| 1000 / 1000 | **77,353 ms**(超 30 s 预算判死) | **0.56–0.76 s**(三次实测) |
| 1000 / 250 → 1000 / 1000(增长比) | 12,797 ms → 76,355 ms(**5.97×**) | 135–151 ms → 590–664 ms(**4.37–4.60×**) |
| 4400 / 4400(票面的真实规模) | 未实跑(按上两行是同规模 19× 外推至**分钟级**) | **2.61–3.07 s**(两次实测) |
| 4400 / 1100 → 4400 / 4400(增长比) | — | 588–642 ms → 2,765–3,040 ms(**4.70–4.74×**) |
| **空存档** / 250 → 1000(纯写入阶段的增长比) | 1,260 ms → 19,338 ms(**15.35×**) | 136–151 ms → 626–664 ms(**4.40–4.60×**) |
| **企业表 7352 行** / 1000(存档 1000) | 23.6–45.3 s(六次,中位 **27.5 s**) | 515–623 ms(六次,中位 **557 ms**) |

(改后各给一个**区间**:同一台机器上多次实跑的抖动就在这个幅度内 —— 记单点会让人对不上数。)

**最后两行是两个不同的轴,别混**:

- **空存档那一行**说的是**批内查询数**的平方项 —— 上两行的存档是**固定**的,于是计划阶段的
  代价对批内查询数只是**线性**,增长比天然落在 4–6× 一带,**看不出平方**。要让平方项真正占
  主导,得把存档清空,让代价全落到**写入**阶段(表边写边涨,第 i 条查询要扫 i 行 ⇒ 恰好 N²/2)。
  改前 **15.35×**(平方给 16×)就是这个平方项;改后 4.60×。断言增长比的那条用例正是按这个形状取的。
- **企业表那一行**说的是**企业表规模**这一轴(真实库 7352 行)。RL-18 主体修的是四类实体
  (查询/关系/别名/差异);收尾时补上了它们**共同依赖的企业侧** —— 写入阶段每写一条平台关系
  都要按统代在企业表里定位一次(`enterpriseByExactUscc` → `findEnterpriseByUscc`),而企业表
  是**独立于本批**的外部规模。三列(`uscc_norm` / 主键 / `name_norm`)本来**都已有索引**,
  改前却是 `select().all().find(...)`,即每条关系整表读一遍 ⇒ **随企业表线性增长**。

**结论**:分批**不再是为了规避计划阶段的复杂度**,而只是控制单次事务时长与失败重试代价的
**可选上限**。修后**单批 4400 条查询(票面全量规模)实测 2.6 秒**即可完成,千条级稳定在毫秒级;
增长比在 4× 输入下约 4.4–4.7×(近线性),不再是平方。企业表满员(7352 行)时,单批 1000 条查询
从改前的**中位 27.5 秒**降到**中位 0.56 秒**(约 49×)。
改前那一栏跨了 23.6–45.3 s:机器上同时有别的 vitest 在跑,抖动大,故给区间与中位;改后的区间 515–623 ms 则是**两次独立实测各三次**合起来算的(我方三次 + 独立审核方三次)。

长跑的用法不变,仍建议分片:`--limit N --offset M` 一片一片地跑(`reconcile` 任务的
`params.limit` / `params.offset` 同义)。片与片不重叠也不漏 —— 本流程**不新建**
`record` / `enterprise`,所以 `getComparison` 的目标集合在片与片之间是稳定的;
查询是否重取由证据新鲜度决定；已确认结论不会被采集覆盖。没有新证据或处理状态时不重复写入。

---

### 3.2 差异状态 `difference_reason.status`

| 取值 | 中文 | 含义 |
|---|---|---|
| `not_queried` | 未查询 | 尚未对该差异做过平台查询 |
| `query_failed` | 查询失败 | 查询失败，或尚无关系且所需查询范围未完成，不能确认完整无记录 |
| `no_record` | 无记录 | 所需查询全部成功完成且返回0条；不代表已确认业务原因 |
| `confirmed_no_diff` | 已确认无差异 | 有成功查询且表明两侧一致 / 无需处置(配 `measure_code=none`) |
| `confirmed_reason` | 已确认原因 | 已凭证据确认原因(填 `reason_code` + 配对 `measure_code`) |
| `needs_review` | 待核实 | 证据不足 / 关系冲突 / 同名多主体 ⇒ **不自动合并、不猜填** |

> 前五个里 `未查询 / 查询失败 / 无记录 / 已确认无差异` 四态互不等价。
> `confirmed_reason` 承载「外迁/注销/更名/平台未更新/迁入」五类**已确认原因**。
> (是否把 `confirmed_reason` 并入 `confirmed_no_diff` —— 见 ADR「待父代理裁决」。)
>
> **四态与 `platform_stale` 的分界**(2026-10-16 补,与 §2.8 的定义配套):
>  - `no_record` = 平台的**成功查询**返回 **0 条关系**(两个接口都查不到);
>  - `confirmed_reason` + `platform_stale` = 至少一个接口**返回了关系**,
>    只是导出表滞后于公布文件。**«接口有记录» 不等于 «无差异»**。
>
> **2026-10-18 用户裁定：原因由代理/用户确认。** `reconcile` 仅保存查询和原始关系，并分类 `not_queried` / `query_failed` / `no_record` / `needs_review`。
> 有记录一律交代理核实，不从 `qymc`、`szsfmc`、`cszt` 或申报时间推导原因、迁移方向或曾用名。
> `no_record` 要求本任务四个槽位均成功完成且全部为0；部分失败/未查不能冒充完整无记录。
> `confirmed_reason` / `confirmed_no_diff` 以及别名、归并仍通过统一导入 API 显式提交，不由采集任务产生。
> 采集任务保留已确认结论，新的查询证据仍可单独入库。报告 `aliases` 固定为0、`mergeCandidates` 为空；`reusedFresh` 兼容统计复用处理状态和保留已确认结论。
> 历史自动结论不会因升级被批量重写。代理逐项核对原证据、最新来源和正式公告后，以新 `recordedAt` 追加更正并保留原记录；证据不足交待核，不能把旧“其他”批量替换成“平台未更新”。
> 具体工作流见仓库清洗技能的差异核查参考；本节裁定优先于旧文中的自动判因描述。

---

## 4. 证据结构

每条平台证据同时携带四样东西(都在表里成列,可查可 join):

| 证据要素 | 落点 |
|---|---|
| 平台原始关系 | `platform_relation.raw_fields` / `source_text` / `uscc_raw` / `name_raw` / `alias_name_raw` |
| 查询时点 | `platform_query.queried_at`(+ `platform_query.raw_response`) |
| 匹配依据 | `platform_relation.match_basis`(`uscc`/`alias`/`manual`/`none`) |
| 核验状态 | `platform_relation.verification_status`、`enterprise_alias.verification_status`、`difference_reason.verification_status` |

**不建设模糊推断引擎**:`match_basis` 只有四个可读取值,归属必须能指回一条人类可读的依据
(统代 / 来源明确写出的曾用名 / 人工确认);否则 `none` + `pending`(待核实)。

---

## 5. 历史 / 当前数据边界(查询口径)

| 问题 | 权威数据 | 表 |
|---|---|---|
| 某企业拿过哪些称号、哪年哪批认定/复核 | **公布文件** | `record` / `record_event` / `record_evidence` |
| 某年某天平台现状如何 | **采集时点快照** | `platform_export_batch` / `platform_export_row` |
| 为什么某条是差异 | **接口证据** | `platform_query` / `platform_relation` / `difference_reason` |

- **公布事件永不因平台快照缺失而删除**,也**永不因平台快照出现而新增**。
- **当前总表成员**(派生,不落列):
  `rosterState` = 该企业**存在任意 `jxj` 来源的 `record`(含 ≥1 正式认定/复核事件)**
  ⇒ `current`;
  否则若它**只由历史平台导出引入**(仅 miit 来源 / 仅出现在历史快照)**且不在最新快照中**
  ⇒ `removed_platform_only`(**从当前总表移除`,但企业行与公布历史**保留**)。
  即:**「仅由平台引入、从未出现在任何公布名单」** 的判定 =
  「没有 jxj 认定/复核事件,且只出现在导出快照」。
- 三张导出表**分开存储、分开查询**;`platform_export_*` 与 `record*` **不互相 join 出历史事实**。

### 5.1 曾用名的判定规则(由平台关系行承载)

平台**没有**独立「曾用名」列。判定规则:

> **同一 `tyshxydm` 下、`qymc` 不同的历史关联行,就是该企业曾用名的原始证据。**

- 落点:`enterprise_alias`,其中 `name = ` 那条历史的 `qymc` 原值、
  `name_norm = normalizeName(querym)`、`source_kind = 'platform_business' |
  'platform_apply'`、`source_ref_id = platform_relation.id`、`verification_status` 由人工/代理确认后置 `confirmed`。
- **只由证据驱动**:软件不推断「哪条是曾用名」,只做**证据查看 → 确认 → 回填 → 查询**。
  关系冲突 / 同名多主体 / 仅凭名称相似 ⇒ 不合并,`verification_status='pending'`(**待核实**)。
- 实测例子:USCC `91330211255994457P` 的 6 条关联中,`SQ332022062212391`(申请 2022-06-22)、
  `SQ332023041984270`(更新 2023-04-19)的 `qymc = 宁波上航测绘有限公司`;其余 4 条
  `qymc = 宁波上航测绘股份有限公司`。逐字段比对后**唯一**与名称有关的差异字段就是 `qymc`。

### 5.2 确认主体后的回填与归并(处理 `enterprise_uscc_norm_uq` 冲突)

**规则:确认主体 → 回填统一社会信用代码 → 归并为总表一行,且不丢任何称号/事件/出处。**

`enterprise.uscc_norm` 上有唯一索引(`enterprise_uscc_norm_uq`),所以「把无统代企业的
`uscc_norm` 直接改成已存在的值」会**撞唯一键**。因此回填**不是 `UPDATE`,是一次归并(MERGE)**:

1. **确定规范行(canonical)**:已带该 USCC 的企业行(示例中的 7289)。
2. **写曾用名**:把被并企业(示例中的 375,`uscc_missing`)的名称写成
   `enterprise_alias`(`verification_status='confirmed'`,来源关系证据),**旧名不丢**。
3. **迁移子行**:把被并企业名下的 `record` / `enterprise_alias` / `difference_reason` /
   `platform_relation` 全部改指规范行。
4. **解决 `record_identity_uq(enterprise_id, title_code, source)` 冲突**:若规范行已有
   同 `(称号, 来源)` 的 `record`,则把被并 `record` 的 **`record_event` 与
   `record_evidence` 迁到规范行的那条 `record` 上**(`record_event.record_id` 改指),
   然后删除被并的空 `record` 行。
   **事件与出处一条都不合并、不折叠、不删除** —— 这正是「不丢任何称号/事件/出处」。
5. **删除被并的 `enterprise` 行**(其子行已全部迁走,`record.enterprise_id` 无级联,
   必须在迁移后删除才不违反引用)。归并的审计轨迹落在写入它的 `import_batch.item_results`。

**写曾用名时按 `(enterprise_id, name_norm)` 去重**(RL-06 增量,父代理 2026-10-16 实测要求):
归并的两处别名写入(被并方的名字、被顶掉的规范行原名)**先查同名 `confirmed` 别名,有就复用**,
不再插第二条。理由是 `enterprise_alias` 的唯一键含 `source_ref_id` —— 「同一家企业、同一个名字、
换一条来源关系」**不撞唯一键**,而归并是按候选统代逐条触发的,一轮里同一个名字会被写两遍
(实测:一次 96 条的写回里 26 条命中)。那不算「逐条留证」,只是同一个名字留了两遍,详情页上同名并列。
`aliases[]` 那条**显式**写别名的路保持原行为(调用方主动写一条来自某来源的别名,本就该各自成条)。

实测基准:企业 375 `宁波上航测绘有限公司`(无统代,jxj 专精特新 2022 认定,
出处 `甬经信中小〔2022〕145号….pdf` 附件 序号 74 第 74 页)与企业 7289
`宁波上航测绘股份有限公司`(统代 `91330211255994457P`,miit 专精特新 + 小巨人 各一条 `maintain` 2025-1)
归并后**总表一行**,同时保留:小巨人(miit)+ 专精特新中小企业(jxj, 2022 认定, 第 74 页)+
专精特新中小企业(miit);**按现名或曾用名搜索都命中同一企业**;并展示该 USCC 的全部 6 条关联。

### 5.3 主名称口径,与「重名候选」的证据驱动归并(RL-14 增量补齐)

> **边界不变**:称号 / 年份 / 批次 / 认定与复核事件**仍以公布文件为唯一权威**(§0)。
> 本节只规定**企业名称**这一项,以及「同一家公司被拆成两行」时怎么办。

**① `enterprise.name` 以工信部导出表(最新情况)为准,公布名单里的名字是当年名(历史名)。**

`enterprise.name` 取**平台导出表侧**的名称 —— 它代表**最新情况**;公布名单里的名字是
**历年当年**的写法,属**历史名**。

> **口径出处**:用户 2026-10-16 明确(ADR §11.1 决策 4)。与 §0 第 1 条的边界**不冲突**:
> `platform_export_*` 仍是「采集时点的平台**现状**」,只在**企业名称**这一项上代表最新情况;
> 称号 / 年份 / 批次 / 认定与复核事件**仍以公布文件为唯一权威**,导出一行也不能改写公布历史。

归并时因此:

- 规范行(canonical)是**带统一社会信用代码**的那一行(该统代由平台接口/导出表引入);
- **逐字不同名**时,被并的公布名写进 `enterprise_alias`
  (`verification_status='confirmed'`,来源 = 平台关系);
- **两侧名称逐字相同时不造别名**(没有任何第二个名字可留)⇒ 只并身份。
  实测的 4 例重名(公布名 == 导出表名,逐字相同)都走这一支,归并净新增 0 行。
- 判据用**逐字相等**而不是归一化相等:归一化会抹掉括号、空白与「宁波」前缀,
  而「公布名写短名、导出表写全名」正是要靠别名留住的差异。

**导出表侧给了另一个现名时,归并会**把规范行改名**(父代理 2026-10-16 裁决)。**
机制是**显式字段**,不是隐式副作用:调用方在 `merges[]` 上给 `canonicalName`(见 **§8.4**),
执行时把规范行的 `name` / `name_norm` 改成它,并把**被顶掉的原名**落成
`enterprise_alias`(`confirmed`,来源 = 本次归并的来源行)—— 旧名同样不丢。
形如「公告名 `宁波一力减震器有限公司` → 导出名 `宁波一力实业有限公司`」的企业,
归并后规范行叫**导出名**,公告名在别名里,按两个名字搜索都命中同一企业。

- **缺省不改名**:不给 `canonicalName`(或它与原值相同)⇒ 规范行保持不动,与既有写法向后兼容。
- **导出表侧没有这家企业的名字 ⇒ 留空、不改名**(空值优于错误值,不猜)。
- 谁是「导出表侧的名字」由调用方按证据给出:重名候选那条路径取**最新导出快照**
  (`platform_export_row`,§1.7)里该统代的名字(见 §8.8.3)。
  「最新」的判据与读侧**同一套**(**年份大者新,同年按批 id**;见
  `lib/roster/enterprise-roster.ts` 的 `latestBatchByTitle`)—— 不另立第二套
  「当前快照」的定义,免得归并选的现名与页面显示的当前快照不是同一份。

**② 重名候选:同一家公司被拆成两行时,软件必须**显式报出来**。**

`upsertEnterprise` 的身份规则是「**有统代只按统代、无统代才按名**」(§1.2 的身份键)。
这个行为**本身正确** —— 按名自动合并会踩「同名多主体」,SPEC 明令禁止;但它的后果是:
同一家公司带着统代再进来一次(jxj 历年工作簿 / 导出表),会与既有那条**同名但无统代**的行
**另起一行**,而导入报告里**一个字都没有**。实测:导入经信局历年小巨人工作簿后
**静默多出 4 家重复企业身份**(见 §8.8 的实测基准)。

所以:**新建企业**时,只要库里(或本批更早)**已有 `name_norm` 相同的行**(不论它有无统代),
就产生一条**重名候选**(`DuplicateNameCandidate`,见 §8.8)—— 字段含既有企业 id / 名 / 统代(可空)、
新建企业 id / 统代、判定依据(`same_name_norm`)、触发它的载荷项引用。
**候选不是结论**:匹配规则一点没放宽(那两行照样都在),是否归并另由下一条决定。

**③ 归并必须**证据驱动**:平台自己说「这个统代就叫这个名字」。**

判据(唯一的一条,可复核):

> 拿候选的**新统代**去查**已落库**的平台关系;若存在一条关系的 `qymc`(`platform_relation.name_raw`)
> **逐字等于**被并方名称,就是平台自己记录了「这个统代就叫这个名字」 ⇒ **独立原始证据成立** ⇒ 可并。
> 查不到、或 `qymc` 与名称不符 ⇒ **不并**,列**待核**。

没有相似度、没有推断、没有按名归并。此外**被并方自带统代的一律不并**
(那说明它是**另一个已识别的主体**,同名只说明同名);同一条既有行被多条候选认领时
**只并第一认领者,其余待核**。归并的执行形状见 §8.4,可运行入口见 §8.8。

---

## 6. 生命周期语义(读侧必须实现的判定)

1. **首次认定** = 该(企业 × 称号)下**最早的 `award` 事件**年份。
   数据源以公布文件为准;该称号无公布来源时(如小巨人的历史工作簿)用其唯一来源。
2. **复核通过不算新的首次认定**:`review` + `reviewOutcome='passed'` 不改变首次认定。
3. **复核失败后再次获批不重置首次认定**:`review` + `reviewOutcome='failed'` 后又有新的
   `award`,首次认定**仍是**最早那条 `award`。
4. **复核锚点** = 最近一次「授予或延续有效资格」的事件年份,取
   `max(decided_year ?? year)`,对 `award` 事件与 `reviewOutcome='passed'` 的 `review` 事件取最大。
   **下一次复核到期 = 锚点 + 3**。重新获批**刷新锚点**但不改首次认定。
   `decided_year` 缺失时退回 `year` 并把该企业标为**待核**。
5. **失败复核不再进入当前有效资格的复核队列**:`reviewOutcome='failed'` 终止当前有效资格。
6. **`nurture`(入库培育)不计入称号有效期**,不参与首次认定/复核清单。
7. **(RL-08 增量)首次认定的「确立」**:在数据库中该企业 × 称号的全部事件里,
   只取最早正式 `award`；年份使用 `decided_year ?? year`。复核、维护、培育不参与首次计算。
   若现存 award 缺有效年份或首次事件没有出处,则**标待确认**(判据见 §7.5)。为此 `computeTitleLifecycle` 一并给出
   `awardCount`(该称号有没有正式认定过)与 `undatedAwardIds`(哪些认定定不了年)。

> 验收样例见 ADR §9 与 `tests/lifecycle-contract.test.ts`。

---

## 7. 读接口(可发现契约)

> **由 RL-04 / RL-05 / RL-08 / RL-09 / RL-10 实现**;RL-01 只冻结形状。
> 读接口**不鉴权**(与既有分法一致:读不鉴权,写/任务鉴权)。

### 7.1 `GET /api/roster/enterprises` — 跨称号去重企业总表(RL-04)

查询参数:`q`(名称 / **已确认**曾用名 / **统代**关键词,走 §5 搜索口径)、`title`(可重复)、
`district`、`rosterState`(`current` \| `removed_platform_only`)、
`source`(可重复,`jxj` \| `miit`)、`eventType`(可重复)、`year`(可重复)、
`firstYear`(可重复,**首次认定年份**,RL-08 增量,与 `year` 不是一回事)、
`firstStatus`(可重复,`confirmed` \| `pending`,RL-08 增量)、
`diffStatus`(可重复,RL-20)、`sort`(RL-20,默认 `recognition`)、
`page`(默认 1)、`pageSize`(默认 50)。

> `source` / `eventType` / `year` 是 **RL-17 增量**(合并台账后「按企业」要能承接
> `/stats` 的下钻)。口径与 `GET /api/records` 的 `buildWhere` **同构**:
> 存在一条该企业的记录,它满足 `source`,且它上面有一条事件**同时**满足 `eventType` 与 `year`。
> 「来源与事件落在同一条记录上、类型与年份落在同一条事件上」这两条不能松 ——
> 松了,同一个 URL 在「按企业」与「按企业×称号」下会给出两批不同的企业。
> `q` 的统代匹配同样是 RL-17 增量(`/api/records` 一直认统代,两个分组共用一个搜索框)。

> `diffStatus` 与差异摘要是 RL-20 的只读列表扩展,不改变记录、差异或写入语义。
> `diffStatus` 可取六个差异状态、原因代码或 `none`。状态匹配企业任一差异记录；原因按企业当前摘要的原因匹配，保证筛选与可见列一致；同参数多值取或。`none` 表示没有差异记录。列表和导出共用解析、筛选与计数口径，先筛后分页。`sort` 支持 `recognition`(最早首次认定年,新到旧,默认)、`name` 与 `title`;各顺序以名称和企业 id 稳定收尾。

响应(字段级):

```jsonc
{
  "rows": [{
    "enterpriseId": 1,
    "name": "宁波…有限公司",
    "uscc": "913302…" ,            // 可空
    "district": "鄞州区",           // 可空
    "city": "宁波市",              // 可空
    "regStatus": "存续",           // 可空
    "rosterState": "current",
    "titles": ["specialized_sme", "innovative_sme"],
    "aliasNames": ["宁波旧名…"],    // 仅 confirmed
    "firstRecognition": [{ "titleCode": "specialized_sme", "year": 2021 }],
    "awards": [{ "titleCode": "specialized_sme", "year": 2021, "batchSeq": 1 }], // 正式认定年份与批次；不折叠复核/维持事件
    "nextReviewYear": 2028,         // 可空;锚点+3
    "anchorNeedsReview": false,    // 锚点事件缺少结论年份时待核
    "difference": {                // RL-20:企业差异摘要
      "count": 1,                  // 企业 × 称号 × 方向的差异记录数
      "status": "confirmed_reason", // 可空;摘要状态
      "reasonCode": "platform_stale", // 可空;与摘要状态配对
      "anyCurrent": true           // 是否仍有当前差异
    }
  }],
  "counts": {
    "total": 1,                     // **企业数**(与筛选同口径、先于分页)
    "titlePairs": 2,                // **企业 × 称号**数 = titles 各桶之和
    "titles": { "specialized_sme": 1, "innovative_sme": 1 },
    "recognitionPairs": 1,          // 命中首次认定判据的**企业 × 称号**数
    "differences": 1                // RL-20:筛选内差异记录数,先于分页
  },
  "page": 1, "pageSize": 50
}
```

> **RL-08 增量**(见 §7.5.1):`firstRecognition` 的一项还带
> `firstEventId` / `source` / `status` / `pendingReason` / `evidence` / `undatedAwardIds`,
> `year` 放宽为可空;`counts` 增加 `recognitionPairs`;查询参数增加
> `firstYear` / `firstStatus`(与 `year` **不是一回事**)。

### 7.2 `GET /api/roster/enterprises/:id` — 企业详情(RL-04)

```jsonc
{
  "enterprise": { /* §7.1 单行字段 */ },
  "aliases":    [{ "id": 3, "name": "宁波旧名…", "sourceKind": "platform_business",
                   "sourceRefId": 7, "verificationStatus": "confirmed", "validFrom": null }],
  "records":    [{ "id": 5, "titleCode": "specialized_sme", "source": "jxj" }],
  "events":     [{ "id": 8, "recordId": 5, "eventType": "award", "year": 2021,
                   "batchSeq": 1, "decidedYear": 2021, "reviewOutcome": null },
                  { "id": 9, "recordId": 5, "eventType": "review", "year": 2021,
                   "batchSeq": 1, "decidedYear": 2024, "reviewOutcome": "failed" }],
  "evidence":   [{ "eventId": 8, "sourceFile": "…145号.pdf", "attachment": "附件一",
                   "listNo": 74, "page": 7 }],
  "recognitions": [{ "titleCode": "specialized_sme", "firstYear": 2021, "firstEventId": 8,
                     "status": "confirmed", "pendingReason": null, "evidence": [/* 首次 award 出处 */] }],
  "differences":[{ "id": 2, "titleCode": "specialized_sme", "direction": "missing_in_miit",
                   "status": "confirmed_reason", "reasonCode": "moved_out",
                   "measureCode": "mark_moved_out", "recordedAt": "2026-10-14T06:00:00Z",
                   "evidenceQueryId": 4 }]
}
```

### 7.3 `GET /api/roster/differences` — 差异与解释(RL-04)

查询参数:`q`(名称 / **已确认**曾用名 / **统代**关键词;RL-17 增量 —— 合并台账的搜索框对
三个视图都生效)、`title`、`direction`、`status`(§3.2 取值)、`reason`、`page`、`pageSize`。

展示态**只取自 `difference_reason.status`、零推导**(§3.2):没有解释记录的坐标给状态机的
默认值 `not_queried`,并用 `explanationId === null` 说明「确实没有存下来的解释」。
六态在页面上的徽章变体见 `lib/labels.ts` 的 `DIFFERENCE_STATUS_VARIANTS`(单一出处,六态两两可区分)。

```jsonc
{
  "rows": [{ "enterpriseId": 1, "name": "…", "titleCode": "specialized_sme",
             "direction": "missing_in_miit", "status": "confirmed_reason",
             "reasonCode": "moved_out", "measureCode": "mark_moved_out",
             "movedIn": null, "verificationStatus": "confirmed",
             "evidence": { "queryId": 4, "queriedAt": "2026-10-14T03:00:00Z",
                           "interface": "business_list", "status": "success",
                           "relationIds": [11, 12] } }],
  "counts": { "specialized_sme": { "missing_in_miit": 1, "extra_in_miit": 0 } }
}
```

### 7.4 `GET /api/records` — 通用企业×称号记录查询(RL-09)

查询参数:`title`、`source`、`district`、`eventType`、`year`、`firstYear`、`firstStatus`、`dueYear`、`q`、`flags`、`page`、`pageSize`。
多值参数可用逗号分隔或重复传入。`year` 过滤事件的**所涉年份**；`firstYear` 过滤首次正式认定年份
(`decidedYear ?? year`)，与事件年份不同；`firstStatus` 取 `confirmed` / `pending` 并使用 §7.5 的首次认定判据；
`dueYear` 是生命周期到期年份筛选，单值精确匹配。派生筛选先读取完整事件历史，再于分页前过滤；分页和 total 基于筛选后的组合。

`q` 搜当前企业名、`confirmed` 曾用名和归一化统一社会信用代码。`pending` 别名不参与搜索。
事件筛选只决定哪些企业×称号行出现；返回行保留该组**全部来源、全部事件和全部事件出处**，避免筛选
把其他来源或历史事件裁掉。

每行粒度为一组 `{ enterpriseId, titleCode }`，含企业现名、统代、属地、来源、质量标记以及：

- `events[]`:事件 id、所属记录 id、事件类型、事件所涉年份 `year`、结论年份 `decidedYear`、复核结论、批次序号、来源及 `evidence[]`。出处逐条给出 `{ sourceFile, attachment, listNo, page }`。
- `lifecycle`:调用 §6 的 `computeTitleLifecycle` 得到的首次认定年份/事件、当前锚点年份/事件、到期年份、资格状态和 `needsReview`；`status` 明确区分 `active` / `needs_review` / `terminated` / `undatable` / `not_applicable`。
  `anchorEventId`、`firstRecognitionEventId` 可直接关联回 `events[]`。
- `firstYear` 只匹配 `lifecycle.firstRecognitionYear`;无法确定首次年份的行不匹配具体年份。它不改变 `year` 对事件年份的筛选语义。
- `lifecycle.flags[]`: `{ code, reason }` 待核提示。缺结论年份、复核结论未知、缺批次、缺出处或无法确定锚点只增加提示，**不会把行从未筛选结果中隔离**。
  对未知复核结论不猜成通过或未通过；已明确未通过且后续没有重新认定时，按 §6 标记为资格终止，`dueYear` 为空。
- `flags[]`:企业数据质量标记，含义与现有记录查询一致。

不带 `dueYear` 时可查看全部命中记录及其生命周期状态，包括无法计算到期年的记录和原因；传入 `dueYear=2027`
则只返回共享生命周期算法计算结果恰为 2027 的行。缺少字段的提示不改变确定的 `dueYear`，也不代替用户口径另造一套计算。

REST 与 MCP `query_records` 共用同一参数解析和 `listRecords` 读模型。企业详情 MCP tool `get_enterprise_detail`
复用 `GET /api/roster/enterprises/:id` 的 `getRosterEnterpriseDetail` 读模型。别名、归并和归并时规范名更新
仍经 §8.3 的 `preflight_roster_batch` / `save_roster_batch` 统一预检与事务提交。

### 7.5 `GET /api/roster/recognitions` — 首次认定(RL-08)

查询参数:`title`、`year`。响应行:`{ enterpriseId, titleCode, firstYear, firstEventId, source }`。

**增量(RL-08 交付,2026-10-16)**。原形状是**最小骨架**:它给得出年份与事件 id,
却给不出票面(issue #8)明写的「首次认定的依据必须能回到出处」。实现按数据库中该企业 × 称号的完整事件集计算；正式名单是否完整入库由独立的清理入库验收负责，不把整条未入库事件建模成产品状态。补齐如下(全是**加字段**,不改既有字段含义):

- **行形状补齐**(`firstYear` / `firstEventId` / `source` 语义**不变**):

```jsonc
{
  "enterpriseId": 1, "name": "宁波…有限公司",        // name / uscc / district 是增量:
  "uscc": "913302…", "district": "鄞州区",           // 清单要能直接读,不能只给一个 id
  "titleCode": "specialized_sme",
  "firstYear": 2021,          // 已知最早那次认定(award)的年份;**给不出时为 null**
  "firstEventId": 9,          // 那条认定事件;`null` 同 firstYear
  "source": "jxj",            // 那条认定所在记录的来源(§6.1 的「数据源」)
  "status": "confirmed",      // 增量:`confirmed` | `pending`
  "pendingReason": null,      // 增量:见下表;`status='pending'` 时必非空
  "evidence": [               // 增量:`firstEventId` 那条事件的**全部**出处,一条不折叠
    { "sourceFile": "jxj/announcement/2022/甬经信中小〔2022〕145号….pdf",
      "attachment": "附件一", "listNo": 74, "page": null }
  ],
  "undatedAwardIds": []       // 增量:该称号下**定不了年**的 award 事件 id(升序)
}
```

- **`status` 的判据**(确定性,与 `lib/roster/first-recognition.ts` 一处实现)。
  `pending` 的三种原因**互不等价**、**按此优先级**取第一条成立的:

  | `pendingReason` | 什么时候 | `firstYear` |
  |---|---|---|
  | `no_dated_award` | 有认定,但**一条都定不了年**(`year` 与 `decided_year` 都空) | `null`(**不猜**) |
  | `undated_award` | 有现存 award 定不了有效年份(`year` 与 `decided_year` 都空),但另有可定年的 award | 给出已知最早的年份,状态待确认 |
  | `no_evidence` | 年份有了,那条认定却**没有存下来的出处** | 照给,依据回不到出处 |

  三条之外一律 `confirmed`。这些待确认原因只对应数据库中**实际存在**但缺有效年份或出处的 award；
  它们不表示数据库可能漏了一条更早事件。`no_evidence` 是「依据回不到出处」(§3 的
  「证据不足留空并标待核,绝不猜填」)。它们与 §7.1 的 `needsReview`(**锚点**口径,§6.4)
  是**两件事**,不共用一个字段。

- **查询参数增量**:`status`(多值,`confirmed` / `pending`)+ 分页 `page` / `pageSize`
  (默认 1 / 50,上限 `MAX_PAGE_SIZE` = 200)。9930 条级别的清单不分页无法使用。
  非法 `title` / `status` 一律 400(不静默放过)。

- **计数增量**:响应信封与 §7.1 / §7.3 同构 `{ rows, counts, page, pageSize }`,
  且计数**两个单位都给**(issue #8 验收第 5 条「统计清楚标示企业数或企业×称号数」):

```jsonc
"counts": {
  "titlePairs": 2,       // 符合条件的**企业 × 称号**数(= 行数,先于分页)
  "enterprises": 1,      // 符合条件的**企业**数(多称号企业只算一家)
  "titles": { "little_giant": 0, "specialized_sme": 1, "innovative_sme": 1 }
}
```

- **一行 = 一个企业 × 称号**。同一企业多称号就是多行;`counts.enterprises` 才是企业数。
- **空数据口径**:没有 award 的数据库返回空 `rows` 与 0 计数。相关行为通过合成 fixture / 隔离 SQLite 验证；正式历史名单完整性与未复核文件由独立清理入库验收核对，不作为功能实现前置条件。

- **与 §7.1 的 `firstRecognition` 是同一处计算**(`buildProfile` 一次算出,两处只是取舍字段),
  所以两处不可能给出不同的首次年份。**筛选判据同理**:`matchesRecognitionQuery`
  (`lib/roster/first-recognition.ts`)是总表与本节清单共用的**唯一一份**判据 ——
  两处各写一遍,一边加了条件另一边没加,就会「总表筛出 3 家、清单筛出 5 家」,而这两个数在页面上并排。§7.1 那一项同时**增量补齐**同名字段
  (`firstEventId` / `source` / `status` / `pendingReason` / `evidence` / `undatedAwardIds`),
  并把 `year` 放宽为**可空**(`null` = 一条都定不了年);`needsReview` **语义不变**。

#### 7.5.1 §7.1 / §7.2 的增量(RL-08)

- **§7.1 `counts`** 增加 `recognitionPairs`:本次筛选下**符合首次认定判据**的
  「企业 × 称号」数。它与 `titlePairs` 不同 —— 后者数的是符合条件企业的**全部**称号;
  给了 `firstYear` / `firstStatus` 之后两者不再相等,不单列就会被当成同一个数。
- **§7.1 查询参数**增加 `firstYear`(多值,**首次认定年份**)、`firstStatus`(多值)。
  ⚠️ 与既有的 `year` **不是一回事**:`year` 筛的是**事件**年份(任何类型的事件)。
  判据与 `title` **落在同一个称号上**(与 RL-17 那条「来源与事件必须落在同一条记录上」同构):
  「存在一个称号,几个判据都落在它身上」。`firstYear` **不匹配** `firstYear == null` 的称号
  ——「未知」不是某个具体年份。
  同理 §7.3(差异)与记录粒度分组**不认**这两项(`lib/roster/ledger-view.ts` 的
  `LEDGER_VIEW_FILTERS` 里只有 `enterprise` 有)。
- **§7.2 详情**增加 `recognitions: RecognitionEntry[]`(每个有认定的称号一条),
  展开面板据此标出**哪一条事件是首次认定**并直接给出它的出处。
- **导出**(`GET /api/roster/export`)继承上述筛选(与列表同一份解析),并新增一列
  **「首次认定出处」**(文件 · 附件 · 序号 · 页;没有出处的写「待确认:原因」)。
  首行口径里补上「其中 N 个『企业 × 称号』有首次认定」。

### 7.6 `GET /api/platform/queries` — 平台查询证据(RL-03)

查询参数:`interface`、`queryKey`、`enterpriseId`、`page`、`pageSize`。
响应行:`{ query: {…§1.3}, relations: [ {…§1.4} ] }`。

### 7.7 `GET /api/platform/snapshots` — 导出快照与版本(RL-05)

查询参数:`title`(可重复)、`year`(可重复)。响应信封 `{ rows, count }`,行:
`{ batch: {…§1.6}, replacedBatchId, rowCount, importStatus }`。

**增量(RL-05 交付,父代理 2026-10-16 裁决接受)**:`GET /api/platform/snapshots/diff` ——
比较两个快照批次。查询参数 `from`(旧批号)、`to`(新批号),**两批必须同称号**,否则 400;
批号不存在 404。响应 `{ from, to, diff }`:`from` / `to` 是批次摘要
(`{ id, titleCode, year, collectedOn, originalFilename, sha256, importStatus, replacedBatchId }`),
`diff` 含 `added` / `removed` / `changed` / `unchanged`,每处差异带两侧**源行号**
`sourceRowNo`(可回溯到导出的物理行)。只读、不鉴权。

### 7.8 `GET /api/roster/import/duplicate-candidates` — 重名候选报告(RL-14 增量)

查询参数:`batchKey`(**必填**,产出候选的导入批次幂等键)。缺 `batchKey` ⇒ 400;
该幂等键没有批次 ⇒ 404。只读、不鉴权。

响应:

```jsonc
{
  "batchKey": "jxj/workbook/little-giant#sha256:…",
  "batchId": 12,
  "counts": { "candidates": 4, "ready": 4, "pending": 0 },   // 计数
  "candidates": [ /* DuplicateNameCandidate,见 §8.8 */ ],     // 明细
  "ready": [{ "candidate": {…}, "evidence": {…}, "merge": {…} }],  // 证据成立、可并
  "pending": [{ "candidate": {…}, "reason": "no_platform_query", "message": "…" }], // 不并,待核
  "previous": { "batchId": 3, "idempotencyKey": "duplicate_merge:…" },  // 已执行过则指出那一次;否则 null
  "request": { "idempotencyKey": "…", "sourceKind": "alias_evidence", "sourceIdentity": "…", "payload": { "merges": [ … ] } }
}
```

- `request` **可直接 POST 给 `/api/roster/import/commit`**(§8.2);没有可并项时为 `null`
  (**不发空批**)。于是「判定」与「落库」是同一条路,不存在第二种写入口。
- `ready[].exportName` 是**导出表侧**给这家企业记的名字(最新快照,§1.7;没有就是 `null`)。
  它与规范行现名不同时,`merge.canonicalName` 会带上它(§8.4)⇒ 归并**改名**并把被顶掉的原名
  落成别名;为 `null` 或与现名相同时不带 ⇒ **不改名**(§5.3 ①)。
- `evidence` 记这条候选凭什么可并:`{ relationId, queryId, interface, queryKey, rdjb, queriedAt,
  sequenceNo, relationKey, nameRaw, usccRaw, sourceKind }` —— `nameRaw` 就是那条 `qymc`。
  取证据的规则是**确定性**的:只认**以该统代为查询键**的查询(按名查的键是 `name:<nameNorm>`,
  不构成「这个统代叫这个名字」);**用户实测过的那一类形状(`business_list` + `rdjb=3`)优先**,
  其余接口按查询时点新→旧(时点并列按行 id 大→小),查询内按序号小→大取第一条 `qymc` 逐字相等的
  ⇒ 同一个库给出同一条证据,归并可重放。
  接口不设门槛的理由:判据是「平台说这个统代叫什么」,`apply_list` 的关系同样带
  `tyshxydm` + `qymc`,这句话不因接口而不同;用了哪一条**如实记进报告**供复核。
  (字典外的接口不静默降级成某个类别,而是不拿来当证据。)
- `pending.reason` 是可判别的原因:`no_target_uscc` / `no_platform_query`(没查过 ≠ 查了没有)/
  `name_not_evidenced` / `source_gone` / `source_has_uscc`(同名多主体)/
  `target_gone` / `source_claimed` / `same_enterprise`。**每一条都不得并。**

---

### 7.9 `GET|POST /api/roster/uscc-research` — 缺统一社会信用代码企业:待查清单 + 补录计划(RL-06 增量)

**只读,不鉴权**(与 §7.8 同一分法:读侧判证据、写侧只有入口)。`GET` 走**库内**路径;
`POST` 同一路径,多收一批**公开来源查证结果** `claims`(结构化成百条,不适合放进 query string)。

查询参数(两者共用):`q`(名称 / 已确认曾用名关键词)、`title`(逗号分隔,可重复)、`district`、
`page`(清单页码,默认 1)、`pageSize`(默认 50)。`title` 不在字典内 ⇒ 400。

```jsonc
{
  "checklist": {
    "rows": [{
      "enterpriseId": 375, "name": "宁波上航测绘有限公司", "district": "镇海区", "city": null,
      "titles": ["specialized_sme"],
      "aliasNames": [],                       // 仅 confirmed(§1.2)
      "traces": [{ "explanationId": 825, "enterpriseId": 375, "titleCode": "specialized_sme",
                   "direction": "missing_in_miit", "status": "not_queried",
                   "reasonCode": null, "reasonNote": "本企业无统一社会信用代码…" }],
      "evidence": [{ "titleCode": "specialized_sme", "sourceFile": "jxj/announcement/2022/…145号….pdf",
                     "attachment": "附件", "listNo": 74, "page": null }],
      "queries": [],                          // 以该企业为查询键的平台查询(无统代时通常为空)
      "coreWord": "上航测绘"                   // 检索用,**不是**身份判据
    }],
    "counts": { "total": 133, "titles": { "specialized_sme": 85, "innovative_sme": 58 } },
    "page": 1, "pageSize": 50
  },
  "plan": {
    "counts": { "targets": 133, "withCandidates": 38, "filled": 31, "conflict": 0,
                "notFound": 95, "manual": 7, "closed": 31,
                "byRoute": { "library": 31, "platform_claim": 0, "public_source": 0 },
                "ready": 31, "aliasAlreadyPresent": 0 },
    "outcomes": [{ "enterpriseId": 375, "name": "宁波上航测绘有限公司", "outcome": "filled",
                   "code": "library", "message": "…", "candidates": [ … ], "uscc": "91330211255994457P" }],
    "ready": [{ "outcome": "filled", "targetId": 375, "targetName": "宁波上航测绘有限公司",
                "route": "library", "candidates": [ … ], "chosen": { … }, "uscc": "91330211255994457P",
                "evidence": { "relationId": 337, "queryId": 159, "interface": "business_list", "rdjb": "3",
                              "queriedAt": "…", "sequenceNo": 1, "relationKey": "SQ332022062212391",
                              "nameRaw": "宁波上航测绘有限公司", "usccRaw": "91330211255994457P",
                              "sourceKind": "platform_business" },
                "merge": { … }, "backfill": null }],
    "pending": [{ "targetId": 10, "targetName": "宁波星箭航天机械有限公司", "outcome": "not_found",
                  "code": "no_candidate", "message": "…", "candidates": [] }],
    "request": { "idempotencyKey": "uscc_research#sha256:…", "sourceKind": "alias_evidence",
                 "sourceIdentity": "roster/uscc-research",
                 "payload": { "merges": [ … ], "usccBackfills": [ … ] } }
  }
}
```

**清单口径 = 「仍缺统代」**(`enterprise.uscc_norm IS NULL`,与 `GET /api/quality?kind=uscc_missing`
同一口径)**且仍在当前总表**(`rosterState === 'current'`)。这就是票面说的「接口曾用名匹配后仍未
解决的企业」:实测库里 133 家无统代企业**全部**停在 `not_queried`(平台两接口按统代取数,无统代
直查不了),两者是同一集合;但清单**按缺统代筛**,因为那才是「还没解决」的定义。补齐/归并之后
该企业自动离开清单(票面第 6 条),不需要额外的排除规则。

**四桶互斥、逐条有理由**(`plan.outcomes`,相加恒等于 `counts.targets`):

| 情形 | 桶 | `code` |
|---|---|---|
| 公开来源 claim 给出一个库里没人占用的合法统代 | `filled` | `public_source` |
| claim 的代码违法 / 被别家占用 / 地区不符 | `conflict` | `uscc_format_invalid` / `uscc_taken` / `region_mismatch` |
| claim 证据三要素不齐 | `manual` | `source_evidence_incomplete` |
| **平台证据认领**给出的统代已被规范行持有(归并)或库里没人持有(补录) | `filled` | `platform_claim` |
| 认领的企业名/地区对不上,或认领的代码违法/被别家占用/本轮被别家认领 | `conflict` | `uscc_format_invalid` / `uscc_taken` |
| **认领说 resolved,但平台原始证据对不上**(库里没有那条关系,认领也没带来逐字相等的摘要) | `manual` | `no_platform_evidence` |
| 认领的企业已持有该统代 | `manual` | `already_resolved` |
| 认领/判定文件写的是清单外的企业 | `manual` | `claim_target_not_found` / `out_of_scope` |
| 库内核心词搜不到候选 | `not_found` | `no_candidate` |
| 有候选,但**没有一个**被平台原始关系逐字证实 | `manual` | `candidate_without_platform_evidence` |
| **恰好一个**候选被逐字证实 | `filled` | `library` |
| **两个及以上**不同统代都被逐字证实 | `conflict` | `multiple_subjects` |

`closed` = `filled`(那些目标写完就不再缺统代)。`byRoute` 说明补齐走的是哪条路
(`library` 库内核心词 / `platform_claim` 平台证据认领 / `public_source` 公开来源);
`aliasAlreadyPresent` 数出「规范行已有同名 `confirmed` 曾用名 ⇒ 本轮只并身份、不重复写别名」
的条数(见 §5.2)。

**范围规则**(两份输入都适用):给了**认领**(`claims` / `platformClaims`,含判定文件解析出来的)
就**只判这些认领落到的企业** —— 认领按 `enterpriseId` **或** `enterpriseName` 解析到企业后再定范围
(只看数值 id 会让按名指认的那条进了载荷却不在 `targets` 里,四桶之和就与 `counts.targets` 对不上了);
显式给 `enterpriseIds` 时以它为准,范围外的认领逐条落 `out_of_scope` 而不是静默丢掉。
**不给认领**才跑全库库内计划。不这样定的话,一次「判定文件写回」会顺带把库内路径能解决的几十家
也一起归并 —— 那不是这次要写的东西。

**清单口径与票面第 6 条**:清单 = 「缺统代 **且** 仍在当前总表」。一家已经由接口关系确认过、
甚至已经写过曾用名的企业(如 `91330211255994457P` 案例里的 375),只要**自己那行还没有统代**,
就**仍然在清单里** —— 因为它的公布侧记录还需要并进规范行;一旦补齐/归并(它拿到统代或被并掉),
它就自然离开清单,不需要额外的排除规则。

**名称只用于生成候选**:库内检索的判据只有「字符串包含」(现名 ∪ **已确认**曾用名 ⊇ 核心词),
没有相似度、没有编辑距离;候选能不能补录**只由平台原始关系的逐字 `qymc` 决定**
(证据规则与 §7.8 同一份实现 —— `findUsccKeyedRelationEvidence`)。**同一轮内收敛**:某目标一旦
补齐,它的名字立刻进字典,本轮后续目标即可命中 —— 不把收敛推到下一轮。

**写入口仍然只有 §8.2**:`plan.request` 可直接 `POST /api/roster/import/commit`
(有规范行 ⇒ `payload.merges`,§8.4;库里没人持有该统代 ⇒ `payload.usccBackfills`,§8.10)。
没有可执行项时 `request` 为 `null`(**不发空批**)。`POST` 的 `claims` 形状:

```jsonc
{ "q": "…", "title": "…", "district": "…",
  "claims": [{ "enterpriseId": 10,               // 或 enterpriseName
               "uscc": "91330211MA2CL6FP24",
               "source": { "url": "https://…", "checkedOn": "2026-10-16",
                           "basis": "公开信用信息页:主体名…、注册地宁波市、统代一致",
                           "name": "宁波星箭航天机械有限公司", "region": "宁波市/海曙区" },
               "note": null }] }
```

`claims` 只做**形状**检查(400),语义判定(格式/校验位、三要素、地区、是否被占用)一律在
计划里做**一处**。可运行入口:`node scripts/roster-uscc-research.mjs [--claims claims.json]`
(只读报告 + 把 `request` 转投 `/commit`;`--dry-run` 只读,`--strict` 有未补齐项退出码 3)。

**`POST` 还能收另外两种输入**(与 `claims` 一样,**本端点一行都不写**):

```jsonc
{
  "enterpriseIds": [375],            // 可选:显式限定范围(见上文「范围规则」)
  "platformClaims": [{               // **平台证据认领**:某统代的平台关系 qymc 逐字等于本企业名
    "enterpriseId": 10,              //   与 enterpriseName 恰给其一
    "uscc": "913302121444188959",
    "evidence": [{ "interface": "apply_list", "rdjb": "", "sequenceNo": 1,
                   "relationKey": "SQ332022050658900", "nameRaw": "宁波星箭航天机械有限公司",
                   "status": "终审通过", "usccRaw": "913302121444188959",
                   "query": "qymc=宁波星箭航天机械有限公司" }],
    "reason": "apply_list qymc 逐字等于公布名…",   // 判定依据(落 note / source_text 供复核)
    "batchRef": "uscc-verdict-batch-4",             // 证据来自哪份交接文件
    "observedAt": "2026-10-16T15:40:53+08:00"       // 该文件的产出时刻(见下「关于 queried_at」)
  }],
  "verdictFiles": [{                 // **判定文件原文**(并行判断代理的交接物),整份交给服务端
    "file": "uscc-verdict-batch-1.json",
    "value": { /* 文件内容,形状见下 */ }
  }]
}
```

判定文件(经 `verdictFiles` 传入)的形状——每项至少含 `enterpriseId` / `name` / `candidateUscc` /
`platformEvidence[]` / `qymcEqualsAnnouncedName` / `verdict` / `reason`:

- **只采纳** `verdict === "resolved"` **且** `qymcEqualsAnnouncedName === true`;
  `conflict` / `not_found` / `needs_human` 一律不动库,逐条带文件给的理由与 `blocked`
  (要人工核对的原件位置,如 `甬经信中小〔2024〕192号 附件1 序号290`)回给调用方。
- 该字段**缺席不等于 `true`**:不替它补 true,而是如实报出「其 `platformEvidence` 里有 N 条
  逐字相等的关系」,供调用方裁定(字段笔误时不必自己再去数)。
- **跨批次按企业去重**(同一家企业两个称号会在两批各出现一次):同企业同候选统代只采纳先出现的
  那份,同企业**两个不同**候选统代 ⇒ 后一条落 `conflict`(不猜哪个对)。
- **判定文件是线索,不是证据**:采纳后仍要走上表的平台证据判据 —— 库里已有那条关系就直接用,
  库里没有而文件带来了 `evidence` 摘要就用 §8.7 的**批内自然键**把查询/关系与证据指针写进同一批,
  两边都没有 ⇒ `no_platform_evidence`,一行不写。「代理说 resolved」本身不构成任何写权限。

**补充证据的交接形态**:复查代理交回来的文件可能用 **`resolvedItems`**(而不是 `items`)、
**不带 `verdict`**(整份都是已转正条目)、并且把 queryList 那条写成 **`query_list`**。
这些都在归一化层接受:`resolvedItems` 与 `items` 等价;`verdict` 缺席按 `resolved` 处理并记一条
`problem`(采纳与否仍由证据判据决定);`query_list` 映射为 `apply_list`(它就是 queryList 端点),
原始拼写留在证据里。`qymcEqualsAnnouncedName` 可以写成**字符串**(如 `"normalizeName"`,
意为「只在归一化口径下相等」)——同样只记档、不作准入门槛。

**同一企业、同一候选统代被两份文件分别给出**时,**采用带可用证据的那份**(不按先到先得):
先到的那份可能只带来结论、没有关系摘要,按先到先得会让本可补齐的企业停在
`no_platform_evidence`(实测 `507` / `384` 就是这样被卡住过)。

**关于 `queried_at` 与 `raw_response`**:判定文件的交接物只有字段摘要(原始平台响应没随文件走),
所以由它转写出来的 `platform_query` 行,其 `queried_at` 用的是该文件的 `generatedAt`(**代理产出时刻**,
不是平台响应时刻)、`raw_response` 留空;两件事都写进那条关系的 `source_text`,不留「看着像原始响应」的假象。

---

## 8. 写接口(RL-11 实现)

> **鉴权**:`Authorization: Bearer <NUXT_API_TOKEN>` 或 `X-API-Token`(与 `server/utils/api-auth.ts` 同分法)。
> **token 未配置 ⇒ 写入整体关闭**。凭证只从运行时配置读,不落库、不进仓库、不进日志。

### 8.1 `POST /api/roster/import/preflight` — 只读预检

**不写库**,只算「这次提交会发生什么」并落一条 `import_batch`(`status='preflight'`)。

请求体:

```jsonc
{
  "idempotencyKey": "jxj/省专/2024/192号#sha256:abc",   // 必填
  "sourceKind": "announcement",                          // §2.12
  "sourceIdentity": "jxj/announcement/2024/2/甬经信中小〔2024〕192号.docx",
  "sourceSha256": "abc…",                                 // 可空
  "payload": { /* 见 8.3 */ }
}
```

响应:`{ "batchId": 12, "status": "preflight", "preflight": { "add": 12, "update": 3, "remove": 1, "review": 2, "conflicts": [], "evidenceRepoints": 0, "batchStatus": "preflight" } }`

> 最后两项是 RL-19 的增量(§8.9.1 / §8.9.2);计数口径见 §8.5 的表格。

### 8.2 `POST /api/roster/import/commit` — 事务提交

请求体同 8.1。**幂等键位置 = body 的 `idempotencyKey`**(`import_batch.idempotency_key` 唯一):
同一 key 重复调用**不再重复写企业/事件**,返回既有批次的摘要。

响应(`status` 变为 `committed`):

```jsonc
{
  "batchId": 12, "status": "committed",
  "summary": { "written": 15, "skipped": 0, "failed": 0 },
  "items": [
    { "ok": true,  "kind": "record_event", "ref": "event:91" },
    { "ok": false, "kind": "record_event", "ref": "row:37",
      "error": { "code": "title_unknown", "field": "titleCode", "message": "称号不在字典内" } }
  ]
}
```

**逐项错误形状**:`{ ok:false, kind, ref, error:{ code, field?, message } }`。
提交是**单批事务**:要么整批 `committed`,要么 `failed` 且 `error` 说明原因;绝不部分提交。

### 8.3 `payload` 形状(预检与提交共用)

```jsonc
{
  "announcement": {
    "sourceDocument": { "source": "jxj", "title": "…", "docNumber": "甬经信中小〔2024〕192号" },
    "records": [{
      "enterprise": { "name": "…", "uscc": "913302…", "district": "鄞州区" },  // uscc 可空;district 可空
      "titleCode": "specialized_sme",
      "events": [{ "eventType": "review", "year": 2021, "batchSeq": 1,
                   "decidedYear": 2024, "reviewOutcome": "failed",
                   "evidence": [{ "sourceFile": "…", "attachment": "附件2", "listNo": 3, "page": 7 }] }]
    }]
  },
  "aliases": [{ "enterpriseName": "…", "uscc": "913302…", "name": "宁波旧名…",
                "sourceKind": "platform_business", "sourceRefId": 7,
                "verificationStatus": "confirmed", "validFrom": null }],
  "platformQueries": [{ "interface": "business_list", "queryKey": "913302…",
                        "queriedAt": "2026-10-14T03:00:00Z", "status": "success",
                        "relations": [{ "sequenceNo": 1, "usccRaw": "913302…",
                                        "nameRaw": "…", "aliasNameRaw": "…",
                                        "matchBasis": "alias", "verificationStatus": "confirmed" }] }],
  "exportSnapshot": { "titleCode": "specialized_sme", "year": 2026, "collectedOn": "2026-10-14",
                      "originalFilename": "…xlsx", "sha256": "…",
                      "rows": [{ "sourceRowNo": 1, "usccRaw": "913302…", "nameRaw": "…" }] },
  "differences": [{ "enterpriseName": "…", "titleCode": "specialized_sme",
                    "direction": "missing_in_miit", "status": "confirmed_reason",
                    "reasonCode": "moved_out", "measureCode": "mark_moved_out",
                    "movedIn": null, "verificationStatus": "confirmed",
                    "evidenceQueryId": 4, "recordedAt": "2026-10-14T08:00:00Z" }],
  "merges": [{ /* 归并与回填,见 §8.4 */ }],
  "usccBackfills": [{ /* 给本来没有统代的企业补录代码,见 §8.10(RL-06 增量) */ }]
}
```

公告记录中的 `enterprise.uscc` 缺席、`null` 或空白表示未提供身份代码；非空值必须通过既有
USCC 格式与校验位验证，否则该记录以 `uscc_format_invalid` 逐项报错并使整批不写。事件出处的
`page` 缺席或 `null` 保持为 `null`；PDF 提供页码时必须是精确的正整数，否则报 `page_invalid`；
Word / Excel 等非 PDF 出处若提供非 `null` 页码，报 `not_page_capable`。这些校验发生在身份规划与提交前。
预检和提交还会从配置的文件库根读取源 PDF 页数(PDFium):超出实际页数以 `page_invalid` 拒绝，源 PDF
缺失、不可读或路径无法安全解析以 `page_count_unknown` 拒绝；拒绝时业务记录不部分写入。页图可能尚未全部
渲染，不能用页图数量替代源 PDF 页数。

> **`year` / `collectedOn` 由调用方给出**(RL-05 的解析器**不从文件内容或文件名推断**年度：
> 导出表里那列「维护批次」是平台口径的维护批次，不是快照年度)。`exportSnapshot.rows[].rawFields`
> 的键是 **1-based 列号字符串**、只留**非空**值(契约 §1.7)；单张导出表实测 6273 行、数十列，
> payload 是 MB 级且**真实体量远大于合成夹具的估计**。2026-10-16 用**真实导出表**实测
> (`pnpm build` + 起 `.output` 打真路由):「专精特新中小企业」表 **306 列**,整行 `rawFields`
> 让一次 POST 达 **33 MB**;小巨人 **6.4 MB**、创新型 **8.7 MB**。
> **实测生产路由能完整收下并落库**(200 / `committed` / `written: 3268` / 3267 行,约 0.32s),
> 无需调 `bodyLimit`。⚠️ 但每年 × 每称号约 33 MB 落 SQLite 的 JSON 列是可观体量 ——
> 是否裁列或压缩留待后续决策,**当前按契约原样存,不擅自裁剪**。
>
> **证据指针可以指向本批新建的查询/关系**:`aliases[].sourceRelationRef`、
> `differences[].evidenceQueryRef` / `evidenceRelationRef`、`merges[].sourceRelationRef` /
> `evidenceQueryRef` —— 自然键与解析规则见 **§8.7**。裸 id(`sourceRefId` / `evidenceQueryId` /
> `evidenceRelationId`)继续可用,指向**已存在**的行。
>
> **两个「回填」形状的分工**(先读 §5.2 / §8.4 / §8.10):
> `merges` 并身份(该统代**已挂在某家企业行上**,把无统代的那行并过去);
> `usccBackfills` 只补一个缺失的值(该统代**库里还没有任何一行持有**,§8.10,RL-06 增量)。

### 8.4 `payload.merges` —— 归并与回填的写入形状(RL-11 增量补齐)

> **父代理澄清 C2**:§5.2 只定义了归并的**语义**,§8.3 的 `payload` **缺**它的写入形状。
> 本节是 RL-11 的**增量扩展** —— 只新增小节,**不改**任何已冻结的表 / 列 / 枚举。
> 语义严格照 §5.2(不是 `UPDATE uscc_norm`,而是 MERGE)。

```jsonc
"merges": [{
  "fromEnterpriseId": 375,          // 被并企业 id;与 fromEnterpriseName 恰给其一
  "fromEnterpriseName": "宁波上航测绘有限公司",   // 也可按归一化名找被并企业
  "intoUscc": "91330211255994457P", // 规范行(保留的那家)的统一社会信用代码
  "canonicalName": "宁波上航测绘股份有限公司", // **主名称**(§5.3 ①):给了就把规范行改成它、原名落别名;不给=不改名
  "aliasName": "宁波上航测绘有限公司",  // 写进曾用名的名称;不给则用被并企业的现名
  "sourceKind": "platform_business", // 曾用名来源类别(§2.2);默认 manual
  "sourceRefId": 7,                 // 曾用名的来源证据行 id(如 platform_relation.id,**已存在**的行);默认 0
  "sourceRelationRef": { "interface": "business_list", "queryKey": "91330211255994457P",
                         "rdjb": "3", "sequenceNo": 2 },  // 或自然键(可指本批新建的关系);与 sourceRefId 恰给其一,见 §8.7
  "evidenceQueryId": 4,             // 支撑本次归并的查询证据(记入血缘,不落列);可空
  "evidenceQueryRef": { "interface": "business_list", "queryKey": "91330211255994457P", "rdjb": "3" }, // 或自然键,见 §8.7
  "note": "businessList rdjb=3 的 qymc 差异行"   // 可空
}]
```

**`canonicalName`(RL-14 增量,父代理 2026-10-16 裁决)**:规范行的**主名称**,以工信部导出表
(最新平台态)为准(§5.3 ①)。语义:

| 给的值 | 行为 |
|---|---|
| 非空且与规范行现名**不同** | 规范行 `name` / `name_norm` 改成它;**被顶掉的原名**落 `enterprise_alias`(`confirmed`,来源 = 本次归并的来源行);血缘 `rename: { from, to, aliasId }` |
| 与现名相同 | 不改名(无副作用;血缘 `rename: null`) |
| 不给 / `null` | **不改名** —— 缺省行为,与既有写法向后兼容(血缘 `rename: null`) |
| 空串 / 非字符串 | 逐项报错 `canonical_name_invalid`,整批 `failed`(**不静默忽略**) |

导出表侧**没有**这家企业的名字时留空(不猜)。谁是导出表侧的名字由调用方按证据给出。

预检的 `merge` 计划项在 `detail.requestedCanonicalName` 里**如实回显请求**里给的值
(`null` = 没要求改名)。⚠️ 这是**请求**不是结论:真会不会改名取决于**执行时**规范行的现名
(规范行可能本批才建、也可能与给定的名字逐字相同),权威答案是血缘的 `rename`
(`null` = 确实没改名)—— 预检不承诺执行阶段才成立的事。

执行步骤(逐字照 §5.2):**①** 定位规范行(`intoUscc`)与被并企业 → **②** 把被并企业的名称
写成规范行的 `enterprise_alias`(`verification_status='confirmed'`,带 `sourceKind` /
`sourceRefId` 来源证据)→ **③** 迁移子行(`record` / `enterprise_alias` /
`difference_reason` / `platform_relation` 改指规范行)→ **④** 解决 `record_identity_uq`
冲突:规范行已有同 `(称号, 来源)` 的记录时,把被并记录的 `record_event` **改指**规范行那条记录
(出处挂在事件上随之归入),然后删除被并的空 `record`;**事件与出处一条都不合并、不折叠、不删除**
→ **⑤** 删除被并的 `enterprise` 行。

**执行时解析身份(重要)**:`merges` 与同一 `payload` 里**本批新建**的企业/记录可以互相引用 ——
`fromEnterpriseId` / `fromEnterpriseName` / `intoUscc` 在**写入阶段**(而不是预检阶段)解析,
所以「一个批次先写企业、再归并它」是合法的。

**逐项报错**:任一归并项不合法(被并企业不存在 / 规范行不存在 / 两行相同 / 来源类别不在字典内)
⇒ 整批 `failed`,错误形如 `{ ok:false, kind:"merge", ref, error:{ code, field?, message } }`。

**归并血缘(父代理裁决 #4 的硬要求)**:每条成功的 `merge` 项在 `import_batch.item_results`
里带 `detail.lineage`,可直接查回:

```jsonc
{ "ok": true, "kind": "merge", "ref": "merge:375->7289",
  "detail": { "lineage": {
    "fromEnterpriseId": 375, "fromEnterpriseName": "宁波上航测绘有限公司",
    "intoEnterpriseId": 7289, "intoUscc": "91330211255994457P",
    "canonicalName": "宁波上航测绘股份有限公司",   // 规范行**最终**的名字(§5.3 ①)
    "rename": { "from": "宁波上航测绘有限公司", "to": "宁波上航测绘股份有限公司", "aliasId": 91 }, // 没改名是 null
    "aliasId": 91,
    "childRowsMoved": { "aliases": 1, "differences": 0, "relations": 6, "records": 1 },
    "recordsMoved": [640],                 // 直接改指规范行的记录 id
    "recordsFolded": [{ "fromRecordId": 641, "intoRecordId": 512 }],  // 折进规范行同坐标记录
    "eventsMoved": [91, 92],               // 被并企业名下的(原)事件 id —— 一条都没删
    "evidenceMoved": [301, 302]            // 随之归入规范行的出处 id(含页码)
  } } }
```

> `canonicalName` / `rename` 是 RL-14 的增量(见上文 `canonicalName` 一节)。
> `rename.aliasId` 是**被顶掉的原名**那条别名;`aliasId` 是**被并方名字**那条。
> 两者可能是同一条(两个名字相同时按唯一键复用,只写一条别名 —— 见 §5.3 ①)。

### 8.5 预检计数口径(精确语义,供各写入方对齐)

`preflight` 的 `{ add, update, remove, review, conflicts }` 含义固定如下(契约 §8.1 的示例只给了形状):

| 字段 | 含义 |
|---|---|
| `add` | 本次将**新增**的**计划项**数。⚠️ 计数单位是**计划项**(一个 `payload.records[]` 条目 = 1 项),**不是**「企业+记录+事件+出处」各算一行。实测:小巨人工作簿 511 行源数据 → `add: 510`(= 企业/记录数),而非 2000+。 |
| `update` | 本次将**复用或更新**的既有计划项数(按唯一键命中:如同一 `(称号, 年度, sha256)` 的快照批)。**重放时若只有出处的 `source_file` 需要收敛(§8.9),该 `payload.records[]` 项也计入 `update`** —— 那一项确实改了既有行,不该报成 `skip`。 |
| `remove` | 归并会**删除**的被并企业行数(= 成功的 `merges` 项数)。 |
| `review` | 落在**待核**状态的行数(`pending` / `needs_review`,以及未知枚举原样入库的行)。 |
| `conflicts` | 逐项冲突(`{ ok:false, kind, ref, error }`),**不静默丢行**。 |
| `evidenceRepoints` | **行**口径(RL-19 增量,§8.9.1):本次将改掉几行 `record_evidence.source_file`。它与 `update` **不是一个数** —— `update` 的单位是计划项,而一条记录可以带多条事件、每条各有出处(真数据实测 `update: 510` / `evidenceRepoints: 511`)。它跨项共享一个「已认领出处行」集合,故同坐标的重复载荷记录不会被数两遍。 |
| `batchStatus` | 预检时该幂等键在库里的批次状态(RL-19 增量,§8.9.2)。为 `'committed'` 时上面所有计数一律为 0 —— 同键 `commit` 不会再写任何东西,别把它读成「无事可做」;要补收敛走 `POST …/replay`(§8.9.3)。 |

**`add` / `update` / `skip` 的判据 = 写入侧的**身份规则**(RL-14 修正)**:一条 `records[]` 是
`add` 还是 `skip`,看它**会不会真的新建企业** —— 判据就是 `upsertEnterprise` 用的那套
(有统代只按统代、无统代才按名),**不是**「按名回退」那套。后者在「统代查不到、名字却对得上」
时会说「复用既有行」,而写入侧另起一行 —— 那正是本票事故的根因,预检与提交会自相矛盾。

两条判据缺一不可(**库状态** + **本批更早的计划**):库里已有同坐标 `record` ⇒ `skip`;
此外,**同一批里更早的记录已为同一身份的同一 `(称号, 来源)` 建过**时,写入侧的
`upsertEnterprise` / `upsertRecord` 会**复用**那一条(`rowsWritten` 为 0)⇒ 后一条也计 `skip`。
只看库状态会把这种输入(重复的工作簿行)误报成 `add`。

`conflicts` 非空 ⇒ 提交整批 `failed`,业务数据一行不落。

### 8.6 `replaced_batch_id` 的方向(父代理 2026-10-16 裁决)

按 §1.6 的列语义「**本批替换了哪一批**」:**新批**记下它替换掉的批次 = 同
`(title_code, year)` 下**现有的最新批**的 id(不同 `sha256`);首版为 `null`。
同 `sha256` 重放命中唯一键 `(title_code, year, sha256)` ⇒ **不新建批**;换内容 ⇒ 新版本,
用 `replaced_batch_id` 指向被替换的旧版,**两版并存**(旧快照不因替换而消失)。

### 8.7 `payload` 的**批内自然键引用**(RL-11 增量补齐)

> **父代理补正(2026-10-16)**:§8.3 的证据指针（`aliases[].sourceRefId`、
> `differences[].evidenceQueryId` / `evidenceRelationId`、`merges[].sourceRefId`）只收**裸整数 id**,
> 而那些 id 由写入侧在**本批事务内**生成 —— 客户端构造载荷时**不可能预知**。
> 只认裸 id 会把「查询 → 关系 → 别名/差异证据」逼成**两批**（先写查询、读回 id、再写别名）,
> 而验收第 2 条要求「**一个批次**可提交企业、**带来源证据的**已确认曾用名、
> 差异原因和后续措施」—— 两批不算满足。本节补上**同一批内**的证据指针。

#### 8.7.1 引用形状 `RosterPlatformRef`

`platform_query` 的唯一键是 `(interface, query_key, rdjb, queried_at)`,
`platform_relation` 的唯一键是 `(query_id, sequence_no)` —— 自然键即由此而来:

```jsonc
{ "interface": "business_list",   // 必填;business_list | apply_list
  "queryKey": "91330211255994457P", // 必填;统一社会信用代码 或 name:<nameNorm>
  "rdjb": "3",                    // 可空;businessList 的认定级别,默认 ''
  "queriedAt": "2026-10-16T03:00:00.000Z", // 可空;**给了**就精确匹配那一次查询
  "sequenceNo": 2 }               // **关系引用必填**(同一次查询内第几条,从 1 起);查询引用不用
```

**为什么不认「只给 `relationKey`」**:实测同一 `relationKey` 在 `business_list` 与 `apply_list`
下**各出现一次** —— 单靠它有歧义,自然键**必须含接口**。
`sequenceNo` 仍是**关系引用必填**(自然键要能唯一定位),但它是**参考值**;真正的**权威锚点**是
`relationKey`(RL-06 增量,父代理 2026-10-16:实测「平台的排序可能与解析顺序不同」)。
所以引用里可以**同时**给 `relationKey` —— 给了就按它校验:

```jsonc
{ "interface": "business_list", "queryKey": "913302…", "rdjb": "2",
  "queriedAt": "2026-10-16T08:16:12Z", "sequenceNo": 1,
  "relationKey": "SQ332023042745662" }   // 权威锚点;与 sequenceNo 指的不是同一行 ⇒ 报错
```

- 该查询下**没有**这个 `relationKey` ⇒ 逐项报错 `relation_ref_not_found`;
- 有,但它与 `sequenceNo` 指的不是同一行 ⇒ 逐项报错 **`relation_ref_mismatch`**，
  **绝不按其中一个猜**;执行阶段会再校验一遍,不符即整批回滚。

落点与字段名:

| 载荷项 | 字段 | 指向 |
|---|---|---|
| `aliases[]` | `sourceRelationRef` | `platform_relation` 行(→ `enterprise_alias.source_ref_id`) |
| `differences[]` | `evidenceQueryRef` | `platform_query` 行(→ `difference_reason.evidence_query_id`) |
| `differences[]` | `evidenceRelationRef` | `platform_relation` 行(→ `difference_reason.evidence_relation_id`) |
| `merges[]` | `sourceRelationRef` | `platform_relation` 行(→ 归并写出的 `enterprise_alias.source_ref_id`) |
| `merges[]` | `evidenceQueryRef` | `platform_query` 行(只进血缘 `lineage.evidenceQueryId`) |

#### 8.7.2 解析时机与顺序（**批内**引用）

写入的**执行顺序**固定为:公布文件(企业/记录/事件/出处) → `platformQueries`(查询 + 关系)
→ `aliases` → `differences` → `exportSnapshot` → `merges`。
自然键在**写入阶段**(关系与查询已插入之后)解析成真实行 id 落列 ——
所以「**同一批**先写查询与关系、再用自然键给别名/差异补证据」是合法的,无需二次批。
(载荷里的键序不影响执行顺序;`merges` 最后执行,才能把本批新建的记录一并折进规范行。)

`queriedAt` **可省**:省了就用 `(interface, queryKey, rdjb)` 匹配,并要求**恰好命中一次**
(命中多次 ⇒ 逐项报错,绝不猜);给了就精确匹配那一次查询。

#### 8.7.3 冲突与失败规则(绝不静默、绝不猜)

- **同一列裸 id 与自然键恰给其一**:两个都给 ⇒ 逐项报错
  （`source_ref_conflict` / `evidence_ref_conflict`），**不静默取其中一个**。
- **解析不到 ⇒ 逐项报错、整批 `failed`、业务数据一行不落**，错误码:
  `query_ref_not_found`（查询不存在）/ `relation_ref_not_found`（该查询里没有这个序号）/
  `ref_sequence_no_required`（关系引用缺 `sequenceNo`）/
  `query_ref_ambiguous` · `relation_ref_ambiguous`（省了 `queriedAt` 且命中多次）/
  `ref_interface_unknown` · `ref_query_key_required` · `ref_shape_invalid`。
- **绝不落 `0` 哨兵**:`source_ref_id = 0` 只表示「本就没给来源行」;
  给了引用就必须解析到真实行,解析不到报错而不是退回哨兵。
- 执行阶段的项失败同样**回滚整批**:已完成项标 `commit_rolled_back`、
  未执行项标 `not_executed`，`status='failed'`、`written=0`。

#### 8.7.4 兼容

裸 id(`aliases[].sourceRefId`、`differences[].evidenceQueryId` / `evidenceRelationId`、
`merges[].sourceRefId` / `evidenceQueryId`)**继续可用**,语义不变:指向**已存在**的行
(如「先写查询、读回 id 后再写别名」的既有做法)。既有写法不必改。

### 8.8 重名候选的**显式化**与可执行的归并(RL-14 增量)

> **只增量**:不改 §1 的任何表/列/枚举,不改 `upsertEnterprise` 的身份规则
> (有统代只按统代、无统代才按名),不新建模糊推断。口径见 §5.3。

#### 8.8.1 候选出现在哪里(报告的两处落点)

| 落点 | 形状 | 何时 |
|---|---|---|
| `import_batch.item_results` | `{ ok:true, kind:"duplicate_candidate", ref:"duplicate_candidate:<新统代>~enterprise:<既有 id>", detail:{ candidate } }` | 提交后 |
| `preflight`(§8.1 响应 / `import_batch.preflight_result`) | 多一个**增量**字段 `duplicateCandidates: DuplicateNameCandidate[]` | 预检时 |

```jsonc
// DuplicateNameCandidate
{
  "basis": "same_name_norm",        // 判定依据:归一化名相同(目前唯一取值)
  "nameNorm": "宁波仁栋电气有限公司",
  "name": "宁波仁栋电气有限公司",     // 本批新建侧的名称原值
  "existingEnterpriseId": 186,      // 既有侧(库里已有,或本批更早写入的同名行)
  "existingEnterpriseName": "宁波仁栋电气有限公司",
  "existingUscc": null,             // 事故里正是「既有那行无统代」
  "newEnterpriseId": 7394,          // 本批新建的那一行(预检阶段为 null —— 还没建)
  "newUscc": "913302017133602847",
  "sourceRef": "record:169"         // 触发新建的载荷项引用,供逐项追溯
}
```

- 候选项在计划里的归类是 **`note`**:只记录,**不计入** `add` / `update` / `skip` / `review`,
  也不写任何行(`rowsWritten: 0`)—— 它描述的是事实,不是影响。
- 判「会新建」用的是**写入侧的同一份身份规则**,所以预检说「会新建」与提交**真的新建**是同一件事。
- 逐字同名但**本批内**才出现的第二行也算候选(既有侧记为本批更早写入的那一行,
  其 id 在**执行阶段**补齐)。
- **禁止**把候选读成「已合并」:它只说明两行同名。

#### 8.8.2 可运行的归并入口

1. **只读报告**:`GET /api/roster/import/duplicate-candidates?batchKey=…`(§7.8)
   —— 逐条判「可并 / 待核」,并给出可直接提交的 `request`。
2. **提交**:把那份 `request` **原样 POST** 给 `POST /api/roster/import/commit`(§8.2)。
   写入侧没有新增任何入口:同一份单批事务、同一份幂等键语义、同一份逐项错误与血缘。
3. **脚本**:`node scripts/roster-duplicate-merge.mjs --base-url <URL> --batch-key <键>`
   —— 上面两步的薄封装(`--dry-run` 只读、`--strict` 有待核则退出码 3;token 只从
   `NUXT_API_TOKEN` 读,不打印)。

**幂等键由服务端派生**:`duplicate_merge:<源批次键>#sha256:<归并内容的短哈希>` ⇒
同样的证据重复执行**命中已提交批次、一行不增**;之后补了新证据 ⇒ 内容变了 ⇒ 新键 ⇒ 新批次
(原先待核的那几条这时才可能被并)。`sourceKind='alias_evidence'`,
`sourceIdentity='roster/duplicate-merge/<源批次键>'`(据此可查「本批候选执行过没有」,
即 §7.8 的 `previous`)。

#### 8.8.3 实测基准(2026-10-16,真数据)

在**真实库的副本**上导入**真实的小巨人工作簿**(`buildLittleGiantImportRequest` → 同一套 API),
再按 §5.3 的证据规则写入 4 组实测平台关系,然后用**上面那个脚本**执行:

| 既有(无统代) | 新建(带统代) | 归并后 |
|---|---|---|
| enterprise:52 宁波昌隆机电有限公司 | enterprise:7391 `913302067562827060` | 1 行(7391) |
| enterprise:81 宁波巨神制泵实业有限公司 | enterprise:7393 `913302126102116572` | 1 行(7393) |
| enterprise:186 宁波仁栋电气有限公司 | enterprise:7394 `913302017133602847` | 1 行(7394) |
| enterprise:354 宁波哲能精密塑料有限公司 | enterprise:7395 `91330205084796244Y` | 1 行(7395) |

- 导入那一步:重名候选 **4 条**(正是原先**静默**产生的 4 家重复企业身份);
  此时证据还没写 ⇒ `ready 0 / pending 4`(`no_platform_query`),**一行都没并**。
- 写入证据后:`ready 4 / pending 0`;执行归并 `written 0`(两侧逐字同名 ⇒ 不造别名),
  每条 `merge:<旧>-><新>` 把记录/事件/出处各 1 条并入规范行。
  ⚠️ 那次跑**没有**写导出快照 ⇒ `exportName` 为 `null` ⇒ 不改名(§5.3 ① 的缺省支)。
- 血缘示例(`merge:52->7391`):
  `{"fromEnterpriseId":52,"intoEnterpriseId":7391,"intoUscc":"913302067562827060",
    "canonicalName":"宁波昌隆机电有限公司","rename":null,"aliasId":null,
    "evidenceQueryId":4,"childRowsMoved":{"records":1,"relations":0,"aliases":0,"differences":0},
    "recordsMoved":[52],"recordsFolded":[],"eventsMoved":[52],"evidenceMoved":[52]}`

### 8.9 重放时的**出处指针收敛**(RL-16 增量补齐;RL-19 补齐重放路径)

**场景**:来源文件入库后,同一份内容的标识从**库外路径**变成**库内路径**
(如 `经信局名单/小巨人/….xlsx` → `jxj/announcement/经信局公布历年小巨人企业名单.xlsx`)。
此时 `sourceIdentity` 与幂等键(§8.1 的 `<来源标识>#sha256:<内容>`)随之改变 ⇒ 用新键**重导一次**。

**收敛规则**(`server/utils/roster-import.ts` 的 `repointTargets`):

- 事件坐标(eventType / year / batchSeq / reviewOutcome / decidedYear)**逐字相同**才进入这条路径;
- 出处的 `attachment` 与 `listNo` 逐字匹配。目标 `sourceFile` 为 PDF 时,`page` 也逐字匹配(含 `null`);目标为 DOCX / Excel 等无稳定分页格式时,请求页码与已有页码都归一为 `null`,不参与匹配,且事件内必须只有一条相同附件与序号的候选行才收敛,多条候选按歧义跳过;
- 收敛前必须验证旧路径和目标路径各自唯一的内容 SHA-256 相同。路径哈希来自 `stored_file.sha256`,或来自 `sourceIdentity` 与该路径逐字相同时的当前请求 / 已提交公告批次 `sourceSha256`;只接受 64 位十六进制 SHA。逻辑来源标识不能替其他证据路径背书。任一哈希缺失 / 冲突或两端不同,预检与写入返回出处冲突并保持旧出处;不得按坐标覆盖权威来源。需要保存不同内容的正式来源时,由调用方单独处理为独立出处;
- 同一既有事件坐标在载荷中重复出现时,先合并全部出处目标再判定:与现有 `sourceFile` 相同的 no-op 不认领出处行;同一行出现多个不同有效目标路径时按歧义跳过,不按载荷顺序猜配。计划期冻结具体出处行、旧路径和目标路径;预检数出的行由普通 commit 按此计划最多更新一次。目标快照与对象键及数组顺序规范化后的完整公告载荷 SHA-256 指纹（包括 `sourceDocument.source` 等记录默认值上下文）只作为服务端 replay 记账持久化,不属于 API `items[].detail`。显式 replay 仅在原批次来源标识与规范化公告载荷指纹都一致时复用快照;仅当行仍指向记录的旧路径时更新,已到目标或已指向第三条路径则跳过,不会因重算而反向切换;
- 普通 commit 中同一批载荷里尚不存在的记录/事件坐标重复出现时,先合并所有出处关系再写新事件。既有企业按唯一解析到的 `enterprise.id` 归组:给了 USCC 按精确 USCC 定位;未给 USCC 时,只有同名候选恰为一家才与其归组。若无 USCC 的名称命中多家既有企业,无论该记录是否与其他记录重复、事件坐标是否相同,预检与 commit 都返回现有 `enterprise_ambiguous` 逐项错误并整批不写;不得因名称查询首条或与另一条 USCC 记录分组结果不同而猜配。对于库内没有同名企业的新身份,计划先按整份公告的规范化名称汇总显式 USCC 候选:恰有一个不同 USCC 时,name-only 项在预检、commit 中都映射到该 USCC 身份,同称号/来源/事件坐标的出处合并后只写一个事件;有多个不同 USCC 时,name-only 项返回 `enterprise_ambiguous` 并使整批不写,显式 USCC 项仍各按自己的统代定位;没有显式 USCC 候选时,单独的 name-only 项仍按名称新建无统代企业。此映射按整批候选决定,不按输入先后推断,也不只凭名称把不同统代合并。明确 USCC 仍按精确企业定位,不同 USCC 不因名称相同而合并。不同 `sourceFile` 保留为不同出处行;完全相同的 `(sourceFile, attachment, listNo, page)`(非 PDF 页码归一为 `null` 后)只写一次,并按规范化坐标稳定排序后由首次出现项插入。后续重复事件只跳过,不重新收敛来源,所以输入顺序、普通 commit 重试和显式 replay 都不会丢来源或改变来源集合;
- 目标格式为非 PDF 时,命中的历史 `page` 清为 `null`(§8.11);PDF 的既有实际页码原样保留,不推断页码。格式按目标 `sourceFile` 的扩展名判定;
- 收敛既有事件时**不新增、不删除、不合并**任何行(不变量:企业 / 记录 / 事件 / 出处计数不变);
- 命中的出处行数逐项报在 `items[].detail.evidenceRepointed`(RL-16 新增字段,**不**计入 `summary.written`);内部目标快照供显式 replay 复用,但不返回给调用方;
- 同一幂等键的普通 `commit` 仍是**彻底的空操作**(批次已 `committed` ⇒ 直接返回既有摘要,不重跑计划)。补收敛走独立的 `POST …/replay`(§8.9.3),其结果按原提交快照保持幂等。

**为什么可以改历史批次的行**:变的不是历史事实,是**同一份文档在库里的位置**。收敛只在
「同一份来源内容(同 `sha256`)且坐标逐字相同」时发生,故不会把一条出处挪到另一条上;
「公布历史不可改写」指的是事件坐标与结论,那些一个字节都没动。

> **RL-19 对上面这行措辞的更正**:本节原先写「预检的 `update` 如实计入本次将收敛的出处行数」——
> 那句话**不成立**,`update` 的单位是**计划项**(§8.5),而行数是另一回事(实测 510 项 / 511 行)。
> 行口径改用独立字段 `preflight.evidenceRepoints` / `summary.evidenceRepointed` 承载(§8.9.1)。
> 这不是把口径改松,是把一个本来就报不准的数换成两个各自报得准的数。

#### 8.9.1 计划项口径与**行口径**都要报(RL-19)

§8.5 的 `update` 计数单位是**计划项**(一个 `payload.records[]` 条目算一),而收敛改的是**行**;
一条记录可以带多条事件、每条事件各有出处。两处都报出来,「预检答应的」与「提交真改的」
才逐行可比对:

| 位置 | 字段 | 口径 |
|---|---|---|
| 预检响应 | `preflight.update` | 计划项数(§8.5) |
| 预检响应 | `preflight.evidenceRepoints` | **行**数:本次会改掉几行 `record_evidence.source_file` |
| 提交响应 | `summary.written` | 新增的行数(收敛**不算**,它是 UPDATE) |
| 提交响应 | `summary.evidenceRepointed` | **行**数:本次真的改掉了几行 |
| 提交响应 | `items[].detail.evidenceRepointed` | 该项自己改掉的行数(求和 = `summary.evidenceRepointed`) |

**实测基准(2026-10-16,真数据)**:511 行小巨人工作簿 → `preflight.update = 510`(510 条记录)、
`preflight.evidenceRepoints = 511`(511 行出处,其中一条企业跨两批 ⇒ 一条记录两条事件两条出处);
提交后 `summary.evidenceRepointed = 511`、`summary.written = 0`,四张业务表计数一行不变。
**验收判据**:`preflight.evidenceRepoints === summary.evidenceRepointed`(若 `conflicts` 非空则整批
`failed`、一行不写 —— 与 §8.5 的既有限定一致)。

#### 8.9.2 已 `committed` 的幂等键:预检必须说真话(RL-19)

同键 `commit` 对已提交批次**不重跑计划、直接返回既有摘要**(§8.2 的幂等,保持不变)。
因此对这样的请求,**预检不得报一份做不到的计划**,也不得**覆写**那条已提交批次的预检记账。

- `POST …/preflight` 遇到 `status='committed'` 的批次时返回
  `{ add:0, update:0, remove:0, review:0, conflicts:[], evidenceRepoints:0, batchStatus:'committed' }`,
  且**不写** `import_batch.preflight_result`;
- 原因(这是 RL-19 的事故现场):那次提交跑的是 **RL-16 合入前的构建**,输出
  `{"written":0,"skipped":1021}`(510 个 `skip` 计划项 + 511 条被跳过的事件);
  重新构建后**再跑预检**得到 `{"update":510}` 并覆写了记账,于是批次行里留下
  「预检说改 510 行、摘要说改了 0 行」的自相矛盾记录 —— 读起来像「谓词一条都不命中」,
  实际是**两个构建的产物被拼在了一起**。谓词(`repointTargets`)本身没有问题。
- 已消费的键要补收敛,走 §8.9.3 的显式重放入口。

> **历史行不清洗**:本修正只保证**今后**不再产生这种自相矛盾的记账。库里**已经**存在的那类
> 行(例如 `acceptance/20261016-final/roster.db` 的 `import_batch#6`:摘要
> `{"written":0,"skipped":1021}` 挨着 `preflight_result={"update":510}`)保持原样 ——
> 清洗它等于直写 SQL 改记账,而本票的约束是**修代码路径**,不是修数据。
> **读这些旧行时的口径**:一个已 `committed` 批次上的 `preflight_result` 是**当时最后一次
> 预检**说的话,不保证与该批次的 `summary` 同源;判断「这一批到底改了什么」,只认 `summary`
> 与 `item_results`。

#### 8.9.3 `POST /api/roster/import/replay` —— 收敛的**显式重放入口**(RL-19 增量补齐)

**为什么需要它**:出处指针的收敛依赖「来源文件已经入库」,而这件事可能**晚于**那次提交
(提交跑的是旧构建 / 载荷当时还指着库外路径 / 文件后落位)。幂等键一旦消费,上面所有
正常路径都改不动了 —— 受影响的库**永远修不回来**。本入口把「收敛」这件事**从批次是否
已 `committed` 里解耦**:它是可以显式、重复调用的一次动作。

```jsonc
POST /api/roster/import/replay
{
  "idempotencyKey": "jxj/announcement/…xlsx#sha256:5de6298a…",  // 必填;与那次提交**同一个键**
  "sourceKind": "announcement",
  "sourceIdentity": "jxj/announcement/经信局公布历年小巨人企业名单.xlsx",
  "sourceSha256": "5de6298a…",
  "payload": { /* §8.3;本入口只读其中出处的坐标与路径 */ }
}
```

响应:

```jsonc
{
  "batchId": 7,               // 本次收敛的**记账**行 id
  "status": "replayed",       // 或 "failed"(载荷有逐项冲突 ⇒ 一行不改)
  "update": 510,              // 计划项口径:将收敛的计划项数(= 预检的 `update`)
  "evidenceRepointed": 511,   // 行口径:真的改掉的出处行数(= 预检的 `evidenceRepoints`)
  "items": [ { "ok": true, "kind": "record", "ref": "record:19749",
               "detail": { "recordId": 19749, "evidenceRepointed": 1, "rowsWritten": 0 } } ],
  "error": null
}
```

**语义(逐条都是硬约束)**:

- 收敛 `record_evidence.source_file`;目标来源为非 PDF 时同时清理 `page`,PDF 页码原样保留:不新建企业 / 记录 / 事件 / 出处,不归并,不删行;
- **只认既有**:库里没有的记录 / 事件一律跳过 —— 收敛**不补历史**(补历史走 `commit`);
- 载荷里那些**会写新行**的类别(平台查询 / 别名 / 差异 / 快照 / 归并)**根本不进计划**,
  故没有可执行的东西(与 `commit` 共用 `planRosterImport`,靠 `convergeOnly` 收窄);
- **与批次状态无关**:原键已 `committed` 也照跑 —— 这正是它的用途;
- **幂等**:指针已经收敛过之后,谓词不再命中 ⇒ `evidenceRepointed: 0`(重复调用安全);
- **记账**:写一条 `import_batch`,键 = `<原幂等键>#repoint`(确定性派生,重放多次同一行,
  不覆盖原批次的账)、`status='committed'`、`summary = { written:0, skipped:0, failed:0,
  evidenceRepointed }`;载荷有冲突时置 `status='failed'` 且一行不改;
- 鉴权与 `commit` 同分法(§8 开头,`NUXT_API_TOKEN`,未配 ⇒ 关闭)。

**为什么它不会把指针改坏**:它不是自动发生的 —— 只有调用方**显式**拿一份载荷来重放时才跑,
且只做「按 (attachment, listNo, page) 逐字匹配、同坐标事件下」的那一列替换。
`commit` 的行为一个字没变(已提交批次仍是彻底的空操作),所以既有的「同键重放不写库」
这条保证不受影响。**风险留给显式调用方**:用一份**过时**的载荷(出处仍指着库外路径)
去重放,就会把指针收敛到那条过时路径上 —— 这是调用方给错了输入,不是自动路径能造成的。

### 8.10 `payload.usccBackfills` —— 补录统一社会信用代码(RL-06 增量补齐)

> **只增量**:不改 §1 的任何表 / 列 / 枚举,不改任何既有写入语义。
> 只新增一个 `payload` 键,语义见下。

**它补的是 `payload` 缺的那一格。** §5.2/§8.4 的 `merges` 只覆盖「规范行**已经存在**
(那个统代已挂在某家企业行上)」的情形 —— 那是**归并**。而 RL-06 走「库内核心词 → 候选 →
平台按统代验证」这条路时,候选统代有时**库里还没有任何一行持有**(该企业只出现在公布名单里,
导出表从未见过它):这时没有「规范行」可以并过去,`merges` 表达不了;而
`announcement.records[].enterprise.uscc` 又会按统代**另起一行**(`upsertEnterprise` 有统代只按
统代匹配)—— 那正是要避免的重复。

```jsonc
"usccBackfills": [{
  "enterpriseId": 10,                      // 与 enterpriseName 恰给其一
  "enterpriseName": "宁波星箭航天机械有限公司",
  "uscc": "91330211MA2CL6FP24",            // 必填;格式与校验位必须合法(GB 32100-2015)
  "source": {                              // 公开来源证据:三要素必填
    "url": "https://…",                    // 可复核的公开内容来源(搜索引擎摘要不算)
    "checkedOn": "2026-10-16",             // 查证日期 YYYY-MM-DD
    "basis": "公开信用信息页:主体名…、注册地宁波市、统代一致",  // 名称/地区对应依据
    "name": "宁波星箭航天机械有限公司",       // 来源里写出的主体名称(原值,留档)
    "region": "宁波市/海曙区"               // 来源给出的地区;给不出留空,不猜
  },
  "note": null
}]
```

**`source` 的三条证据路径**(都由 RL-06 使用;后两条按 `basisKind` 记档):

| `basisKind` | 谁带来 | 证据 | 记档要求 |
|---|---|---|---|
| `byte` / `typographic` / `district_suffix` | 平台接口(库里已有或同批写入的关系) | 那条 `platform_relation` 行 | `source.url` 写**平台接口地址**,`basis` 写清是哪条关系 |
| `public_source` | 联网核实的 `found` 条目 | **公开内容页** | `source.url` 写那个**内容页**,`basis` 保留核实者写的对应依据;来源页的登记状态(如「注销」)进 `note` |
| `cross_source`(记 `basisKind: "public_source"`,两段拼) | 用户裁定「按 A 组归并」(2026-10-16) | **两段互相独立**、缺一不可:**①**「公布名↔代码」来自**公开来源页**;**②**「代码↔现名」来自**平台按码**(`businessList`/`queryList` 的逐字 `qymc`) | note **必须**写实两句:「**平台在该码下持有的现名为 X,与公布名不同**」与「**按公布名查平台 `qymc` 返回 0 行 —— 平台不索引旧名**(对照组「宁波劦群」证明了真匹配也会 0 行),故本归并**不是**由平台名称匹配触发的,而是两段拼成」;**不得**出现「名称相等/归一化后相等/名称相似」 |
| `ocr_correction` | **人工确认的用字纠错**(如 OCR 误读) | 那条 `platform_relation` 行 **+ 人工确认**,**两者缺一不可** | `basis` **必须**写清「公布名经〈谁〉确认为 OCR 误读,平台记录〈平台写法〉为准」;**不得**写成「名称相等」或「归一化后相等」 |

> ⚠️ **`cross_source` 这一档也不是名称匹配**:按公布名查平台返回 **0 行**(平台**不索引旧名**,
> 实测;对照组「宁波劦群」证明真匹配也会 0 行)。它成立的前提正是「平台按码持有的现名与公布名**不同**」
> —— 判据是两段**独立来源**(公开页配对 + 平台按码),不是两个名字像不像。
> `merges[].sourceKind` 落 `manual`(`sourceRefId = 0`:来源是公开页,不是某条平台关系),
> 平台那一半走 `merges[].evidenceQueryRef` 进血缘。
>
> ⚠️ **`ocr_correction` 绝不可由字形相近自动推出。** 荔/劦 只是**先例**,不是可套用的模式 ——
> 系统**不自动判定字形相近**(那正是 §0 第 3 条明令禁止的模糊推断引擎)。
> 它只能由调用方**显式**给出(判定文件里的 `basisKind: "ocr_correction"` + 确认出处),
> 且必须**指名确认人**(取不到确认人 ⇒ 不按纠错处理,该条自然停在待人工)。
> 平台写法:显式字段优先;否则取该统代**证据行里唯一的那个 `qymc`**(不是「像不像」,
> 而是「这次返回里平台只写了这一个名字」);不唯一 ⇒ 不猜、拒收。

**`source` 的两种字段形态**——公开内容页与平台接口地址都写在这两个字段里,差别在写法:

| 证据形态 | 谁带来 | `source.url` 写什么 |
|---|---|---|
| **公开主体来源**(路径二) | 人/代理逐家查证的公开内容页 | 那个**内容页**的 URL(搜索引擎摘要不算);`basis` 写「为什么这个主体就是本企业」 |
| **平台原始关系**(路径一) | 平台接口返回的关系行 | 平台**接口地址**(`businessList` / `queryList` 的 URL —— 它不是公开内容页);`basis` 写清**哪一条**关系(接口 / rdjb / 序号 / `relationKey`)的 `qymc` 逐字等于公布名 |

第二种的**身份证据是那条 `platform_relation` 行本身**(`enterprise_alias.source_ref_id` /
`import_batch` 血缘都指得回它),不是那个 URL —— `url` 在这一格里只回答「证据从哪个接口来」。
两种形态在载荷里同形(不新增字段),用 `basis` 的写法区分;要在报告里分开,看 `plan.byRoute`
(`public_source` / `platform_claim`)。

**执行语义(逐条硬边界)**:

| 判据 | 不过时 |
|---|---|
| 代码**格式与校验位**合法(GB 32100-2015:18 位、字符集不含 `I O S V Z`、加权校验位) | 逐项报错 `uscc_format_invalid`,`field: "uscc"` |
| 公开来源三要素(**URL / 查证日期 / 主体对应依据**)+ 来源名称齐备 | `source_evidence_incomplete`,`field: "source"` |
| 目标企业存在;按名定位时**同名行唯一** | `enterprise_not_found` / `enterprise_ambiguous`(同名多主体不猜) |
| 目标企业**本来没有**统代 | `uscc_already_present` —— **不覆盖已有代码** |
| 该统代**未被别的企业占用** | `uscc_taken` —— **不自动合并身份**(要合并走 `merges`,那条路要平台关系证据) |

任一项不过 ⇒ 逐项报错、**整批 `failed`、业务数据一行不落**(与其它载荷项同一条规则)。
成功时**只动两处**:`enterprise.uscc_norm` = 该代码,并从 `quality_flags` 里摘掉
`uscc_missing`(那个标记说的就是「缺统代」,补上以后它不再为真)。**不写别名、不改名、不动
`record` / `record_event` / 出处 / 关系** —— 名称沿革是 `aliases` / `merges` 的事。

**血缘**(落 `import_batch.item_results[].detail.lineage`,与归并同一处可查):

```jsonc
{ "ok": true, "kind": "uscc_backfill", "ref": "uscc_backfill:10->91330211MA2CL6FP24",
  "detail": { "enterpriseId": 10, "uscc": "91330211MA2CL6FP24", "rowsWritten": 1,
              "lineage": { "enterpriseId": 10, "enterpriseName": "宁波星箭航天机械有限公司",
                           "uscc": "91330211MA2CL6FP24", "previousUscc": null,   // 恒为 null(不覆盖)
                           "source": { /* 与载荷同形 */ }, "note": null } } }
```

- **预检计数**:成功的补录项计 `update`(它改的是一条既有企业行),`review` 为 `false`
  (证据齐备才算数,不存在「待核的补录」)。
- **执行顺序**:`usccBackfills` 排在 `merges` **之前**(§8.7.2 的固定顺序 + 这一项)。
  理由是 `merges` 会**删掉**被并企业行 —— 两项若指向同一行,先归并会让补录在写入阶段找不到
  企业(进而整批回滚)。读侧计划从不为同一个目标同时给出两者:一个目标要么有规范行可并,
  要么只能补录。写入阶段会**再校验一遍**(企业还在、仍无统代、统代没被占),任何一条不过就
  抛 `ExecStageFailure` 让整批回滚,**绝不**写出自相矛盾的状态。
- **只读的计划入口**见 §7.9;可运行入口见 `scripts/roster-uscc-research.mjs`。

### 8.11 `POST /api/roster/evidence/pages` —— 出处页码补录(RL-10 增量补齐)

> **只增量**:不改 §1 的任何表 / 列 / 枚举(用的就是既有的 `record_evidence.page`),
> 不改任何既有写入语义,也不改 §8.3 的 `evidence[]`(它本来就能带 `page`)。
>
> ⚠️ **这是本节第二条写入口**,与 §8.6 / §8.7 里「不存在第二种写入口」「写入口仍然只有 §8.2」
> 那两句**不冲突**——那两句说的是 **RL-06 研究流程**(核心词候选 → 平台验证 → 回填)**自己**
> 不另开一条落库路,它产出的东西照样走 §8.2 的 `commit`。本节是**另一件事**:
> §8.3 的 `evidence[].page` 只管**今后**的导入,而库里已有一批 `page` 全为 `null` 的既有行要补,
> 那是对既有行的 UPDATE,不该也不能造一条导入批次账。**它不碰企业 / 记录 / 事件,也不做归并。**

**它补的是「既有行」的那一格。** §8.3 的 `evidence[].page` 只对**今后**的导入有效;
库里已有的两万余条出处是在这个字段还没人填的时候落下的 —— 那是一批 `page` 全为 `null` 的行。
补页码是**对既有行的 UPDATE**,不是一次新的导入:不改企业 / 记录 / 事件,也不该再造一条批次账。

```jsonc
POST /api/roster/evidence/pages
{
  "dryRun": false,                     // 可选;true = 只报结论、一行不写
  "entries": [
    { "sourceFile": "jxj/announcement/2022/甬经信中小〔2022〕145号….pdf",
      "listNo": 6,                     // 名单里的**序号** —— 不是页码
      "page": 8,                       // **PDF 实际页序**(1 起)
      "enterpriseId": 204,             // 定位:与 enterpriseName 至少给一个
      "enterpriseName": "宁波开诚生态技术有限公司",   // 可选,逐字归一后比对
      "district": "海曙区",             // 可选,进一步收窄
      "basis": "人工核对页图:附件二第 6 行" }        // 留档用,不参与判定
  ]
}
```

响应:

```jsonc
{
  "status": "applied",                 // 或 "dry_run"
  "summary": { "requested": 17, "assigned": 15, "written": 15, "unchanged": 0, "pending": 2 },
  "assignments": [ { "index": 0, "evidenceId": 204, "sourceFile": "…", "listNo": 6,
                     "page": 8, "previous": null, "basis": "人工核对页图:附件二第 6 行" } ],
  "pending": [ { "index": 1, "sourceFile": "…", "listNo": 6, "page": 9,
                 "reason": "no_match", "detail": "…序号 6 有 3 条(分节不同…),但没有一条与本条给定的企业 / 属地一致 —— 不猜。",
                 "candidateIds": [1, 2, 3], "sameListNo": 3 } ]
}
```

**语义(逐条都是硬约束)**:

| 判据 | 不过时 |
|---|---|
| `sourceFile` 非空;`listNo` 是正整数;**且必须带 `enterpriseId` 或 `enterpriseName`** | `entry_incomplete` |
| `page` 是正整数(**不取整、不夹到边界、不当成「没有页码」**),且未超出可读取的源 PDF 实际页数 | `page_invalid` |
| 源 PDF 页数无法可靠读取 | `page_count_unknown` |
| 来源是 **PDF**(Word / Excel 没有可复核的页) | `not_page_capable` |
| 按 `(sourceFile, listNo)` + 定位能命中**恰好一条**出处行 | `no_match` / `ambiguous` |

- **裸序号一律拒收。** 判据不是洁癖:`record_evidence` 只有 `(source_file, attachment, list_no)`,
  **没有分节列**,而一份公布文件里可以并置**多张序号各自从 1 起算**的名单 ——
  `甬经信中小〔2022〕145号` 的「附件」里就是三张(一、198 行;二、104 行;三、413 行,共 715 家)。
  库里「145号 + 序号 6」命中 **3 条**完全不同的企业。拿裸序号定位就会把页码写到**错的公司**上。
- **定位信息只用来收窄候选,不用来「像不像」判定**:`enterpriseName` 走 `normalizeName` 的
  **逐字归一**(括号、空白、不可见字符),不是相似度、不是编辑距离。
- **`no_match` 与 `ambiguous` 都要把「同序号有几条」报出来**(`sameListNo` / `candidateIds`):
  那是「分节陷阱」的可观察探针 —— 报告要能区分「库里没有」与「同序号分属别的分节」。
- **定不下来的条目一行不改**,逐条带 `reason` 回报;写入是**逐条尽力**而不是整批事务 ——
  一批里混着「已核对好」与「还没核对」,后者的正确处置是**留空待核**,不是把前者一起回滚。
- **页数取自源 PDF 本身**(PDFium);不会用已渲染页图数量代替总页数。请求页超过已知总页数返回
  `page_invalid`;源文件缺失或打不开时返回 `page_count_unknown` 并留空待核,不猜边界。
- **同一条出处行被两条入参指向、且页码不同** ⇒ 两条都不写(`ambiguous`)。
  同页码是同一个事实的重复表达(批处理重跑常见),照写并计入 `unchanged`。
- **幂等**:重跑同一批 `written: 0` / `unchanged` 全中。
- **非 PDF 永远没有页码**,在**链接层**也成立:`evidencePreviewHref()` 对非 PDF 不写 `page` 参数 ——
  票面要求「Word、Excel 等没有可靠分页的文件不跳转到猜测页」,这条口径在写入、读模型、链接三处一致。
- 鉴权与 §8 其它写入口同分法(`NUXT_API_TOKEN`,未配 ⇒ 关闭);可运行入口见
  `scripts/roster-evidence-pages.mjs`(读人工核对的页图结论,`--dry-run` 先看结论)。

**页码是 PDF 实际页序,与附件无关**(票面「附件切换和跨页名单的页码与 PDF 实际页序一致」)。
页码取的是**整份 PDF 的页**;一张页可以同时装着两个附件的内容,这时**同一个页码**对两个附件都成立。
实测(`甬经信中小〔2022〕145号`,逐页读过页图):**第 8 页**下半是分节标题
「二、有效期:2021年12月1日至2024年11月31日」+ 附件二 序号 1–6,上半是附件一 序号 194–198,
页脚印着「— 8 —」。所以「附件二 序号 6 → 第 8 页」是对的,**不能**把它算成「附件二的第 6 页」。
同理第 14 页的序号 104 是「宁波力劲机械有限公司」(附件三),而第 8 页附近的序号 65 是
「宁波力劲科技有限公司」(附件一)—— **同一份文件里的两家近似名,分属两个附件、两个页码,绝不合并**。

> ⚠️ **已知交互(留给父代理裁决,RL-10 未改)**:§8.9 的出处指针收敛按
> **(attachment, listNo, page) 逐字相同**配对,而本入口会把既有行的 `page` 从 `null` 改成实际页。
> 于是**被补过页码的那些行**,在有人拿一份 `page: null` 的载荷重放收敛(§8.9.3)时不再命中,
> `source_file` 不会被改 —— 也就是「重命名来源文件后仍解析到同一内容」这条路径**对这批行失效**。
> 改它要动 §8.9 冻结的配对谓词(RL-16/RL-19 的领地),故本票**不动**,在此记明场景与影响面
> (仅限被补过页码的行;`.docx` / Excel 行的 `page` 仍是 `null`,不受影响)。

---

## 9. MCP tool 形状(RL-11 / RL-09 实现)
> **RL-01 不注册任何新 tool**(写入 tool 名单由 `server/utils/mcp-auth.ts` 的
> `MCP_WRITE_TOOLS` 单点维护,且有测试钉死 —— 新增写入 tool 必须同时改那里)。
> 下面是 RL-11 和 RL-09 要注册的形状。

| tool | 读写 | 参数 | 说明 |
|---|---|---|---|
| `save_roster_batch` | **写**(需 `NUXT_MCP_TOKEN`) | `{ idempotencyKey, sourceKind, sourceIdentity, sourceSha256?, payload }` | 等价 `POST /api/roster/import/commit`;返回 `{ batchId, status, summary, items }` |
| `preflight_roster_batch` | 读(只读预检) | 同上 | 等价 `POST …/preflight` |
| `list_enterprises` | 读 | `{ q?, title?: string \| string[], firstYear?, firstStatus?, page?, pageSize? }` | 等价 `GET /api/roster/enterprises`；`title` 接受单个称号或称号数组；首次认定筛选按同一个企业×称号匹配 |
| `list_differences` | 读 | `{ title?, direction?, status?, page?, pageSize? }` | 等价 `GET /api/roster/differences` |
| `query_records` | 读 | `{ title?, source?, district?, eventType?, year?, firstYear?, firstStatus?, dueYear?, q?, flags?, page?, pageSize? }` | 与 `GET /api/records` 共用参数解析和企业×称号读模型；`year` 是事件年份，`firstYear` 是首次认定年份，`firstStatus` 与 §7.5 判据一致，`dueYear` 是到期年份 |
| `get_enterprise_detail` | 读 | `{ enterpriseId }` | 与 `GET /api/roster/enterprises/:id` 共用详情读模型 |

「只读不鉴权,写入必带 token」沿用既有分法;token 只从 `NUXT_MCP_TOKEN` 读。

> **实现说明(RL-11 / RL-09)**:
> - **写入清单是单点维护的**:新增写入 tool 必须同时改 `server/utils/mcp-auth.ts` 的
>   `MCP_WRITE_TOOLS`(测试把它钉死)。RL-11 追加 `save_roster_batch`;名录查询 tool 均为只读，
>   不加入写入名单。
> - **`preflight_roster_batch` 按本表归为「读」**(不需 token)。注意它**不是纯读**:
>   与 HTTP 的 `/preflight` 一样,它会在 `import_batch` 落一条 `status='preflight'` 的记账行
>   (**不改任何业务数据**)。这是本表「只读预检」的字面落地;若日后要求它也必须带 token,
>   改 `MCP_WRITE_TOOLS` 即可(一处)。
> - `query_records` 与 REST `GET /api/records` 共用 `parseRecordQuery` 和 `listRecords`；
>   `get_enterprise_detail` 与 REST 企业详情共用 `getRosterEnterpriseDetail`。两者均为只读 tool。


---

## 10. 与既有能力的接缝

- 文件传输:**TUS `/api/uploads`** 负责断点续传,**不定义业务文件身份**(RL-13 处理命名)。
- 文件/OCR/解析已有:文件登记、页图(派生缓存)、`ocr_result`、`stored_file_part`、
  以及 MCP 的 `save_ocr_result` / `set_file_category` / `save_parse_result`。
- **本契约不重造上面任何一条**;RL-11 只补「名单实体/事件/快照/解释」的写入路径,并复用既有传输/OCR。
- `record_evidence.page`(PDF 实际页序,给不出页码则 NULL)是 RL-10 的跳转依据,本契约沿用。

### 平台实时只读查询（#51）

新增 `POST /api/platform/query` / MCP `query_platform` 与能力发现
`GET /api/platform/capabilities` / `get_platform_capabilities`。
统一输入、结果、错误、完整性、安全上限和调用示例见
[平台实时查询契约](platform-live-query.md)。本入口不写历史平台证据，不改变 §7.6
`GET /api/platform/queries`；平台业务请求和既有 reconcile 共用进程内最多2请求预算。

实时平台批次查询（不写业务数据）：见 [platform-batch-query.md](platform-batch-query.md)。
REST `/api/platform/batches` 与 MCP `submit_platform_batch` 提交后按稳定 batchId/itemId
取状态/逐项结果；仅对 unfinished 显式重试。调查与统一名录 preflight/commit 保持独立。


### #59 兼容扩展：已认定企业证据

`platform_query.interface` 新增 `recognized_list`，只对应实时 `queryBusList`；旧来源不重分类。status 增加 `partial`；新增可空 JSON `collection_evidence`，原时间/条件/称号范围/页/计数/末页/未完成/原行逐项保存。旧载荷和旧记录均兼容。

[完整转存与读契约](platform-recognized-evidence.md) 规定新来源必填字段、预检拒绝规则、原始批量 segments 转存、幂等冲突、REST/MCP 历史筛选和同批差异引用。查询与批量入口仍不写业务证据；所有转存经统一写入。企业详情带原字段与页行映射，#60 单独交付界面。

### 用户明确裁决的待审核

`pending_review` 是独立差异原因，配 `confirmed_reason` + `verificationStatus=confirmed` + `follow_review`。确认的是当前分类，后续审核结果尚未产生；与 `needs_review`（原因待核实）、复核失败、失效分开。统一 API/MCP 共用校验此组合。保留正式事件，以新 `recordedAt` 追加解释并保留旧 audit。筛选及页面沿用共享原因/措施字典。

仅在用户明确范围的批次，代理核对同企业同称号历史终审通过、按 `sqsj` 最新更新/待审核、当前导出缺失及无更新相反记录后提交。软件不自动推断，也不要求额外外部证明。证据说明保留流程号、类型、时间、状态及三接口引用，未知字段空。数据库列为 SQLite TEXT，无 DDL/迁移；旧版本应用不识别新增原因，因此回滚前需保留新解释并升级兼容读写端。
