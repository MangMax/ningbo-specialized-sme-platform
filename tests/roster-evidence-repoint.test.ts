/**
 * RL-16(票 #17)—— **来源文件入库后,出处指针怎么收敛**。
 *
 * 问题:小巨人工作簿导入时用的来源标识是**库外路径**,`record_evidence.source_file`
 * 于是解析不到文件,名录行的预览/跳转全断(用户 2026-10-16 反馈)。
 *
 * 修法(两条一起才成立):
 *  1. 导入侧把来源标识换成**库内相对路径**(见 `lib/roster/little-giant-import.ts`);
 *  2. 统一写入 API 重放同一份来源时,**只把出处的 `source_file` 收敛到新路径** ——
 *     事件坐标不变 ⇒ 历史一行不改、一行不加、一行不删。
 *
 * 这个文件盯着第 2 条。走的是**真实 HTTP**(`tests/helpers/roster-http-server.ts` 起真端口,
 * `lib/roster-import-client.ts` 发真请求),库只用 drizzle **读**计数。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import { createRosterImportClient, type RosterImportRequest } from '../lib/roster-import-client'
import { rosterRowCounts } from '../server/utils/roster-import'
import { startRosterApi } from './helpers/roster-http-server'

const TOKEN = 'rl16-repoint-token-value'

/** 库外路径(RL-02 的历史口径)与库内路径(RL-16 之后的唯一口径)。 */
const LEGACY_SOURCE_FILE = '经信局名单/小巨人/经信局公布历年小巨人企业名单.xlsx'
const LIBRARY_SOURCE_FILE = 'jxj/announcement/经信局公布历年小巨人企业名单.xlsx'

const dirs: string[] = []

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-repoint-'))
  dirs.push(dir)
  return useDb({ dbPath: join(dir, 'roster.db') })
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
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    try {
      // 1) 历史批次:库外路径(RL-02 的口径)。
      const legacy = littleGiantRequest({
        idempotencyKey: `${LEGACY_SOURCE_FILE}#sha256:sha-historical`,
        sourceFile: LEGACY_SOURCE_FILE,
        sha256: 'sha-historical',
      })
      expect((await client.commit(legacy)).status).toBe('committed')

      const afterFirst = rosterRowCounts(db)
      expect(evidenceRows(db).map((row) => row.sourceFile)).toEqual([LEGACY_SOURCE_FILE])

      // 2) 文件入库后的重导:同一份内容,来源标识换成了库内路径 ⇒ 键也不同。
      const relinked = littleGiantRequest({
        idempotencyKey: `${LIBRARY_SOURCE_FILE}#sha256:sha-historical`,
        sourceFile: LIBRARY_SOURCE_FILE,
        sha256: 'sha-historical',
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
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    try {
      const request = littleGiantRequest({
        idempotencyKey: `${LIBRARY_SOURCE_FILE}#sha256:sha-stable`,
        sourceFile: LIBRARY_SOURCE_FILE,
        sha256: 'sha-stable',
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
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    try {
      // 同一家企业、同一坐标的事件,但出处序号是 20(而不是重导载荷里的 14)。
      const legacy = littleGiantRequest({
        idempotencyKey: `${LEGACY_SOURCE_FILE}#sha256:sha-other-listno`,
        sourceFile: LEGACY_SOURCE_FILE,
        sha256: 'sha-other-listno',
        listNo: 20,
      })
      await client.commit(legacy)

      const relinked = littleGiantRequest({
        idempotencyKey: `${LIBRARY_SOURCE_FILE}#sha256:sha-other-listno`,
        sourceFile: LIBRARY_SOURCE_FILE,
        sha256: 'sha-other-listno',
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
