import { projectUsccTargets, pageUsccChecklist, type DictionaryEntry, projectUsccDictionary, type UsccResearchOptions, type UsccResearchReport, prepareUsccResearch, projectUsccResearch } from './uscc-research-model'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { planRosterImport } from './roster-import'
import type { UsccChecklistFilter, UsccChecklistResult, UsccChecklistRow } from '../../lib/roster/uscc-research'
import { currentEnterpriseIdentity } from '../../lib/roster/enterprise-identity'
import { readUsccTargets, usccResearchEvidence } from './uscc-research-read'
type Db = BetterSQLite3Database<typeof schema>
// ---------------------------------------------------------------------------
// 待查清单（票面：企业名 / 地区 / 称号 / 来源文件与可用页码 / 接口匹配追溯）
// ---------------------------------------------------------------------------

/**
 * 取**全部**仍缺统代的企业（不分页）—— 清单与计划共用这一处取数。
 *
 * 独立轻量投影先筛缺统代且当前有效的目标，再批量取这些目标的出处与查询追溯。
 * 清单与计划共用同一份目标；清单分页不缩小计划范围，平台原文不进入此聚合。
 */
export function collectUsccTargets(
  db: Db,
  filter: Omit<UsccChecklistFilter, 'page' | 'pageSize'> = {},
): UsccChecklistRow[] {
  return projectUsccTargets(readUsccTargets(db, filter))
}
export function listUsccChecklist(db: Db, filter: UsccChecklistFilter = {}): UsccChecklistResult {
  return pageUsccChecklist(collectUsccTargets(db, filter), filter)
}
/**
 * 建**匹配字典**：库里全部**有统代**企业 + 它们的**已确认**曾用名。
 *
 * 为什么必须含已确认曾用名：用户 2026-10-16 明确「这次过后这个名称就会进入曾用名表中，
 * 之后就能匹配上了」—— 曾用名表**就是**匹配字典的一部分；`pending` 的别名**不入字典**
 * （契约 §1.2：未确认的别名不参与搜索/归并，证据不足宁可待核）。
 */
function buildDictionary(db: Db): DictionaryEntry[] {
  return projectUsccDictionary(
    db.select({ id: schema.enterprise.id, name: schema.enterprise.name, nameNorm: schema.enterprise.nameNorm, usccNorm: schema.enterprise.usccNorm, district: schema.enterprise.district }).from(schema.enterprise).where(currentEnterpriseIdentity(db)).all(),
    db.select({ enterpriseId: schema.enterpriseAlias.enterpriseId, name: schema.enterpriseAlias.name, nameNorm: schema.enterpriseAlias.nameNorm }).from(schema.enterpriseAlias).where(eq(schema.enterpriseAlias.verificationStatus, 'confirmed')).all(),
  )
}
/**
 * 出一份**只读**的补录计划：清单 → 库内候选 → 平台原始关系证据 → 可提交载荷。
 *
 * ── 一个目标怎么落桶（四桶互斥、逐条有理由）──────────────────────────────
 *
 * | 情形 | 结论 |
 * |---|---|
 * | 公开来源 claim 带来一个**库里没人占用**的合法统代 | `filled`（`usccBackfills`，路径二） |
 * | claim 的代码被别的企业占用 / 格式不合法 / 地区不符 | `conflict` |
 * | claim 证据三要素不齐 | `manual` |
 * | 库内核心词**搜不到**候选 | `not_found` |
 * | 有候选，但**没有一个**被平台原始关系逐字证实 | `manual`（**不按名字挑最像的**） |
 * | **恰好一个**候选被逐字证实 | `filled`（`merges`，路径一） |
 * | **两个及以上**不同统代都被逐字证实 | `conflict`（**同名多主体**，不猜） |
 *
 * ── 同一轮内也要收敛 ───────────────────────────────────────────────────
 * 第 ⑤ 步写出的曾用名**立刻进字典**：某目标一旦被补齐，它的名字就成为规范行的一条已确认曾用名，
 * 于是**本轮**后续目标的核心词检索就能命中它（用户：「之后就能匹配上了」）。实现方式是
 * 反复扫未决目标直到某一轮没有任何新补齐 —— 不把收敛推到「下一次运行」。
 *
 * ── 只读 ───────────────────────────────────────────────────────────────
 * 全程不写库；`merges` / `usccBackfills` 只是**载荷**，落库仍由统一导入 API 完成。
 */
export function planUsccResearch(db: Db, options: UsccResearchOptions = {}): UsccResearchReport {
  const allTargets = options.targets ? [...options.targets] : collectUsccTargets(db, options.filter ?? {})
  const inputs = prepareUsccResearch(allTargets, buildDictionary(db), options)
  const evidence = usccResearchEvidence(db)
  evidence.load(inputs.codes)
  const plan = projectUsccResearch(inputs, evidence, options)
  let step = plan.next()
  while (!step.done) step = plan.next(planRosterImport(db, step.value).conflicts)
  return step.value
}
export { projectUsccTargets, pageUsccChecklist, type UsccTargetSnapshot, projectUsccDictionary, findLibraryCandidates, type UsccResearchReady, type UsccResearchPending, type UsccResearchReport, type UsccResearchOptions, usccResearchIdempotencyKey, USCC_RESEARCH_SOURCE_IDENTITY, prepareUsccResearch, projectUsccResearch } from './uscc-research-model'
