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
 */
export const RECONCILE_LEGEND_TITLE = '图例'
export const RECONCILE_LEGEND_NOTE =
  '徽章是平台侧的结论;悬停、键盘聚焦或点按可展开该企业的登记位置、关联记录与取数时间。'
/** 图例最多显示几个徽章(超出的用「…」收尾,避免图例比表格还高)。 */
export const RECONCILE_LEGEND_MAX = 5
