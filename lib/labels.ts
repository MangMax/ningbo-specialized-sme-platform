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
