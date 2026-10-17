/**
 * 出处页码的**补录接口**(RL-10):把 `record_evidence.page` 按**已核对的页码**写进库。
 *
 * ── 为什么要有这个入口(而不是靠导入载荷)──────────────────────────────
 *
 * 统一导入 API(契约 §8.3)的 `evidence[]` **本来就能带 `page`** —— 但那只对**今后**的
 * 导入有效。库里已有的 21,189 条出处(`record_evidence`)是在这个字段还没人填的时候
 * 落下的,**每一行的 `page` 都是 NULL**;而补页码是**对既有行的更新**,不是一次新的导入
 * (它不改企业/记录/事件,也不该再造一条批次账)。所以单独开一条最小的写入面。
 *
 * ── 判据在哪一层 ──────────────────────────────────────────────────────
 *
 * **定位与三态全在 `lib/roster/evidence-page.ts` 的纯函数里**(`planEvidencePages`),
 * 本文件只做三件事:读候选行 → 调纯函数 → 把结论写回库(或 dry-run 时只报结论)。
 * 这样「裸序号拒收」「分节歧义留空待核」这些判据可以脱离 HTTP 与库被单测钉住,
 * 而 HTTP 面又可以被真实端口回放(见 `tests/helpers/roster-http-server.ts`)。
 *
 * 本文件**不 import h3**(读请求描述即可),理由与 `roster-import-http.ts` 顶部同一段。
 *
 * ── 写入是「逐条尽力」而不是整批事务 ────────────────────────────────────
 *
 * 与导入的「整批 committed / failed」**故意不同**:这里一批里混着「已核对好」与
 * 「还没核对」,后者的正确处置是**留空待核**,不是把前者一起回滚。所以每条独立判定:
 * 定得下来的写,定不下来的**一行不改**并在响应里逐条报原因。绝不会出现「猜一个填上」。
 */

import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import {
  isPageCapable,
  planEvidencePages,
  type EvidencePageCandidate,
  type EvidencePageEntry,
  type EvidencePagePlan,
} from '../../lib/roster/evidence-page'
import { authorizeRosterWrite } from './roster-import-http'
import { readPdfPageCount } from './pdf-pages'

type Db = BetterSQLite3Database<typeof schema>

export interface EvidencePagesHttpRequest {
  /** 大写 HTTP 方法;仅 POST 被接受。 */
  method: string
  headers: Record<string, string | undefined>
  /** 已解析的请求体(JSON);解析失败给 `null`。 */
  body: unknown
}

export interface EvidencePagesHttpResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

/**
 * 读出**候选出处行** —— 只取判定用得上的那几列,顺带把企业名与属地 join 进来。
 *
 * 只读、无副作用。**按来源文件收窄**(`inArray`),不在 JS 里筛全表:一次补录总是围绕
 * 一两份来源文件做的,而整库 `record_evidence` 有两万行 —— 逐个 `.all().filter()` 是把
 * 一次索引命中换成一次全表扫(与 `planExportSnapshot` 那处被点名的写法同一类)。
 */
export function readEvidencePageCandidates(db: Db, sourceFiles: readonly string[]): EvidencePageCandidate[] {
  const wanted = [...new Set(sourceFiles.filter((f) => typeof f === 'string' && f !== ''))]
  if (wanted.length === 0) return []

  return db
    .select({
      evidenceId: schema.recordEvidence.id,
      sourceFile: schema.recordEvidence.sourceFile,
      listNo: schema.recordEvidence.listNo,
      page: schema.recordEvidence.page,
      enterpriseId: schema.enterprise.id,
      enterpriseName: schema.enterprise.name,
      district: schema.record.district,
      // 企业自身属地也带上:界面上显示的有效属地是它优先(见 `EvidencePageCandidate`)。
      enterpriseDistrict: schema.enterprise.district,
    })
    .from(schema.recordEvidence)
    .innerJoin(schema.recordEvent, eq(schema.recordEvent.id, schema.recordEvidence.recordEventId))
    .innerJoin(schema.record, eq(schema.record.id, schema.recordEvent.recordId))
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .where(inArray(schema.recordEvidence.sourceFile, wanted))
    .all()
}

/** 入参里那些**来源文件**。用于把候选读窄,顺带做输入校验(非字符串/空的丢掉)。 */
function sourceFilesOf(entries: readonly EvidencePageEntry[]): string[] {
  const out = new Set<string>()
  for (const e of entries) {
    if (typeof e?.sourceFile === 'string' && e.sourceFile.trim() !== '') out.add(e.sourceFile.trim())
  }
  return [...out]
}

/** 一批里的条目形状校验。返回 `null` 表示形状可用;否则是给调用方的错误信封。 */
function entriesOf(body: unknown): { entries: EvidencePageEntry[]; dryRun: boolean } | { error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体必须是一个 JSON 对象:{ entries: [...], dryRun?: boolean }' }
  }
  const record = body as Record<string, unknown>
  if (!Array.isArray(record.entries)) {
    return { error: '缺少 entries(页码条目数组)' }
  }
  if (record.entries.length === 0) {
    return { error: 'entries 是空的 —— 没有要补的页码。' }
  }
  return { entries: record.entries as EvidencePageEntry[], dryRun: record.dryRun === true }
}

function summarize(plan: EvidencePagePlan, written: number, requested: number) {
  const seenEvidence = new Set<number>()
  let unchanged = 0
  for (const assignment of plan.assignments) {
    if (assignment.previous === assignment.page || seenEvidence.has(assignment.evidenceId)) unchanged += 1
    seenEvidence.add(assignment.evidenceId)
  }
  return {
    /** 入参给了几条。 */
    requested,
    /** 定得下来的(含本来就是这个值的)。 */
    assigned: plan.assignments.length,
    /** 其中**真的改了库**的行数(空操作不算)。 */
    written,
    /** 定得下来但无需重复写(已有相同页码或本请求里的重复 claim)。 */
    unchanged,
    /** 留空待核的条数 —— 一行没改。 */
    pending: plan.pending.length,
  }
}

/**
 * 处理一次补录请求。`db` 由调用方给(路由用 `useDb()`;测试用临时库),
 * `apiToken` 从运行时配置读(Nuxt:`useRuntimeConfig().apiToken`)。
 */
export async function handleEvidencePagesRequest(
  request: EvidencePagesHttpRequest,
  ctx: { db: Db; apiToken: string | null | undefined; filesDir?: string },
): Promise<EvidencePagesHttpResponse> {
  if (request.method !== 'POST') {
    return { status: 405, headers: { ...JSON_HEADERS, allow: 'POST' }, body: { message: '只接受 POST。' } }
  }

  const auth = authorizeRosterWrite(request, ctx.apiToken)
  if (!auth.ok) return { status: auth.status, headers: auth.headers, body: auth.body }

  const parsed = entriesOf(request.body)
  if ('error' in parsed) {
    return { status: 400, headers: JSON_HEADERS, body: { message: parsed.error } }
  }

  const candidates = readEvidencePageCandidates(ctx.db, sourceFilesOf(parsed.entries))
  const sourceFiles = sourceFilesOf(parsed.entries).filter(isPageCapable)
  const pageCounts = new Map<string, number | null>(
    await Promise.all(
      sourceFiles.map(async (sourceFile) => [
        sourceFile,
        ctx.filesDir ? await readPdfPageCount(ctx.filesDir, sourceFile) : null,
      ] as const),
    ),
  )
  const plan = planEvidencePages(parsed.entries, candidates, pageCounts)

  let written = 0
  if (!parsed.dryRun) {
    const writtenEvidence = new Set<number>()
    for (const a of plan.assignments) {
      if (a.previous === a.page || writtenEvidence.has(a.evidenceId)) continue
      ctx.db
        .update(schema.recordEvidence)
        .set({ page: a.page })
        .where(eq(schema.recordEvidence.id, a.evidenceId))
        .run()
      writtenEvidence.add(a.evidenceId)
      written += 1
    }
  }

  const summary = summarize(plan, written, parsed.entries.length)
  return {
    status: 200,
    headers: JSON_HEADERS,
    body: {
      /** `dry_run` = 只报结论没写库;`applied` = 已按结论写入(可能仍有待核项)。 */
      status: parsed.dryRun ? 'dry_run' : 'applied',
      summary,
      assignments: plan.assignments.map((a) => ({
        index: a.index,
        evidenceId: a.evidenceId,
        sourceFile: a.entry.sourceFile,
        listNo: a.entry.listNo,
        page: a.page,
        previous: a.previous,
        // 留档:`basis` 说明这个页码**怎么来的**,不参与判定。
        basis: a.entry.basis ?? null,
      })),
      pending: plan.pending.map((p) => ({
        index: p.index,
        sourceFile: p.entry?.sourceFile ?? null,
        listNo: p.entry?.listNo ?? null,
        page: p.entry?.page ?? null,
        reason: p.reason,
        detail: p.detail,
        candidateIds: p.candidateIds,
        sameListNo: p.sameListNo,
      })),
    },
  }
}
