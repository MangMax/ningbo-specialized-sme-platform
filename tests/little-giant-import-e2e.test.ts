import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema, useDb } from '../db'
import {
  ROSTER_IMPORT_COMMIT_PATH,
  createRosterImportClient,
  type RosterImportCommitResponse,
  type RosterImportRequest,
} from '../lib/roster-import-client'
import { buildLittleGiantImportRequest, LITTLE_GIANT_SOURCE_FILE } from '../lib/roster/little-giant-import'
import { parseLittleGiantWorkbook, type LittleGiantWorkbook } from '../lib/roster/little-giant-workbook'
import { rosterRowCounts } from '../server/utils/roster-import'
import { startRosterApi, type RosterApiServer } from './helpers/roster-http-server'
import { SYNTHETIC_DUPLICATE_USCC, hasRealSource, loadLittleGiantSource, type LittleGiantSource } from './helpers/little-giant-source'

/**
 * RL-02 **端到端** —— 把这份工作簿**经真实 HTTP** 提交给统一写入 API(RL-11),
 * 断言用户可观察的结果:企业去重、两条批次事件、来源证据、重复运行幂等。
 *
 * ── 走的是哪条链路 ──────────────────────────────────────────────────────
 * `tests/helpers/roster-http-server.ts` 在**真端口**上起一个 node:http 服务,挂的是
 * **Nitro 路由同款**的 `handleRosterImportRequest`(RL-11 的验收夹具,不是另写的替身);
 * 客户端用 `lib/roster-import-client.ts`(**契约类型 + HTTP 客户端**)。全程 `pnpm test` 默认跑,
 * 不需要环境变量:真件在就用真件,不在就用合成夹具跑**同一条链路**(见 `helpers/little-giant-source.ts`)。
 *
 * ── 为什么可以读库 ──────────────────────────────────────────────────────
 * 「重复导入不重复新增企业/事件/出处」这条验收**只能**用库里的行数回答 —— 读面
 * (`GET /api/roster/*`)是 RL-04 的范围,本票没有。**写**仍然一律走 API:
 * 本文件只用 drizzle 的查询构造器**读**计数,没有任何 SQL 写。
 */

const TOKEN = 'rl02-e2e-token-value'

/** 合成夹具的期望(独立于 payload 构造器,手数出来的 7 行里的 6 家 / 7 条事件)。 */
const EXPECTED_SYNTHETIC = { rows: 7, enterprises: 6, records: 6, events: 7, evidences: 7 }
/** 真件的期望(`docs/roster-little-giant-source.md` §4 记录的数字)。 */
const EXPECTED_REAL = { rows: 511, enterprises: 510, records: 510, events: 511, evidences: 511 }

interface Expected {
  rows: number
  enterprises: number
  records: number
  events: number
  evidences: number
}

describe('RL-02 端到端:经真实 HTTP 提交小巨人工作簿', () => {
  let dir: string
  let db: ReturnType<typeof useDb>
  let server: RosterApiServer
  let source: LittleGiantSource
  let workbook: LittleGiantWorkbook
  let request: RosterImportRequest
  let expected: Expected
  /** 首次提交的响应(声明顺序执行,后面的用例都靠它)。 */
  let first: RosterImportCommitResponse

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rl02-e2e-'))
    db = useDb({ dbPath: join(dir, 'roster.db') })
    server = await startRosterApi({ db, apiToken: TOKEN })

    source = await loadLittleGiantSource()
    workbook = await parseLittleGiantWorkbook(source.buffer)
    request = buildLittleGiantImportRequest(workbook, { sourceFile: source.sourceFile })
    expected = source.real ? EXPECTED_REAL : EXPECTED_SYNTHETIC
  }, 60_000)

  afterAll(async () => {
    await server?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const client = () => createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })

  it('预检:只算影响、不写业务数据,且没有逐项冲突', async () => {
    const result = await client().preflight(request)

    expect(result.status).toBe('preflight')
    expect(result.preflight.conflicts).toEqual([])
    expect(result.preflight.remove).toBe(0)
    expect(result.preflight.update).toBe(0)
    expect(result.preflight.review).toBe(0)
    // 实测口径:预检 `add` = 本批将新增的**计划项**数;这份载荷「一家企业 = 一项」
    // ⇒ add = 记录数。(契约 §8.5 的措辞写的是「任一新行:企业/记录/事件/出处…」,
    // 与实现的「按计划项」不是一回事 —— 已作为观察项报给父代理,故这里按**实测**断言。)
    expect(result.preflight.add).toBe(expected.records)
    // 预检**不写业务数据**:七张新表 + 来源文件表全是 0。
    expect(rosterRowCounts(db)).toEqual({
      enterprise: 0,
      record: 0,
      record_event: 0,
      record_evidence: 0,
      enterprise_alias: 0,
      platform_query: 0,
      platform_relation: 0,
      platform_export_batch: 0,
      platform_export_row: 0,
      difference_reason: 0,
      source_document: 0,
    })
  })

  it(`首次提交(${hasRealSource ? '真件' : '合成夹具'}):逐条源行落到事件,企业按信用代码去重`, async () => {
    first = await client().commit(request)

    expect(first.status).toBe('committed')
    expect(first.error ?? null).toBeNull()
    expect(first.items.every((item) => item.ok)).toBe(true)

    const counts = rosterRowCounts(db)
    expect(counts).toMatchObject({
      enterprise: expected.enterprises,
      record: expected.records,
      record_event: expected.events,
      record_evidence: expected.evidences,
      enterprise_alias: 0,
      platform_relation: 0,
      difference_reason: 0,
    })
    // 一次提交 = 一条批次。
    expect(db.select().from(schema.importBatch).all()).toHaveLength(1)

    // 源行数 = 事件数 + 未进名单的待核行(这份源的待核行数在报告里)。
    expect(workbook.rows.length + workbook.issues.filter((i) => i.severity === 'blocked').length).toBe(
      expected.rows,
    )
    expect(workbook.rows).toHaveLength(expected.events)
  })

  it(`跨批次同一信用代码 ${SYNTHETIC_DUPLICATE_USCC}:企业一行,但两批各留一条认定事件`, async () => {
    const rows = db
      .select({
        enterpriseId: schema.record.enterpriseId,
        eventType: schema.recordEvent.eventType,
        year: schema.recordEvent.year,
        batchSeq: schema.recordEvent.batchSeq,
      })
      .from(schema.enterprise)
      .innerJoin(schema.record, eq(schema.record.enterpriseId, schema.enterprise.id))
      .innerJoin(schema.recordEvent, eq(schema.recordEvent.recordId, schema.record.id))
      .where(eq(schema.enterprise.usccNorm, SYNTHETIC_DUPLICATE_USCC))
      .orderBy(schema.recordEvent.batchSeq)
      .all()

    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.enterpriseId)).size).toBe(1)
    expect(rows.map((row) => [row.eventType, row.batchSeq, row.year])).toEqual([
      ['award', 2, 2020],
      ['award', 6, 2024],
    ])
  })

  it('来源证据落到事件上:源文件 / 附件(工作表) / 名单序号 / 页码留空', async () => {
    const evidence = db
      .select({
        sourceFile: schema.recordEvidence.sourceFile,
        attachment: schema.recordEvidence.attachment,
        listNo: schema.recordEvidence.listNo,
        page: schema.recordEvidence.page,
        batchSeq: schema.recordEvent.batchSeq,
      })
      .from(schema.recordEvidence)
      .innerJoin(schema.recordEvent, eq(schema.recordEvent.id, schema.recordEvidence.recordEventId))
      .where(eq(schema.recordEvidence.listNo, 14))
      .all()

    // 序号 14 在两份源里都只出现一次(真件 r15 / 夹具第 2 条),且都是第 2 批。
    expect(evidence).toEqual([
      {
        sourceFile: source.sourceFile,
        attachment: workbook.sheetName,
        listNo: 14,
        page: null,
        batchSeq: 2,
      },
    ])

    // 每条源行都带出处,无一遗漏。
    expect(rosterRowCounts(db).record_evidence).toBe(expected.evidences)
    expect(
      db.select().from(schema.recordEvidence).all().filter((row) => row.listNo !== null),
    ).toHaveLength(expected.evidences)
  })

  it('重复导入(同幂等键):返回**同一批次**,企业 / 记录 / 事件 / 出处一个都不多', async () => {
    const before = rosterRowCounts(db)

    // 走**原始 fetch** 再提交一次:既验重放,也验 HTTP 面本身。
    const response = await fetch(`${server.baseUrl}${ROSTER_IMPORT_COMMIT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(request),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')

    // 注意:`response.status` 是 HTTP 状态,批次的 `status` 在 JSON body 里 —— 两者别混。
    const body = (await response.json()) as RosterImportCommitResponse
    expect(body.status).toBe('committed')
    expect(body.batchId).toBe(first.batchId)

    expect(rosterRowCounts(db)).toEqual(before)
    expect(db.select().from(schema.importBatch).all()).toHaveLength(1)
  })

  it('出处指向**文件库内**的路径(RL-16);真件入库后那份文件解析得到', () => {
    const rows = db.select({ sourceFile: schema.recordEvidence.sourceFile }).from(schema.recordEvidence).all()
    expect(rows).toHaveLength(expected.evidences)
    // 全批只有一个口径 —— 不混着「库内路径」与「库外路径」两种写法。
    expect(new Set(rows.map((row) => row.sourceFile))).toEqual(new Set([source.sourceFile]))

    // 「预览/跳转」要的是:库内相对路径 + 那份文件真的在文件库里。
    // 全新 clone 没有运行时 `files/`(已 gitignore),故这半条只在文件库就位时判。
    const fileStore = join(process.cwd(), 'files')
    const hasRealFileStore = existsSync(join(fileStore, 'miit', 'export'))
    if (source.real && hasRealFileStore) {
      expect(source.sourceFile).toBe(LITTLE_GIANT_SOURCE_FILE)
      expect(LITTLE_GIANT_SOURCE_FILE.startsWith('jxj/announcement/')).toBe(true)
      expect(existsSync(join(fileStore, LITTLE_GIANT_SOURCE_FILE))).toBe(true)
    }
  })

  describe.runIf(hasRealSource)('真件的具体数字(仅真件在时断言)', () => {
    it('511 条源行 / 510 个信用代码 / 511 条事件,批次分布为第 1–7 批', () => {
      expect(workbook.dataRowCount).toBe(511)
      expect(workbook.rows).toHaveLength(511)
      expect(new Set(workbook.rows.map((row) => row.uscc)).size).toBe(510)
      expect(workbook.duplicateUscc).toHaveLength(1)
      expect(workbook.duplicateUscc[0]!.uscc).toBe(SYNTHETIC_DUPLICATE_USCC)
      expect(workbook.missingBatches).toEqual([8])
    })

    it('库里就是 510 企业 / 510 记录 / 511 事件 / 511 出处', () => {
      expect(rosterRowCounts(db)).toMatchObject({
        enterprise: 510,
        record: 510,
        record_event: 511,
        record_evidence: 511,
      })
    })
  })
})
