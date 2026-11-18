/**
 * 「把已确认的**重名候选**执行成 `payload.merges`」的契约类型（RL-14）。
 *
 * ── 这一层解决什么 ──────────────────────────────────────────────────────
 * 导入侧现在会把「新建企业时库里已有同名行」**显式报出来**（`DuplicateNameCandidate`），
 * 但那只是候选 —— 候选**不是**结论。本模块描述的是从「候选」到「可执行的归并」这一段：
 * 先用**平台关系证据**把候选判成「可并 / 待核」，再把可并的那几条编成一份
 * 契约 §8.3 的 `payload.merges` 请求（经 `POST /api/roster/import/commit` 落库）。
 *
 * ── 判据（唯一的、可复核的）────────────────────────────────────────────
 * 拿候选的**新统代**去查**已落库**的平台关系：若存在一条关系的 `qymc`（`name_raw`）
 * **逐字等于**被并方名称，那就是平台自己记录了「这个统代就叫这个名字」 —— 独立原始证据成立
 * ⇒ 可并。查不到、或 `qymc` 与名称不符 ⇒ **不并**，列待核。
 *
 * **绝不按名归并**：没有任何相似度、没有任何推断；证据不成立就停在「待核」。
 * 证据的来源是**已经落库**的平台关系（写入一律走统一 API），本模块不另造查询路径、
 * 也不自己访问平台接口。
 */
import type { PlatformInterface } from '../labels'
import type {
  DuplicateNameCandidate,
  RosterImportMerge,
  RosterImportRequest,
} from '../roster-import-client'
import type { NameMatchLevel } from './uscc-research'

/** 支撑一次重名归并的**平台关系证据**。 */
export interface DuplicateMergeEvidence {
  /** `platform_relation.id` —— 落成 `merges[].sourceRefId`（曾用名的来源行）。 */
  relationId: number
  /** `platform_query.id` —— 落进血缘 `lineage.evidenceQueryId`。 */
  queryId: number
  interface: PlatformInterface
  /** 查询键；**必须是统一社会信用代码**（按名查的查询不构成「这个统代叫这个名字」的证据）。 */
  queryKey: string
  rdjb: string
  queriedAt: string
  /** 关系序号（同一次查询内第几条，从 1 起）。 */
  sequenceNo: number
  relationKey: string | null
  /** 关系的 `qymc` 原值 —— 与被并方名称**逐字相等**，这就是判据本身。 */
  nameRaw: string
  /** 关系的 `tyshxydm`（可为空）。 */
  usccRaw: string | null
  /** 曾用名的来源类别（接口 → 字典取值）。 */
  sourceKind: 'platform_business' | 'platform_apply'
  /**
   * 命中这条证据时名称比对到了哪一档（RL-06 增量）：`byte` 逐字相等 /
   * `typographic` 只差全半角括号与空白 / `district_suffix` 只差区县后缀的有无。
   * 用来在报告里如实区分「哪些回填依赖放宽判据」——缺省（RL-14 那条路）恒为逐字。
   */
  nameMatch?: NameMatchLevel
}

/** 证据不足的**可判别**原因（每一个都对应一句可读的理由，绝不合并成一个「失败」）。 */
export type DuplicateMergePendingReason =
  /** 候选的新建行没有统代 ⇒ 没有可回填的规范行。 */
  | 'no_target_uscc'
  /** 该统代**一次都没查过** ⇒ 无证据（不是「查了没有」）。 */
  | 'no_platform_query'
  /** 查过，但没有任何关系的 `qymc` 逐字等于被并方名称 ⇒ 证据不成立。 */
  | 'name_not_evidenced'
  /** 被并方企业行已不在库里（多半已被前一次归并处理）。 */
  | 'source_gone'
  /** 被并方**自带统代** ⇒ 与规范行是两个**已识别**的不同主体（同名多主体）⇒ 不并。 */
  | 'source_has_uscc'
  /** 规范行（该统代的企业行）不在库里。 */
  | 'target_gone'
  /** 同一既有行被**多条**候选认领（同名多主体）⇒ 逐条待核，不猜。 */
  | 'source_claimed'
  /** 被并方与规范行是同一行。 */
  | 'same_enterprise'

/** 有证据、可直接执行的一条归并。 */
export interface DuplicateMergeReady {
  candidate: DuplicateNameCandidate
  evidence: DuplicateMergeEvidence
  /**
   * **导出表侧**给这家企业记的名字（§5.3 ①，取最新快照；没有就是 `null`）。
   *
   * 与规范行现名不同时，`merge.canonicalName` 会带上它 ⇒ 归并把规范行改成这个名字、
   * 被顶掉的原名落成别名；为 `null` 或与现名相同时 `canonicalName` 不给 ⇒ **不改名**。
   */
  exportName: string | null
  /** 编好的 `payload.merges` 项（两侧同名的候选**不带** `aliasName`，见契约 §5.3）。 */
  merge: RosterImportMerge
}

/**
 * 候选**既有侧**的稳定键（`enterprise:<id>`，没有 id 时退回 `uscc:<统代>`）。
 *
 * 「既有行的身份」在两个地方要被拼出来 —— 候选的逐项引用（`duplicate_candidate:…`）
 * 与归并计划的去重键（`…-><新统代>`）。两处**只写这一份**，免得哪天改了写法只改一处。
 */
export function duplicateTwinKey(
  candidate: Pick<DuplicateNameCandidate, 'existingEnterpriseId' | 'existingUscc' | 'nameNorm'>,
): string {
  return candidate.existingEnterpriseId != null
    ? `enterprise:${candidate.existingEnterpriseId}`
    : `uscc:${candidate.existingUscc ?? candidate.nameNorm}`
}

/** 证据不足 ⇒ **不并**，留待核。 */
export interface DuplicateMergePending {
  candidate: DuplicateNameCandidate
  reason: DuplicateMergePendingReason
  message: string
}

/**
 * 一次「执行已确认重名候选」的**计划 / 报告**。
 *
 * 同一份对象既是**只读报告**（计数 + 明细 + 待核理由），又是**可直接提交的请求体**
 * （`request`）—— 预检与提交不对漂，与 `planRosterImport` 同一个做法。
 */
export interface DuplicateMergeReport {
  /** 产出这些候选的导入批次幂等键（本报告的证据溯源点）。 */
  batchKey: string
  /** 该批次的行 id；批次不存在为 `null`。 */
  batchId: number | null
  /** 计数（与下面的明细同源，供报告直接读）。 */
  counts: {
    /** 从批次读回的候选数（去重后）。 */
    candidates: number
    /** 有证据、可执行。 */
    ready: number
    /** 证据不足、留待核。 */
    pending: number
  }
  /** 从 `import_batch.item_results` 读回的重名候选（去重后）。 */
  candidates: DuplicateNameCandidate[]
  ready: DuplicateMergeReady[]
  pending: DuplicateMergePending[]
  /**
   * 本批候选**已经执行过**的那次归并批次（来源身份 / 幂等键都指向它）；没执行过为 `null`。
   *
   * 为什么需要它：归并会把被并企业行删掉，于是**再次**读这份报告时那些候选会因为
   * 「企业行已不在库里」变成待核 `source_gone`。那不是说候选有问题，而是说**这件事做过了**
   * —— 把这个事实单独报出来，`source_gone` 才不会被误读成「证据不够」。
   */
  previous: { batchId: number; idempotencyKey: string } | null
  /**
   * 可直接 **POST `/api/roster/import/commit`** 的请求体。
   * 没有可并项时是 `null`（**不发空批**：空 `merges` 只会白记一条批次）。
   */
  request: RosterImportRequest | null
}
