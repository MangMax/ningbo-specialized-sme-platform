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
| `interface` | text | | `business_list` \| `apply_list` | 两个接口 |
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
| `reason_code` | text | ✅ | `moved_out` \| `deregistered` \| `renamed` \| `platform_stale` \| `moved_in` \| `other` | 已知原因;`confirmed_no_diff` / `needs_review` 时可为空 |
| `reason_note` | text | ✅ | | 原因说明;新原因写这里(配 `other`) |
| `measure_code` | text | ✅ | §2.8 的八个取值 | **与原因成对**的后续措施 |
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
| 2.8 | 差异原因 | `moved_out` 外迁 / `deregistered` 注销 / `renamed` 更名 / `platform_stale` 平台未更新 / `moved_in` 迁入 / `other` 其他 | `DIFFERENCE_REASONS` |
| 2.9 | 后续措施 | `keep_history` 保留正式公布历史 / `mark_platform_snapshot` 标明平台时点,不覆盖历史 / `mark_moved_out` 记录迁出状态 / `mark_deregistered` 记录注销主体状态 / `update_current_name` 更新当前名并保留旧名为曾用名 / `record_moved_in` 记录迁入来源(城市/称号/年份/批次) / `manual_review` 转人工核实 / `none` 无需措施 | `DIFFERENCE_MEASURES` |
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

### 3.2 差异状态 `difference_reason.status`

| 取值 | 中文 | 含义 |
|---|---|---|
| `not_queried` | 未查询 | 尚未对该差异做过平台查询 |
| `query_failed` | 查询失败 | 有过查询但失败,且**没有**成功的查询 |
| `no_record` | 无记录 | 有成功查询,但平台无记录 |
| `confirmed_no_diff` | 已确认无差异 | 有成功查询且表明两侧一致 / 无需处置(配 `measure_code=none`) |
| `confirmed_reason` | 已确认原因 | 已凭证据确认原因(填 `reason_code` + 配对 `measure_code`) |
| `needs_review` | 待核实 | 证据不足 / 关系冲突 / 同名多主体 ⇒ **不自动合并、不猜填** |

> 前五个里 `未查询 / 查询失败 / 无记录 / 已确认无差异` 四态互不等价。
> `confirmed_reason` 承载「外迁/注销/更名/平台未更新/迁入」五类**已确认原因**。
> (是否把 `confirmed_reason` 并入 `confirmed_no_diff` —— 见 ADR「待父代理裁决」。)

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

> 验收样例见 ADR §9 与 `tests/lifecycle-contract.test.ts`。

---

## 7. 读接口(可发现契约)

> **由 RL-04 / RL-05 / RL-08 / RL-09 / RL-10 实现**;RL-01 只冻结形状。
> 读接口**不鉴权**(与既有分法一致:读不鉴权,写/任务鉴权)。

### 7.1 `GET /api/roster/enterprises` — 跨称号去重企业总表(RL-04)

查询参数:`q`(名称/曾用名关键词,走 §5 搜索口径)、`title`(可重复)、`district`、
`rosterState`(`current` \| `removed_platform_only`)、`page`(默认 1)、`pageSize`(默认 50)。

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
    "nextReviewYear": 2028          // 可空;锚点+3
  }],
  "counts": { "total": 1, "titles": { "specialized_sme": 1, "innovative_sme": 1 } },
  "page": 1, "pageSize": 50
}
```

### 7.2 `GET /api/roster/enterprises/:id` — 企业详情(RL-04)

```jsonc
{
  "enterprise": { /* §7.1 单行字段 */ },
  "aliases":    [{ "id": 3, "name": "宁波旧名…", "sourceKind": "platform_business",
                   "sourceRefId": 7, "verificationStatus": "confirmed", "validFrom": null }],
  "records":    [{ "id": 5, "titleCode": "specialized_sme", "source": "jxj" }],
  "events":     [{ "id": 9, "recordId": 5, "eventType": "review", "year": 2021,
                   "batchSeq": 1, "decidedYear": 2024, "reviewOutcome": "failed" }],
  "evidence":   [{ "eventId": 9, "sourceFile": "…192号.docx", "attachment": "附件2",
                   "listNo": 3, "page": 7 }],
  "differences":[{ "id": 2, "titleCode": "specialized_sme", "direction": "missing_in_miit",
                   "status": "confirmed_reason", "reasonCode": "moved_out",
                   "measureCode": "mark_moved_out", "recordedAt": "2026-10-14T06:00:00Z",
                   "evidenceQueryId": 4 }]
}
```

### 7.3 `GET /api/roster/differences` — 差异与解释(RL-04)

查询参数:`title`、`direction`、`status`(§3.2 取值)、`reason`、`page`、`pageSize`。

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

### 7.4 `GET /api/roster/reviews` — 下一年度复核清单(RL-09)

查询参数:`year`(必填)、`title`。响应行:`{ enterpriseId, name, titleCode, anchorYear, dueYear, basisEventId }`。

### 7.5 `GET /api/roster/recognitions` — 首次认定(RL-08)

查询参数:`title`、`year`。响应行:`{ enterpriseId, titleCode, firstYear, firstEventId, source }`。

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

响应:`{ "batchId": 12, "status": "preflight", "preflight": { "add": 12, "update": 3, "remove": 1, "review": 2, "conflicts": [] } }`

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
                    "evidenceQueryId": 4, "recordedAt": "2026-10-14T08:00:00Z" }]
}
```

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
| `update` | 本次将**复用或更新**的既有计划项数(按唯一键命中:如同一 `(称号, 年度, sha256)` 的快照批)。 |
| `remove` | 归并会**删除**的被并企业行数(= 成功的 `merges` 项数)。 |
| `review` | 落在**待核**状态的行数(`pending` / `needs_review`,以及未知枚举原样入库的行)。 |
| `conflicts` | 逐项冲突(`{ ok:false, kind, ref, error }`),**不静默丢行**。 |

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

**为什么不认 `relationKey`（如 `SQ332022062212391`）**:实测同一 `relationKey` 在
`business_list` 与 `apply_list` 下**各出现一次** —— 单靠它有歧义,自然键**必须含接口**。

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

---

## 9. MCP tool 形状(RL-11 实现)
> **RL-01 不注册任何新 tool**(写入 tool 名单由 `server/utils/mcp-auth.ts` 的
> `MCP_WRITE_TOOLS` 单点维护,且有测试钉死 —— 新增写入 tool 必须同时改那里)。
> 下面是 RL-11 要注册的形状。

| tool | 读写 | 参数 | 说明 |
|---|---|---|---|
| `save_roster_batch` | **写**(需 `NUXT_MCP_TOKEN`) | `{ idempotencyKey, sourceKind, sourceIdentity, sourceSha256?, payload }` | 等价 `POST /api/roster/import/commit`;返回 `{ batchId, status, summary, items }` |
| `preflight_roster_batch` | 读(只读预检) | 同上 | 等价 `POST …/preflight` |
| `list_enterprises` | 读 | `{ q?, title?, page?, pageSize? }` | 等价 `GET /api/roster/enterprises` |
| `list_differences` | 读 | `{ title?, direction?, status?, page?, pageSize? }` | 等价 `GET /api/roster/differences` |

「只读不鉴权,写入必带 token」沿用既有分法;token 只从 `NUXT_MCP_TOKEN` 读。

> **实现说明(RL-11)**:
> - **写入清单是单点维护的**:新增写入 tool 必须同时改 `server/utils/mcp-auth.ts` 的
>   `MCP_WRITE_TOOLS`(测试把它钉死)。RL-11 追加 `save_roster_batch`;**全部四个 tool 均已注册**
>   (实测真机 `/mcp`:`tools/list` 无 token 时 8 个只读 tool,带 token 时 12 个,
>   `save_roster_batch` 未鉴权调用→HTTP 401)。
> - **`preflight_roster_batch` 按本表归为「读」**(不需 token)。注意它**不是纯读**:
>   与 HTTP 的 `/preflight` 一样,它会在 `import_batch` 落一条 `status='preflight'` 的记账行
>   (**不改任何业务数据**)。这是本表「只读预检」的字面落地;若日后要求它也必须带 token,
>   改 `MCP_WRITE_TOOLS` 即可(一处)。
> - **`list_enterprises` / `list_differences` 是 §7.1 / §7.3 读模型的**最小只读面**,
>   由 RL-11 为「写入后自查」提供(RL-04 负责完整读模型与 `GET /api/roster/*` 端点)。
>   两者**字段同名**,RL-04 落地后可把这两个 tool 重新指向同一实现;`firstRecognition` /
>   `nextReviewYear` 等生命周期字段属 RL-08 / RL-09,未在此代做。


---

## 10. 与既有能力的接缝

- 文件传输:**TUS `/api/uploads`** 负责断点续传,**不定义业务文件身份**(RL-13 处理命名)。
- 文件/OCR/解析已有:文件登记、页图(派生缓存)、`ocr_result`、`stored_file_part`、
  以及 MCP 的 `save_ocr_result` / `set_file_category` / `save_parse_result`。
- **本契约不重造上面任何一条**;RL-11 只补「名单实体/事件/快照/解释」的写入路径,并复用既有传输/OCR。
- `record_evidence.page`(PDF 实际页序,给不出页码则 NULL)是 RL-10 的跳转依据,本契约沿用。
