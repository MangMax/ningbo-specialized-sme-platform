/**
 * RL-18 —— 写入侧**规模**用例：单批千条级平台查询不再随批内查询数平方增长。
 *
 * ── 为什么默认不跑（`ROSTER_IMPORT_SCALE=1` 才跑）─────────────────────────────
 * 这条用例要**先造一个已存在的平台查询存档**（每条带几十 KB 的 `raw_response`，
 * 复现真实运行的形状），再造一个千条级的批次。改前它在计划阶段就是 O(N²) 次整行读，
 * 单跑一次要分钟级 —— 放进默认 `pnpm test` 会把 20 秒的日常套件拖成几分钟，
 * 而它验证的是**规模行为**、不是日常回归，所以门控开、不默认跑。
 *
 * 手动跑（默认规模：存档 1000/批次 1000）：
 *
 * ```bash
 * ROSTER_IMPORT_SCALE=1 pnpm vitest run tests/roster-import-scale.test.ts
 * ```
 *
 * 规模可用环境变量调：
 *
 * ```bash
 * ROSTER_IMPORT_SCALE=1 ROSTER_IMPORT_SCALE_ARCHIVE=400 ROSTER_IMPORT_SCALE_BATCH=200 \
 *   pnpm vitest run tests/roster-import-scale.test.ts
 * ```
 *
 * ── 判据为什么是「预算 + 亚二次增长」而不是「不许整表扫」─────────────────────
 * 「有没有整表扫」是**实现细节**，绑上去的用例一重构就假红。这里断言的是用户可观察的
 * 两件事：① 千条级单批能在**秒级**跑完（改前是分钟级＝实质卡死）；② 规模翻 4 倍时
 * 耗时**不是** 16 倍（平方），留出足够宽的余量以免 CI 抖动误报。
 *
 * ── 覆盖了哪几轴 ────────────────────────────────────────────────────────────
 * 四条用例：**存档查询表**（计划阶段按唯一键找既有行，跑两次 —— 首写 + 换键重放）、
 * **空档纯写入**（让平方项占主导，才能从增长比看出形状）、
 * **企业表**（写入阶段每条关系按统代定位企业 —— 企业表是独立于本批的外部规模）。
 * 只压批次不压企业表就看不见最后那条路径。
 *
 * ── ⚠️ 当前只在**手动跑**时执行 ─────────────────────────────────────────────
 * 父代理 2026-10-16 裁决：不接进 CI（要不要为性能守单开一条 CI 作业是项目级决定，
 * 不在 RL-18）。所以默认 `pnpm test` 里这三条是 **skipped**（`describe.runIf` 让它
 * **可见**，而不是用顶层 `if` 藏掉）。要跑就照上面的命令。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import { normalizeName } from '../lib/domain'
import {
  commitRosterImport,
} from '../server/utils/roster-import'
import type { RosterImportRequest } from '../lib/roster-import-client'

/** 门控：默认不跑（见文件头）。 */
const SCALE_ENABLED = process.env.ROSTER_IMPORT_SCALE === '1'

/** 已存在的平台查询存档规模（条）。 */
const ARCHIVE_QUERIES = Number(process.env.ROSTER_IMPORT_SCALE_ARCHIVE ?? 1000)
/** 本批的查询条数（条）。 */
const BATCH_QUERIES = Number(process.env.ROSTER_IMPORT_SCALE_BATCH ?? 1000)
/** 存档里每条查询的 `raw_response` 字节数 —— 按票面「每条几十 KB」取的实测量级。 */
const RAW_RESPONSE_BYTES = 24_000
/** 本批每条查询带几条关系。 */
const RELATIONS_PER_QUERY = 4

/**
 * **企业表**的规模 —— 真实库实测 7352 行。
 *
 * 为什么要把它种进夹具：写入阶段每写一条平台关系，都要按 `usccRaw` 去企业表定位一次
 * （`enterpriseByExactUscc` → `findEnterpriseByUscc`）。企业表是**独立于本批**的外部规模，
 * 只压批次而不种企业，就看不见这条路径 —— 那正是 RL-18 收尾时补上的另一半。
 */
const ENTERPRISE_ROWS = Number(process.env.ROSTER_IMPORT_SCALE_ENTERPRISES ?? 7352)

/** 千条级单批的**计划 + 提交**总预算。改前是分钟级，改后是秒级，这里留足余量。 */
const BATCH_BUDGET_MS = 30_000

/**
 * **带企业表**时的预算。改后实测 ~0.6 s（见契约 §3.1c），给到 10 s 仍有十倍余量 ——
 * 而企业侧退回整表线性时这里是 **22 s 量级**，会当场判死。
 */
const ENTERPRISE_BUDGET_MS = 10_000

/**
 * vitest 的默认 `testTimeout` 是 5 秒 —— 对规模用例太短（即便改后也要几秒）。
 * 这里显式放宽到预算的 3 倍：**超时**与**超预算**是两件事，前者只是别把用例判假红。
 */
const CASE_TIMEOUT_MS = BATCH_BUDGET_MS * 3

const dirs: string[] = []

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-roster-scale-'))
  dirs.push(dir)
  return useDb({ dbPath: join(dir, 'roster.db') })
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/**
 * 造一个**已存在**的企业表：`count` 行，各带一个统代。
 *
 * 键前缀刻意用 `93…`，与本批关系里的 `usccRaw`（`92…`）**不重叠** —— 于是每条关系都要
 * 走一次「按统代定位、定位不到」的完整查找。命中与不命中在改前都要整表扫描，取不命中
 * 是因为它更贴近实情（新查到的企业还没进名录）。
 */
function seedEnterprises(db: ReturnType<typeof makeDb>, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const name = `存量企业${i}`
    db.insert(schema.enterprise)
      .values({
        name,
        nameNorm: normalizeName(name),
        usccNorm: `93${String(330200000000000 + i).padStart(16, '0')}`,
        qualityFlags: [],
      })
      .run()
  }
}

/** 一段形状像平台 HTML 表格的假响应（只为占字节，不参与任何解析）。 */
function fakeRawResponse(uscc: string): string {
  const head = `<table><tr><th>qymc</th><th>tyshxydm</th></tr><tr><td>企业${uscc}</td><td>${uscc}</td></tr>`
  return head + 'x'.repeat(Math.max(0, RAW_RESPONSE_BYTES - head.length)) + '</table>'
}

/**
 * 造一个**已存在**的平台查询存档：`count` 次查询，各带几十 KB 的 `raw_response`。
 * 这是**输入夹具**（不是被测行为），所以直插 drizzle。
 */
function seedArchive(db: ReturnType<typeof makeDb>, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const uscc = `91${String(330200000000000 + i).padStart(16, '0')}`
    const queryId = db
      .insert(schema.platformQuery)
      .values({
        interface: 'business_list',
        queryKey: uscc,
        rdjb: '3',
        queriedAt: '2026-10-15T00:00:00.000Z',
        status: 'success',
        rawResponse: fakeRawResponse(uscc),
      })
      .returning({ id: schema.platformQuery.id })
      .get().id
    db.insert(schema.platformRelation)
      .values({ queryId, sequenceNo: 1, relationKey: `ARC-${i}`, usccRaw: uscc, nameRaw: `存档企业${i}` })
      .run()
  }
}

/** 本批：`count` 条**新**查询（键与存档不重叠），每条带 `RELATIONS_PER_QUERY` 条关系。 */function scaleRequest(count: number, idempotencyKey: string): RosterImportRequest {
  return {
    idempotencyKey,
    sourceKind: 'alias_evidence',
    sourceIdentity: `scale/${count}`,
    payload: {
      platformQueries: Array.from({ length: count }, (_, i) => {
        const uscc = `92${String(330300000000000 + i).padStart(16, '0')}`
        return {
          interface: 'business_list' as const,
          queryKey: uscc,
          rdjb: '3',
          queriedAt: '2026-10-16T00:00:00.000Z',
          status: 'success' as const,
          rawResponse: fakeRawResponse(uscc),
          relations: Array.from({ length: RELATIONS_PER_QUERY }, (_, s) => ({
            sequenceNo: s + 1,
            relationKey: `NEW-${i}-${s}`,
            usccRaw: uscc,
            nameRaw: `本批企业${i}`,
            matchBasis: 'uscc' as const,
            verificationStatus: 'confirmed' as const,
          })),
        }
      }),
    },
  }
}

/** 跑一次「计划 + 提交」并计时。`planRosterImport` 由 `preflightRosterImport`/`commit` 内部调用。 */
function timedCommit(db: ReturnType<typeof makeDb>, request: RosterImportRequest) {
  const started = Date.now()
  const result = commitRosterImport(db, request)
  return { result, elapsedMs: Date.now() - started }
}

describe.runIf(SCALE_ENABLED)('RL-18 规模：单批千条级平台查询', () => {
  it(`存档 ${ARCHIVE_QUERIES} 条 + 单批 ${BATCH_QUERIES} 条查询能在预算内跑完`, () => {
    const db = makeDb()
    seedArchive(db, ARCHIVE_QUERIES)
    const request = scaleRequest(BATCH_QUERIES, 'scale/batch#sha256:rl18')

    const { result, elapsedMs } = timedCommit(db, request)

    // 逐项结果与写入语义在规模下不变：整批 committed、每条查询一行、关系数如实。
    expect(result.status).toBe('committed')
    expect(result.summary.failed).toBe(0)
    expect(result.items).toHaveLength(BATCH_QUERIES)
    // 每条查询：1 行查询 + RELATIONS_PER_QUERY 行关系。
    expect(result.summary.written).toBe(BATCH_QUERIES * (1 + RELATIONS_PER_QUERY))

    // eslint-disable-next-line no-console
    console.log(
      `[RL-18 规模] 存档=${ARCHIVE_QUERIES} 批次=${BATCH_QUERIES} ` +
        `raw_response=${RAW_RESPONSE_BYTES}B 计划+提交=${elapsedMs}ms`,
    )
    expect(elapsedMs).toBeLessThan(BATCH_BUDGET_MS)
  }, CASE_TIMEOUT_MS)

  it('同内容换幂等键重放：每个计划项都命中既有行，一行都不写', () => {
    const db = makeDb()
    seedArchive(db, ARCHIVE_QUERIES)
    const request = scaleRequest(BATCH_QUERIES, 'scale/replay#sha256:rl18')
    const { result: first } = timedCommit(db, request)
    expect(first.summary.written).toBeGreaterThan(0)

    const countQueries = () => db.select({ id: schema.platformQuery.id }).from(schema.platformQuery).all().length
    const countRelations = () => db.select({ id: schema.platformRelation.id }).from(schema.platformRelation).all().length
    const queriesBefore = countQueries()
    const relationsBefore = countRelations()

    // 换幂等键 ⇒ 走**真正执行**那条路（不是命中已 `committed` 的批次直接返回既有摘要），
    // 于是千条级查询各自都要「找既有行」一次 —— 正是本票要压的那条路径。
    const { result: replay, elapsedMs } = timedCommit(db, {
      ...request,
      idempotencyKey: 'scale/replay-again#sha256:rl18',
    })

    expect(replay.status).toBe('committed')
    expect(replay.summary.written).toBe(0)
    expect(countQueries()).toBe(queriesBefore)
    expect(countRelations()).toBe(relationsBefore)
    expect(elapsedMs).toBeLessThan(BATCH_BUDGET_MS)
  }, CASE_TIMEOUT_MS)

  /**
   * 企业表这一轴：写入阶段每写一条关系都要按统代去企业表定位一次。
   * 企业表是**独立于本批**的规模（真实库 7352 行）——
   * 只压批次、不种企业，这条路径就完全看不见（RL-18 收尾补的就是它）。
   */
  it(`企业表 ${ENTERPRISE_ROWS} 行 × 单批 ${BATCH_QUERIES} 条查询能在预算内跑完`, () => {
    const db = makeDb()
    seedEnterprises(db, ENTERPRISE_ROWS)
    seedArchive(db, ARCHIVE_QUERIES)
    const request = scaleRequest(BATCH_QUERIES, 'scale/enterprise#sha256:rl18')

    const { result, elapsedMs } = timedCommit(db, request)

    expect(result.status).toBe('committed')
    expect(result.summary.written).toBe(BATCH_QUERIES * (1 + RELATIONS_PER_QUERY))
    // eslint-disable-next-line no-console
    console.log(
      `[RL-18 规模] 企业=${ENTERPRISE_ROWS} 存档=${ARCHIVE_QUERIES} 批次=${BATCH_QUERIES} ` +
        `关系=${BATCH_QUERIES * RELATIONS_PER_QUERY} 计划+提交=${elapsedMs}ms`,
    )
    expect(elapsedMs).toBeLessThan(ENTERPRISE_BUDGET_MS)
  }, CASE_TIMEOUT_MS)

  /**
   * 增长比是**唯一**能直接看出「平方」的判据，但它只在**平方那一项真的占主导**时才灵。
   *
   * 所以这里刻意让**存档为空**：库是空的 ⇒ 计划阶段没有可扫的行，代价全落在**提交**阶段 ——
   * 而提交阶段表是**边写边涨**的，第 i 条查询要扫 i 行 ⇒ 恰好是 N²/2。改前这条会给出
   * 接近 16× 的比值（诚实实测，不是推的），改后近线性。
   *
   * 为什么不用「存档=1000」那种更贴近真实的形状：那时计划阶段的代价是 O(N × 固定的存档行数)，
   * 对 N 只是**线性**，于是改前改后的比值都在 4–6× 一带 —— 这条用例会**在改前也通过**，
   * 等于什么都没守。宁可把形状说清楚，也不留一条看着像守、实际守不住的断言。
   */
  it('规模翻 4 倍：耗时**不是** 16 倍（空存档，纯提交阶段的平方项）', () => {
    const small = BATCH_QUERIES / 4
    const measure = (batch: number) => {
      const db = makeDb()
      const { elapsedMs } = timedCommit(db, scaleRequest(batch, `scale/ratio-${batch}#sha256:rl18`))
      return Math.max(elapsedMs, 1)
    }
    // 先小后大：把冷启动（首次建表 / drizzle 预热）算在小规模那一侧，
    // 于是比值只会**偏保守**（更容易误报二次增长），不会掩盖它。
    const smallMs = measure(small)
    const largeMs = measure(BATCH_QUERIES)
    const ratio = largeMs / smallMs
    // eslint-disable-next-line no-console
    console.log(`[RL-18 规模] 空存档；${small} 条=${smallMs}ms，${BATCH_QUERIES} 条=${largeMs}ms，比值=${ratio.toFixed(2)}×`)
    // 平方会给出 16×；这里给到 8× 的宽松上限（含固定开销与抖动）。
    expect(ratio).toBeLessThan(8)
  }, CASE_TIMEOUT_MS)
})
