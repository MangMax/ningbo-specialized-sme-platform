/**
 * **年度名录增量的预览投影**(RL-07,契约 §8.11)。
 *
 * ── 位置:在 RL-11 的统一写入 API **之上**,不重写它 ──────────────────────
 * 「会发生什么」本来就有唯一一份实现:`planRosterImport`(RL-11/RL-18/RL-19)。
 * 本文件只做三件它没做的事,而且一件都不改它的语义:
 *
 *  1. 把一次年度更新当成**一批**来源文件(包里的每一项还是一条 §8.1 请求);
 *  2. 把计划项翻成**逐项可看**的分类与错误(页面要能逐条对照);
 *  3. 算出**总表增减**:叠加新快照之后,谁离开当前总表、谁因为公布历史留下、
 *     谁因为接口失败只能算待核。这一条的判据不是新写的 —— 派生状态仍然只由
 *     `deriveRosterState` 一份实现给出,这边只做「叠加」(`projectRosterStates`)。
 *
 * ── 这个入口**一行都不写**(比 §8.1 的预检更严)────────────────────────
 * 契约 §8.1 的 `/preflight` 会落一条 `status='preflight'` 的 `import_batch`;
 * 本入口连那条都不写。理由有两条,都是硬的:
 *  - 预览**不该有副作用**:同一个键连按两次「预览」,不产生任何可观察差异;
 *  - RL-19 的事故形态正是「预检**覆写**了已提交批次的记账」,于是批次行里留下
 *    「预检说改 N 行、摘要说改了 0 行」的自相矛盾记录(§8.9.2)。**不写**就永远不会覆写。
 * 所以已 `committed` 的幂等键在这里**如实报零**(同键 `commit` 一行不写,§8.2),
 * 并带上 `batchStatus: 'committed'`;要补收敛走 `POST …/replay`(§8.9.3)。
 */
import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import {
  classifyPlannedItem,
  queryKeyMatchesEnterprise,
  sumCounts,
  zeroCounts,
  type AnnualIncrementBundle,
  type AnnualPreviewCounts,
  type AnnualPreviewEntry,
  type AnnualPreviewItem,
  type AnnualPreviewResponse,
  type AnnualRosterDelta,
  type AnnualRosterRow,
} from '../../lib/roster/annual-increment'
import { nextSyntheticBatchIds, projectRosterStates, type ProjectedSnapshot } from '../../lib/roster/enterprise-roster'
import type { RosterImportRequest } from '../../lib/roster-import-client'
import { findBatchByKey, planRosterImport, validateImportRequest } from './roster-import'

type Db = BetterSQLite3Database<typeof schema>

/** 一年的年度更新是「1 份公布文件 + 3 张导出表」量级;超过这个数是调用方接错了(不是业务约束)。 */
const MAX_ANNUAL_ENTRIES = 32

const EMPTY_PROJECTION: ProjectedSnapshot = { batches: [], rows: [] }

export type AnnualBundleValidation =
  | { ok: true; value: AnnualIncrementBundle }
  | { ok: false; status: number; message: string }

/**
 * 校验一次年度更新的载荷包。
 *
 * 收两种写法,因为它们描述的是同一件事:
 *  - `{ year?, entries: [ …§8.1 请求… ] }` —— 显式的包;
 *  - 单条 §8.1 请求(带 `idempotencyKey`)—— 一次只更新一份文件时的简写。
 * 每一项都走**同一份** `validateImportRequest`,不在这里另写一套判据。
 */
export function validateAnnualBundle(raw: unknown): AnnualBundleValidation {
  if (!isObject(raw)) return { ok: false, status: 400, message: '请求体必须是 JSON 对象' }

  const rawEntries = Array.isArray(raw.entries) ? raw.entries : 'idempotencyKey' in raw ? [raw] : null
  if (!rawEntries) {
    return { ok: false, status: 400, message: '缺少 entries（一次年度更新的来源文件清单）或单条 §8.1 请求' }
  }
  if (rawEntries.length === 0) return { ok: false, status: 400, message: 'entries 为空：年度增量至少要有一份来源文件' }
  if (rawEntries.length > MAX_ANNUAL_ENTRIES) {
    return { ok: false, status: 400, message: `entries 最多 ${MAX_ANNUAL_ENTRIES} 项，收到 ${rawEntries.length}` }
  }
  const entries: RosterImportRequest[] = []
  for (let i = 0; i < rawEntries.length; i += 1) {
    const validated = validateImportRequest(rawEntries[i])
    if (!validated.ok) {
      return { ok: false, status: validated.status, message: `entries[${i}]：${validated.message}` }
    }
    entries.push(validated.value)
  }
  return { ok: true, value: { year: optionalInt(raw.year), entries } }
}

// ---------------------------------------------------------------------------
// 预览
// ---------------------------------------------------------------------------

export function previewAnnualIncrement(db: Db, bundle: AnnualIncrementBundle): AnnualPreviewResponse {
  const prepared = bundle.entries.map((request, index) => prepareEntry(db, request, index))
  const entries = prepared.map((item) => item.entry)
  const totals = sumCounts(entries.map((entry) => entry.counts))
  const announced = announcedEnterpriseIds(db, prepared.flatMap((item) => item.announcedIds))
  const roster = projectRosterDelta(db, bundle.entries, announced)
  const anyWillApply = entries.some((entry) => entry.willApply)
  const blockedReason = annualBlockedReason(entries, totals, anyWillApply)

  return { entries, totals, roster, applyable: blockedReason === null, blockedReason }
}

function annualBlockedReason(
  entries: AnnualPreviewEntry[],
  totals: AnnualPreviewCounts,
  anyWillApply: boolean,
): string | null {
  if (totals.conflicts > 0) {
    return `有 ${totals.conflicts} 项不合法：整批不会落任何业务数据（逐项错误见下表）。修好载荷后按同一幂等键重来即可。`
  }
  if (!anyWillApply) {
    const allCommitted = entries.length > 0 && entries.every((entry) => entry.batchStatus === 'committed')
    return allCommitted
      ? '这一批的幂等键在库里都已经是「已提交」：同键再提交一行都不会写（幂等）。要修出处指针请走 POST /api/roster/import/replay。'
      : '这些幂等键此刻都不会写入任何东西（每一项都是「无变化」）。'
  }
  return null
}

interface PreparedEntry {
  entry: AnnualPreviewEntry
  /** 本批将给它建/写 **jxj** 记录的企业 id(计划项自报,不另写一套身份解析)。 */
  announcedIds: number[]
}

/** 一项来源文件的预览。**只读**:计划算一遍、批次状态读一次,不写任何行。 */
function prepareEntry(db: Db, request: RosterImportRequest, index: number): PreparedEntry {
  const batch = findBatchByKey(db, request.idempotencyKey)
  const batchStatus: AnnualPreviewEntry['batchStatus'] = batch
    ? (batch.status as AnnualPreviewEntry['batchStatus'])
    : 'none'

  const base = {
    index,
    idempotencyKey: request.idempotencyKey,
    sourceKind: request.sourceKind,
    sourceIdentity: request.sourceIdentity,
    batchStatus,
  }

  // 已提交的键:**不重跑计划**。同键 commit 直接返回既有摘要、一行不写(§8.2),
  // 对它报一份「会改 N 行」的计划是假话(§8.9.2),而且要真算出来也不便宜。
  if (batchStatus === 'committed') {
    return { entry: { ...base, counts: zeroCounts(), items: [], willApply: false }, announcedIds: [] }
  }

  const plan = planRosterImport(db, request, { batchId: batch?.id })
  const names = resolveEnterpriseNames(db, request, plan)
  const items: AnnualPreviewItem[] = plan.items.map((planned) => {
    const enterpriseId = optionalInt(planned.item.detail?.enterpriseId)
    return {
      entryIndex: index,
      class: classifyPlannedItem({ action: planned.action, kind: planned.item.kind, ok: planned.item.ok }),
      kind: planned.item.kind,
      ref: planned.item.ref,
      ok: planned.item.ok,
      review: planned.review,
      error: planned.item.error ?? null,
      titleCode: optionalString(planned.item.detail?.titleCode),
      enterpriseName:
        (enterpriseId != null ? names.byId.get(enterpriseId) : null) ??
        names.byRef.get(planned.item.ref) ??
        null,
    }
  })

  // 计数:口径沿用契约 §8.5 的预检计数(计数单位 = 计划项),但**按分类分桶**
  // —— `add`/`update`/`merge`/`unchanged` 四桶互斥,再加 `review`/`conflicts`/`candidates`。
  // 这一条必须守住:计划里的**冲突项**带的是 `action:'skip'`,不加 `ok` 判据就会
  // 同时计进 `unchanged` —— 于是页面上「无变化 1 / 冲突 1」讲的是**同一行**,
  // 而这一页的全部职责正是把「会发生什么」说准(§8.11.1 承诺逐项分类与计划项一一对应)。
  const counts: AnnualPreviewCounts = {
    add: plan.items.filter((p) => p.item.ok && p.action === 'add').length,
    update: plan.items.filter((p) => p.item.ok && p.action === 'update').length,
    merge: plan.items.filter((p) => p.item.ok && p.item.kind === 'merge').length,
    unchanged: plan.items.filter((p) => p.item.ok && p.action === 'skip').length,
    review: plan.items.filter((p) => p.review).length,
    conflicts: plan.conflicts.length,
    candidates: plan.items.filter((p) => p.item.kind === 'duplicate_candidate').length,
    evidenceRepoints: plan.items.reduce((n, p) => n + (p.repoints ?? 0), 0),
  }

  const announcedIds = plan.items
    .filter(
      (planned) =>
        planned.item.kind === 'record' && planned.item.ok && optionalString(planned.item.detail?.source) === 'jxj',
    )
    .map((planned) => optionalInt(planned.item.detail?.enterpriseId))
    .filter((id): id is number => id != null)

  return { entry: { ...base, counts, items, willApply: planWillApply(plan) }, announcedIds }
}

/** 有冲突 ⇒ 整批 `failed`;计划里一项都没有 ⇒ 点了应用也不会写任何东西。 */
function planWillApply(plan: { items: unknown[]; conflicts: unknown[] }): boolean {
  return plan.conflicts.length === 0 && plan.items.length > 0
}

/**
 * 逐项明细里的**企业名**:能取到的就取,取不到留空 —— **不猜**。
 *
 * 两个来源,都用写入侧已有的东西:
 *  - 计划项自己报的 `enterpriseId`(企业已在库里)⇒ 按 id 一次性批量查名;
 *  - 本批**新建**的企业(id 还是 `null`)⇒ 按计划项的 `ref`(`record:N`)回指载荷里那一条。
 */
function resolveEnterpriseNames(
  db: Db,
  request: RosterImportRequest,
  plan: { items: Array<{ item: { ref: string; detail?: Record<string, unknown> } }> },
): { byId: Map<number, string>; byRef: Map<string, string> } {
  const ids = new Set<number>()
  const byRef = new Map<string, string>()
  const records = Array.isArray(request.payload?.announcement?.records) ? request.payload.announcement.records : []

  for (const planned of plan.items) {
    const enterpriseId = optionalInt(planned.item.detail?.enterpriseId)
    if (enterpriseId != null) ids.add(enterpriseId)
    // 归并项的计划期 `ref` 形如 `merge:375->7289` —— 两头的 id 都在里面。
    if (planned.item.ref.startsWith('merge:')) {
      for (const part of planned.item.ref.slice('merge:'.length).split('->')) {
        const id = optionalInt(Number(part))
        if (id != null) ids.add(id)
      }
    }
    // `record:N` / `record:N#i` ⇒ 载荷里那一条记录的企业名(本批新建的企业只有这里能拿到名字)。
    const recordIndex = /^record:(\d+)/.exec(planned.item.ref)
    if (recordIndex) {
      const name = optionalString(records[Number(recordIndex[1])]?.enterprise?.name)
      if (name) byRef.set(planned.item.ref, name)
    }
  }

  const byId = new Map<number, string>()
  if (ids.size > 0) {
    for (const row of db
      .select({ id: schema.enterprise.id, name: schema.enterprise.name })
      .from(schema.enterprise)
      .where(inArray(schema.enterprise.id, [...ids]))
      .all()) {
      byId.set(row.id, row.name)
    }
  }
  return { byId, byRef }
}

// ---------------------------------------------------------------------------
// 总表增减(投影)
// ---------------------------------------------------------------------------

/**
 * 把「这批载荷落库之后,当前总表会怎么变」算出来。
 *
 * 三个集合,各由**一个**判据给出:
 *  1. `anchorLost` = **因这张新快照而失去锚点**的企业:叠加前后 `inLatestSnapshot` 由真变假
 *     (它此前至少在最新快照里出现过,叠加后一张都不在)。这一条纯看快照 —— 谁「只由平台
 *     引入」的正证据也在这里。
 *  2. `removed` = 其中**真的会离开当前总表**的那些:叠加前后的 `rosterState` 由 `current`
 *     变 `removed_platform_only`(判据仍然只有 `deriveRosterState` 一份)。有 jxj 记录的企业
 *     在这里天然出局 —— 那正是票面第 5 条「曾出现在正式公布文件的企业不因平台缺失而删除」。
 *  3. `keptByAnnouncement` = `anchorLost` 里被第 2 条排除的那些(有公布历史而留下)。
 *     ★ 必须用 1 与 2 的差,不能拿 `state` 前后比:有公布历史的家庭外还有**本批**才拿到
 *     jxj 记录的(计划项自报,见 `announcedEnterpriseIds`),以及「去掉 jxj 后一条记录都没有」
 *     因而落进判据 3 的企业 —— 只比 `state` 会把这两种都漏掉。
 *  4. 第 2 条的结果再按**接口重查的结果**分流:这次重查**失败**过(`status='failed'`)的
 *     ⇒ 待核、**不得据此删除**(票面第 7 条);否则 ⇒ 将移出。
 */
function projectRosterDelta(
  db: Db,
  entries: RosterImportRequest[],
  announced: Set<number>,
): AnnualRosterDelta {
  const projected = projectSnapshots(db, entries)
  const before = projectRosterStates(db, EMPTY_PROJECTION)
  const after = projectRosterStates(db, projected)

  const lostAnchor: number[] = []
  const flipped: number[] = []
  for (const [enterpriseId, state] of after) {
    const previous = before.get(enterpriseId)
    if (!previous) continue
    if (previous.inLatestSnapshot && !state.inLatestSnapshot) lostAnchor.push(enterpriseId)
    if (previous.state === 'current' && state.state === 'removed_platform_only') flipped.push(enterpriseId)
  }
  const flippedSet = new Set(flipped)
  // 3 与 2 的差:锚点没了、但按派生状态仍在当前总表里的 ⇒ 是公布历史把它留住的。
  const keptIds = lostAnchor.filter((enterpriseId) => !flippedSet.has(enterpriseId))
  if (lostAnchor.length === 0) {
    return { removed: [], blocked: [], keptByAnnouncement: [], counts: { removed: 0, blocked: 0, keptByAnnouncement: 0 } }
  }

  const rows = db.select().from(schema.enterprise).where(inArray(schema.enterprise.id, lostAnchor)).all()
  const byId = new Map(rows.map((row) => [row.id, row]))
  const anchorBatch = latestAnchorBatch(db, before, projected)
  const failedKeys = failedQueryKeys(entries)

  const removed: AnnualRosterRow[] = []
  const blocked: AnnualRosterRow[] = []
  const keptByAnnouncement: AnnualRosterRow[] = []
  const toRow = (enterpriseId: number): AnnualRosterRow | null => {
    const enterprise = byId.get(enterpriseId)
    if (!enterprise) return null
    return {
      enterpriseId,
      name: enterprise.name,
      uscc: enterprise.usccNorm ?? null,
      district: enterprise.district ?? null,
      snapshot: anchorBatch.get(enterpriseId) ?? null,
    }
  }

  // ③ 锚点没了但有公布历史 ⇒ 保留(只更新平台状态)。
  for (const enterpriseId of keptIds) {
    const row = toRow(enterpriseId)
    if (row) keptByAnnouncement.push(row)
  }
  // ② 真会离开当前总表的,再按接口重查的结果分流。
  for (const enterpriseId of flipped) {
    const row = toRow(enterpriseId)
    if (!row) continue
    const usccNorm = row.uscc ? normalizeUscc(row.uscc) : null
    const nameNorm = byId.get(enterpriseId)?.nameNorm ?? ''
    // 本批**才**给它建 jxj 记录的:叠加后的状态算的是**库现状**,算不到这一批将新建的记录
    // —— 所以它会落在 `flipped` 里,但它其实不会被移出(提交之后就有公布历史了)。
    if (announced.has(enterpriseId)) {
      keptByAnnouncement.push(row)
      continue
    }
    if (failedKeys.some((key) => queryKeyMatchesEnterprise(key, { usccNorm, nameNorm }))) blocked.push(row)
    else removed.push(row)
  }

  const byName = (a: AnnualRosterRow, b: AnnualRosterRow) =>
    a.name.localeCompare(b.name, 'zh') || a.enterpriseId - b.enterpriseId
  removed.sort(byName)
  blocked.sort(byName)
  keptByAnnouncement.sort(byName)
  return {
    removed,
    blocked,
    keptByAnnouncement,
    counts: { removed: removed.length, blocked: blocked.length, keptByAnnouncement: keptByAnnouncement.length },
  }
}

/**
 * 载荷里的导出快照 → 一份**尚未写入**的投影。
 *
 * 同 `(称号, 年度, sha256)` 的批次库里已经有时,**用它的真 id**:写入侧命中唯一键不会新建
 * 批次,拿合成 id 反而会把它抬成「该称号最新的那一张」,于是在别的年度有锚点的企业会被
 * 误判成移出。库里没有时才给合成 id(必然大于库内全部 id ⇒ 同年并列时它就是更新的那一版,
 * 与写入侧「后写的那版 id 更大」一致)。
 */
function projectSnapshots(db: Db, entries: RosterImportRequest[]): ProjectedSnapshot {
  const snapshots = entries.flatMap((entry) => (entry.payload?.exportSnapshot ? [entry.payload.exportSnapshot] : []))
  if (snapshots.length === 0) return EMPTY_PROJECTION

  const existing = db.select().from(schema.platformExportBatch).all()
  const synthetic = nextSyntheticBatchIds(db, snapshots.length)
  let next = 0
  const batches: ProjectedSnapshot['batches'] = []
  const rows: ProjectedSnapshot['rows'] = []
  for (const snapshot of snapshots) {
    const known = existing.find(
      (batch) =>
        batch.titleCode === snapshot.titleCode && batch.year === snapshot.year && batch.sha256 === snapshot.sha256,
    )
    const batchId = known?.id ?? synthetic[next++]!
    batches.push({ id: batchId, titleCode: snapshot.titleCode, year: snapshot.year })
    for (const row of Array.isArray(snapshot.rows) ? snapshot.rows : []) {
      rows.push({ batchId, usccRaw: optionalString(row?.usccRaw), nameRaw: optionalString(row?.nameRaw) })
    }
  }
  return { batches, rows }
}

/**
 * 叠加后**会有 jxj 记录**的企业:库里已有 jxj 记录的,加上本批计划项自报的那些 id。
 * 「谁有公布历史」这件事因此仍然只有一份判据(写入侧的身份规则)。
 */
function announcedEnterpriseIds(db: Db, fromPlans: number[]): Set<number> {
  const ids = new Set(
    db
      .select({ enterpriseId: schema.record.enterpriseId })
      .from(schema.record)
      .where(eq(schema.record.source, 'jxj'))
      .all()
      .map((row) => row.enterpriseId),
  )
  for (const id of fromPlans) ids.add(id)
  return ids
}

/**
 * 企业 → 它**上次出现在最新快照里**的那张(叠加前),给页面标出「上次出现在哪张表」。
 *
 * 取的是 `anchorBatchIds`(出现过的批次 ∩ **当时算最新**的那些)里 id 最大的那张 ——
 * 不是「它出现过的最后一张」:后者可能是某个**早已不是最新**的旧版本批次,拿它当
 * 「还在不在最新快照里」的坐标会把结论说反(而这个坐标正是「只由平台引入」唯一的一条正证据)。
 */
function latestAnchorBatch(
  db: Db,
  before: Map<number, { state: string; batchIds: number[]; anchorBatchIds: number[] }>,
  projected: ProjectedSnapshot,
): Map<number, { batchId: number; titleCode: string; year: number }> {
  const info = new Map<number, { titleCode: string; year: number }>()
  for (const batch of db.select().from(schema.platformExportBatch).all()) {
    info.set(batch.id, { titleCode: batch.titleCode, year: batch.year })
  }
  for (const batch of projected.batches) info.set(batch.id, { titleCode: batch.titleCode, year: batch.year })

  const out = new Map<number, { batchId: number; titleCode: string; year: number }>()
  for (const [enterpriseId, state] of before) {
    // `anchorBatchIds` 升序 ⇒ 最后一张就是「最近一次仍在最新快照里的出现」。
    const batchId = state.anchorBatchIds[state.anchorBatchIds.length - 1]
    if (batchId == null) continue
    const meta = info.get(batchId)
    if (!meta) continue
    out.set(enterpriseId, { batchId, titleCode: meta.titleCode, year: meta.year })
  }
  return out
}

/** 本批载荷里**声明为失败**的那些查询的键(`failed` ≠ `no_record`,契约 §3.1)。 */
function failedQueryKeys(entries: RosterImportRequest[]): string[] {
  const keys: string[] = []
  for (const entry of entries) {
    for (const query of Array.isArray(entry.payload?.platformQueries) ? entry.payload.platformQueries : []) {
      if (optionalString(query?.status) !== 'failed') continue
      const key = optionalString(query?.queryKey)
      if (key) keys.push(key)
    }
  }
  return keys
}

// ---------------------------------------------------------------------------
// 小工具(与写入侧同一套 isObject / optional* 口径)
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function optionalInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}
