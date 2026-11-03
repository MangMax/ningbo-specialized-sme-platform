/**
 * 关系分组与**曾用名证据**(RL-03)。这里只做两件事,而且都**不做推断**:
 *
 * 1. 把接口返回的每一行映射成契约 §1.4 的关系记录(逐条保留,不去重);
 * 2. 按 USCC 分组,列出**同一 USCC 下出现过哪些企业名**,以及每个名字挂在哪些原始关系上。
 *
 * 关于「曾用名」的领域规则(契约 §5.1,已实测):
 * **平台没有独立「曾用名」列。同一 `tyshxydm` 下 `qymc` 不同的历史关联行,本身就是证据。**
 * 实测 `91330211255994457P` 的 8 条关系里,2 条写 `宁波上航测绘有限公司`、其余写
 * `宁波上航测绘股份有限公司`,逐字段比对后**唯一与名称有关的差异字段就是 `qymc`**。
 *
 * 因此本模块给出的是**候选**(`pending`),不是结论:软件不猜「哪条是曾用名」,
 * 由代理/人看原始关系后确认,确认结果才进 `enterprise_alias`(见 `payload.ts`)。
 * 同名多主体(同一名字挂在不同 USCC 下)是**冲突**,候选一律为空、不自动合并。
 */
import { normalizeName } from '../domain'
import type { PlatformInterface } from '../labels'
import type { PlatformRow, PlatformQueryMeta } from './types'

/** 一条平台关系(已映射到契约 §1.4 的列含义)。 */
export interface PlatformRelationRecord {
  interface: PlatformInterface
  /** 该接口的查询参数:`business_list` 的 rdjb;`apply_list` 为空。 */
  rdjb: string
  /** 关系序号:同一次查询内第几条(从 1 起)。**逐条保留**的载体。 */
  sequenceNo: number
  /** 平台关联主键(`id`,如 `SQ332022062212391`)。 */
  relationKey: string | null
  /** 企业名称(`qymc`)。同一 USCC 下不同 ⇒ 曾用名证据。 */
  nameRaw: string | null
  /** 统一社会信用代码(`tyshxydm`)。 */
  usccRaw: string | null
  /** 所属省市名称(`szsfmc`)。 */
  province: string | null
  /** 办理状态(`cszt`)，与查询是否成功各自独立。 */
  status: string | null
  /** 维护批次(`whpc`)。 */
  batch: string | null
  /** 申报类型(`sblx`):`apply`/`update`/`review`;非字典取值**原样保留**。 */
  declareKind: string | null
  /** 申报时间(`sqsj`)。 */
  appliedAt: string | null
  /** 认定批次(`personuuid`,值如 `第四批`)。 */
  awardBatchLabel: string | null
  /** 申报记录年份(`queryList` 的 `year`)。 */
  year: number | null
  /** 该关系来自哪个接口 —— 决定 `enterprise_alias.source_kind`。 */
  sourceKind: 'platform_business' | 'platform_apply'
  /** 整行原始字段(留证)。 */
  rawFields: PlatformRow
}

const DECLARE_KINDS: Record<string, string> = {
  申请: 'apply',
  更新: 'update',
  复核: 'review',
}

/** Known source values use the existing dictionary; unknown values stay verbatim. */
export function normalizeDeclareKind(value: unknown): string | null {
  const raw = text(value)
  return raw ? (Object.hasOwn(DECLARE_KINDS, raw) ? DECLARE_KINDS[raw]! : raw) : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function toYear(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Parse process facts without copying the archived row or interpreting identity. */
export function processFactsFromRow(row: PlatformRow) {
  const rawKind = text(row.sblx)
  return {
    province: text(row.szsfmc),
    status: text(row.cszt),
    batch: text(row.whpc),
    // 非字典取值原样保留，包括原型同名键。
    declareKind: normalizeDeclareKind(rawKind),
    appliedAt: text(row.sqsj),
    awardBatchLabel: text(row.personuuid),
    year: toYear(row.year),
  }
}

/**
 * 平台一行 → 关系记录。字段名沿用接口的 `id`(见 02-RESEARCH 的字段表),空值一律 `null`。
 *
 * `sequenceNo` 由调用方给出(它属于「哪次查询的第几条」,单行看不出来)。
 */
export function relationFromRow(
  row: PlatformRow,
  meta: PlatformQueryMeta & { sequenceNo?: number },
): PlatformRelationRecord {
  return {
    interface: meta.interface,
    rdjb: meta.rdjb ?? '',
    sequenceNo: meta.sequenceNo ?? 0,
    relationKey: text(row.id),
    nameRaw: text(row.qymc),
    usccRaw: text(row.tyshxydm),
    ...processFactsFromRow(row),
    sourceKind: meta.interface === 'business_list' ? 'platform_business' : 'platform_apply',
    rawFields: { ...row },
  }
}

/** 同一 USCC 下出现的**一个名字**及其全部原始关系证据。 */
export interface RelationNameGroup {
  /** 来源里的**原值**(取该组出现次数最多/最先出现的写法)。 */
  name: string
  /** 归一化名(与 `lib/domain.ts` 的 `normalizeName` 同规则)。 */
  nameNorm: string
  relations: PlatformRelationRecord[]
  /** 该名字在来源里最早一次申报时间;来源未给出则空。 */
  earliestAppliedAt: string | null
}

/** 一个 USCC(或无统代的一组)之下的全部关系与名字。 */
export interface UsccRelationGroup {
  /** 统一社会信用代码;无统代关系为 `null`(不并入任何企业)。 */
  uscc: string | null
  relations: PlatformRelationRecord[]
  names: RelationNameGroup[]
}

function earliest(values: (string | null)[]): string | null {
  const times = values.filter((v): v is string => !!v)
  if (!times.length) return null
  // `YYYY-MM-DD HH:mm:ss` 与 ISO 都能按字典序比较。
  return times.reduce((a, b) => (a < b ? a : b))
}

/** 按 USCC 聚合关系,再按 `qymc` 分出名字组。**不去重、不折叠**:每条关系都留在原组里。 */
export function groupRelationsByUscc(relations: PlatformRelationRecord[]): UsccRelationGroup[] {
  const byUscc = new Map<string, PlatformRelationRecord[]>()
  for (const relation of relations) {
    const key = relation.usccRaw ?? ''
    const bucket = byUscc.get(key)
    if (bucket) bucket.push(relation)
    else byUscc.set(key, [relation])
  }

  return [...byUscc.entries()]
    .map(([uscc, groupRelations]) => {
      const byName = new Map<string, PlatformRelationRecord[]>()
      for (const relation of groupRelations) {
        const name = relation.nameRaw ?? ''
        const bucket = byName.get(name)
        if (bucket) bucket.push(relation)
        else byName.set(name, [relation])
      }
      const names: RelationNameGroup[] = [...byName.entries()].map(([name, groupByName]) => ({
        name: groupByName[0]!.nameRaw ?? name,
        nameNorm: normalizeName(name),
        relations: groupByName,
        earliestAppliedAt: earliest(groupByName.map((r) => r.appliedAt)),
      }))
      return { uscc: uscc || null, relations: groupRelations, names }
    })
    .sort((a, b) => (a.uscc ?? '').localeCompare(b.uscc ?? ''))
}

/** 候选曾用名:同一 USCC 下、与**最新关系写出的名字**不同的历史名称。**不是结论**。 */
export interface AliasCandidate {
  name: string
  nameNorm: string
  /** 支撑该候选的全部原始关系(**逐条**)。 */
  relations: PlatformRelationRecord[]
  /** 由哪个接口报出 —— 决定 `enterprise_alias.source_kind`。 */
  sourceKind: 'platform_business' | 'platform_apply'
  /** 来源给出的生效时间(该名称最早一次申报);未给出留空。 */
  validFrom: string | null
  /** 候选默认 `pending`:确认是代理/人的动作,不是软件的推断。 */
  verificationStatus: 'pending'
}

/**
 * 从一组关系中挑出候选曾用名。
 *
 * 判据只有一条且全部来自来源:**最新一次申报(qsj 最大)写出的名字 = 现名,其余名字是候选**。
 * 所以:
 *  - 没有任何时间信息 ⇒ 返回 `[]`(定不出先后,不靠猜测);
 *  - 最新时间点上并列出现两个不同名字 ⇒ 返回 `[]`(`needs_review`,不猜哪个是现名)。
 *
 * 同名多主体的情形在这里天然不会产生候选:候选只在**单个 USCC 组内**比较名字,
 * 不同 USCC 组各算各的,调用方据 `groups.length > 1` 识别冲突。
 */
export function aliasCandidatesOf(group: UsccRelationGroup): AliasCandidate[] {
  const timed = group.relations.filter((r) => !!r.appliedAt)
  if (!timed.length) return []
  const latestAt = timed.map((r) => r.appliedAt!).reduce((a, b) => (a > b ? a : b))
  const currentNames = new Set(
    timed.filter((r) => r.appliedAt === latestAt).map((r) => r.nameRaw ?? ''),
  )
  if (currentNames.size !== 1) return []

  const [currentName] = [...currentNames]
  return group.names
    .filter((name) => name.name !== currentName && name.name.trim() !== '')
    .map((name) => ({
      name: name.name,
      nameNorm: name.nameNorm,
      relations: name.relations,
      sourceKind: name.relations[0]!.sourceKind,
      validFrom: name.earliestAppliedAt,
      verificationStatus: 'pending' as const,
    }))
}
