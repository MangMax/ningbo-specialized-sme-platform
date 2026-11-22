import { nativeAppAdapter } from '../../support/native-app'
import { createReviewedPostgresImportClient } from '../enterprise-read/fixtures/postgres-import-http'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../fixtures/postgres-tables'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  createRosterImportClient,
  ROSTER_IMPORT_COMMIT_PATH,
  type RosterImportCommitResponse,
  type RosterImportRequest,
} from '../../../layers/sme-roster/lib/roster-import-client'
import { buildLittleGiantImportRequest, LITTLE_GIANT_SOURCE_FILE } from '../../../layers/sme-roster/lib/roster/little-giant-import'
import { parseLittleGiantWorkbook, type LittleGiantWorkbook } from '../../../layers/sme-roster/lib/roster/little-giant-workbook'
import { landingSegments } from '../../../layers/sme-roster/lib/sme-roster/file-landing'
import { SYNTHETIC_DUPLICATE_USCC, hasRealSource, loadLittleGiantSource, type LittleGiantSource } from './fixtures/official-source'

const TOKEN = 'rl02-e2e-token-value'

/**
 * 真实**文件库**是否就位(全新 clone 只提交了 `lib/file-store-scope.ts`,运行时数据已 gitignore)。
 * 用它把「出处解析得到文件」那半条**显式** skip 掉 —— 写成 `if (...)` 的话,文件库不在时
 * 那几条断言会**静默通过**,读起来像验过了。
 */
const hasRealFileStore = existsSync(join(process.cwd(), 'files', 'miit', 'export'))

/** 合成夹具的期望(独立于 payload 构造器,手数出来的 7 行里的 6 家 / 7 条事件)。 */
const EXPECTED_SYNTHETIC = { rows: 7, enterprises: 6, records: 6, events: 7, evidences: 7 }
/** 真件的期望。 */
const EXPECTED_REAL = { rows: 511, enterprises: 510, records: 510, events: 539, evidences: 539 }

interface Expected {
  rows: number
  enterprises: number
  records: number
  events: number
  evidences: number
}

describe('经真实 HTTP 提交小巨人工作簿', () => {
  let dir: string
  let db: NodePgDatabase
  let app: ReturnType<typeof nativeAppAdapter>
  let source: LittleGiantSource
  let workbook: LittleGiantWorkbook
  let request: RosterImportRequest
  let expected: Expected
  /** 首次提交的响应(声明顺序执行,后面的用例都靠它)。 */
  let first: RosterImportCommitResponse

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rl02-e2e-'))
    app = nativeAppAdapter({ dir, token: TOKEN })
    await app.start()
    db = app.db

    source = await loadLittleGiantSource()
    workbook = await parseLittleGiantWorkbook(source.buffer)
    request = buildLittleGiantImportRequest(workbook, { sourceFile: source.sourceFile })
    expected = source.real ? EXPECTED_REAL : EXPECTED_SYNTHETIC
  }, 60_000)

  afterAll(async () => {
    try { await app?.close() }
    finally { if (dir) rmSync(dir, { recursive: true, force: true }) }
  })

  const clientOptions = () => ({ baseUrl: app.url(''), token: TOKEN })
  const client = () => createReviewedPostgresImportClient(clientOptions(), db)
  async function rosterRowCounts() {
    const { rows } = await db.execute(sql`
      SELECT (SELECT count(*)::int FROM business.enterprise) AS enterprise,
             (SELECT count(*)::int FROM business.record) AS record,
             (SELECT count(*)::int FROM business.record_event) AS record_event,
             (SELECT count(*)::int FROM business.record_evidence) AS record_evidence,
             (SELECT count(*)::int FROM business.enterprise_alias) AS enterprise_alias,
             (SELECT count(*)::int FROM business.platform_business_observation) AS platform_observation,
             (SELECT count(*)::int FROM business.platform_collection) AS platform_collection,
             (SELECT count(*)::int FROM business.difference_reason) AS difference_reason,
             (SELECT count(*)::int FROM business.source_document) AS source_document
    `)
    const counts = rows[0]
    if (!counts) throw new Error('Expected roster counts from the isolated database')
    return counts
  }

  it('预检:只算影响、不写业务数据,且没有逐项冲突', async () => {
    const result = await createRosterImportClient(clientOptions()).preflight(request)

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
    expect(await rosterRowCounts()).toEqual({
      enterprise: 0,
      record: 0,
      record_event: 0,
      record_evidence: 0,
      enterprise_alias: 0,
      platform_collection: 0,
      platform_observation: 0,
      difference_reason: 0,
      source_document: 0,
    })
  })

  it(`首次提交(${hasRealSource ? '真件' : '合成夹具'}):逐条源行落到事件,企业按信用代码去重`, async () => {
    const result = await client().commit(request)
    expect(result.status).toBe('committed')
    if (result.status !== 'committed') throw new Error(JSON.stringify(result))
    first = result

    expect(first.status).toBe('committed')
    expect(first.error ?? null).toBeNull()
    expect(first.items.every((item) => item.ok)).toBe(true)

    const counts = await rosterRowCounts()
    expect(counts).toMatchObject({
      enterprise: expected.enterprises,
      record: expected.records,
      record_event: expected.events,
      record_evidence: expected.evidences,
      enterprise_alias: 0,
      platform_observation: 0,
      difference_reason: 0,
    })
    // 一次提交 = 一条批次。
    expect(await db.select().from(schema.importBatch)).toHaveLength(1)

    // 源行数 = 事件数 + 未进名单的待核行(这份源的待核行数在报告里)。
    expect(workbook.rows.length + workbook.issues.filter((i) => i.severity === 'blocked').length).toBe(
      expected.rows,
    )
    expect(workbook.rows).toHaveLength(expected.rows)
  })

  it(`跨批次同一信用代码 ${SYNTHETIC_DUPLICATE_USCC}:企业一行,但两批各留一条认定事件`, async () => {
    const rows = await db
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

    expect(rows).toHaveLength(hasRealSource ? 3 : 2)
    expect(new Set(rows.map((row) => row.enterpriseId)).size).toBe(1)
    expect(rows.map((row) => [row.eventType, row.batchSeq, row.year])).toEqual([
      ['award', 2, 2020],
      ...(hasRealSource ? [['review', 2, 2020]] : []),
      ['award', 6, 2024],
    ])
  })

  it('来源证据落到事件上:源文件 / 附件(工作表) / 名单序号 / 页码留空', async () => {
    const evidence = await db
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

    // 序号 14 在两份源里都只出现一次(真件 r15 / 夹具第 2 条),且都是第 2 批。
    expect(evidence).toEqual(Array.from({ length: hasRealSource ? 2 : 1 }, () => (
      {
        sourceFile: source.sourceFile,
        attachment: workbook.sheetName,
        listNo: 14,
        page: null,
        batchSeq: 2,
      }
    )))

    // 每条源行都带出处,无一遗漏。
    expect((await rosterRowCounts()).record_evidence).toBe(expected.evidences)
    expect(
      (await db.select().from(schema.recordEvidence)).filter((row) => row.listNo !== null),
    ).toHaveLength(expected.evidences)
  })

  it('重复导入(同幂等键):返回**同一批次**,企业 / 记录 / 事件 / 出处一个都不多', async () => {
    const before = await rosterRowCounts()

    // 走**原始 fetch** 再提交一次:既验重放,也验 HTTP 面本身。
    const response = await fetch(app.url(ROSTER_IMPORT_COMMIT_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(request),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')

    // 注意:`response.status` 是 HTTP 状态,批次的 `status` 在 JSON body 里 —— 两者别混。
    expect(await response.json()).toMatchObject({ status: 'staged', rowCount: request.payload.announcement!.records.length })
    expect(await client().commit(request)).toEqual(first)

    expect(await rosterRowCounts()).toEqual(before)
    expect(await db.select().from(schema.importBatch)).toHaveLength(1)
  })

  it('出处指向**文件库内**的路径(RL-16),全批一个口径', async () => {
    const rows = await db.select({ sourceFile: schema.recordEvidence.sourceFile }).from(schema.recordEvidence)
    expect(rows).toHaveLength(expected.evidences)
    // 全批只有一个口径 —— 不混着「库内路径」与「库外路径」两种写法。
    expect(new Set(rows.map((row) => row.sourceFile))).toEqual(new Set([source.sourceFile]))
  })

  describe.runIf(hasRealSource && hasRealFileStore)(
    '出处解析得到文件(仅真件 + 真实文件库都在时断言)',
    () => {
      it('台账指的库内路径就是落位规则算出来的那一条,且那份文件在盘上', () => {
        // 1) 「可复现的入库」:这条路径不是手写的,是 app 落位规则对该 metadata 的输出 ——
        //    所以经公开上传接口(tus + register)一定能把它放进去,不需要为这个文件开特例。
        expect(
          landingSegments({
            source: 'jxj',
            kind: 'announcement',
            filename: LITTLE_GIANT_SOURCE_FILE.split('/').pop(),
          }).join('/'),
        ).toBe(LITTLE_GIANT_SOURCE_FILE)
        // 2) 「预览/跳转」要的那一半:那份文件真的在文件库里。
        expect(source.sourceFile).toBe(LITTLE_GIANT_SOURCE_FILE)
        expect(existsSync(join(process.cwd(), 'files', LITTLE_GIANT_SOURCE_FILE))).toBe(true)
      })
    },
  )

  describe.runIf(hasRealSource)('真件的具体数字(仅真件在时断言)', () => {
    it('511 条源行 / 510 个信用代码 / 511 条事件,批次分布为第 1–7 批', () => {
      expect(workbook.dataRowCount).toBe(511)
      expect(workbook.rows).toHaveLength(511)
      expect(new Set(workbook.rows.map((row) => row.uscc)).size).toBe(510)
      expect(workbook.duplicateUscc).toHaveLength(1)
      expect(workbook.duplicateUscc[0]!.uscc).toBe(SYNTHETIC_DUPLICATE_USCC)
      expect(workbook.missingBatches).toEqual([8])
    })

    it('库里保留511认定和28明确失败复核，共539事件和出处', async () => {
      expect(await rosterRowCounts()).toMatchObject({
        enterprise: 510,
        record: 510,
        record_event: 539,
        record_evidence: 539,
      })
    })
  })
})
