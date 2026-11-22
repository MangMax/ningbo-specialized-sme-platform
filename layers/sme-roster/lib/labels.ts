/**
 * code → 中文 映射的**唯一来源**。
 * 页面、导出、查询层一律从此处取标签,避免各写一份导致文案漂移
 * (例如称号「小巨人」曾在小巨人/专精特新“小巨人”之间不一致)。
 *
 * 称号文案复用 `db/titles.ts` 的 `TITLE_SEED.nameZh`,字典与展示同源。
 */
import { TITLE_SEED } from '../../../db/titles'

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
// ---------------------------------------------------------------------------
// 文件库(票 09)
// ---------------------------------------------------------------------------

/** 类别代号 → 中文名。与 SOURCES 同源同风格。 */
export const KINDS: Record<string, string> = {
  announcement: '公布名单',
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
// 名录生命周期契约(RL-01)—— 新枚举的 code → 中文 映射
//
// 与数据库约束定义的取值一致，契约原文见
// `layers/sme-roster/lib/roster-import-client.ts`。页面/查询/导出一律从此处取文案。
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
  announcement: '公布名单',
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
 * 核验状态展示标签(`enterprise_alias` / `platform_relation` / `difference_reason` 共用)。
 * `withdrawn` 仅用于别名；各业务允许的取值以对应 schema 列枚举为准。
 * `pending` 待核实是**不参与自动归并/搜索**的一侧 —— 证据不足宁可待核。
 */
export const VERIFICATION_STATUSES: Record<string, string> = {
  confirmed: '已确认',
  pending: '待核实',
  withdrawn: '已撤回',
}

/** 核验状态展示顺序。 */
export const VERIFICATION_STATUS_ORDER: string[] = ['confirmed', 'pending', 'withdrawn']

/** 生命周期读模型中的待核原因。 */
export const LIFECYCLE_FLAGS: Record<string, string> = {
  decided_year_missing: '至少一条认定/复核事件缺少结论年份，生命周期计算按规则回退到事件所涉年份',
  review_outcome_unknown: '有复核事件但没记结论',
  no_batch: '认定/复核事件缺批次序号',
  no_evidence: '认定/复核事件没有出处记录',
  no_anchor_year: '没有任何可算的年份',
}

/** 生命周期标记顺序。 */
export const LIFECYCLE_FLAG_ORDER: string[] = [
  'no_anchor_year',
  'decided_year_missing',
  'review_outcome_unknown',
  'no_batch',
  'no_evidence',
]

/**
 * 平台接口取值与联合类型。适配层、写入侧、读接口和查询路由使用同一组值。
 */
export const PLATFORM_INTERFACE_VALUES = ['business_list', 'apply_list', 'recognized_list'] as const
export type PlatformInterface = (typeof PLATFORM_INTERFACE_VALUES)[number]

/** 平台接口(`platform_query.interface`)→ 中文名。 */
export const PLATFORM_INTERFACES: Record<string, string> = {
  business_list: '称号查询记录',
  apply_list: '申报办理记录',
  recognized_list: '已认定企业列表',
}

/** 平台接口展示顺序(即取值顺序)。 */
export const PLATFORM_INTERFACE_ORDER: string[] = [...PLATFORM_INTERFACE_VALUES]

/**
 * 平台查询状态(`platform_query.status`)→ 中文名。
 * **失败 ≠ 无记录** —— 四态必须彼此可区分,这正是这组文案存在的理由。
 */
export const PLATFORM_QUERY_STATUSES: Record<string, string> = {
  partial: '部分结果',
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

/** 差异状态 → 企业列表状态条的三档取向。六态仍由表格标签与详情徽章区分。 */
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

/** 台账页名称在页头、侧边栏入口与 document.title 三处共用。 */
export const ENTERPRISE_LIST_TITLE = '历年优质中小企业'
export const CURRENT_ENTERPRISES_TITLE = '优质中小企业'

/** 企业列表排序选项(RL-20)。 */
export const ENTERPRISE_SORT_LABELS: Record<string, string> = {
  recognition: '认定年',
  name: '企业名称',
  title: '称号等级',
}
export const ENTERPRISE_SORT_ORDER: string[] = ['recognition', 'name', 'title']
export const ENTERPRISE_SORT_HINTS: Record<string, string> = {
  recognition: '按该企业最早的首次认定年排,新认定的在前',
  name: '按企业名称排',
  title: '按称号等级排:专精特新“小巨人” → 专精特新中小企业 → 创新型中小企业',
}

/**
 * 差异原因(`difference_reason.reason_code`)→ 中文名。
 * 已知原因覆盖:`moved_out` 外迁 / `deregistered` 注销 / `renamed` 更名 /
 * `platform_stale` 平台未更新 / `pending_review` 待审核 / `moved_in` 迁入;`other` 供**凭证据扩展**的新原因。
 */
export const DIFFERENCE_REASONS: Record<string, string> = {
  moved_out: '外迁',
  deregistered: '注销',
  renamed: '已更名',
  platform_stale: '平台未更新',
  pending_review: '待审核',
  moved_in: '迁入',
  other: '其他',
}

/** 差异原因展示顺序。 */
export const DIFFERENCE_REASON_ORDER: string[] = [
  'moved_out',
  'deregistered',
  'renamed',
  'platform_stale',
  'pending_review',
  'moved_in',
  'other',
]

/** 后续措施(`difference_reason.measure_code`)→ 中文名。与原因**成对**出现。 */
export const DIFFERENCE_MEASURES: Record<string, string> = {
  keep_history: '保留正式公布历史',
  mark_platform_snapshot: '标明平台时点,不覆盖历史',
  follow_review: '保留正式公布历史并跟进审核',
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
  'follow_review',
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
  announcement: '公布名单',
  platform_export: '平台导出',
  alias_evidence: '别名证据',
  correspondence_decision: '记录对应确认',
  comparison_scope_proof: '对比范围依据',
  event_correction: '正式事件更正',
  platform_archive: '平台采集归档',
}

/** 导入来源类别展示顺序。 */
export const IMPORT_SOURCE_KIND_ORDER: string[] = [
  'announcement',
  'platform_export',
  'alias_evidence',
  'correspondence_decision',
  'comparison_scope_proof',
  'event_correction',
  'platform_archive',
]

/** 两侧名录比对方向,页面与导出共用。 */
export const COMPARISON_LABELS = {
  missing_in_miit: '应纳未纳',
  extra_in_miit: '应出未出',
} as const

/** 旧 JSON 解释缓存的原因词表；保留历史读取与 pipeline 兼容。 */
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

/**
 * 首次认定的两态(RL-08,契约 §7.5 增量)。
 *
 * 取值本身定义在 `layers/sme-roster/lib/roster/first-recognition.ts`(判定与取值同处),这里只放**中文标签与
 * 展示顺序** —— 与全仓别的枚举同一分法(`*_ORDER` + 标签表),页面不再各写一份。
 */
export const FIRST_RECOGNITION_STATUSES: Record<string, string> = {
  confirmed: '已确立',
  pending: '待确认',
}
export const FIRST_RECOGNITION_STATUS_ORDER: string[] = ['confirmed', 'pending']

/**
 * 首次认定「待确认」的原因 —— 三条**互不等价**,像差异六态一样必须彼此可区分:
 * 是「一条都定不了年」还是「另有现存 award 缺有效年份」还是「没有出处」,处理方式不同。
 */
export const FIRST_RECOGNITION_REASONS: Record<string, string> = {
  no_dated_award: '认定事件定不了年',
  undated_award: '现存认定缺有效年份',
  no_evidence: '首次认定没有存下来的出处',
}
/** 展示顺序 = 判定里的优先级(`no_dated_award` > `undated_award` > `no_evidence`)。 */
export const FIRST_RECOGNITION_REASON_ORDER: string[] = [
  'no_dated_award',
  'undated_award',
  'no_evidence',
]

/**
 * 首次认定一栏的表头提示(台账表的列头 `title`,**这是它唯一的用处**)。
 *
 * 写成纯文本:它出现在 `title` 属性里,漂进去的 Markdown 星号会**原样**显示给用户。
 */
export const FIRST_RECOGNITION_HINT =
  '首次认定按「企业 × 称号」算:该企业在该称号上最早的那次认定。' +
  '复核通过不是新的首次认定;复核未通过后再次获批也不重置。' +
  '标「待确认」的原因有三种且互不相同:认定事件定不了年 / 现存认定缺有效年份 / 首次认定没有存下来的出处。'

/** 方向代号 → 标签(`COMPARISON_LABELS` 是 `as const`,动态字符串取不到,这里放宽一次)。 */
export function comparisonDirectionLabel(code: string): string {
  return (COMPARISON_LABELS as Record<string, string>)[code] ?? code
}

/** 方向代号 → 一句话说明;不认识的取值原样返回,不吞。 */
export function comparisonDirectionNote(code: string): string {
  return COMPARISON_DIRECTION_NOTES[code] ?? code
}
