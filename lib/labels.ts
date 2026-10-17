/**
 * code → 中文 映射的**唯一来源**。
 * 页面、导出、查询层一律从此处取标签,避免各写一份导致文案漂移
 * (例如称号「小巨人」曾在小巨人/专精特新“小巨人”之间不一致)。
 *
 * 称号文案复用 `db/titles.ts` 的 `TITLE_SEED.nameZh`,字典与展示同源。
 */
import { TITLE_SEED } from '../db/titles'

/** 称号代号 → 中文名(如 little_giant → 专精特新“小巨人”)。 */
export const TITLES: Record<string, string> = Object.fromEntries(
  TITLE_SEED.map((t) => [t.code, t.nameZh]),
)

/** 称号展示顺序(等级由高到低,与 TITLE_SEED.rank 一致)。 */
export const TITLE_ORDER: string[] = TITLE_SEED.map((t) => t.code)

/**
 * 称号的短名。只在**按钮和圆点图例**这类放不下全称的地方用(如筛选按钮、图表下钻 chip),
 * 正式名称始终走 TITLES —— 表格、详情、导出里一概写全称。
 */
export const TITLE_SHORT: Record<string, string> = {
  little_giant: '小巨人',
  specialized_sme: '专精特新',
  innovative_sme: '创新型',
}

/** 称号代号 → 等级(1 最高)。徽章梯度与统计排序都按它走。 */
export const TITLE_RANK: Record<string, number> = Object.fromEntries(
  TITLE_SEED.map((t) => [t.code, t.rank]),
)

/** 称号代号 → 认定层级(national 国家级 / municipal 市级)。 */
export const TITLE_LEVEL: Record<string, string> = Object.fromEntries(
  TITLE_SEED.map((t) => [t.code, t.level]),
)

/** 来源代号 → 中文名。 */
export const SOURCES: Record<string, string> = {
  jxj: '经信局',
  miit: '工信部',
}

/** 来源展示顺序。 */
export const SOURCE_ORDER: string[] = ['jxj', 'miit']

/** 事件类型 → 中文名。 */
export const EVENTS: Record<string, string> = {
  award: '认定',
  review: '复核',
  maintain: '维护',
  nurture: '入库培育',
}

/** 事件类型展示顺序。 */
export const EVENT_ORDER: string[] = ['award', 'review', 'maintain', 'nurture']

/** 质量标记 → 中文名。 */
export const QUALITY_FLAGS: Record<string, string> = {
  uscc_missing: '无统一社会信用代码',
  name_ambiguous: '重名待核',
  non_ningbo: '非宁波',
  deregistered: '已注销 / 吊销',
  attachment_unparsed: '附件未解析',
}

// ---------------------------------------------------------------------------
// 文件库(票 09)
// ---------------------------------------------------------------------------

/** 类别代号 → 中文名。与 SOURCES 同源同风格。 */
export const KINDS: Record<string, string> = {
  announcement: '公布文件',
  export: '导出表',
}

/** 类别展示顺序。 */
export const KIND_ORDER: string[] = ['announcement', 'export']

/**
 * 分类状态 → 中文名。说的是「分类是否已定」,不是「文件好坏」。
 * `set` 已定 / `inferred` 程序推的(待确认)/ `unset` 未定。
 */
export const CATEGORY_STATES: Record<string, string> = {
  set: '已分类',
  inferred: '推断分类',
  unset: '待分类',
}

/** 分类状态展示顺序。 */
export const CATEGORY_STATE_ORDER: string[] = ['set', 'inferred', 'unset']

/** 解析状态 → 中文名。说的是「有没有从文件产出过记录」。 */
export const PARSE_STATES: Record<string, string> = {
  unparsed: '未解析',
  parsed: '已解析',
  failed: '解析失败',
}

/** 解析状态展示顺序。 */
export const PARSE_STATE_ORDER: string[] = ['unparsed', 'parsed', 'failed']

// ---------------------------------------------------------------------------
// OCR 结果的通路(票 14 的三条通路)
// ---------------------------------------------------------------------------

/**
 * 通路代号 → 中文名。与 `server/utils/ocr-result.ts` 的 `OCR_CHANNELS` **同值** ——
 * 那一侧是写库时的枚举,这一侧只是把它念给人听。
 *
 * 说清通路是有用的:结果对不上时,「这条是机器识别的还是人贴进来的」是第一个要问的问题。
 */
export const OCR_CHANNELS: Record<string, string> = {
  api: '在线识别',
  upload: '人工上传',
  mcp: '代理写回',
}

/** 通路展示顺序(枚举顺序)。 */
export const OCR_CHANNEL_ORDER: string[] = ['api', 'upload', 'mcp']


// ---------------------------------------------------------------------------
// 名录生命周期契约(RL-01)—— 新枚举的 code → 中文 映射
//
// 与 `db/schema.ts` 里各列的 `enum` 取值**逐字对应**,契约原文见
// `docs/roster-lifecycle-contract.md`。页面/查询/导出一律从此处取文案。
// ---------------------------------------------------------------------------

/** 复核结论(`record_event.review_outcome`)→ 中文名。`null` 不在此列(不适用/未知)。 */
export const REVIEW_OUTCOMES: Record<string, string> = {
  passed: '复核通过',
  failed: '复核未通过',
}

/** 复核结论展示顺序。 */
export const REVIEW_OUTCOME_ORDER: string[] = ['passed', 'failed']

/** 别名来源类别(`enterprise_alias.source_kind`)→ 中文名。 */
export const ALIAS_SOURCE_KINDS: Record<string, string> = {
  platform_business: '平台业务接口',
  platform_apply: '平台申报接口',
  announcement: '公布文件',
  manual: '人工登记',
}

/** 别名来源类别展示顺序。 */
export const ALIAS_SOURCE_KIND_ORDER: string[] = [
  'platform_business',
  'platform_apply',
  'announcement',
  'manual',
]

/**
 * 核验状态(`enterprise_alias` / `platform_relation` / `difference_reason` 共用)→ 中文名。
 * `pending` 待核实是**不参与自动归并/搜索**的一侧 —— 证据不足宁可待核。
 */
export const VERIFICATION_STATUSES: Record<string, string> = {
  confirmed: '已确认',
  pending: '待核实',
}

/** 核验状态展示顺序。 */
export const VERIFICATION_STATUS_ORDER: string[] = ['confirmed', 'pending']

/**
 * 两个平台接口**取值**与联合类型(契约 §2.4)。**唯一出处** —— 适配层、写入侧、
 * 读接口、查询路由一律引用它,不要各自内联拼写 `'business_list' | 'apply_list'`
 * 或重列一遍数组:每多一处就多一个和 `db/schema.ts` 的 `platformQuery.interface`
 * 漂移的机会(该列枚举与本数组由 `tests/labels-enums.test.ts` 对齐钉死)。
 */
export const PLATFORM_INTERFACE_VALUES = ['business_list', 'apply_list'] as const
export type PlatformInterface = (typeof PLATFORM_INTERFACE_VALUES)[number]

/** 平台接口(`platform_query.interface`)→ 中文名。 */
export const PLATFORM_INTERFACES: Record<string, string> = {
  business_list: '称号查询记录',
  apply_list: '申报办理记录',
}

/** 平台接口展示顺序(即取值顺序)。 */
export const PLATFORM_INTERFACE_ORDER: string[] = [...PLATFORM_INTERFACE_VALUES]

/**
 * 平台查询状态(`platform_query.status`)→ 中文名。
 * **失败 ≠ 无记录** —— 四态必须彼此可区分,这正是这组文案存在的理由。
 */
export const PLATFORM_QUERY_STATUSES: Record<string, string> = {
  success: '查询成功',
  failed: '查询失败',
  no_record: '无记录',
  not_queried: '未查询',
}

/** 平台查询状态展示顺序(顺序即状态机顺序:未查 → 失败 → 无记录 → 成功)。 */
export const PLATFORM_QUERY_STATUS_ORDER: string[] = [
  'not_queried',
  'failed',
  'no_record',
  'success',
]

/** 关系匹配依据(`platform_relation.match_basis`)→ 中文名。 */
export const RELATION_MATCH_BASES: Record<string, string> = {
  uscc: '按统一社会信用代码',
  alias: '按曾用名',
  manual: '人工确认',
  none: '未匹配',
}

/** 关系匹配依据展示顺序。 */
export const RELATION_MATCH_BASE_ORDER: string[] = ['uscc', 'alias', 'manual', 'none']

/** 平台申报类型(`platform_relation.declare_kind`,接口字段 `sblx`)→ 中文名。 */
export const RELATION_DECLARE_KINDS: Record<string, string> = {
  apply: '申请',
  update: '更新',
  review: '复核',
}

/** 平台申报类型展示顺序。 */
export const RELATION_DECLARE_KIND_ORDER: string[] = ['apply', 'update', 'review']

/**
 * `businessList` 的 `rdjb`(认定级别)= 称号。腔调与 `TITLES` 同源(取 `TITLE_SEED` 的中文名)。
 * 实测:同一 USCC 下 `rdjb=3` 返回 6 条、`rdjb=1`/`rdjb=2` 各返回 0 条。
 */
export const PLATFORM_RDJBS: Record<string, string> = {
  '1': '创新型中小企业',
  '2': '专精特新中小企业',
  '3': '专精特新“小巨人”',
}

/** `rdjb` 展示顺序(等级由低到高,与接口取值一致)。 */
export const PLATFORM_RDJB_ORDER: string[] = ['1', '2', '3']

/**
 * 差异状态(`difference_reason.status`)→ 中文名。
 * 前五个里 `not_queried` / `query_failed` / `no_record` / `confirmed_no_diff` 必须彼此可区分;
 * `confirmed_reason` 承载已确认原因;`needs_review` 是证据不足的落点。
 */
export const DIFFERENCE_STATUSES: Record<string, string> = {
  not_queried: '未查询',
  query_failed: '查询失败',
  no_record: '无记录',
  confirmed_no_diff: '已确认无差异',
  confirmed_reason: '已确认原因',
  needs_review: '待核实',
}

/** 差异状态展示顺序(先未查/失败,再中间态,最后已确认)。 */
export const DIFFERENCE_STATUS_ORDER: string[] = [
  'not_queried',
  'query_failed',
  'no_record',
  'needs_review',
  'confirmed_no_diff',
  'confirmed_reason',
]

/**
 * 差异状态 → 徽章变体。**这是六态颜色的唯一出处** —— 页面与展开面板都从这里取,
 * 不许再各写一份本地级联。
 *
 * 为什么必须是唯一出处:契约 §3.2 要求「未查询 / 查询失败 / 无记录」等四态**彼此可区分**
 * (用户反馈过的「失败 ≠ 无记录、未查询 ≠ 无记录」就靠这条守住)。而颜色一旦在三个文件里
 * 各写一遍,就会出现两份把 `not_queried` 与 `no_record` 画成同一枚 outline、
 * 把 `needs_review` 与 `query_failed` 一律画红的实现 —— 四态当场糊成两态。
 *
 * ── 怎么挑的这六个 ──────────────────────────────────────────────────────
 * `Badge` 的基础类**本来就带 `font-medium`**(见 `components/ui/badge/index.ts`),
 * 所以「字重」不是可用的区分通道:`solid` 与 `outline` 的差别其实只剩**边框浓淡**一处,
 * 六态会退化成五态半。挑变体时按**实际渲染出来**的差别算,因此取:
 *
 * | 状态 | 变体 | 实际差别 | 读作 |
 * |---|---|---|---|
 * | `not_queried` 未查询 | `dashed` | 灰字 + **虚线**框 | 还什么都没做 |
 * | `query_failed` 查询失败 | `destructive` | **红实底** + 白字 | 出错,要重查 |
 * | `no_record` 无记录 | `outline` | **深字** + 实线框 | 查过了,平台确实没有 |
 * | `needs_review` 待核实 | `quiet` | **灰字** + 实线框 | 证据不足,等人裁决 |
 * | `confirmed_no_diff` 已确认无差异 | `secondary` | **浅灰实底** | 已确认,且无事 |
 * | `confirmed_reason` 已确认原因 | `default` | **主色实底** | 已确认,有结论 |
 *
 * 四个通道:有无底色(3 有 / 3 无)· 底色色相(红 / 灰 / 主色)· 字色(深 / 灰)·
 * 线型(虚线 / 实线)。逐对至少差一个,且没有一对只差边框浓淡。
 *
 * 为什么留 `dashed` 给「未查询」:它是唯一还没被占用的第六种观感(线型通道),
 * 语义上也贴 —— 「尚未发生」。代价是 `dashed` 在事件徽章那边表示「入库培育」;
 * 两处都在**同一列的上下文里**用,不会并排出现,但这条跨语义复用要在评审时知道。
 * 另一条路是给 `Badge` 新增一个警告色变体,那属于改共享组件的视觉语言,不在这张票里。
 *
 * `tests/difference-status-variants.test.ts` 把「六态**解析出来的 class** 两两不同」
 * 与「调用点不许压字重/字色」两条一起钉住。
 */
export const DIFFERENCE_STATUS_VARIANTS: Record<
  string,
  'dashed' | 'destructive' | 'outline' | 'quiet' | 'secondary' | 'default'
> = {
  not_queried: 'dashed',
  query_failed: 'destructive',
  no_record: 'outline',
  needs_review: 'quiet',
  confirmed_no_diff: 'secondary',
  confirmed_reason: 'default',
}

export const DIFFERENCE_COLUMN_HINT =
  '库内平台解释:状态取自解释记录(difference_reason)——未查询 / 查询失败 / 无记录 / 待核实 / 已确认无差异 / 已确认原因,并配对的后续措施。' +
  '「查询失败」与「无记录」不是一回事:前者是查询没执行成功,后者是查询成功但平台返回 0 条。'

/**
 * 差异状态 → 台账列表最左那条 6px 状态条的取向(RL-20)。
 *
 * ── 为什么是**三档**而不是六档 ──────────────────────────────────────────
 * 状态条只有 6px 宽,是一条**色带**而不是一枚徽章:它要在向下滚动时连成一条可读的带
 * (方向卡里的「记忆点」),所以它只回答**一个问题** —— **这条差异查清了没有**:
 *
 * | 取向 | 含义 | 取值 |
 * |---|---|---|
 * | `confirmed` | 有结论(已查明原因 / 已确认无差异) | `confirmed_reason` / `confirmed_no_diff` |
 * | `open` | 还没结论(未查询 / 待核实 / 无记录) | `not_queried` / `needs_review` / `no_record` |
 * | `failed` | **查询本身没成功**(要重查) | `query_failed` |
 *
 * 六态**彼此可区分**这件事仍然由中文标签承重(表里「差异状态」列写全、抽屉里那枚徽章
 * 走 `DIFFERENCE_STATUS_VARIANTS` 的六态)—— 与 `DIFFERENCE_STATUS_VARIANTS` 那段注释里
 * 「颜色是冗余加固,不是承重结构」是同一条判据。**一条 6px 色带扛不起六态**,
 * 硬塞进去只会变成一片认不出的花色 —— 那正是方向卡「换掉彩色胶囊」要躲开的东西。
 *
 * 没有画到的一档:**一条差异记录都没有的企业不画状态条**(方向卡:「无差异的行不画状态条」)。
 * 于是「空白 / 藏青 / 灰 / 红」四种观感各有确定含义,滚动时那条带就是差异分布本身。
 */
export const DIFFERENCE_STATUS_RAILS: Record<string, 'confirmed' | 'open' | 'failed'> = {
  not_queried: 'open',
  query_failed: 'failed',
  no_record: 'open',
  needs_review: 'open',
  confirmed_no_diff: 'confirmed',
  confirmed_reason: 'confirmed',
}

/** 「一条差异记录都没有」这一档的文案(筛选里的伪状态 `none`)。 */
export const DIFF_STATUS_NONE_LABEL = '无差异'

/**
 * 台账页(「企业列表」)的页面名 —— 页头、侧边栏入口、`document.title` 三处**只认这一个**。
 *
 * 用户明确点过名:「页面名与侧边栏入口都改叫**企业列表**」(旧名「名录台账」)。
 * 三处各写一遍字面量,迟早会出现「页头改了、侧栏忘了」这种只改一半的状态,
 * 而那种错在单看任一屏时都看不出来。
 */
export const ENTERPRISE_LIST_TITLE = '企业列表'

/**
 * 总表排序的选项文案(RL-20)。键与 `ROSTER_ENTERPRISE_SORTS` 同集合(有测试钉住)。
 * 「认定年」后面那半句方向写在 `title` 里,不占控件上的位置 —— 与设计稿上那个
 * 只写「认定年」的控件逐字一致。
 */
export const ENTERPRISE_SORT_LABELS: Record<string, string> = {
  recognition: '认定年',
  name: '企业名称',
  title: '称号等级',
}
export const ENTERPRISE_SORT_ORDER: string[] = ['recognition', 'name', 'title']
/** 排序选项的悬停说明(方向写在这里,不挤进控件)。 */
export const ENTERPRISE_SORT_HINTS: Record<string, string> = {
  recognition: '按该企业最早的首次认定年排,新认定的在前',
  name: '按企业名称排',
  title: '按称号等级排:专精特新“小巨人” → 专精特新中小企业 → 创新型中小企业',
}

/**
 * 比对页差异状态图例的固定说明句(RL-15)。徽章只列**当前结果里真出现过**的取值。
 *
 * ── 这句话改过两次(两次都是盲测报「文案与行为不符」)────────────────────────
 *
 * 原文:「徽章是库内解释记录里的差异状态;悬停、键盘聚焦或点按可展开原因、配对措施与
 * 接口证据。」它**印在图例那一排徽章下面**,读起来像在说这些图例徽章 —— 而图例徽章是
 * 纯展示的 `Badge`,悬停什么都不会发生(盲测按 `[data-state="open"]` 实测没有)。
 * 可展开的那一枚在**表里**:`ComparisonReconcile` 的徽章带 `role="button"` /
 * `tabindex="0"` / click + keydown 与 Tooltip(悬停 / 真实键盘 Tab / 点按三种都验过)。
 * 所以**不给图例徽章新加交互**(那是凭空造一个没人在等的控件),改文案指向真正的对象。
 *
 * 第二版又错了两处,一并订正:
 *
 *  1. **列名写错**。第二版写「表里『平台原因』那一列」,而该列的列头是 **「平台解释」**
 *     (`pages/comparison.vue`)。用户按字面**找不到那一列**。
 *     统一到**列头那个词**:列头是用户在屏幕上真正看到的东西,而领域语言同样是「解释」——
 *     契约把这一组读接口叫「差异与解释」,常量也一直是 `DIFFERENCE_COLUMN_HINT`(「库内平台解释」)、
 *     `RECONCILE_SOURCE`(「平台解释的取数来源」)。`difference_reason` 只是**表名**,
 *     不该出现在给用户看的句子里。同一次把 `DIFFERENCE_COLUMN_HINT` 里那句
 *     「库内平台原因」也改成「库内平台解释」(它是同一个列头的 `title`,同一处不一致)。
 *  2. **浮层里没有「接口证据」**。实测 `ComparisonReconcile` 的浮层只有
 *     原因 / 后续措施 / 迁入来源 / 核验(以及可选的旧解释缓存);证据在**隔壁**
 *     「平台证据」那一列。所以不再声称浮层里有证据,而是**指向隔壁那一列**。
 */
export const DIFFERENCE_LEGEND_TITLE = '状态图例'
export const DIFFERENCE_LEGEND_NOTE =
  '徽章只表示取值本身。表里「平台解释」那一列的状态徽章,悬停、键盘聚焦或点按可展开原因、后续措施、迁入来源与核验;接口证据在隔壁「平台证据」那一列。'

// ── 父代理合入裁决(2026-10-16)───────────────────────────────────────────
// RL-15 与 RL-17 各建了一份同名表,取值不同。**RL-15 那份有缺陷**:
// `not_queried` 与 `confirmed_no_diff` 都取 `quiet` ⇒ 两态不可区分,
// 而它自己引用的契约 §3.2 恰恰要求「未查询 / 查询失败 / 无记录 / 已确认无差异」彼此可区分。
// 故**取 RL-17 那组**(六态两两不同,且逐对至少差一个**可见通道**——按实际渲染算过)。
// RL-15 的 DIFFERENCE_COLUMN_HINT / DIFFERENCE_LEGEND_* 保留(RL-17 未定义)。
// RL-15 注释里「仓里另有两处本地级联待收敛」也**已由 RL-17 收敛完毕**:
// `pages/roster.vue` 退化为 302 重定向,`components/RosterEnterprisePanel.vue` 改为从本表取。

/**
 * 差异原因(`difference_reason.reason_code`)→ 中文名。
 * 已知五类必须覆盖:`moved_out` 外迁 / `deregistered` 注销 / `renamed` 更名 /
 * `platform_stale` 平台未更新 / `moved_in` 迁入;`other` 供**凭证据扩展**的新原因。
 */
export const DIFFERENCE_REASONS: Record<string, string> = {
  moved_out: '外迁',
  deregistered: '注销',
  renamed: '已更名',
  platform_stale: '平台未更新',
  moved_in: '迁入',
  other: '其他',
}

/** 差异原因展示顺序。 */
export const DIFFERENCE_REASON_ORDER: string[] = [
  'moved_out',
  'deregistered',
  'renamed',
  'platform_stale',
  'moved_in',
  'other',
]

/** 后续措施(`difference_reason.measure_code`)→ 中文名。与原因**成对**出现。 */
export const DIFFERENCE_MEASURES: Record<string, string> = {
  keep_history: '保留正式公布历史',
  mark_platform_snapshot: '标明平台时点,不覆盖历史',
  mark_moved_out: '记录迁出状态',
  mark_deregistered: '记录注销主体状态',
  update_current_name: '更新当前名并保留旧名为曾用名',
  record_moved_in: '记录迁入来源(城市/称号/年份/批次)',
  manual_review: '转人工核实',
  none: '无需措施',
}

/** 后续措施展示顺序。 */
export const DIFFERENCE_MEASURE_ORDER: string[] = [
  'keep_history',
  'mark_platform_snapshot',
  'mark_moved_out',
  'mark_deregistered',
  'update_current_name',
  'record_moved_in',
  'manual_review',
  'none',
]

/** 导出批次导入状态(`platform_export_batch.import_status`)→ 中文名。 */
export const EXPORT_IMPORT_STATUSES: Record<string, string> = {
  pending: '待导入',
  imported: '已导入',
  failed: '导入失败',
}

/** 导出批次导入状态展示顺序。 */
export const EXPORT_IMPORT_STATUS_ORDER: string[] = ['pending', 'imported', 'failed']

/** 统一导入批次状态(`import_batch.status`)→ 中文名。预检与提交是两个不同状态。 */
export const IMPORT_BATCH_STATUSES: Record<string, string> = {
  preflight: '预检',
  committed: '已提交',
  failed: '提交失败',
}

/** 统一导入批次状态展示顺序。 */
export const IMPORT_BATCH_STATUS_ORDER: string[] = ['preflight', 'committed', 'failed']

/** 导入来源类别(`import_batch.source_kind`)→ 中文名。 */
export const IMPORT_SOURCE_KINDS: Record<string, string> = {
  announcement: '公布文件',
  platform_export: '平台导出',
  alias_evidence: '别名证据',
}

/** 导入来源类别展示顺序。 */
export const IMPORT_SOURCE_KIND_ORDER: string[] = [
  'announcement',
  'platform_export',
  'alias_evidence',
]

/** 两侧名录比对方向,页面与导出共用。 */
export const COMPARISON_LABELS = {
  missing_in_miit: '应纳未纳',
  extra_in_miit: '应出未出',
} as const
export const COMPARISON_HINTS = {
  missing_in_miit: `在${SOURCES.jxj}、不在${SOURCES.miit}`,
  extra_in_miit: `在${SOURCES.miit}、不在${SOURCES.jxj}`,
} as const
export const COMPARISON_OTHER_SIDE = {
  missing_in_miit: `${SOURCES.miit}无匹配统代`,
  extra_in_miit: `${SOURCES.jxj}无匹配统代`,
} as const
export const COMPARISON_NO_USCC = '无统代,另一侧无可匹配身份'

/**
 * 平台解释(入库管线重整 票 16):拿工信部平台两个接口的记录解释「为什么这一行是差异」。
 * 文案与 `pipeline/src/reconcile.ts` 的 `REASON_LABELS` **同值** —— 取值一侧变了另一侧要跟着改。
 *
 * ⚠️ **这是旧 JSON 解释缓存(`data/platform-reconcile.json`)的词表,不是库内差异状态的词表。**
 * RL-15 起,比对页的主源是 `difference_reason`(见下面 `DIFFERENCE_STATUSES` /
 * `DIFFERENCE_REASONS` / `DIFFERENCE_MEASURES`);这套 `RECONCILE_*` 只剩两个用途:
 *  - `ComparisonReconcile.vue` 的「旧解释缓存」**对照**行(`RECONCILE_LABELS` / `RECONCILE_SOURCE`);
 *  - `lib/reconcile.ts` 那条**保持兼容**的旧路径,以及 `tests/reconcile.test.ts` 的钉桩。
 * 下面 `RECONCILE_VARIANTS` / `RECONCILE_ORDER` / `RECONCILE_LEGEND_*` 目前**只有测试引用** ——
 * 它们是旧图例的取值集,删除要连 `tests/reconcile.test.ts` 一起改,留待与旧缓存一并退役。
 */
export const RECONCILE_LABELS = {
  deregistered: '已注销',
  moved_out: '已外迁',
  non_local: '外地注册',
  withdrawn: '已撤回',
  on_platform: '平台有记录',
  no_platform_record: '平台亦无记录',
  unknown: '未查询',
} as const

export type ReconcileReason = keyof typeof RECONCILE_LABELS

/** 徽章色:注销 / 外迁最要紧用 destructive;外地 / 撤回用 outline(与城市徽章一致);其余轻描。 */
export const RECONCILE_VARIANTS: Record<
  ReconcileReason,
  'destructive' | 'outline' | 'secondary' | 'quiet'
> = {
  deregistered: 'destructive',
  moved_out: 'destructive',
  non_local: 'outline',
  withdrawn: 'outline',
  on_platform: 'secondary',
  no_platform_record: 'quiet',
  unknown: 'quiet',
}

/**
 * 差异方向 → 一句话说明,用在需要写全的地方(徽章、展开面板、下拉选项)。
 *
 * 与 `COMPARISON_LABELS` 的分工:`COMPARISON_LABELS` 是**短标签**(应纳未纳 / 应出未出),
 * 适合列头与 chip;这里是**能独立读懂的自述**(公布有而平台无 / 平台有而公布无),
 * 适合用户第一次遇到这个词的地方。两处都写死在各自的模板里过,合并时才发现
 * 「同一个方向的三种说法」散在三个文件 —— 收在这里一份。
 */
export const COMPARISON_DIRECTION_NOTES: Record<string, string> = {
  missing_in_miit: '公布有而平台无',
  extra_in_miit: '平台有而公布无',
}

/** 方向代号 → 标签(`COMPARISON_LABELS` 是 `as const`,动态字符串取不到,这里放宽一次)。 */
export function comparisonDirectionLabel(code: string): string {
  return (COMPARISON_LABELS as Record<string, string>)[code] ?? code
}

/** 方向代号 → 一句话说明;不认识的取值原样返回,不吞。 */
export function comparisonDirectionNote(code: string): string {
  return COMPARISON_DIRECTION_NOTES[code] ?? code
}

/** 平台解释的取数来源(页面脚注、行内 tooltip 共用;**同一处定义**,避免两处写法漂移)。 */
export const RECONCILE_SOURCE = '工信部优质中小企业梯度培育平台'

/**
 * 比对的总口径 —— **以公布文件为准**。这句在两方向都成立,单独成一个常量,
 * 页面只显示**一次**并且加粗,不塞进各方向的半句里。
 */
export const RECONCILE_BASIS = '以公布文件为准,对照导出文件。'

/**
 * 按方向只给**相关的那半句**原因(用户口径:不在公布文件的可能是外地企业,
 * 不在导出文件的可能注销 / 外迁)。**两个方向不共处一行** —— 同时摊开两套原因
 * 会让人分不清当前方向该看哪句。
 */
export const RECONCILE_REASONS = {
  missing_in_miit: '不在导出文件的多为注销 / 外迁。',
  extra_in_miit: '不在公布文件的多为外地注册。',
} as const

/** 「平台解释」列的说明(表头 title / 脚注共用):总口径 + 当前方向那半句。 */
export function reconcileHint(direction: keyof typeof RECONCILE_REASONS): string {
  return `${RECONCILE_BASIS}${RECONCILE_REASONS[direction]}`
}

/**
 * 图例里徽章的排列顺序:先「会被排除/要紧」的,再中性,最后「没查到」。
 * 与 `RECONCILE_LABELS` 的键同集合(改一处要改两处,有测试钉住)。
 */
export const RECONCILE_ORDER = [
  'deregistered',
  'moved_out',
  'non_local',
  'withdrawn',
  'on_platform',
  'no_platform_record',
  'unknown',
] as const satisfies readonly ReconcileReason[]

/**
 * 图例的固定说明句:一行讲清「这些徽章是什么」+「怎么展开」。
 * 徽章本身只列**当前结果里真出现过的**取值,所以图例不会长成一张词表。
 *
 * ── ⚠️ 这组 `RECONCILE_LEGEND_*` 目前**没有任何地方引用**(2026-10-16 RL-17 实测)
 * 上面那条注释说「只有测试引用」,对 `RECONCILE_VARIANTS` / `RECONCILE_ORDER` 成立
 * (`tests/reconcile.test.ts` 在用),但这三个 `RECONCILE_LEGEND_*` 常量**连测试都没有引用** ——
 * 全仓 grep 只剩它们自己的定义。它们与旧 JSON 解释缓存图例一起退役,退役时要连这条注释一起清。
 * 下面按「文案与屏幕一致」把浮层那句话改对了,但要知道:**它现在不渲染在任何一个页面上**。
 *
 * ── 这句话 2026-10-16 改过(父代理裁决「一起收」)────────────────────────────
 * 原文「徽章是平台侧的结论;悬停、键盘聚焦或点按可展开该企业的登记位置、关联记录与取数时间。」
 * 有三处与 `components/ComparisonPlatformEvidence.vue` 的实际行为不符:
 *
 *  1. **「悬停」不成立**:该组件没有任何 `Tooltip` / `Popover`,悬停什么都不会发生。
 *  2. **「可展开…登记位置…取数时间」不成立**:这两样是**直接印在单元格里**的
 *     (查询摘要那行就是「接口 · 认定级别 · 查询状态 · 取数时间 · 关系 N 条」),不在任何展开区后面。
 *  3. **「登记位置」不是屏幕上的词**:这个单元格里没有这四个字。
 *
 * 真的交互只有一处:`<button>` 「展开原始关系(N 条)」→ 展开逐条关系原文(原生 button,
 * 点按与键盘都可用)。所以文案只保留这一处,并把「直接显示」说成直接显示。
 * 引用的名称一律用屏幕上的原字:「平台证据」(列头)、「展开原始关系」(按钮)。
 */
export const RECONCILE_LEGEND_TITLE = '图例'
export const RECONCILE_LEGEND_NOTE =
  '徽章是平台侧的结论。「平台证据」列直接给出曾用名,以及每次平台查询的接口、状态、取数时间和关系条数;逐条关系原文要点「展开原始关系」按钮(点按或键盘都可以)。'
/** 图例最多显示几个徽章(超出的用「…」收尾,避免图例比表格还高)。 */
export const RECONCILE_LEGEND_MAX = 5
