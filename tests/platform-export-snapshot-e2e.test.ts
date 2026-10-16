/**
 * RL-05 收尾 —— **写侧端到端闭环**(真实导出表 → §8.3 payload → 真实 HTTP 提交 → 读侧)。
 *
 * 这是 RL-05 交付时明确缺的那一步:解析器 + `payload.exportSnapshot` + 读侧/diff 当时已完成,
 * 但「payload → `platform_export_batch` / `platform_export_row` 的事务写入」卡在 RL-11
 * (`POST /api/roster/import/commit`)尚未落地。RL-11 合入后,这里把它补成**默认运行**的验收。
 *
 * 链路全程用**生产实现**:
 *   `lib/platform-export.ts` 解析真实 xlsx → `buildExportSnapshotPayload` 造 §8.3 payload
 *   → 真实端口 `POST /api/roster/import/commit`(同一份 `handleRosterImportRequest`)
 *   → `GET /api/platform/snapshots` / `/diff` 读回闭环。
 *
 * 断言的口径(票面验收):
 *   - 批次身份落库:称号 / 年份 / 采集日 / 原文件名 / SHA-256 / 行数 / 导入状态;
 *   - 行落 `platform_export_row` 且 `source_row_no` 可追溯回源文件物理行;
 *   - `import_batch_id` 指回本次提交的统一批次;
 *   - 同 `(title_code, year, sha256)` 重放**不新建批**;换内容 ⇒ 新版本 + `replaced_batch_id`,两版并存;
 *   - MB 级载荷(最大一张导出表 6273 行)一次 POST 能完整收到并落库。
 *
 * 真实 xlsx **不进 Git**;目录不可用时整块跳过(路径可用 `SPZTX_PLATFORM_EXPORT_DIR` 覆盖)。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import { buildExportSnapshotPayload, readPlatformExport, type ParsedPlatformExport } from '../lib/platform-export'
import { createRosterImportClient } from '../lib/roster-import-client'
import { startRosterPlatformApi } from './helpers/platform-http-server'

const TOKEN = 'test-api-token-value'
const REAL_DIR =
  process.env.SPZTX_PLATFORM_EXPORT_DIR ?? '/Users/mang/Workfile/宁波/专精特新/20261013/工信部名单'
const realFile = (name: string) => join(REAL_DIR, name)

const dirs: string[] = []
function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-export-e2e-'))
  dirs.push(dir)
  return useDb({ dbPath: join(dir, 'roster.db') })
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** 把解析结果包成一次提交请求(幂等键与来源身份都由文件身份派生,不含凭证)。 */
function requestFor(parsed: ParsedPlatformExport, meta: { year: number; collectedOn: string }) {
  const payload = buildExportSnapshotPayload(parsed, meta)
  return {
    idempotencyKey: `platform-export/${parsed.titleCode}/${meta.year}#sha256:${parsed.sha256}`,
    sourceKind: 'platform_export' as const,
    sourceIdentity: `miit/export/${parsed.originalFilename}`,
    sourceSha256: parsed.sha256,
    payload: { exportSnapshot: payload },
  }
}

/** 起服务 + 客户端 + 收尾,避免每个用例重复样板。 */
async function withServer<T>(db: ReturnType<typeof makeDb>, run: (client: ReturnType<typeof createRosterImportClient>) => Promise<T>): Promise<T> {
  const server = await startRosterPlatformApi({ db, apiToken: TOKEN })
  try {
    return await run(createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN }))
  } finally {
    await server.close()
  }
}

const getJson = async (baseUrl: string, path: string) => {
  const res = await fetch(`${baseUrl}${path}`)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

// ---------------------------------------------------------------------------

describe.runIf(existsSync(REAL_DIR))('RL-05 写侧端到端:真实导出表 → 统一写 API → 读回', () => {
  it('专精特新中小企业导出(3267 行):批次身份落库,行可追溯到源行号,import_batch_id 指回本批', async () => {
    const db = makeDb()
    const parsed = await readPlatformExport(realFile('专精特新中小企业导出Excel.xlsx'))
    expect(parsed.titleCode).toBe('specialized_sme')
    expect(parsed.rowCount).toBe(3267)

    const request = requestFor(parsed, { year: 2026, collectedOn: '2026-10-15' })
    // 实测载荷体量:这张表有 **306 列**,整行 rawFields 让 §8.3 payload 达到 ≈33 MB
    // (契约 §8.3 记的 7.6 MB 是 RL-11 的合成夹具;真实「中小」表大一个量级)。
    // 已在**生产 Nitro 路由**上实测:33 MB 一次 POST 完整收下(HTTP 200、3267 行落库),
    // 无需调 `bodyLimit` —— 这条断言把「真实体量」钉住,免得被小夹具掩盖。
    const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
    expect(bytes).toBeGreaterThan(30_000_000)

    await withServer(db, async (client) => {
      const result = await client.commit(request)
      expect(result.status).toBe('committed')
      expect(result.items.find((i) => i.kind === 'export_batch')?.ok).toBe(true)

      // 批次身份:称号 / 年份 / 采集日 / 原文件名 / SHA-256 / 行数 / 导入状态。
      const batch = db.select().from(schema.platformExportBatch).all()[0]!
      expect(batch).toMatchObject({
        titleCode: 'specialized_sme',
        year: 2026,
        collectedOn: '2026-10-15',
        originalFilename: '专精特新中小企业导出Excel.xlsx',
        sha256: parsed.sha256,
        rowCount: 3267,
        importStatus: 'imported',
        replacedBatchId: null, // 首版
      })
      // import_batch_id 指回本次提交的统一批次。
      expect(batch.importBatchId).toBe(result.batchId)

      // 行落 platform_export_row,数量一致。
      const stored = db
        .select()
        .from(schema.platformExportRow)
        .all()
        .filter((r) => r.batchId === batch.id)
      expect(stored).toHaveLength(3267)

      // source_row_no 可追溯:两行表头之后的第一条数据行是源文件第 3 行。
      expect(Math.min(...stored.map((r) => r.sourceRowNo))).toBe(3)
      const firstRow = stored.find((r) => r.sourceRowNo === 3)!
      expect(firstRow).toMatchObject({
        nameRaw: '宁波铭辉汽车零部件有限公司',
        usccRaw: '91330226MA28309443',
        province: '浙江省',
        city: '宁波市',
        district: '宁海县',
        regStatus: '待审核',
      })
      // 整行原始字段按 1-based 列号留存(统代在 18、审核状态在 300)。
      expect((firstRow.rawFields as Record<string, string>)['18']).toBe('91330226MA28309443')
      expect((firstRow.rawFields as Record<string, string>)['300']).toBe('待审核')
    })
  }, 120_000)

  it('同文件重放(同 sha256)不新建批、不重落行 —— 换幂等键也一样', async () => {
    const db = makeDb()
    const parsed = await readPlatformExport(realFile('专精特新中小企业导出Excel.xlsx'))
    const request = requestFor(parsed, { year: 2026, collectedOn: '2026-10-15' })

    await withServer(db, async (client) => {
      const first = await client.commit(request)
      expect(first.status).toBe('committed')

      // 同一幂等键重放:返回既有批次,不重复写。
      const replay = await client.commit(request)
      expect(replay.batchId).toBe(first.batchId)
      expect(db.select().from(schema.platformExportBatch).all()).toHaveLength(1)

      // **换一个幂等键**、同一文件内容:唯一键 (title_code, year, sha256) 命中 ⇒ 仍不新建批。
      const otherKey = await client.commit({ ...request, idempotencyKey: `${request.idempotencyKey}#again` })
      expect(otherKey.status).toBe('committed')
      expect(db.select().from(schema.platformExportBatch).all()).toHaveLength(1)
      const rows = db
        .select()
        .from(schema.platformExportRow)
        .all()
        .filter((r) => r.batchId === first.batchId)
      expect(rows).toHaveLength(3267)
    })
  }, 120_000)

  it('替换文件 ⇒ 新版本 + replaced_batch_id 指向上一个版本,两版并存,差异可追到行', async () => {
    const db = makeDb()
    const parsed = await readPlatformExport(realFile('专精特新小巨人导出Excel.xlsx'))
    expect(parsed.rowCount).toBe(481)
    const v1 = requestFor(parsed, { year: 2026, collectedOn: '2026-10-14' })

    // 模拟「换了一份导出文件」:内容变了(删一行 / 改一行的区县 / 增一行)⇒ 版本哈希随之改变。
    const rows = parsed.rows
    const removedRow = rows[2]! // 源行 5
    const changedRow = rows[1]! // 源行 4
    const v2Rows = [
      ...rows
        .filter((r) => r.sourceRowNo !== removedRow.sourceRowNo)
        .map((r) => (r.sourceRowNo === changedRow.sourceRowNo ? { ...r, district: '北仑区' } : r)),
      {
        sourceRowNo: Math.max(...rows.map((r) => r.sourceRowNo)) + 1,
        usccRaw: '91330299ZZZZZZZ001',
        nameRaw: '新增企业有限公司',
        province: '浙江省',
        city: '宁波市',
        district: '海曙区',
        regStatus: '待审核',
        rawFields: { '1': '新增企业有限公司', '18': '91330299ZZZZZZZ001' },
      },
    ]
    const v2Sha = createHash('sha256').update(JSON.stringify(v2Rows)).digest('hex')
    expect(v2Sha).not.toBe(parsed.sha256)
    const v2 = {
      ...v1,
      idempotencyKey: `platform-export/little_giant/2026#sha256:${v2Sha}`,
      sourceSha256: v2Sha,
      payload: { exportSnapshot: { ...v1.payload.exportSnapshot, sha256: v2Sha, rows: v2Rows } },
    }

    const server = await startRosterPlatformApi({ db, apiToken: TOKEN })
    try {
      const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
      const first = await client.commit(v1)
      const second = await client.commit(v2)
      expect(first.status).toBe('committed')
      expect(second.status).toBe('committed')

      const batches = db.select().from(schema.platformExportBatch).all()
      expect(batches).toHaveLength(2) // 两版并存
      const oldBatch = batches.find((b) => b.sha256 === parsed.sha256)!
      const newBatch = batches.find((b) => b.sha256 === v2Sha)!
      expect(newBatch.replacedBatchId).toBe(oldBatch.id)
      expect(oldBatch.replacedBatchId).toBeNull()
      // 旧版的行不因替换而消失。
      expect(
        db.select().from(schema.platformExportRow).all().filter((r) => r.batchId === oldBatch.id),
      ).toHaveLength(481)
      expect(
        db.select().from(schema.platformExportRow).all().filter((r) => r.batchId === newBatch.id),
      ).toHaveLength(481)

      // --- 回到读侧闭环 ---
      const listed = await getJson(server.baseUrl, '/api/platform/snapshots?title=little_giant&year=2026')
      expect(listed.status).toBe(200)
      const listedRows = listed.body.rows as Array<{ batch: { id: number }; replacedBatchId: number | null; rowCount: number; importStatus: string }>
      expect(listedRows).toHaveLength(2)
      expect(listedRows.map((r) => r.batch.id)).toEqual([oldBatch.id, newBatch.id])
      expect(listedRows.find((r) => r.batch.id === newBatch.id)!.replacedBatchId).toBe(oldBatch.id)
      expect(listedRows.every((r) => r.importStatus === 'imported' && r.rowCount === 481)).toBe(true)

      const diff = await getJson(server.baseUrl, `/api/platform/snapshots/diff?from=${oldBatch.id}&to=${newBatch.id}`)
      expect(diff.status).toBe(200)
      const d = diff.body.diff as {
        added: Array<{ usccRaw: string; sourceRowNo: number }>
        removed: Array<{ usccRaw: string; sourceRowNo: number }>
        changed: Array<{ usccRaw: string; fromSourceRowNo: number; toSourceRowNo: number; fields: Array<{ field: string; from: string; to: string }> }>
        unchanged: number
      }
      // 每处差异都能追回原始行号。
      expect(d.added).toEqual([expect.objectContaining({ usccRaw: '91330299ZZZZZZZ001', sourceRowNo: expect.any(Number) })])
      expect(d.removed).toEqual([expect.objectContaining({ usccRaw: removedRow.usccRaw, sourceRowNo: removedRow.sourceRowNo })])
      expect(d.changed).toHaveLength(1)
      expect(d.changed[0]).toMatchObject({ usccRaw: changedRow.usccRaw, fromSourceRowNo: 4, toSourceRowNo: 4 })
      expect(d.changed[0]!.fields).toEqual([{ field: 'district', from: changedRow.district, to: '北仑区' }])
      // 旧版 481 行:去掉 1 行、改掉 1 行 ⇒ 剩下 479 行完全未变。
      expect(d.unchanged).toBe(479)
    } finally {
      await server.close()
    }
  }, 120_000)

  it('MB 级载荷:最大一张导出表(创新型 6273 行 × 数十列)经真实 HTTP 完整收下并落库', async () => {
    const db = makeDb()
    const parsed = await readPlatformExport(realFile('创新型中小企业导出Excel.xlsx'))
    expect(parsed.rowCount).toBe(6273)

    const request = requestFor(parsed, { year: 2026, collectedOn: '2026-10-15' })
    const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
    // 实测:这份真实载荷是 MB 级(整行 rawFields 按 1-based 列号留存)。
    expect(bytes).toBeGreaterThan(1_000_000)

    await withServer(db, async (client) => {
      const result = await client.commit(request)
      expect(result.status).toBe('committed')

      const batch = db.select().from(schema.platformExportBatch).all()[0]!
      expect(batch.rowCount).toBe(6273)
      expect(batch.sha256).toBe(parsed.sha256)

      const stored = db
        .select()
        .from(schema.platformExportRow)
        .all()
        .filter((r) => r.batchId === batch.id)
      expect(stored).toHaveLength(6273)
      expect(Math.min(...stored.map((r) => r.sourceRowNo))).toBe(3)
      // 整行原始字段完整保留(真实导出的列数远多于抽样列)。
      const firstRow = stored.find((r) => r.sourceRowNo === 3)!
      expect(Object.keys(firstRow.rawFields as Record<string, string>).length).toBeGreaterThan(30)
      expect(firstRow.nameRaw).toBe('宁波东海蓝帆科技有限公司')
      expect(firstRow.usccRaw).toBe('91330201753252106U')
    })
  }, 180_000)
})
