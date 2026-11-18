import { createReviewedFixtureImportClient } from '../imports/fixtures/reviewed-announcement'
import { initializeDb } from '../../../db/client'
/**
 * RL-16(票 #17)—— **来源文件入库后,出处指针怎么收敛**。
 *
 * 问题:小巨人工作簿导入时用的来源标识是**库外路径**,`record_evidence.source_file`
 * 于是解析不到文件,名录行的预览/跳转全断(用户 2026-10-16 反馈)。
 *
 * 修法(两条一起才成立):
 *  1. 导入侧把来源标识换成**库内相对路径**(见 `layers/sme-roster/lib/roster/little-giant-import.ts`);
 *  2. 统一写入 API 重放同一份来源时,**只把出处的 `source_file` 收敛到新路径** ——
 *     事件坐标不变 ⇒ 历史一行不改、一行不加、一行不删。
 *
 * 这个文件盯着第 2 条。走的是**真实 HTTP**(`tests/helpers/roster-http-server.ts` 起真端口,
 * `layers/sme-roster/lib/roster-import-client.ts` 发真请求),库只用 drizzle **读**计数。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema, useDb } from '../../../db'
import { type RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import {
  buildLittleGiantImportReport,
  buildLittleGiantImportRequest,
  LITTLE_GIANT_SOURCE_FILE,
} from '../../../layers/sme-roster/lib/roster/little-giant-import'
import { parseLittleGiantWorkbook } from '../../../layers/sme-roster/lib/roster/little-giant-workbook'
import { rosterRowCounts } from '../../../layers/sme-roster/server/utils/roster-import'
import { executeNativeImport, startRosterApi } from '../imports/fixtures/import-server'
import { loadLittleGiantSource } from '../little-giant/fixtures/official-source'

const TOKEN = 'rl16-repoint-token-value'

/**
 * 库外路径(RL-02 的历史口径)与库内路径(RL-16 之后的唯一口径)。
 *
 * `LIBRARY_SOURCE_FILE` 与模块默认值同源 —— 真件与合成夹具都按**同一条规则**取：
 * 那份工作簿入库后落在哪，出处就该指哪(`loadLittleGiantSource().sourceFile`)。
 */
const LEGACY_SOURCE_FILE = '经信局名单/小巨人/经信局公布历年小巨人企业名单.xlsx'
const LIBRARY_SOURCE_FILE = LITTLE_GIANT_SOURCE_FILE
const SHA_HISTORICAL = 'a'.repeat(64)
const SHA_STABLE = 'b'.repeat(64)
const SHA_OTHER_LISTNO = 'c'.repeat(64)

const dirs: string[] = []

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-repoint-'))
  dirs.push(dir)
  return initializeDb({ create: true, dbPath: join(dir, 'roster.db') })
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** 一份小巨人工作簿批次:一家企业 × 一条认定事件 × 一条出处(序号 14)。 */
function littleGiantRequest(options: {
  idempotencyKey: string
  sourceFile: string
  sha256: string
  listNo?: number
}): RosterImportRequest {
  return {
    idempotencyKey: options.idempotencyKey,
    sourceKind: 'announcement',
    sourceIdentity: options.sourceFile,
    sourceSha256: options.sha256,
    payload: {
      announcement: {
        sourceDocument: { source: 'jxj', title: '经信局公布历年小巨人企业名单', docNumber: null },
        records: [
          {
            enterprise: { name: '宁波昌扬机械工业有限公司', uscc: '91330211316904639T', district: '镇海区' },
            titleCode: 'little_giant',
            events: [
              {
                eventType: 'award',
                year: 2020,
                batchSeq: 2,
                decidedYear: 2020,
                reviewOutcome: null,
                evidence: [
                  {
                    sourceFile: options.sourceFile,
                    attachment: '专精特新小巨人企业 (2)',
                    listNo: options.listNo ?? 14,
                    page: null,
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  }
}

function evidenceRows(db: ReturnType<typeof makeDb>) {
  return db.select().from(schema.recordEvidence).all()
}

describe('RL-16:重导把出处指针收敛到库内路径,历史一行不改', () => {
  it('首次导入用库外路径 → 重导(来源标识变了 ⇒ 换键)后只换指针,不多不少', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN, executeImport: executeNativeImport })
    const client = createReviewedFixtureImportClient({ baseUrl: server.baseUrl, token: TOKEN }, db)
    try {
      // 1) 历史批次:库外路径(RL-02 的口径)。
      const legacy = littleGiantRequest({
        idempotencyKey: `${LEGACY_SOURCE_FILE}#sha256:${SHA_HISTORICAL}`,
        sourceFile: LEGACY_SOURCE_FILE,
        sha256: SHA_HISTORICAL,
      })
      expect((await client.commit(legacy)).status).toBe('committed')

      const afterFirst = rosterRowCounts(db)
      expect(evidenceRows(db).map((row) => row.sourceFile)).toEqual([LEGACY_SOURCE_FILE])

      // 2) 文件入库后的重导:同一份内容,来源标识换成了库内路径 ⇒ 键也不同。
      const relinked = littleGiantRequest({
        idempotencyKey: `${LIBRARY_SOURCE_FILE}#sha256:${SHA_HISTORICAL}`,
        sourceFile: LIBRARY_SOURCE_FILE,
        sha256: SHA_HISTORICAL,
      })
      const preflight = await client.preflight(relinked)
      // 预检如实报「会更新既有行」—— 否则它就不是「提交真会发生的事」。
      expect(preflight.preflight.add).toBe(0)
      expect(preflight.preflight.update).toBeGreaterThan(0)

      const committed = await client.commit(relinked)
      expect(committed.status).toBe('committed')

      // 指针换了……
      expect(evidenceRows(db).map((row) => row.sourceFile)).toEqual([LIBRARY_SOURCE_FILE])
      // ……但企业 / 记录 / 事件 / 出处**一行都不多**(重放不堆行)。
      const afterSecond = rosterRowCounts(db)
      for (const table of ['enterprise', 'record', 'record_event', 'record_evidence', 'source_document'] as const) {
        expect({ table, n: afterSecond[table] }).toEqual({ table, n: afterFirst[table] })
      }
      // 出处的坐标(附件 / 序号 / 页)没被动过。
      expect(evidenceRows(db)[0]).toMatchObject({
        attachment: '专精特新小巨人企业 (2)',
        listNo: 14,
        page: null,
      })
    } finally {
      await server.close()
    }
  })

  it('同键重放是彻底的空操作:指针不再变、一行不增、也不报「改了」', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN, executeImport: executeNativeImport })
    const client = createReviewedFixtureImportClient({ baseUrl: server.baseUrl, token: TOKEN }, db)
    try {
      const request = littleGiantRequest({
        idempotencyKey: `${LIBRARY_SOURCE_FILE}#sha256:${SHA_STABLE}`,
        sourceFile: LIBRARY_SOURCE_FILE,
        sha256: SHA_STABLE,
      })
      const first = await client.commit(request)
      const counts = rosterRowCounts(db)

      // 同一幂等键再提交:批次命中已提交记录,连计划都不重跑。
      const again = await client.commit(request)
      expect(again.batchId).toBe(first.batchId)
      expect(rosterRowCounts(db)).toEqual(counts)
      expect(evidenceRows(db).map((row) => row.sourceFile)).toEqual([LIBRARY_SOURCE_FILE])
    } finally {
      await server.close()
    }
  })

  it('收敛只认**坐标逐字相同**的出处行:序号不同的那条不会被误改', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN, executeImport: executeNativeImport })
    const client = createReviewedFixtureImportClient({ baseUrl: server.baseUrl, token: TOKEN }, db)
    try {
      // 同一家企业、同一坐标的事件,但出处序号是 20(而不是重导载荷里的 14)。
      const legacy = littleGiantRequest({
        idempotencyKey: `${LEGACY_SOURCE_FILE}#sha256:${SHA_OTHER_LISTNO}`,
        sourceFile: LEGACY_SOURCE_FILE,
        sha256: SHA_OTHER_LISTNO,
        listNo: 20,
      })
      await client.commit(legacy)

      const relinked = littleGiantRequest({
        idempotencyKey: `${LIBRARY_SOURCE_FILE}#sha256:${SHA_OTHER_LISTNO}`,
        sourceFile: LIBRARY_SOURCE_FILE,
        sha256: SHA_OTHER_LISTNO,
        listNo: 14,
      })
      const outcome = await client.commit(relinked)

      // 序号对不上 ⇒ 不收敛(宁可留着旧路径,也不把指针挪到别的出处行上)。
      expect(outcome.summary.written).toBe(0)
      expect(evidenceRows(db).map((row) => row.sourceFile)).toEqual([LEGACY_SOURCE_FILE])
      // 预检也如实报「没有可更新的行」。
      expect((await client.preflight({ ...relinked, idempotencyKey: 'probe-key' })).preflight.update).toBe(0)
    } finally {
      await server.close()
    }
  })
})

// ---------------------------------------------------------------------------
// RL-19(票 #20)—— 「预检答应了、提交没做」与幂等键被消费后的修复路径
// ---------------------------------------------------------------------------
//
// 票面实测现象:`preflight = {"update":510}` 而 `summary = {"written":0,"skipped":1021}`,
// 且每项 `evidenceRepointed: 0`。真正的原因是**两件事叠在一起**,下面两条用例各钉死一件:
//
//  1. 那次提交跑的是 **RL-16 合入前的构建** —— 旧计划把 510 条记录一律算 `skip`
//     (旧代码是 `action: existingRecord ? 'skip' : 'add'`,且重复事件分支不做收敛),
//     输出正是 `written: 0 / skipped: 1021`(= 510 个 skip 项 + 511 条被跳过的事件)。
//     重新构建后**再跑 preflight** 就报出 `update: 510`(新代码算得出来),而**再跑 commit**
//     只返回既有摘要 —— 于是批次行里留下「预检说 510、摘要说 0」的自相矛盾记录。
//     ⇒ 谓词本身没坏,坏的是:预检在已提交批次上**覆写了记账**(现在已如实报「同键什么都不改」),
//       以及幂等键一旦消费就**再没有重放路径**。
//  2. 幂等键消费之后,库里那 511 条出处指针**永远修不回来** —— 本票补的 `replay` 入口。

/** 把载荷里每一条出处的 `sourceFile` 换成给定路径(键与 sourceIdentity 不动)。 */
function withEvidencePath(request: RosterImportRequest, sourceFile: string): RosterImportRequest {
  const announcement = request.payload.announcement!
  return {
    ...request,
    payload: {
      ...request.payload,
      announcement: {
        ...announcement,
        records: announcement.records.map((record) => ({
          ...record,
          events: (record.events ?? []).map((event) => ({
            ...event,
            evidence: (event.evidence ?? []).map((evidence) => ({ ...evidence, sourceFile })),
          })),
        })),
      },
    },
  }
}

/** 出处行的**坐标三元组**(按行 id 排) —— 用来证明收敛只换了 `source_file`。 */
function coordinateTriples(rows: ReturnType<typeof evidenceRows>) {
  return [...rows].sort((a, b) => a.id - b.id).map((row) => [row.attachment, row.listNo, row.page])
}

/** 载荷里出处的**路径多重集** —— 收敛前后该换的都换了、不该换的一个没动。 */
function sourceFiles(rows: ReturnType<typeof evidenceRows>) {
  return [...new Set(rows.map((row) => row.sourceFile))].sort()
}

// 下面三条走**真件**(511 行 / 510 记录 / 511 条出处),每条要跑 2–3 次完整计划,
// 而计划阶段对每条记录都要按身份与坐标找既有行 —— 单条在本机约 3–7 秒,机器有负载时
// 会到十几秒。给足 120 秒,免得用例在忙时被误报成红(它验的是语义,不是性能)。
describe('RL-19:预检报的行数 = 提交真改的行数(计划项口径与行口径都对得上)', () => {
  it('库中出处指向旧路径 → 以新来源标识重导 → 全部收敛,企业/记录/事件/出处计数一行不变', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN, executeImport: executeNativeImport })
    const client = createReviewedFixtureImportClient({ baseUrl: server.baseUrl, token: TOKEN }, db)
    try {
      const source = await loadLittleGiantSource()
      const workbook = await parseLittleGiantWorkbook(source.buffer)
      const report = buildLittleGiantImportReport(workbook)
      const request = buildLittleGiantImportRequest(workbook, { sourceFile: LIBRARY_SOURCE_FILE })
      // 报告的数字是**独立于写入侧**手算出来的(见 `layers/sme-roster/lib/roster/little-giant-import.ts`
      // 的 `totals`):记录数 = 去重后的企业数,事件数 = 出处行数(一条认定事件一条出处)。
      const recordCount = report.totals.records
      const evidenceCount = report.totals.evidences
      expect(evidenceCount).toBeGreaterThan(0)

      // 1) 历史批次:出处全部指向**库外**路径(RL-02 的口径)。
      const legacy = withEvidencePath(
        {
          ...request,
          idempotencyKey: `${LEGACY_SOURCE_FILE}#sha256:${workbook.sha256}`,
          sourceIdentity: LEGACY_SOURCE_FILE,
        },
        LEGACY_SOURCE_FILE,
      )
      expect((await client.commit(legacy)).status).toBe('committed')
      const baseline = rosterRowCounts(db)
      const before = evidenceRows(db)
      expect(before).toHaveLength(evidenceCount)
      expect(sourceFiles(before)).toEqual([LEGACY_SOURCE_FILE])

      // 2) 文件入库后重导(来源标识换成库内路径 ⇒ 换键)。
      const preflight = await client.preflight(request)
      // 计划项口径(§8.5):一条记录算一项 ⇒ `update` = 记录数。
      expect(preflight.preflight.add).toBe(0)
      expect(preflight.preflight.update).toBe(recordCount)
      // 行口径:一条记录可以带多条事件、每条各有出处 ⇒ 实测 510 项 / 511 行。
      expect(preflight.preflight.evidenceRepoints).toBe(evidenceCount)
      expect(preflight.preflight.batchStatus).not.toBe('committed')

      const committed = await client.commit(request)
      expect(committed.status).toBe('committed')
      // ★ 票面验收:预检答应的**行数** = 提交真改的**行数**。
      expect(committed.summary.evidenceRepointed).toBe(preflight.preflight.evidenceRepoints)
      expect(committed.summary.evidenceRepointed).toBe(evidenceCount)
      expect(committed.summary.written).toBe(0)
      // 逐项自报的行数之和 = 摘要的合计数 —— 「有几项」不能当「改了几行」。
      const perItem = committed.items.reduce((n, item) => n + ((item.detail?.evidenceRepointed as number) ?? 0), 0)
      expect(perItem).toBe(evidenceCount)

      // 3) 收敛:出处全部指向库内路径;四张业务表的计数一行不变。
      const after = evidenceRows(db)
      expect(sourceFiles(after)).toEqual([LIBRARY_SOURCE_FILE])
      const counts = rosterRowCounts(db)
      for (const table of ['enterprise', 'record', 'record_event', 'record_evidence', 'source_document'] as const) {
        expect({ table, n: counts[table] }).toEqual({ table, n: baseline[table] })
      }
      // 4) 事件坐标与结论一个字节都没动(只有 source_file 变了)。
      expect(coordinateTriples(after)).toEqual(coordinateTriples(before))
    } finally {
      await server.close()
    }
  }, 120_000)
})

describe('RL-19:幂等键被消费后,收敛仍补得上(重放入口 §8.9.3)', () => {
  /**
   * 这条用例把票面的**事故现场**在测试里复现出来:
   *
   *  - `commit` 用「新来源标识」的键,但载荷里的出处**还指着旧路径** —— 这正是那次
   *    「跑的是 RL-16 之前的构建」在库层面留下的样子:批次 `committed`、键被消费、
   *    指针一条没动(`evidenceRepointed: 0`)。
   *  - 之后(新构建下)无论怎么重跑都改不动:同键 `commit` 返回既有摘要,`preflight`
   *    过去还会**覆写**成「update: 510」的假象 —— 现在如实说「同键提交什么都不改」。
   *  - 补收敛的唯一路径是显式的 `replay`。
   */
  it('键已消费 → 预检如实报「同键提交什么都不改」→ commit 空操作 → replay 把指针收敛掉,计数一行不变', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN, executeImport: executeNativeImport })
    const client = createReviewedFixtureImportClient({ baseUrl: server.baseUrl, token: TOKEN }, db)
    try {
      const source = await loadLittleGiantSource()
      const workbook = await parseLittleGiantWorkbook(source.buffer)
      const report = buildLittleGiantImportReport(workbook)
      const request = buildLittleGiantImportRequest(workbook, { sourceFile: LIBRARY_SOURCE_FILE })
      const recordCount = report.totals.records
      const evidenceCount = report.totals.evidences

      // 1) 历史批次(库外路径、库外键)先落库。
      const legacy = withEvidencePath(
        {
          ...request,
          idempotencyKey: `${LEGACY_SOURCE_FILE}#sha256:${workbook.sha256}`,
          sourceIdentity: LEGACY_SOURCE_FILE,
        },
        LEGACY_SOURCE_FILE,
      )
      await client.commit(legacy)
      const baseline = rosterRowCounts(db)

      // 2) ★ 事故:键换成了新来源标识,载荷里的出处却还指着旧路径 ⇒ 批次 committed,指针一条没动。
      //    这一条提交的输出形状与票面实测**逐字一致**:`written: 0`,而 `skipped` = 被跳过的事件数
      //    + 判为 skip 的计划项数(`records`)。真件上正是 `0 / 1021`(= 511 + 510)。
      const consumed = await client.commit(withEvidencePath(request, LEGACY_SOURCE_FILE))
      if (consumed.status !== 'committed') throw new Error(JSON.stringify(consumed))
      expect(consumed.summary.written).toBe(0)
      expect(consumed.summary.evidenceRepointed).toBe(0)
      expect(consumed.summary.skipped).toBe(evidenceCount + recordCount)
      expect(sourceFiles(evidenceRows(db))).toEqual([LEGACY_SOURCE_FILE])

      // #103 retains new request hashes: a different request on a consumed key is
      // explicitly rejected. The historical RL-19 accident predates receipt retention.
      for (const submit of [() => client.preflight(request), () => client.commit(request)]) {
        await expect(submit()).rejects.toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } })
      }
      // Synthetic pre-#103 fixture: retain the original batch and every business row,
      // but remove its newly generated recovery receipt to model a real old ledger.
      db.transaction(tx => {
        const intake = tx.select({ id: schema.rosterAnnouncementIntake.id }).from(schema.rosterAnnouncementIntake)
          .where(eq(schema.rosterAnnouncementIntake.idempotencyKey, request.idempotencyKey)).get()!
        const members = tx.select({ enterpriseId: schema.rosterAnnouncementMember.enterpriseId }).from(schema.rosterAnnouncementMember)
          .where(eq(schema.rosterAnnouncementMember.intakeId, intake.id)).all()
        tx.insert(schema.rosterLegacyMember).values(members).onConflictDoNothing().run()
        tx.delete(schema.rosterAnnouncementMember).where(eq(schema.rosterAnnouncementMember.intakeId, intake.id)).run()
        tx.delete(schema.rosterAnnouncementIntake).where(eq(schema.rosterAnnouncementIntake.id, intake.id)).run()
        tx.delete(schema.importReceipt).where(eq(schema.importReceipt.batchId, consumed.batchId)).run()
      })

      // 3) 键被消费之后的**如实**预检:同键提交不会再改任何行 —— 不再报一份做不到的计划。
      const after = await client.preflight(request)
      expect(after.preflight).toMatchObject({
        add: 0,
        update: 0,
        evidenceRepoints: 0,
        batchStatus: 'committed',
      })

      // 同键 commit 更是彻底的空操作(返回既有摘要),指针还是没动。
      const again = await client.commit(request)
      expect(again.batchId).toBe(consumed.batchId)
      expect(again.summary).toEqual(consumed.summary)
      expect(sourceFiles(evidenceRows(db))).toEqual([LEGACY_SOURCE_FILE])

      // 4) ★ 唯一能让收敛真发生的那条路径:显式重放。
      const replay = await client.replay(request)
      expect(replay.status).toBe('replayed')
      expect(replay.evidenceRepointed).toBe(evidenceCount)
      // 计划口径的 `update` 与行口径的 `evidenceRepointed` 各司其职(记录数 ≤ 出处行数)。
      expect(replay.update).toBe(recordCount)
      expect(sourceFiles(evidenceRows(db))).toEqual([LIBRARY_SOURCE_FILE])

      // 5) 不变量:企业 / 记录 / 事件 / 出处计数一行不变。
      const finalCounts = rosterRowCounts(db)
      for (const table of ['enterprise', 'record', 'record_event', 'record_evidence', 'source_document'] as const) {
        expect({ table, n: finalCounts[table] }).toEqual({ table, n: baseline[table] })
      }

      // 6) 重放本身也幂等:再放一次改 0 行(不堆行、不重复记账)。
      const replay2 = await client.replay(request)
      expect(replay2.evidenceRepointed).toBe(0)
      expect(replay2.batchId).toBe(replay.batchId)
      expect(replay2.update).toBe(0)
      expect(rosterRowCounts(db)).toEqual(finalCounts)
      // 重放的记账行键是派生键(`<原键>#repoint`),不覆盖原批次的账。
      const batches = db.select().from(schema.importBatch).all()
      expect(batches.find((b) => b.id === consumed.batchId)!.status).toBe('committed')
      expect(batches.filter((b) => b.idempotencyKey.endsWith('#repoint')).length).toBe(1)
    } finally {
      await server.close()
    }
  }, 120_000)

  it('重放**只**改指针:在空库上重放,业务表一行都不新增', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN, executeImport: executeNativeImport })
    const client = createReviewedFixtureImportClient({ baseUrl: server.baseUrl, token: TOKEN }, db)
    try {
      const source = await loadLittleGiantSource()
      const workbook = await parseLittleGiantWorkbook(source.buffer)
      const request = buildLittleGiantImportRequest(workbook, { sourceFile: LIBRARY_SOURCE_FILE })

      // 库里根本没有这些记录/事件 ⇒ 重放什么也收敛不了(而**绝不**顺手把它们建出来)。
      const replay = await client.replay(request)
      expect(replay.status).toBe('replayed')
      expect(replay.evidenceRepointed).toBe(0)
      expect(replay.update).toBe(0)
      const counts = rosterRowCounts(db)
      expect(counts.enterprise).toBe(0)
      expect(counts.record).toBe(0)
      expect(counts.record_event).toBe(0)
      expect(counts.record_evidence).toBe(0)
    } finally {
      await server.close()
    }
  }, 120_000)
})
