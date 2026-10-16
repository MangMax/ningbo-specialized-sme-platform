/**
 * **差异原因与后置动作的判定引擎**(RL-03 收尾切片)。
 *
 * ── 这一层为什么是纯函数 ──────────────────────────────────────────────────
 * 「实查 → 落证据 → 判定原因与措施 → 写回」这条链里,唯一需要**逐条说清理由**的就是
 * 判定这一步。把它做成不碰网络、不碰库的纯函数,才能对每一条判据单独取证并单测 ——
 * 而不是先跑一遍 1273 条差异再猜它对不对。
 *
 * ── 一条铁律:只依据显式证据,绝不推断 ────────────────────────────────────
 * 每一类判定都必须能指回一条**可读的来源字段**(`qymc` / `szsfmc` / `cszt` / `sqsj`),
 * 否则一律 `needs_review` + `manual_review`。本模块**不做**模糊匹配、相似度打分或
 * 原因猜测;`reasonNote` 里必须写清「缺什么证据」。
 *
 * ── 四态互不等价(契约 §3.2)──────────────────────────────────────────────
 * `not_queried`(没查,含「无统代 ⇒ 平台按 tyshxydm 查,查不了」)/
 * `query_failed`(查询没成功执行)/ `no_record`(查询成功但平台返回空)/
 * `confirmed_*`(成功且有结论)。四者绝不互相冒充。
 */

import type { ComparisonDirection } from '../comparison'
import type { PlatformInterface } from '../labels'
import { normalizeName } from '../domain'
import { aliasCandidatesOf, groupRelationsByUscc, type PlatformRelationRecord } from './identity'
import type {
  DifferenceMeasureCode,
  DifferenceReasonCode,
  DifferenceStatus,
} from './payload'

/** 本地省市名(平台 `szsfmc` 的本地取值)。**逐字**比较,不做行政区划推断。 */
export const NINGBO_PROVINCE = '宁波市'

/**
 * 复用**新鲜**证据的默认时间窗:24 小时。
 *
 * 两条都靠它:已有的成功查询(不再打平台)与已有的差异判定(不重复堆行)。实测平台真实
 * 延迟 0.3–1.1 秒/次,一次全量实查是分钟级,重复跑一遍既慢又多出一批时点不同的行。
 */
export const DEFAULT_FRESHNESS_MS = 24 * 60 * 60 * 1000

/** `businessList` 的 `rdjb` → 称号(与 pipeline `TITLE_RDJB` 同一张表,反向)。 */
export const RDJB_TITLE: Record<string, string> = {
  '1': 'innovative_sme',
  '2': 'specialized_sme',
  '3': 'little_giant',
}

/** 平台 `cszt` 里表示「已授予/在册」的取值(用于判断关系是否支撑某称号在册)。 */
const GRANTED_STATUSES = ['终审通过', '省已审', '市已审', '区县已审']

/** 明确的注销/吊销字样 —— 只有来源**明说**时才判 `deregistered`。 */
const DEREGISTERED_RE = /注销|吊销/

/** 一个待判定的差异目标:企业 × 称号 × 方向。 */
export interface ReconcileTarget {
  enterpriseId: number
  enterpriseName: string
  enterpriseNameNorm: string
  /** 统一社会信用代码;`null` = 无统代(平台两接口只认 `tyshxydm`,无法直查)。 */
  uscc: string | null
  titleCode: string
  direction: ComparisonDirection
}

/** 一次查询的**证据形态**(纯数据)。构造方既可以是实查结果,也可以是从库里读回的历史。 */
export interface ReconcileQueryEvidence {
  interface: PlatformInterface
  /** `business_list` 的 rdjb;`apply_list` 为空串。 */
  rdjb: string
  queriedAt: string
  status: 'success' | 'no_record' | 'failed'
  failureReason?: string | null
  /** 逐条关联关系(**不按 id 去重**)。
      平台没有独立「曾用名」列 —— 同一 `tyshxydm` 下 `qymc` 不同的历史行**本身**就是证据。 */
  relations: PlatformRelationRecord[]
}

/** 证据指针的**自然键**(契约 §8.7):写入侧在**同一批内**解析成真实行 id。 */
export interface ReconcileQueryRef {
  interface: PlatformInterface
  queryKey: string
  rdjb: string
  queriedAt: string
}

export interface ReconcileRelationRef extends ReconcileQueryRef {
  sequenceNo: number
}

/** 由本引擎判出的一条**待写曾用名**(证据齐备时才算数)。 */
export interface ReconcileAliasDecision {
  name: string
  sourceKind: 'platform_business' | 'platform_apply'
  sourceRelation: ReconcileRelationRef
  validFrom: string | null
  verificationStatus: 'confirmed' | 'pending'
  note: string
}

/** 一个差异目标的判定结果。**原因与措施成对**,不留半截。 */
export interface DifferenceVerdict {
  status: DifferenceStatus
  /** `needs_review` / `no_record` / `not_queried` / `query_failed` 时可为 null。 */
  reasonCode: DifferenceReasonCode | null
  reasonNote: string
  measureCode: DifferenceMeasureCode
  measureNote: string
  verificationStatus: 'confirmed' | 'pending'
  evidenceQuery: ReconcileQueryRef | null
  evidenceRelation: ReconcileRelationRef | null
  /** 迁入承载;缺项留空待核(§1.5)。 */
  movedIn: { city: string | null; titleCode: string | null; year: number | null; batch: number | null } | null
  /** 需要写成 `enterprise_alias` 的历史名称(逐条带来源关系)。 */
  aliases: ReconcileAliasDecision[]
}

function queryRefOf(query: ReconcileQueryEvidence, queryKey: string): ReconcileQueryRef {
  return { interface: query.interface, queryKey, rdjb: query.rdjb, queriedAt: query.queriedAt }
}

function relationRefOf(query: ReconcileQueryEvidence, queryKey: string, relation: PlatformRelationRecord): ReconcileRelationRef {
  return { ...queryRefOf(query, queryKey), sequenceNo: relation.sequenceNo }
}

/**
 * 找到某条关系的**出处在哪个查询**里。
 *
 * 判据必须含 `rdjb`:同一次核查里 `business_list` 有 rdjb=1/2/3 **三个**槽位,每个槽位都从
 * `sequence_no=1` 起编号 —— 只按 `interface` + `sequenceNo` 找会命中第一个槽位,于是把
 * 「rdjb=1 的第一次查询」写进只可能来自 rdjb=3 的那条关系的证据指针里(§8.7 的自然键会
 * 因此解析到**另一个**查询)。所以按关系自带的 `interface` + `rdjb` 双键定位。
 */
function queryOfRelation(
  queries: ReconcileQueryEvidence[],
  relation: PlatformRelationRecord,
): ReconcileQueryEvidence | null {
  return (
    queries.find(
      (query) =>
        query.interface === relation.interface &&
        query.rdjb === relation.rdjb &&
        query.relations.some((candidate) => candidate.sequenceNo === relation.sequenceNo),
    ) ?? null
  )
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 关系行的**可读原文字段**(用于「证据明说」类判据,如注销)。 */
function readableFields(relation: PlatformRelationRecord): string {
  const values = Object.values(relation.rawFields ?? {}).map((value) => text(value))
  return [relation.status ?? '', relation.nameRaw ?? '', relation.province ?? '', ...values].join(' ')
}

function earliestRelation(relations: PlatformRelationRecord[]): PlatformRelationRecord | null {
  const timed = relations.filter((relation) => !!relation.appliedAt)
  if (!timed.length) return null
  return timed.reduce((a, b) => (a.appliedAt! <= b.appliedAt! ? a : b))
}

function latestRelation(relations: PlatformRelationRecord[]): PlatformRelationRecord | null {
  const timed = relations.filter((relation) => !!relation.appliedAt)
  if (!timed.length) return null
  return timed.reduce((a, b) => (a.appliedAt! >= b.appliedAt! ? a : b))
}

function relationYear(relation: PlatformRelationRecord): number | null {
  if (relation.year != null) return relation.year
  const match = /^(\d{4})-\d{2}-\d{2}/.exec(relation.appliedAt ?? '')
  return match ? Number(match[1]) : null
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/**
 * **更名**判定(契约 §5.1)。返回三样:
 *  - `aliases`:**该写的曾用名**(身份事实,与「这条差异为什么存在」正交 —— 所以
 *    `missing_in_miit` 走 `platform_stale` 时也照样带着它一起写出去);
 *  - `verdict`:把更名**当作差异原因**的判定(原因 + 措施 + 逐条曾用名)。只在没有更强
 *    方向判据时使用:`missing_in_miit` 由父代理口径固定为 `platform_stale`,所以那时取
 *    `aliases` 而不用这个 `verdict`;
 *  - `needsReview`:有更名**候选**但锚不到来源关系 —— 证据在手上却指不回具体行 ⇒ 转人工,
 *    绝不静默降级成别的结论(那样会把更名证据整个吞掉)。
 */
function decideRename(
  target: ReconcileTarget,
  uscc: string,
  relations: PlatformRelationRecord[],
  successes: ReconcileQueryEvidence[],
): { verdict: DifferenceVerdict | null; needsReview: string | null; aliases: ReconcileAliasDecision[] } {
  const group = groupRelationsByUscc(relations).find((item) => item.uscc === uscc) ?? null
  const candidates = group ? aliasCandidatesOf(group) : []

  if (candidates.length > 0) {
    const aliases: ReconcileAliasDecision[] = []
    const unanchored: string[] = []
    for (const candidate of candidates) {
      const anchor = candidate.relations[0]!
      const query = queryOfRelation(successes, anchor)
      if (!query) {
        unanchored.push(candidate.name)
        continue
      }
      aliases.push({
        name: candidate.name,
        sourceKind: candidate.sourceKind,
        sourceRelation: relationRefOf(query, uscc, anchor),
        validFrom: candidate.validFrom,
        // 证据明确:同一 USCC、`qymc` 不同、且**最新一次申报唯一确定现名** ⇒ 可以确认为历史名称。
        // (`aliasCandidatesOf` 的候选默认是 `pending`;这里升级为 `confirmed` 正是「由证据确认」那一步,
        //  不是软件的猜测 —— 时间序无法定出先后时它根本不产候选。)
        verificationStatus: 'confirmed',
        note:
          `平台关系 ${candidate.relations.map((relation) => relation.relationKey ?? `#${relation.sequenceNo}`).join(' / ')} ` +
          `的 qymc 写的是「${candidate.name}」,与同一 tyshxydm 下最新申报写出的现名不同 ⇒ 历史名称。`,
      })
    }
    // 有候选却一条都锚不到来源 ⇒ 不静默降级,如实转人工并说明缺什么。
    if (unanchored.length > 0) {
      return {
        verdict: null,
        aliases: [],
        needsReview:
          `平台关系里出现与现名不同的历史名称(${unanchored.join('、')}),` +
          '但找不到承载该名称的**具体关系行**(证据指针锚不上),无法写成可回溯的曾用名。',
      }
    }
    const anchor = candidates[0]!.relations[0]!
    const query = queryOfRelation(successes, anchor)
    return {
      aliases,
      verdict: {
        status: 'confirmed_reason',
        reasonCode: 'renamed',
        reasonNote:
          `平台关系里同一 tyshxydm 下出现 ${aliases.length + 1} 个不同 qymc:` +
          `${aliases.map((alias) => alias.name).join('、')} 与现名并列 ⇒ 更名证据明确。`,
        measureCode: 'update_current_name',
        measureNote: '现名与曾用名都保留并都可查;旧名写成 enterprise_alias(来源=平台关系行)。',
        verificationStatus: 'confirmed',
        evidenceQuery: query ? queryRefOf(query, uscc) : null,
        evidenceRelation: query ? relationRefOf(query, uscc, anchor) : null,
        movedIn: null,
        aliases,
      },
      needsReview: null,
    }
  }

  // (b) 平台上只写出**一个**名字,而它与本企业(公布侧)的名不同 ⇒ 两侧名字不一致。
  //     方向定不出来(单个名字无法说明谁是现名、谁是旧名)⇒ 曾用名标 `pending`,不猜。
  const names = [...new Set(relations.map((relation) => relation.nameRaw).filter((name): name is string => !!name))]
  const differing = names.filter((name) => normalizeName(name) !== target.enterpriseNameNorm)
  if (differing.length === 1 && names.length === 1) {
    const anchor = relations.find((relation) => relation.nameRaw === differing[0])!
    const query = queryOfRelation(successes, anchor)
    if (!query) {
      return {
        verdict: null,
        aliases: [],
        needsReview: `平台关系写出的名称「${differing[0]}」与本企业名不同,但锚不到承载它的关系行。`,
      }
    }
    const singleAlias: ReconcileAliasDecision[] = [
      {
        name: differing[0]!,
        sourceKind: anchor.sourceKind,
        sourceRelation: relationRefOf(query, uscc, anchor),
        validFrom: anchor.appliedAt,
        verificationStatus: 'pending',
        note:
          `平台关系 ${anchor.relationKey ?? `#${anchor.sequenceNo}`} 的 qymc 写的是「${differing[0]}」,` +
          `与本企业名「${target.enterpriseName}」不同;平台上仅此一个名字,先后待核。`,
      },
    ]
    return {
      aliases: singleAlias,
      verdict: {
        status: 'confirmed_reason',
        reasonCode: 'renamed',
        reasonNote:
          `平台关系的 qymc 写的是「${differing[0]}」,而本企业(公布侧)名是「${target.enterpriseName}」` +
          '⇒ 两侧名称不一致,更名证据明确;但平台上只有这一个名字,定不出孰先孰后。',
        measureCode: 'update_current_name',
        measureNote: '现名与曾用名都保留并都可查;由人核对名称沿革后再定当前名。',
        // 更名本身有证据;方向待核 ⇒ 整条标待核,曾用名也标 `pending`。
        verificationStatus: 'pending',
        evidenceQuery: queryRefOf(query, uscc),
        evidenceRelation: relationRefOf(query, uscc, anchor),
        movedIn: null,
        aliases: singleAlias,
      },
      needsReview: null,
    }
  }

  return { verdict: null, needsReview: null, aliases: [] }
}

/** 平台关系状态里表示「该条记录已作废」的取值(实测字典)。 */
const VOID_STATUSES = ['撤回', '已退回', '已退回待审核', '终审不通过']

/**
 * 平台记录**全部作废**(撤回 / 退回 / 终审不通过)⇒ 原因落 `other`。
 *
 * 为什么用 `other` 而不是硬塞进 `platform_stale`:来源**明说**的是「这条记录被撤了」,
 * 而 `platform_stale`(平台未更新)描述的是「平台还停在旧状态」—— 两者是不同的可读事实。
 * 契约要求未知原因用 `other` + `reasonNote` 并把新原因的说明写清楚,**不新增枚举值**。
 * 措施配 `keep_history`:平台侧作废不妨碍、也不改动任何正式公布历史。
 */
function decideVoidRelations(
  uscc: string,
  relations: PlatformRelationRecord[],
  successes: ReconcileQueryEvidence[],
): DifferenceVerdict | null {
  const statuses = [...new Set(relations.map((relation) => relation.status).filter((s): s is string => !!s))]
  if (statuses.length === 0 || !statuses.every((status) => VOID_STATUSES.includes(status))) return null
  const anchor = relations[0]!
  const query = queryOfRelation(successes, anchor)
  return {
    status: 'confirmed_reason',
    reasonCode: 'other',
    reasonNote:
      `平台关系状态全部为「${statuses.join('、')}」(该记录已作废/未通过),` +
      '既不是「平台未更新」也不是「两侧一致」—— 按证据落「其他」,原文见 reasonNote 与证据行。',
    measureCode: 'keep_history',
    measureNote: '保留正式公布历史与平台原文;**不**据此改写任何一侧。',
    verificationStatus: 'confirmed',
    evidenceQuery: query ? queryRefOf(query, uscc) : null,
    evidenceRelation: query ? relationRefOf(query, uscc, anchor) : null,
    movedIn: null,
    aliases: [],
  }
}

/**
 * 判定一个差异目标的**原因与后置动作**。
 *
 * 判据按优先级排列,**先命中先返回** —— 顺序本身就是「哪条证据更硬」的表态:
 *  1. 无统代 ⇒ `not_queried`(平台按 `tyshxydm` 查,查不了,不编造查询键);
 *  2. 没有任何一次成功查询 ⇒ `query_failed`;
 *  3. 成功但 0 条关联 ⇒ `no_record`;
 *  4. 有证据明说的注销/吊销 ⇒ `deregistered`;
 *  5. 更名证据(同一 USCC 下多个 `qymc`,或平台名 ≠ 公布名)⇒ `renamed`;
 *  6. 省份证据 ⇒ `moved_out` / `moved_in`;
 *  7. 平台记录状态全部撤回/退回/终审不通过 ⇒ `other`(有证据但不在已知五因内);
 *  8. 平台确实有记录、却指不出任何**具体身份事实** ⇒ `platform_stale`(兜底);
 *  9. 其余 ⇒ `needs_review`,并在 `reasonNote` 写清缺什么证据。
 *
 * ⚠️ **第 5–7 步是「具体」,第 8 步才是「泛化兜底」**——顺序不能倒(父代理 2026-10-16 纠正)。
 * 把 `platform_stale` 放在具体原因前面,会把大量更名/迁移吞进兜底类。
 */
export function decideDifference(
  target: ReconcileTarget,
  queries: ReconcileQueryEvidence[],
): DifferenceVerdict {
  // 1. 无统代 —— 两接口只认 `tyshxydm`,不支持按名称查。
  if (!target.uscc) {
    return {
      status: 'not_queried',
      reasonCode: null,
      reasonNote:
        '本企业无统一社会信用代码;平台两接口只认 tyshxydm,不支持按名称查询,无法直查。' +
        '只能靠别处查出的别名间接识别,否则留待核实。',
      measureCode: 'manual_review',
      measureNote: '先补统一社会信用代码,或按平台关系里明确写出的曾用名间接识别主体。',
      verificationStatus: 'pending',
      evidenceQuery: null,
      evidenceRelation: null,
      movedIn: null,
      aliases: [],
    }
  }

  // 2. 还没查过(理论上 orchestration 总会生成四次查询;这里是防御分支)。
  if (queries.length === 0) {
    return {
      status: 'not_queried',
      reasonCode: null,
      reasonNote: `尚未对 ${target.uscc} 做过平台查询。`,
      measureCode: 'manual_review',
      measureNote: '先对该统一社会信用代码执行一次平台查询。',
      verificationStatus: 'pending',
      evidenceQuery: null,
      evidenceRelation: null,
      movedIn: null,
      aliases: [],
    }
  }

  const successes = queries.filter((query) => query.status === 'success' || query.status === 'no_record')
  const failures = queries.filter((query) => query.status === 'failed')

  // 3. 查询**没成功执行** —— 不是「没有记录」。
  if (successes.length === 0) {
    const detail = failures
      .map((query) => `${query.interface}${query.rdjb ? ` rdjb=${query.rdjb}` : ''}:${query.failureReason ?? '失败'}`)
      .join(';')
    return {
      status: 'query_failed',
      reasonCode: null,
      reasonNote: `平台查询未成功执行,不能据此判断有无记录:${detail}`,
      measureCode: 'manual_review',
      measureNote: '更新平台会话凭据或稍后重试;不要把「查询失败」当成「平台无记录」。',
      verificationStatus: 'pending',
      evidenceQuery: queryRefOf(failures[0]!, target.uscc),
      evidenceRelation: null,
      movedIn: null,
      aliases: [],
    }
  }

  const relations = successes.flatMap((query) => query.relations)

  // 4. 查询成功但平台**返回空** —— 真实的「无记录」,与失败、未查询都不同。
  if (relations.length === 0) {
    const scope = successes
      .map((query) => `${query.interface}${query.rdjb ? ` rdjb=${query.rdjb}` : ''}`)
      .join(' + ')
    // 有槽位失败 ⇒ 结论只覆盖成功的那几档。契约把 `query_failed` 定义为「有过查询但失败,
    // **且没有**成功的查询」,所以这里仍是 `no_record`(确实有成功且返空的查询),
    // 但**标待核**并在说明里点明「哪几档没查到」,不假装证据完整。
    const incomplete = failures.length
      ? `另有 ${failures.length} 次查询未成功执行(${failures
          .map((query) => `${query.interface}${query.rdjb ? ` rdjb=${query.rdjb}` : ''}`)
          .join('、')}),本结论不覆盖那几档。`
      : ''
    // 两个方向都只有「**任一次成功查询返回 0 条**」才算无记录;配 `manual_review`(待人工)。
    // 注意 `missing_in_miit` 的另一半在下面:接口**有**记录时是 `platform_stale`(平台未更新),
    // **不是**这里 —— 把「接口有记录」记成 `no_record` 会把「平台滞后」误报成「平台无记录」。
    const contradiction =
      target.direction === 'extra_in_miit'
        ? '导出表(采集时点快照)与接口现状不一致,证据互相矛盾。'
        : '公布名单有该企业,而平台两个接口都查不到 —— 先补查/复核后再定论。'
    return {
      status: 'no_record',
      reasonCode: null,
      reasonNote: `接口查询(${scope})均**成功且返回 0 条**:平台确无该企业的关联记录。${contradiction}${incomplete}`,
      measureCode: 'manual_review',
      measureNote:
        '平台两个接口都没有这家企业的记录,按人工核实处理;不据此改写任何一侧,也不产生新企业。',
      verificationStatus: 'pending',
      evidenceQuery: queryRefOf(successes[0]!, target.uscc),
      evidenceRelation: null,
      movedIn: null,
      aliases: [],
    }
  }

  // 4. 证据**明说**主体已注销/吊销 —— 平台两接口本身不提供注销状态,所以这一条
  //    只可能由关系行原文里的字样触发;没有明说就绝不判。
  const deregistered = relations.find((relation) => DEREGISTERED_RE.test(readableFields(relation)))
  if (deregistered) {
    const query = queryOfRelation(successes, deregistered)
    return {
      status: 'confirmed_reason',
      reasonCode: 'deregistered',
      reasonNote: `平台关系原文写明主体已注销/吊销(关系 ${deregistered.relationKey ?? `#${deregistered.sequenceNo}`})。`,
      measureCode: 'mark_deregistered',
      measureNote: '记录主体注销状态;**不删除**任何正式公布历史。',
      verificationStatus: 'confirmed',
      evidenceQuery: query ? queryRefOf(query, target.uscc) : null,
      evidenceRelation: query ? relationRefOf(query, target.uscc, deregistered) : null,
      movedIn: null,
      aliases: [],
    }
  }

  // 5. 更名 ⇒ 曾用名证据(契约 §5.1)。两条判据都属于「显式证据」:
  //    (a) 同一 `tyshxydm` 下 `qymc` 出现**多个不同写法** ⇒ 历史行本身就是曾用名证据;
  //    (b) 平台关系写出的名字与**本企业(公布侧)的名**不同 ⇒ 两侧名字不一致,同样是更名证据。
  //    (b) 覆盖平台上只写出一个名字、而那个名字与公布名不同的情形 —— 只按 (a) 找会整条漏掉。
  //
  //    **曾用名是身份事实,与「这条差异为什么存在」正交**:所以下面的 `missing_in_miit` 判据
  //    即使给出 `platform_stale`,也照样把这里的曾用名一起写出去(父代理 2026-10-16 的
  //    真实案例 `91330206793007818K`:4 条关系里既有现名又有旧名,旧名必须被识别出来)。
  const rename = decideRename(target, target.uscc, relations, successes)
  if (rename.needsReview) {
    return {
      status: 'needs_review',
      reasonCode: null,
      reasonNote: rename.needsReview,
      measureCode: 'manual_review',
      measureNote: '人工核对平台关系行与公布名;在此之前不作任何回填。',
      verificationStatus: 'pending',
      evidenceQuery: null,
      evidenceRelation: null,
      movedIn: null,
      aliases: [],
    }
  }

  // 6. **具体身份事实优先于泛化的兜底**(父代理 2026-10-16 纠正):
  //    更名 / 外迁 / 迁入 / 注销只要**有证据**就取那个具体值;`platform_stale`(平台未更新)
  //    只在「平台确实知道这家企业、却指不出任何具体身份事实」时才用。
  //    反例教训:把 `platform_stale` 放在前面会把大量具体原因吞进兜底类
  //    (实测 `91330206793007818K` 宁波一力实业:明显是**更名**,不是未更新)。
  if (rename.verdict) return rename.verdict

  // 7. 省份证据:`szsfmc` ≠ 宁波市 ⇒ 不在本地。
  const provinces = [...new Set(relations.map((relation) => relation.province).filter((p): p is string => !!p))]
  const outside = provinces.filter((province) => province !== NINGBO_PROVINCE)
  const localCount = provinces.length - outside.length

  if (outside.length > 0 && localCount === 0) {
    const anchor = relations.find((relation) => relation.province && relation.province !== NINGBO_PROVINCE)!
    const query = queryOfRelation(successes, anchor)
    return {
      status: 'confirmed_reason',
      reasonCode: 'moved_out',
      reasonNote: `平台关系的省份(szsfmc)全部不在宁波市:${outside.join('、')}。`,
      measureCode: 'mark_moved_out',
      measureNote: '记录迁出状态;**不删除**正式公布历史。',
      verificationStatus: 'confirmed',
      evidenceQuery: query ? queryRefOf(query, target.uscc) : null,
      evidenceRelation: query ? relationRefOf(query, target.uscc, anchor) : null,
      movedIn: null,
      aliases: [],
    }
  }

  if (outside.length > 0 && localCount > 0) {
    const first = earliestRelation(relations)
    const last = latestRelation(relations)
    const isOutside = (relation: PlatformRelationRecord | null) =>
      !!relation?.province && relation.province !== NINGBO_PROVINCE
    if (first && last && first.appliedAt !== last.appliedAt) {
      if (isOutside(first) && !isOutside(last)) {
        // 迁入:最早在宁波市以外、最近在宁波市。
        const origin = first.province!
        const titleCode = RDJB_TITLE[first.rdjb] ?? null
        const year = relationYear(first)
        const query = queryOfRelation(successes, first)
        const missing = [
          titleCode ? null : '原称号',
          year != null ? null : '年份',
          '批次(平台 whpc 形如 2025-1,不是批次序号)',
        ].filter(Boolean)
        return {
          status: 'confirmed_reason',
          reasonCode: 'moved_in',
          reasonNote:
            `平台关系按申报时间排序:最早一条在「${origin}」(${first.appliedAt}),` +
            `最近一条在「${NINGBO_PROVINCE}」(${last.appliedAt})⇒ 迁入证据明确。` +
            (missing.length ? `缺项待核:${missing.join('、')}。` : ''),
          measureCode: 'record_moved_in',
          measureNote: '记录迁入来源城市/称号/年份;缺项留空待核,不猜填。',
          verificationStatus:
            titleCode && year != null ? 'confirmed' : 'pending',
          evidenceQuery: query ? queryRefOf(query, target.uscc) : null,
          evidenceRelation: query ? relationRefOf(query, target.uscc, first) : null,
          movedIn: { city: origin, titleCode, year, batch: null },
          aliases: [],
        }
      }
      if (!isOutside(first) && isOutside(last)) {
        // 外迁:最早在宁波市、最近在外地。
        const query = queryOfRelation(successes, last)
        return {
          status: 'confirmed_reason',
          reasonCode: 'moved_out',
          reasonNote:
            `平台关系按申报时间排序:最早一条在「${NINGBO_PROVINCE}」(${first.appliedAt}),` +
            `最近一条在「${last.province}」(${last.appliedAt})⇒ 外迁证据明确。`,
          measureCode: 'mark_moved_out',
          measureNote: '记录迁出状态;**不删除**正式公布历史。',
          verificationStatus: 'confirmed',
          evidenceQuery: query ? queryRefOf(query, target.uscc) : null,
          evidenceRelation: query ? relationRefOf(query, target.uscc, last) : null,
          movedIn: null,
          aliases: [],
        }
      }
    }
    return {
      status: 'needs_review',
      reasonCode: null,
      reasonNote:
        `平台关系的省份同时含宁波市与非宁波市(${provinces.join('、')}),` +
        '但申报时间不足以排出先后(缺失或并列),判不出迁入/迁出方向。',
      measureCode: 'manual_review',
      measureNote: '人工核对申报时间与区划后判定方向;在此之前不作任何回填。',
      verificationStatus: 'pending',
      evidenceQuery: null,
      evidenceRelation: null,
      movedIn: null,
      aliases: [],
    }
  }

  // 8. 平台记录**全部作废**(撤回 / 退回 / 终审不通过)⇒ 原因落 `other`(有证据、但不在五个已知原因里)。
  const voidVerdict = decideVoidRelations(target.uscc, relations, successes)
  if (voidVerdict) return voidVerdict

  // 9. 兜底:平台**确实知道**这家企业,却指不出任何具体身份事实 ⇒ `platform_stale`(平台未更新)。
  //    两个方向的差别只在措辞:导出表缺它叫「审核信息滞后」,导出表多它叫「平台领先于公布文件」。
  const anchor = latestRelation(relations) ?? relations[0]!
  const query = queryOfRelation(successes, anchor)
  // 平台记录里是否已含**同称号且在册** —— 是一句能指回原文的补充,不是推断。
  const sameTitle = relations.some(
    (relation) => RDJB_TITLE[relation.rdjb] === target.titleCode && GRANTED_STATUSES.includes(relation.status ?? ''),
  )
  const stagnant =
    (target.direction === 'missing_in_miit'
      ? `公布名单有该企业、导出表没有,但平台接口对该 USCC 返回 ${relations.length} 条关联记录`
      : `平台对 ${target.uscc} 返回 ${relations.length} 条关联记录,而经信局公布侧无该条`) +
    `(${describeEvidenceScope(relations)})` +
    (sameTitle ? `,其中**已含同称号「${target.titleCode}」且状态为在册**` : '') +
    (target.direction === 'missing_in_miit'
      ? '⇒ 平台知道这家企业,只是**审核信息滞后**于公布文件。'
      : '⇒ 平台现状领先于公布文件,属采集时点差异。')
  return {
    status: 'confirmed_reason',
    reasonCode: 'platform_stale',
    reasonNote: stagnant,
    measureCode: 'mark_platform_snapshot',
    measureNote: '标明平台时点,不覆盖、不改写正式公布历史。',
    verificationStatus: 'confirmed',
    evidenceQuery: query ? queryRefOf(query, target.uscc) : null,
    evidenceRelation: query ? relationRefOf(query, target.uscc, anchor) : null,
    movedIn: null,
    // 曾用名随 `renamed` 那条早返回一起写出去(见上面第 5 步),到这里已无更名证据。
    aliases: [],
  }
}

/**
 * 把「哪些档位、哪些状态、哪些年份」写成一句可读证据(`reasonNote` 要能指回原文)。
 *
 * 状态取 `cszt` 原文,年份优先取 `applyList` 的 `year`、否则从申报时间(`sqsj`)里取年 ——
 * 都是来源**明写**的字段,不是推断。
 */
function describeEvidenceScope(relations: PlatformRelationRecord[]): string {
  const byScope = new Map<string, number>()
  for (const relation of relations) {
    const scope = `${relation.interface}${relation.rdjb ? ` rdjb=${relation.rdjb}` : ''}`
    byScope.set(scope, (byScope.get(scope) ?? 0) + 1)
  }
  const scopes = [...byScope.entries()].map(([scope, count]) => `${scope} ${count} 条`)
  const statuses = [...new Set(relations.map((relation) => relation.status).filter((s): s is string => !!s))]
  const years = [
    ...new Set(
      relations
        .map((relation) => relation.year ?? (/^(\d{4})-\d{2}-\d{2}/.exec(relation.appliedAt ?? '')?.[1] ?? null))
        .filter((year): year is string | number => year != null),
    ),
  ].sort()
  const parts = [scopes.join(';')]
  if (statuses.length) parts.push(`状态含「${statuses.join('」「')}」`)
  if (years.length) parts.push(`年份 ${years.join('/')}`)
  return parts.join(',')
}
