/**
 * **年度名录增量**的载荷包与预览形状(RL-07)。
 *
 * ── 这一层是什么,不是什么 ─────────────────────────────────────────────
 * 写入面(**唯一一份**)是 RL-11 的统一导入 API:`POST /api/roster/import/preflight`
 * 与 `/commit`(契约 §8),预检/幂等/整批事务/逐项错误/批内自然键引用**都已经在那边**。
 * 本文件**不重写它**,只补上年度更新这一层缺的语义:
 *
 *  1. **一次年度更新 = 一批来源文件**,而不是一份载荷 —— 最新公布文件一份,
 *     三张平台导出表各一份(契约 §8.3 的 `payload.exportSnapshot` 一次只装一张表)。
 *     所以「包」是 `entries[]`,每一项都还是一条 §8.1 形状的请求(各自带幂等键)。
 *  2. **预览**:先把「这批东西落库之后会发生什么」逐项算出来再给人看 ——
 *     逐项分类(新增 / 更新 / 归并 / 无变化 / 冲突 / 重名候选)+ 逐项错误 + **总表增减**。
 *     应用仍然走既有的 `/commit`(逐项提交,同一批幂等键),`/replay` 仍只管出处指针收敛。
 *
 * ── 「移出当前总表」为什么是**投影**而不是一张待写清单 ─────────────────────
 * `rosterState`(`current` / `removed_platform_only`)是**派生**的、不落列(契约 §5)。
 * 所以「谁会离开当前总表」的答案 = 「同一份派生口径作用在**叠加了新快照的库**上」。
 * 派生只有一份实现(`deriveRosterState`),预览只做叠加 —— 见
 * `lib/roster/enterprise-roster.ts` 的 `projectRosterStates`。
 *
 * 本文件只放**跨进程共用**的形状与纯函数(服务端 `server/utils/roster-annual.ts` 用它们
 * 组织响应,页面用它们显示)。**不含任何库访问**。
 */
import type { RosterImportRequest } from '../roster-import-client'

/**
 * 一次年度更新的载荷包。
 *
 * `year` 只用于展示与默认幂等键的构造,**不参与任何判据** —— 年度由每一份载荷自己的
 * `exportSnapshot.year`(快照年度)与事件自己的 `year`(事件所涉年份)承载,这里再推一次
 * 就等于给同一件事造了第二个来源。
 */
export interface AnnualIncrementBundle {
  year?: number | null
  /** 本批要应用的来源文件,每项一条 §8.1 形状的请求(幂等键在项内)。 */
  entries: RosterImportRequest[]
}

/** 计划项的**逐项分类**(票面点名的四类 + 两类需要单独看的)。 */
export const ANNUAL_ITEM_CLASSES = [
  /** 新增:库里没有这个坐标,本批会写出来。 */
  'add',
  /** 更新:复用既有行、但确实改了东西(新事件 / 出处指针收敛)。 */
  'update',
  /** 归并:并掉一行企业身份(唯一会**删行**的动作)。 */
  'merge',
  /** 无变化:命中既有行且什么都不会改(重复导入)。 */
  'unchanged',
  /** 冲突:这一项不合法 ⇒ 整批 `failed`、业务数据一行不落。 */
  'conflict',
  /** 只记录:重名候选(不当结论、不进任何影响计数)。 */
  'candidate',
] as const
export type AnnualItemClass = (typeof ANNUAL_ITEM_CLASSES)[number]

/** 影响计数(口径逐字沿用契约 §8.5 的预检计数,不另立一套)。 */
export interface AnnualPreviewCounts {
  /** 计划项口径的新增数(§8.5 `preflight.add`)。 */
  add: number
  /** 计划项口径的复用/更新数(§8.5 `preflight.update`)。 */
  update: number
  /** 归并项数(§8.5 `preflight.remove` = 会被删掉的企业行数)。 */
  merge: number
  /** 命中既有行且什么都不改的计划项数。 */
  unchanged: number
  /** 落在待核状态的行数(§8.5 `preflight.review`:无统代 / 查询失败 / `needs_review`)。 */
  review: number
  /** 逐项冲突数(§8.5 `preflight.conflicts.length`)。 */
  conflicts: number
  /** 重名候选数(只报告,不计入影响)。 */
  candidates: number
  /** **行**口径:本次会改掉的 `record_evidence.source_file` 行数(§8.9.1)。 */
  evidenceRepoints: number
}

/** 一条计划项的预览(逐项明细;`ref` / `error` 与提交时的逐项结果同源同形)。 */
export interface AnnualPreviewItem {
  /** 属于包里的第几项来源文件(0 起)。 */
  entryIndex: number
  class: AnnualItemClass
  kind: string
  ref: string
  /** 该项在计划阶段是否可通过(冲突项的 `false` 就是整批失败的原因)。 */
  ok: boolean
  /** 落在待核状态。 */
  review: boolean
  /** 冲突项的错误(形状与 §8.2 的逐项错误一致)。 */
  error: { code: string; field?: string; message: string } | null
  /** 称号(能取到时)。 */
  titleCode: string | null
  /** 企业名(能取到时;归并项给被并方名称)。 */
  enterpriseName: string | null
}

/** 一项来源文件的预览。 */
export interface AnnualPreviewEntry {
  index: number
  idempotencyKey: string
  sourceKind: string
  sourceIdentity: string
  /** 该幂等键此刻在库里的批次状态;`none` = 库里还没有这一批。 */
  batchStatus: 'none' | 'preflight' | 'committed' | 'failed'
  counts: AnnualPreviewCounts
  items: AnnualPreviewItem[]
  /**
   * 同键 `commit` 会不会**真的跑一遍**(因而可能写行)。
   * 已 `committed` 的键**一行不写**(§8.2 的幂等),预检不得对那种批次报一份做不到的计划
   * (§8.9.2,RL-19 的事故现场);有冲突时也不会写(整批 `failed`);计划项为空时也没什么可写。
   * 其余情况为 `true` —— 注意「命中既有记录坐标」(`classifyPlannedItem` 的 `unchanged`)
   * **不等于**「一行都不会写」:载荷里若有库里还没有的事件,提交会把它们**追加**进去。
   */
  willApply: boolean
}

/** 总表增减里的一行(企业粒度)。 */
export interface AnnualRosterRow {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  /**
   * 它**上次出现在「最新快照」里**是哪一张(定位「只由平台引入」的正证据)。
   * 给不出时为 `null` —— 它一张快照都没出现过,或出现过的几张都不是当时的最新一张。
   */
  snapshot: { batchId: number; titleCode: string; year: number } | null
}

/**
 * 「企业会因新快照失去锚点」的三种去向。**前两栏说的是「这张快照落库之后会怎样」,
 * 第三栏说的是「谁会被移出、但原因这一层必须留待重查」**。
 *
 * ⚠️ **`blocked` 不是「不会被移出」**(契约 §8.11.1 有完整说明):当前总表的成员资格是
 * **派生**的(§5,判据只有「公布记录」与「最新快照」两样),接口重查的结果**不在**这个派生里。
 * 所以新快照一旦提交,`blocked` 里的企业**照样**会落到 `removed_platform_only`。
 * 被挡住的是**原因 / 措施**那一层:不把「没查成」写成「平台没有」,也不写成
 * 「已迁出 / 已注销」,留待重查 —— 这一层由写入侧的守卫挡(契约 §8.11.2),是票面第 3 条
 * 要求的东西。要把**移出本身**也挡住,就得改 §5 的派生判据,那是 RL-04 的冻结面,
 * 见 PR 里「需要裁决的点」。
 */
export interface AnnualRosterDelta {
  /** **将移出当前总表**:只由平台导出引入、没有任何公布历史、且新快照里也不在。 */
  removed: AnnualRosterRow[]
  /**
   * **原因必须留待重查**:这次对它的重查**失败了**(`failed` ≠ `no_record`,契约 §3.1)。
   * 它同样会被新快照移出(见上),但**不得**据此写原因 / 措施 / 「无记录」这类结论。
   */
  blocked: AnnualRosterRow[]
  /** **不因平台缺失而删除**:曾出现在正式公布文件(有 jxj 记录)⇒ 只更新平台状态。 */
  keptByAnnouncement: AnnualRosterRow[]
  counts: { removed: number; blocked: number; keptByAnnouncement: number }
}

/** 年度增量预览的完整响应。 */
export interface AnnualPreviewResponse {
  entries: AnnualPreviewEntry[]
  totals: AnnualPreviewCounts
  roster: AnnualRosterDelta
  /** 整包是否可应用:条目齐全、无冲突、且至少有一项真的会写东西(否则应用是空操作)。 */
  applyable: boolean
  /** 一句话说清不可应用的原因(可应用时为 `null`)。 */
  blockedReason: string | null
}

// ---------------------------------------------------------------------------
// 纯函数(页面与服务端共用,便于单测)
// ---------------------------------------------------------------------------

/**
 * 全零的计数 —— **只此一份**:加字段时改这里,`sumCounts` 与调用方(服务端的预检零报)
 * 都跟着走,不会各自维护一份字面量。
 */
export function zeroCounts(): AnnualPreviewCounts {
  return { add: 0, update: 0, merge: 0, unchanged: 0, review: 0, conflicts: 0, candidates: 0, evidenceRepoints: 0 }
}

/** 累加若干项的计数(不改变各项)。 */
export function sumCounts(list: AnnualPreviewCounts[]): AnnualPreviewCounts {
  const total = zeroCounts()
  for (const counts of list) {
    for (const key of Object.keys(total) as Array<keyof AnnualPreviewCounts>) total[key] += counts[key]
  }
  return total
}

/**
 * 计划项的口径映射:预检的 `action`(见 `roster-import.ts` 的 `PlannedItem.action`) +
 * `kind` + `ok` → 逐项分类。**只在这里做一次。**
 *
 * `action` 收窄成字面量联合(而不是 `string`):本函数唯一的职责就是**如实**告诉操作者
 * 「这一项会怎样」,一个悄悄的 `else` 会把将来新增的动作**静默显示成「无变化」**。
 * `note` 是「只记录、不计入任何影响计数」的那一档(目前只有重名候选用它)。
 */
export function classifyPlannedItem(input: {
  action: 'add' | 'update' | 'skip' | 'note'
  kind: string
  ok: boolean
}): AnnualItemClass {
  if (!input.ok) return 'conflict'
  if (input.kind === 'merge') return 'merge'
  if (input.action === 'add') return 'add'
  if (input.action === 'update') return 'update'
  if (input.action === 'note') return 'candidate'
  return 'unchanged'
}

/**
 * 解析载荷里的**查询键** → 它指的是哪家企业(用于「接口失败 ⇒ 不得据此删除」的匹配)。
 *
 * 契约 §8.1 的 `queryKey` 只有两种写法:统一社会信用代码,或 `name:<nameNorm>`。
 * 判据是**逐字**的(归一后相等),不是相似度 —— 本仓不做模糊匹配。
 */
export function queryKeyMatchesEnterprise(
  queryKey: string,
  enterprise: { usccNorm: string | null; nameNorm: string },
): boolean {
  const key = queryKey.trim()
  if (key.startsWith('name:')) return key.slice('name:'.length).trim() === enterprise.nameNorm
  const uscc = key.toUpperCase()
  return !!enterprise.usccNorm && uscc === enterprise.usccNorm.trim().toUpperCase()
}
