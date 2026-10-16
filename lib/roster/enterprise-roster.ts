/**
 * 跨称号去重企业总表 / 企业详情 / 差异与解释 —— 契约 §7.1 / §7.2 / §7.3 的**读模型**(RL-04)。
 *
 * ── 三条口径,贯穿本文件 ────────────────────────────────────────────────
 *
 * 1. **公布 = 权威历史**。称号、批次、认定/复核事件、出处只从 `record*` 来;
 *    平台导出(`platform_export_*`)与接口关系(`platform_query` / `platform_relation`)
 *    **永不改写**公布历史,只作为对照与证据。
 *
 * 2. **一企一行,但称号与事件一条不折叠**。总表按 `enterprise` 去重(身份已由写入侧
 *    按统代/名称归并),`titles` / `firstRecognition` / 详情里的 `records` `events` `evidence`
 *    把该企业的**全部**称号历史原样带出。
 *
 * 3. **四态不得互相冒充**。展示态**只从 `difference_reason.status` 取**
 *    (父代理 2026-10-16 裁决 #1):没有解释记录时给状态机的**默认值** `not_queried`
 *    (即契约 §3.2 的「尚未对该差异做过平台查询」),**不**从别的列二次推导出
 *    「无记录」或「已确认」。是否真有存下来的解释,由 `explanationId` 说清。
 *
 * 派生状态 `rosterState` **不落列**(契约 §5):见 `deriveRosterState` 的注释。
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeName, normalizeUscc } from '../domain'
import { getComparison, type ComparisonDirection } from '../comparison'
import { SOURCE_ORDER, TITLE_ORDER } from '../labels'
import { MAX_PAGE_SIZE } from '../query'
import { computeTitleLifecycle, type LifecycleEvent, type TitleLifecycle } from './lifecycle'

type Db = BetterSQLite3Database<typeof schema>

/** 当前总表成员状态(派生、不落列)。 */
export const ROSTER_STATES = ['current', 'removed_platform_only'] as const
export type RosterState = (typeof ROSTER_STATES)[number]

// ---------------------------------------------------------------------------
// 取数:一次读完再在内存里组织
// ---------------------------------------------------------------------------
//
// 台账规模是「几千企业 / 几万事件」级(实测 7352 / 19729 / 21189),一次读全表比
// 为每种筛选拼一套 join 更简单也更快;仓库里既有的读模型(`server/utils/mcp-roster.ts`、
// `lib/platform/read.ts`)同一取舍。

interface Snapshot {
  enterprises: (typeof schema.enterprise)['$inferSelect'][]
  records: (typeof schema.record)['$inferSelect'][]
  events: (typeof schema.recordEvent)['$inferSelect'][]
  evidence: (typeof schema.recordEvidence)['$inferSelect'][]
  aliases: (typeof schema.enterpriseAlias)['$inferSelect'][]
  exportRows: (typeof schema.platformExportRow)['$inferSelect'][]
  exportBatches: (typeof schema.platformExportBatch)['$inferSelect'][]
  relations: (typeof schema.platformRelation)['$inferSelect'][]
  queries: (typeof schema.platformQuery)['$inferSelect'][]
  differences: (typeof schema.differenceReason)['$inferSelect'][]
}

function readSnapshot(db: Db): Snapshot {
  return {
    enterprises: db.select().from(schema.enterprise).all(),
    records: db.select().from(schema.record).all(),
    events: db.select().from(schema.recordEvent).all(),
    evidence: db.select().from(schema.recordEvidence).all(),
    aliases: db.select().from(schema.enterpriseAlias).all(),
    exportRows: db.select().from(schema.platformExportRow).all(),
    exportBatches: db.select().from(schema.platformExportBatch).all(),
    relations: db.select().from(schema.platformRelation).all(),
    queries: db.select().from(schema.platformQuery).all(),
    differences: db.select().from(schema.differenceReason).all(),
  }
}

// ---------------------------------------------------------------------------
// §7.1 企业总表
// ---------------------------------------------------------------------------

/** `firstRecognition` 的一项:该称号的首次认定年份。 */
export interface FirstRecognition {
  titleCode: string
  year: number
  /** 该称号的首次认定事件缺 `decided_year`(锚点/首次认定退回 `year`)⇒ **待核**。 */
  needsReview: boolean
}

export interface RosterEnterpriseRow {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  city: string | null
  regStatus: string | null
  rosterState: RosterState
  /** 该企业拿过的称号(按等级排序)。 */
  titles: string[]
  /** **仅 `confirmed`** 的曾用名(契约 §1.2:`pending` 不参与搜索/归并)。 */
  aliasNames: string[]
  /** 每个有 `award` 事件的称号一项(没有 award 的称号不出现)。 */
  firstRecognition: FirstRecognition[]
  /** 下一次复核到期 = 各称号锚点 + 3 的**最早**一个;无从计算时 `null`。 */
  nextReviewYear: number | null
  /** 锚点计算中用到缺 `decided_year` 的事件 ⇒ **待核**(不猜)。 */
  anchorNeedsReview: boolean
}

export interface RosterEnterpriseFilter {
  /** 名称 / **已确认**曾用名 / 统代关键词(契约 §5 搜索口径;统代为 RL-17 增量)。 */
  q?: string
  /** 称号(多值,命中任一)。 */
  title?: string[]
  /** 属地(= 企业自身属地,为空时退回记录属地)。 */
  district?: string
  rosterState?: RosterState
  /**
   * 来源(多值,命中任一)—— RL-17 增量:命中「该企业**存在**一条该来源的记录」。
   *
   * 与 `/api/records` 的 `source` 同构,只是把粒度从「企业 × 称号」抬到「企业」:
   * 合并后的台账只有一个入口,而 `/stats` 的下钻是 `/?source=…`;企业粒度不认这一项的话,
   * 下钻会**静默变成不筛**。
   */
  source?: string[]
  /** 事件类型(多值,命中任一):该企业**存在**一条该类型的事件。 */
  eventType?: string[]
  /** 事件年份(多值,命中任一):该企业**存在**一条该年份的事件。 */
  year?: number[]
  page?: number
  pageSize?: number
}

export interface RosterCounts {
  /** **企业数**(与筛选同口径、不受分页影响)。 */
  total: number
  /** **企业 × 称号**数 = `titles` 各桶之和。 */
  titlePairs: number
  /** 每个称号下的**企业数**(多称号企业在各桶里各计一次)。 */
  titles: Record<string, number>
}

export interface RosterEnterprisesResult {
  rows: RosterEnterpriseRow[]
  counts: RosterCounts
  page: number
  pageSize: number
}

const DEFAULT_PAGE_SIZE = 50

function pageOf(input: { page?: number; pageSize?: number }): { page: number; pageSize: number } {
  const page = Number.isFinite(input.page) && (input.page as number) >= 1 ? Math.floor(input.page as number) : 1
  const size = Number.isFinite(input.pageSize) && (input.pageSize as number) >= 1 ? Math.floor(input.pageSize as number) : DEFAULT_PAGE_SIZE
  return { page, pageSize: Math.min(size, MAX_PAGE_SIZE) }
}

function titleRank(code: string): number {
  const i = TITLE_ORDER.indexOf(code)
  return i === -1 ? TITLE_ORDER.length : i
}

function sourceRank(code: string): number {
  const i = SOURCE_ORDER.indexOf(code)
  return i === -1 ? SOURCE_ORDER.length : i
}

/**
 * 归一化统代后比对:`null` 表示「这个值给不出统代」。
 * 规则本身在 `lib/domain.ts` 的 `normalizeUscc`(单一来源)—— 与写入侧落 `uscc_norm`
 * 的口径必须是**同一条**,否则「按 USCC 认到同一家企业」在读写两侧会各判各的。
 */
function normUscc(uscc: string | null | undefined): string | null {
  return normalizeUscc(uscc) || null
}

/** 每条记录/快照行在内存里组织出来的企业画像(总表与详情共用)。 */
interface Profile {
  enterprise: (typeof schema.enterprise)['$inferSelect']
  records: (typeof schema.record)['$inferSelect'][]
  eventsByRecord: Map<number, (typeof schema.recordEvent)['$inferSelect'][]>
  /** 每称号的生命周期(跨该称号下**全部来源**的记录)。 */
  lifecycleByTitle: Map<string, TitleLifecycle>
  titles: string[]
  summary: { firstRecognition: FirstRecognition[]; nextReviewYear: number | null; anchorNeedsReview: boolean }
}

/**
 * `rosterState` 的派生(契约 §5)。三条判据,顺序即优先级:
 *
 *  1. **出现在任何公布名单里**(该企业有 ≥1 条 `jxj` 来源的 `record`)⇒ `current`;
 *     「有任意 jxj 认定/复核事件」是它的充分条件之一,而入库培育(`nurture`)这类
 *     公布名单出现同样算——**官方历史不因平台快照缺失被删**(契约 §5 的硬边界)。
 *  2. 否则,**有正证据表明它只由平台引入且已从最新快照消失** ⇒ `removed_platform_only`:
 *     它在 ≥1 张导出快照里出现过,而**它出现过的那些批次里,没有一张是「它自己那个称号」
 *     的最新批次**。
 *  3. 其余(含「一张快照都没有」)⇒ `current`。
 *     **证据不足不误删** —— 「无从证明已移除」不等于「已移除」;判据 2 的集合为空时
 *     (没有正证据)一律落到这里。
 *
 * ⚠️ 「最新」必须按**批次自己的称号**判,不能按**企业记录的称号**判:企业可能出现在
 * **别的称号**的快照里(实测:`platform_export_row` 只带 USCC,一家企业在一个称号的
 * 快照批次里出现完全正常)。旧写法拿 `profile.records.map(r => r.titleCode)` 去查
 * `latestBatchByTitle`,于是「企业记的称号一张快照都没有」时查到**空集** ⇒ 误判成
 * `removed_platform_only` —— 可它明明就在最新快照里,违反契约 §5 的「证据不足不误删」。
 */
function deriveRosterState(profile: Profile, index: SnapshotIndex): RosterState {
  if (profile.records.some((r) => r.source === 'jxj')) return 'current'
  if (!profile.records.length) return 'current'
  const present = index.presentByEnterprise.get(profile.enterprise.id)
  if (!present || present.size === 0) return 'current'
  // 按 USCC 的**实际出现**(跨称号):它出现过的批次里只要有一张是「该批次所属称号」的
  // 最新快照,它就还在最新快照里。
  const inLatest = [...present].some((batchId) => index.latestBatchIds.has(batchId))
  return inLatest ? 'current' : 'removed_platform_only'
}

function buildProfile(enterprise: Snapshot['enterprises'][number], snap: Snapshot): Profile {
  const records = snap.records.filter((r) => r.enterpriseId === enterprise.id)
  const eventsByRecord = new Map<number, Snapshot['events']>()
  for (const record of records) {
    eventsByRecord.set(record.id, snap.events.filter((e) => e.recordId === record.id))
  }

  // 生命周期按 **(企业 × 称号)** 算,把该称号下**全部来源**的事件合起来
  // (契约 §6.1:「首次认定按企业 × 称号的最早正式认定事件计算」)。
  const lifecycleByTitle = new Map<string, TitleLifecycle>()
  const eventsByTitle = new Map<string, LifecycleEvent[]>()
  for (const record of records) {
    const list = eventsByTitle.get(record.titleCode) ?? []
    for (const e of eventsByRecord.get(record.id) ?? []) {
      list.push({
        id: e.id,
        eventType: e.eventType,
        year: e.year,
        decidedYear: e.decidedYear,
        reviewOutcome: e.reviewOutcome,
      })
    }
    eventsByTitle.set(record.titleCode, list)
  }
  for (const [titleCode, list] of eventsByTitle) {
    lifecycleByTitle.set(titleCode, computeTitleLifecycle(list))
  }

  const titles = [...eventsByTitle.keys()].sort((a, b) => titleRank(a) - titleRank(b))
  const firstRecognition = titles
    .map((titleCode) => {
      const lc = lifecycleByTitle.get(titleCode)!
      return lc.firstRecognitionYear == null
        ? null
        : { titleCode, year: lc.firstRecognitionYear, needsReview: lc.needsReview }
    })
    .filter((x): x is FirstRecognition => x != null)
  const dues = titles
    .map((titleCode) => lifecycleByTitle.get(titleCode)!.dueYear)
    .filter((y): y is number => y != null)

  return {
    enterprise,
    records: [...records].sort(
      (a, b) => titleRank(a.titleCode) - titleRank(b.titleCode) || sourceRank(a.source) - sourceRank(b.source) || a.id - b.id,
    ),
    eventsByRecord,
    lifecycleByTitle,
    titles,
    summary: {
      firstRecognition,
      nextReviewYear: dues.length ? Math.min(...dues) : null,
      anchorNeedsReview: titles.some((t) => lifecycleByTitle.get(t)!.needsReview),
    },
  }
}

/** 属地:企业自身属地优先,为空时退回它**最早那条带属地的记录**。 */
function effectiveDistrict(profile: Profile): string | null {
  if (profile.enterprise.district) return profile.enterprise.district
  const withDistrict = profile.records.filter((r) => r.district).sort((a, b) => a.id - b.id)
  return withDistrict[0]?.district ?? null
}

function toRow(
  profile: Profile,
  aliasNames: string[],
  rosterState: RosterState,
): RosterEnterpriseRow {
  return {
    enterpriseId: profile.enterprise.id,
    name: profile.enterprise.name,
    uscc: profile.enterprise.usccNorm,
    district: effectiveDistrict(profile),
    city: profile.enterprise.city,
    regStatus: profile.enterprise.regStatus,
    rosterState,
    titles: profile.titles,
    aliasNames,
    firstRecognition: profile.summary.firstRecognition,
    nextReviewYear: profile.summary.nextReviewYear,
    anchorNeedsReview: profile.summary.anchorNeedsReview,
  }
}

/**
 * 导出快照的索引:哪些企业在哪几批快照里出现过,以及**哪些批次是它自己那个称号的最新一张**。
 * 「最新」= 年度最大,同年取 id 最大(替换关系不影响:两版并存,后写的更新)。
 */
interface SnapshotIndex {
  /** 企业 → 它出现过的批次 id 集合(按统代优先、其次归一化名命中)。 */
  presentByEnterprise: Map<number, Set<number>>
  /**
   * 「最新」批次的 id 集合 —— **按批次自己的称号**判定,与企业的 `record.titleCode` 无关。
   * 判「还在不在最新快照里」时只查这一个集合(见 `deriveRosterState`)。
   */
  latestBatchIds: Set<number>
}

function indexSnapshots(snap: Snapshot): SnapshotIndex {
  const usccToEnterprise = new Map<string, number>()
  const nameToEnterprise = new Map<string, number>()
  for (const e of snap.enterprises) {
    const uscc = normUscc(e.usccNorm)
    if (uscc) usccToEnterprise.set(uscc, e.id)
    nameToEnterprise.set(e.nameNorm, e.id)
  }

  const latestBatchByTitle = new Map<string, number>()
  const batchById = new Map(snap.exportBatches.map((b) => [b.id, b]))
  for (const batch of snap.exportBatches) {
    const known = latestBatchByTitle.get(batch.titleCode)
    const prev = known == null ? undefined : batchById.get(known)
    if (!prev || batch.year > prev.year || (batch.year === prev.year && batch.id > prev.id)) {
      latestBatchByTitle.set(batch.titleCode, batch.id)
    }
  }

  const presentByEnterprise = new Map<number, Set<number>>()
  for (const row of snap.exportRows) {
    const uscc = normUscc(row.usccRaw)
    const enterpriseId =
      (uscc != null ? usccToEnterprise.get(uscc) : undefined) ??
      (row.nameRaw ? nameToEnterprise.get(normalizeName(row.nameRaw)) : undefined)
    if (enterpriseId == null) continue
    const bucket = presentByEnterprise.get(enterpriseId)
    if (bucket) bucket.add(row.batchId)
    else presentByEnterprise.set(enterpriseId, new Set([row.batchId]))
  }

  return { presentByEnterprise, latestBatchIds: new Set(latestBatchByTitle.values()) }
}

/**
 * 总表:一行 = 一家企业。筛选作用于企业;`counts` 与筛选**同口径**、且**先于分页**。
 */
export function listRosterEnterprises(db: Db, filter: RosterEnterpriseFilter = {}): RosterEnterprisesResult {
  const { rows, counts } = selectRosterEnterprises(db, filter)
  const { page, pageSize } = pageOf(filter)
  return {
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
    counts,
    page,
    pageSize,
  }
}

/**
 * 不分页地取**全部**匹配企业(导出用)。口径与 `listRosterEnterprises` 共用同一处实现 ——
 * 「筛选与导出同一口径」不是靠对齐两段代码,而是它们本来就是同一段。
 */
export function allRosterEnterprises(
  db: Db,
  filter: Omit<RosterEnterpriseFilter, 'page' | 'pageSize'> = {},
): { rows: RosterEnterpriseRow[]; counts: RosterCounts } {
  return selectRosterEnterprises(db, filter)
}

/**
 * 记录侧的三个增量判据(RL-17)。**在 profile 上判**,不是在企业行上判 ——
 * `RosterEnterpriseRow` 是接口面,不该为了筛选多长出几个字段。
 *
 * 口径与 `/api/records` 的 `buildWhere` **同构**。那里把 `source` 落在 record 行上,
 * 把 `eventType` / `year` 落成一条 EXISTS —— 类型与年份必须在**同一条事件**上,而这条
 * EXISTS 又挂在**那条** record 上。抬到企业粒度就是:
 *
 * > **存在**一条该企业的记录,它满足来源判据,且它上面有一条事件同时满足类型与年份判据。
 *
 * 为什么非要「同一条」:合并后两种分组共用一个 URL,用户在 `按企业` 与 `按企业×称号`
 * 之间切换时,看到的必须是**同一批企业**。松成「各自存在」,企业粒度会命中更多
 * (企业有一条 2023 复核、另有一条 2021 认定,就会被 `eventType=award&year=2023` 判中),
 * 两个分组当场对不上。
 *
 * 缺省即不判:「没给这一项」与「给了个筛不中的值」必须分开(前者返回全部,后者返回 0 条)。
 */
function matchesRecordFilters(profile: Profile, filter: RosterEnterpriseFilter): boolean {
  const sources = filter.source?.length ? filter.source : null
  const types = filter.eventType?.length ? filter.eventType : null
  const years = filter.year?.length ? filter.year : null
  if (!sources && !types && !years) return true
  return profile.records.some((record) => {
    if (sources && !sources.includes(record.source)) return false
    if (!types && !years) return true
    return (profile.eventsByRecord.get(record.id) ?? []).some(
      (e) =>
        (!types || types.includes(e.eventType)) &&
        (!years || (e.year != null && years.includes(e.year))),
    )
  })
}

function selectRosterEnterprises(
  db: Db,
  filter: RosterEnterpriseFilter,
): { rows: RosterEnterpriseRow[]; counts: RosterCounts } {
  const snap = readSnapshot(db)
  const profiles = snap.enterprises.map((enterprise) => buildProfile(enterprise, snap))
  const index = indexSnapshots(snap)

  // 别名:只带 `confirmed`(契约 §1.2 —— `pending` 不参与搜索)。
  const confirmedAliases = new Map<number, string[]>()
  for (const alias of snap.aliases) {
    if (alias.verificationStatus !== 'confirmed') continue
    const list = confirmedAliases.get(alias.enterpriseId) ?? []
    if (!list.includes(alias.name)) list.push(alias.name)
    confirmedAliases.set(alias.enterpriseId, list)
  }

  const needle = filter.q?.trim() ? normalizeName(filter.q) : null
  /**
   * 统代匹配(RL-17 增量)。合并后的台账三个视图共用一个搜索框,框上写着
   * 「企业名 / 曾用名 / 统一社会信用代码」;`/api/records` 那一侧一直认统代,
   * 企业粒度不认的话,粘贴一个统代进来会**静默返回 0 家**。
   * 口径与 `lib/query.ts` 的 `q` 逐字一致:归一化大写后的子串匹配。
   */
  const usccNeedle = filter.q?.trim() ? filter.q.trim().toUpperCase() : null
  const candidates = profiles.map((profile) => ({
    profile,
    aliasNames: [...(confirmedAliases.get(profile.enterprise.id) ?? [])].sort(),
    state: deriveRosterState(profile, index),
  }))
  const rows = candidates
    .filter(({ profile, aliasNames, state }) => {
      if (filter.rosterState && state !== filter.rosterState) return false
      if (filter.title?.length && !profile.titles.some((t) => filter.title!.includes(t))) return false
      if (filter.district && effectiveDistrict(profile) !== filter.district) return false
      if (!matchesRecordFilters(profile, filter)) return false
      if (needle || usccNeedle) {
        const hit =
          (needle != null && normalizeName(profile.enterprise.name).includes(needle)) ||
          (needle != null && aliasNames.some((alias) => normalizeName(alias).includes(needle))) ||
          (usccNeedle != null &&
            (profile.enterprise.usccNorm ?? '').toUpperCase().includes(usccNeedle))
        if (!hit) return false
      }
      return true
    })
    .map(({ profile, aliasNames, state }) => toRow(profile, aliasNames, state))
    .sort(
      (a, b) =>
        titleRank(a.titles[0] ?? '') - titleRank(b.titles[0] ?? '') ||
        a.name.localeCompare(b.name) ||
        a.enterpriseId - b.enterpriseId,
    )

  const titles: Record<string, number> = Object.fromEntries(TITLE_ORDER.map((code) => [code, 0]))
  for (const row of rows) for (const code of row.titles) titles[code] = (titles[code] ?? 0) + 1
  const counts: RosterCounts = {
    total: rows.length,
    titlePairs: Object.values(titles).reduce((a, b) => a + b, 0),
    titles,
  }

  return { rows, counts }
}

// ---------------------------------------------------------------------------
// §7.2 企业详情
// ---------------------------------------------------------------------------

export interface RosterAliasRow {
  id: number
  name: string
  nameNorm: string
  sourceKind: string
  sourceRefId: number
  verificationStatus: string
  validFrom: string | null
  validTo: string | null
  note: string | null
}

export interface RosterRecordRow {
  id: number
  titleCode: string
  source: string
  district: string | null
  usccRaw: string | null
  nameRaw: string | null
  /** 该(企业 × 称号)的生命周期(跨来源合并计算,契约 §6)。 */
  lifecycle: TitleLifecycle
}

export interface RosterEventRow {
  id: number
  recordId: number
  eventType: string
  /** 事件**所涉**年份(复核事件记被复核的原认定年份)。 */
  year: number | null
  batchSeq: number | null
  /** **结论年份**;缺失时锚点退回 `year` 并标待核。 */
  decidedYear: number | null
  reviewOutcome: string | null
}

export interface RosterEvidenceRow {
  eventId: number
  sourceFile: string
  attachment: string | null
  listNo: number | null
  page: number | null
}

export interface MovedIn {
  city: string | null
  titleCode: string | null
  year: number | null
  batch: number | null
  /** 四项齐全才为 `true`;缺项 ⇒ 页面显示**待补证**(不猜填)。 */
  complete: boolean
}

export interface RosterDifferenceRow {
  /** 存下来的解释行 id;**`null` = 还没有解释记录**(状态即状态机默认的 `not_queried`)。 */
  explanationId: number | null
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  direction: ComparisonDirection
  /** 展示态 —— **只从 `difference_reason.status` 取**(父代理裁决 #1)。 */
  status: string
  reasonCode: string | null
  reasonNote: string | null
  measureCode: string | null
  measureNote: string | null
  movedIn: MovedIn | null
  verificationStatus: string
  recordedAt: string | null
  /** 该 (企业 × 称号 × 方向) 当前是否**确实是**差异(对照 §7.3 的差异口径)。 */
  inCurrentDifference: boolean
  evidence: {
    queryId: number
    queriedAt: string
    interface: string
    status: string
    failureReason: string | null
    relationIds: number[]
  } | null
}

export interface RosterPlatformQueryRow {
  id: number
  interface: string
  queryKey: string
  rdjb: string
  queriedAt: string
  status: string
  failureReason: string | null
  relationCount: number
}

export interface RosterPlatformRelationRow {
  id: number
  queryId: number
  sequenceNo: number
  relationKey: string | null
  usccRaw: string | null
  nameRaw: string | null
  province: string | null
  status: string | null
  batch: string | null
  declareKind: string | null
  appliedAt: string | null
  awardBatchLabel: string | null
  year: number | null
  matchBasis: string
  verificationStatus: string
}

export interface RosterEnterpriseDetail {
  enterprise: RosterEnterpriseRow
  aliases: RosterAliasRow[]
  records: RosterRecordRow[]
  events: RosterEventRow[]
  evidence: RosterEvidenceRow[]
  differences: RosterDifferenceRow[]
  platform: {
    queries: RosterPlatformQueryRow[]
    relations: RosterPlatformRelationRow[]
  }
}

function movedInOf(row: Snapshot['differences'][number]): MovedIn | null {
  const any =
    row.movedInCity != null || row.movedInTitleCode != null || row.movedInYear != null || row.movedInBatch != null
  if (!any && row.reasonCode !== 'moved_in') return null
  return {
    city: row.movedInCity,
    titleCode: row.movedInTitleCode,
    year: row.movedInYear,
    batch: row.movedInBatch,
    complete:
      row.movedInCity != null && row.movedInTitleCode != null && row.movedInYear != null && row.movedInBatch != null,
  }
}

/** 每 (企业 × 称号 × 方向) 的**当前**解释 = `recordedAt` 最新那条(旧解释不丢,只是不在这里)。 */
function currentExplanations(snap: Snapshot): Map<string, Snapshot['differences'][number]> {
  const current = new Map<string, Snapshot['differences'][number]>()
  for (const row of snap.differences) {
    const key = differenceKey(row.enterpriseId, row.titleCode, row.direction)
    const kept = current.get(key)
    if (!kept || row.recordedAt > kept.recordedAt) current.set(key, row)
  }
  return current
}

function differenceKey(enterpriseId: number, titleCode: string, direction: string): string {
  return `${enterpriseId}|${titleCode}|${direction}`
}

/**
 * 差异集合 = **比对口径**(`lib/comparison.ts`,`§0` 的「唯一差异口径」)∪ **已有解释**。
 *
 * 为什么要并上「已有解释」:时态化之后,一条解释可能对应一个**当前已不是差异**的坐标
 * (例如两侧后来对齐了)。`confirmed_no_diff` 这类状态必须看得见(否则按 `status` 筛
 * 永远筛不到它)。两边的来源由 `explanationId` 与 `inCurrentDifference` 分别说清。
 */
function differenceUniverse(db: Db, snap: Snapshot): RosterDifferenceRow[] {
  const current = currentExplanations(snap)
  const derived = getComparison(db).rows
  const names = new Map(snap.enterprises.map((e) => [e.id, e]))
  const recordDistrict = new Map<number, string | null>()
  for (const record of [...snap.records].sort((a, b) => a.id - b.id)) {
    if (!recordDistrict.has(record.enterpriseId) && record.district) {
      recordDistrict.set(record.enterpriseId, record.district)
    }
  }

  const coordinates: Array<{ enterpriseId: number; titleCode: string; direction: ComparisonDirection }> = []
  const seen = new Set<string>()
  for (const row of derived) {
    const key = differenceKey(row.enterpriseId, row.titleCode, row.direction)
    if (seen.has(key)) continue
    seen.add(key)
    coordinates.push({ enterpriseId: row.enterpriseId, titleCode: row.titleCode, direction: row.direction })
  }
  const derivedKeys = new Set(seen)
  for (const row of current.values()) {
    const key = differenceKey(row.enterpriseId, row.titleCode, row.direction)
    if (seen.has(key)) continue
    seen.add(key)
    coordinates.push({
      enterpriseId: row.enterpriseId,
      titleCode: row.titleCode,
      direction: row.direction,
    })
  }

  const queriesById = new Map(snap.queries.map((q) => [q.id, q]))
  const relationsByQuery = new Map<number, Snapshot['relations']>()
  for (const relation of snap.relations) {
    const list = relationsByQuery.get(relation.queryId) ?? []
    list.push(relation)
    relationsByQuery.set(relation.queryId, list)
  }

  const rows: RosterDifferenceRow[] = coordinates.map(({ enterpriseId, titleCode, direction }) => {
    const key = differenceKey(enterpriseId, titleCode, direction)
    const explanation = current.get(key) ?? null
    const enterprise = names.get(enterpriseId)
    const query = explanation?.evidenceQueryId != null ? queriesById.get(explanation.evidenceQueryId) ?? null : null
    // 证据 = 这次查询**返回的全部关系**(含未归属的原始行)。不按企业二次过滤:
    // 查询本身就是那条证据,`relationIds` 是它的原文出处(失败的那次也可能留下一行)。
    const relations = query ? relationsByQuery.get(query.id) ?? [] : []
    return {
      explanationId: explanation?.id ?? null,
      enterpriseId,
      name: enterprise?.name ?? '',
      uscc: enterprise?.usccNorm ?? null,
      district: enterprise?.district ?? recordDistrict.get(enterpriseId) ?? null,
      titleCode,
      direction,
      // **只从 `difference_reason.status` 取**:没有解释记录时用状态机的默认态。
      status: explanation?.status ?? 'not_queried',
      reasonCode: explanation?.reasonCode ?? null,
      reasonNote: explanation?.reasonNote ?? null,
      measureCode: explanation?.measureCode ?? null,
      measureNote: explanation?.measureNote ?? null,
      movedIn: explanation ? movedInOf(explanation) : null,
      verificationStatus: explanation?.verificationStatus ?? 'pending',
      recordedAt: explanation?.recordedAt ?? null,
      inCurrentDifference: derivedKeys.has(key),
      evidence: query
        ? {
            queryId: query.id,
            queriedAt: query.queriedAt,
            interface: query.interface,
            status: query.status,
            failureReason: query.failureReason,
            relationIds: relations.map((r) => r.id),
          }
        : null,
    }
  })

  return rows
}

export function getRosterEnterpriseDetail(db: Db, id: number): RosterEnterpriseDetail | null {
  const snap = readSnapshot(db)
  const enterprise = snap.enterprises.find((e) => e.id === id)
  if (!enterprise) return null

  const profile = buildProfile(enterprise, snap)
  const aliasNames = snap.aliases
    .filter((a) => a.enterpriseId === id && a.verificationStatus === 'confirmed')
    .map((a) => a.name)
    .filter((name, index, list) => list.indexOf(name) === index)
    .sort()

  const row = toRow(profile, aliasNames, deriveRosterState(profile, indexSnapshots(snap)))
  const events = profile.records.flatMap((r) => profile.eventsByRecord.get(r.id) ?? [])
  const eventIds = new Set(events.map((e) => e.id))

  const differenceRows = differenceUniverse(db, snap)

  const relations = snap.relations
    .filter((r) => r.enterpriseId === id)
    .sort((a, b) => a.queryId - b.queryId || a.sequenceNo - b.sequenceNo)
  // 该企业的平台查询 = 「有关系归到它」**∪**「查询键就是它」。
  // 后者是必须的:`no_record` / `failed` 这类查询**一条关系都不返回**,
  // 只看关系就会把它们整条丢掉 —— 而「查过、且平台没有」正是要看得见的四态之一。
  const ownKeys = new Set<string>()
  const uscc = normUscc(enterprise.usccNorm)
  if (uscc) ownKeys.add(uscc)
  ownKeys.add(`name:${enterprise.nameNorm}`)
  const queries = snap.queries
    .filter((q) => ownKeys.has(normUscc(q.queryKey) ?? q.queryKey) || relations.some((r) => r.queryId === q.id))
    .sort((a, b) => (a.queriedAt < b.queriedAt ? -1 : a.queriedAt > b.queriedAt ? 1 : 0) || a.id - b.id)
    .map((q): RosterPlatformQueryRow => ({
      id: q.id,
      interface: q.interface,
      queryKey: q.queryKey,
      rdjb: q.rdjb,
      queriedAt: q.queriedAt,
      status: q.status,
      failureReason: q.failureReason,
      relationCount: relations.filter((r) => r.queryId === q.id).length,
    }))

  return {
    enterprise: row,
    aliases: snap.aliases
      .filter((a) => a.enterpriseId === id)
      .sort((a, b) => a.nameNorm.localeCompare(b.nameNorm) || a.id - b.id)
      .map((a): RosterAliasRow => ({
        id: a.id,
        name: a.name,
        nameNorm: a.nameNorm,
        sourceKind: a.sourceKind,
        sourceRefId: a.sourceRefId,
        verificationStatus: a.verificationStatus,
        validFrom: a.validFrom,
        validTo: a.validTo,
        note: a.note,
      })),
    records: profile.records.map((r): RosterRecordRow => ({
      id: r.id,
      titleCode: r.titleCode,
      source: r.source,
      district: r.district,
      usccRaw: r.usccRaw,
      nameRaw: r.nameRaw,
      lifecycle: profile.lifecycleByTitle.get(r.titleCode)!,
    })),
    events: events
      .sort((a, b) => a.sortKey - b.sortKey || a.id - b.id)
      .map((e): RosterEventRow => ({
        id: e.id,
        recordId: e.recordId,
        eventType: e.eventType,
        year: e.year,
        batchSeq: e.batchSeq,
        decidedYear: e.decidedYear,
        reviewOutcome: e.reviewOutcome,
      })),
    evidence: snap.evidence
      .filter((v) => eventIds.has(v.recordEventId))
      .sort((a, b) => a.recordEventId - b.recordEventId || a.id - b.id)
      .map((v): RosterEvidenceRow => ({
        eventId: v.recordEventId,
        sourceFile: v.sourceFile,
        attachment: v.attachment,
        listNo: v.listNo,
        page: v.page,
      })),
    differences: differenceRows
      .filter((r) => r.enterpriseId === id)
      .sort((a, b) => titleRank(a.titleCode) - titleRank(b.titleCode) || a.direction.localeCompare(b.direction)),
    platform: {
      queries,
      relations: relations.map((r): RosterPlatformRelationRow => ({
        id: r.id,
        queryId: r.queryId,
        sequenceNo: r.sequenceNo,
        relationKey: r.relationKey,
        usccRaw: r.usccRaw,
        nameRaw: r.nameRaw,
        province: r.province,
        status: r.status,
        batch: r.batch,
        declareKind: r.declareKind,
        appliedAt: r.appliedAt,
        awardBatchLabel: r.awardBatchLabel,
        year: r.year,
        matchBasis: r.matchBasis,
        verificationStatus: r.verificationStatus,
      })),
    },
  }
}

// ---------------------------------------------------------------------------
// §7.3 差异与解释
// ---------------------------------------------------------------------------

export interface RosterDifferenceFilter {
  title?: string[]
  direction?: ComparisonDirection[]
  status?: string[]
  reason?: string[]
  /**
   * 企业名称 / **已确认**曾用名 / 统代关键词(RL-17 增量)。
   *
   * 合并后台账只有一个搜索框,三个视图共用。原来总表的搜索在两个页签间共享,
   * 但差异查询根本不读 `q` —— 切到「差异与原因」再搜,结果是**静默不筛**,
   * 看到的是没过滤的列表。这里补上,口径与总表逐字一致
   * (`normalizeName` + 仅 `confirmed` 别名 + 统代子串)。
   */
  q?: string
  page?: number
  pageSize?: number
}

export interface RosterDifferencesResult {
  rows: RosterDifferenceRow[]
  /** 当前筛选下,每称号 × 每方向的条数(桶恒在,缺省为 0)。 */
  counts: Record<string, Record<ComparisonDirection, number>>
  /** 当前筛选下的条数(不受分页影响)。 */
  total: number
  page: number
  pageSize: number
}

/**
 * 差异与解释。**按 `(企业 × 称号 × 方向)` 出当前解释**;两个方向都能筛。
 * `counts` 与筛选同口径、先于分页。
 */
export function listRosterDifferences(db: Db, filter: RosterDifferenceFilter = {}): RosterDifferencesResult {
  const snap = readSnapshot(db)
  const differenceRows = differenceUniverse(db, snap)

  // 别名:只带 `confirmed`(契约 §1.2),与总表的搜索口径同一处规则。
  const confirmedAliases = new Map<number, string[]>()
  for (const alias of snap.aliases) {
    if (alias.verificationStatus !== 'confirmed') continue
    const list = confirmedAliases.get(alias.enterpriseId) ?? []
    if (!list.includes(alias.name)) list.push(alias.name)
    confirmedAliases.set(alias.enterpriseId, list)
  }
  const needle = filter.q?.trim() ? normalizeName(filter.q) : null
  const usccNeedle = filter.q?.trim() ? filter.q.trim().toUpperCase() : null

  const rows = differenceRows
    .filter((row) => {
      if (filter.title?.length && !filter.title.includes(row.titleCode)) return false
      if (filter.direction?.length && !filter.direction.includes(row.direction)) return false
      if (filter.status?.length && !filter.status.includes(row.status)) return false
      if (filter.reason?.length && !(row.reasonCode != null && filter.reason.includes(row.reasonCode))) return false
      if (needle || usccNeedle) {
        const hit =
          (needle != null && normalizeName(row.name).includes(needle)) ||
          (needle != null &&
            (confirmedAliases.get(row.enterpriseId) ?? []).some((alias) =>
              normalizeName(alias).includes(needle),
            )) ||
          (usccNeedle != null && (row.uscc ?? '').toUpperCase().includes(usccNeedle))
        if (!hit) return false
      }
      return true
    })
    .sort(
      (a, b) =>
        titleRank(a.titleCode) - titleRank(b.titleCode) ||
        a.direction.localeCompare(b.direction) ||
        a.name.localeCompare(b.name) ||
        a.enterpriseId - b.enterpriseId,
    )

  const counts = Object.fromEntries(
    TITLE_ORDER.map((code) => [code, { missing_in_miit: 0, extra_in_miit: 0 }]),
  ) as Record<string, Record<ComparisonDirection, number>>
  for (const row of rows) {
    counts[row.titleCode] ??= { missing_in_miit: 0, extra_in_miit: 0 }
    counts[row.titleCode]![row.direction] += 1
  }

  const { page, pageSize } = pageOf(filter)
  return {
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
    counts,
    total: rows.length,
    page,
    pageSize,
  }
}
