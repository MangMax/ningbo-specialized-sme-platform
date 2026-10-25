/**
 * 平台查询的处理状态。保留原始关系；业务原因与曾用名由代理/用户查证后显式提交。
 * 此模块只区分查询事实，不从名称、地区、申报状态或时间顺序推断业务结论。
 */
import type { ComparisonDirection } from '../comparison'
import type { PlatformInterface } from '../labels'
import type { PlatformRelationRecord } from './identity'
import type { DifferenceMeasureCode, DifferenceReasonCode, DifferenceStatus } from './payload'

export const DEFAULT_FRESHNESS_MS = 24 * 60 * 60 * 1000
export const RDJB_TITLE: Record<string, string> = {
  '1': 'innovative_sme',
  '2': 'specialized_sme',
  '3': 'little_giant',
}

/** 一个待判定的差异目标:企业 × 称号 × 方向。 */
export interface ReconcileTarget {
  enterpriseId: number
  enterpriseName: string
  enterpriseNameNorm: string
  /**
   * 统一社会信用代码;`null` = 无统代。
   *
   * ⚠️ **事实更正(RL-06,2026-10-16)**:早年这里写「平台两接口只认 `tyshxydm`」——**不对**。
   * 两个接口的**过滤能力不同**:`businessList`(关联记录)才只认 `rdjb` + `tyshxydm`;
   * `queryList`(申报记录)认 `tyshxydm` **或 `qymc`**(子串),还认 `rdjb`/`sblx`/`cszt`/`whpc` 等。
   * 所以「无统代 ⇒ 查不了」只是**这条判定链**的前提(它没有统代、也没带名称),不是接口的硬限制 ——
   * 无统代企业**可以**用 `queryList?qymc=<名称>` 反查出统代(见
   * `/Users/mang/Workfile/宁波/专精特新/20261013/orchestration-notes/00-CONTEXT.md`
   * 的「两个接口的过滤能力不同」一节,以及 `.agents/skills/roster-ingestion-pipeline/references/uscc-recovery.md`)。
   */
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
  status: 'success' | 'no_record' | 'failed' | 'partial'
  completeness?: 'complete' | 'partial' | 'not_queried'
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

/** 显式确认后可提交的一条曾用名（自动采集不产生此项）(证据齐备时才算数)。 */
export interface ReconcileAliasDecision {
  name: string
  sourceKind: 'platform_business' | 'platform_apply'
  sourceRelation: ReconcileRelationRef
  validFrom: string | null
  verificationStatus: 'confirmed' | 'pending'
  note: string
}

/** 一个差异目标的查询处理状态。**原因与措施成对**,不留半截。 */
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


const REQUIRED_SLOTS = ['business_list|1', 'business_list|2', 'business_list|3', 'apply_list|']

/** Compatibility entry point: it classifies query coverage, never the business cause. */
export function decideDifference(target: ReconcileTarget, queries: ReconcileQueryEvidence[]): DifferenceVerdict {
  const result: DifferenceVerdict = {
    status: 'not_queried', reasonCode: null,
    reasonNote: '尚未取得查询证据。', measureCode: 'manual_review',
    measureNote: '代理核对正式名单、导出时点、各平台来源及必要的公开证据后，显式提交原因与措施。',
    verificationStatus: 'pending', evidenceQuery: null, evidenceRelation: null, movedIn: null, aliases: [],
  }
  if (!target.uscc) {
    result.reasonNote = '本次按 tyshxydm 查询的任务缺少信用代码，尚未查询；代理可另用申报记录名称搜索发现候选。'
    return result
  }
  if (!queries.length) return result
  const successful = queries.filter(q => (q.status === 'success' || q.status === 'no_record') && q.completeness === 'complete')
  const failed = queries.filter(q => !successful.includes(q))
  const covered = new Set(successful.map(q => `${q.interface}|${q.rdjb}`))
  const missing = REQUIRED_SLOTS.filter(slot => !covered.has(slot))
  const rows = queries.flatMap(q => q.relations)
  const anchor = successful.find(q => q.relations.length > 0) ?? queries.find(q => q.relations.length > 0) ?? queries[0]!
  result.evidenceQuery = {
    interface: anchor.interface, queryKey: target.uscc, rdjb: anchor.rdjb, queriedAt: anchor.queriedAt,
  }
  if (rows.length === 0 && (!successful.length || failed.length > 0 || missing.length > 0)) {
    result.status = 'query_failed'
    result.reasonNote = `查询失败或范围不完整，不能报告无记录；未完成槽位：${missing.join('、') || '见原始查询'}。` +
      failed.map(q => `${q.interface}${q.rdjb ? ` rdjb=${q.rdjb}` : ''}：${q.failureReason ?? '失败'}`).join('；')
    return result
  }
  if (!rows.length) {
    result.status = 'no_record'
    result.reasonNote = '本次关联接口三个称号与申报接口均成功完成，返回0条；这是查询事实，不是差异原因。'
    return result
  }
  result.status = 'needs_review'
  const states = [...new Set(rows.map(r => r.status).filter(Boolean))]
  result.reasonNote = `已取得${rows.length}条原始关系${states.length ? `（平台状态：${states.join('、')}）` : ''}；待代理核实原因与措施。` +
    (failed.length || missing.length ? ` 查询范围尚未完整：${missing.join('、') || '见失败查询'}。` : '')
  return result
}
