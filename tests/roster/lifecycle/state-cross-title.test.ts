import { initializeDb } from '../../../db/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema, useDb } from '../../../db'
import { listRosterEnterprises } from '../../../layers/sme-roster/lib/roster/enterprise-roster'

/**
 * RL-04 回归钉 —— `rosterState` 的「是否还在最新快照里」必须按 **USCC 的实际出现**判定,
 * **跨称号**,而不是拿企业自己记录的称号去查「该称号的最新快照」。
 *
 * 契约 §5 的硬边界:「**公布事件永不因平台快照缺失而删除**」「证据不足不误删」。
 *
 * 旧实现的失效路径(`layers/sme-roster/lib/roster/enterprise-roster.ts` 的 `deriveRosterState`):
 * 它取 `profile.records.map(r => r.titleCode)` 去查 `latestBatchByTitle`,于是
 * 当企业出现在**别的称号**的快照里、而它自己记录的称号**一张快照都没有**时,
 * 「最新批次」集合是**空的** ⇒ `inLatest = false` ⇒ 判成 `removed_platform_only`。
 * 空集意味着「没有正证据」,而「没有正证据」只能是 `current`。
 *
 * 这里两侧都钉死:
 *  - 跨称号出现在最新快照里 ⇒ `current`(不许误删);
 *  - 确实只出现在**旧**快照里、且已从该称号最新快照消失 ⇒ `removed_platform_only`
 *    (不许因为修上面那条就把正证据也一起丢掉)。
 */

const dir = mkdtempSync(join(tmpdir(), 'spztx-roster-state-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'roster.db') })

const ids: Record<string, number> = {}

function enterprise(key: string, name: string, uscc: string): number {
  const id = db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc })
    .returning({ id: schema.enterprise.id })
    .get().id
  ids[key] = id
  return id
}

/** 一条**非 jxj** 记录 —— 它不足以让 `deriveRosterState` 直接短路成 `current`。 */
function record(enterpriseId: number, titleCode: string, source: 'jxj' | 'miit', year: number) {
  const recordId = db
    .insert(schema.record)
    .values({ enterpriseId, titleCode, source })
    .returning({ id: schema.record.id })
    .get().id
  db.insert(schema.recordEvent)
    .values({ recordId, eventType: 'maintain', year, batchSeq: 1, sortKey: year })
    .run()
  return recordId
}

function snapshotBatch(titleCode: string, year: number, sha256: string) {
  return db
    .insert(schema.platformExportBatch)
    .values({
      titleCode,
      year,
      sha256,
      collectedOn: `${year}-06-30`,
      originalFilename: `${titleCode}-${year}.xlsx`,
      rowCount: 1,
      importStatus: 'imported',
    })
    .returning({ id: schema.platformExportBatch.id })
    .get().id
}

function snapshotRow(batchId: number, sourceRowNo: number, usccRaw: string, nameRaw: string) {
  db.insert(schema.platformExportRow).values({ batchId, sourceRowNo, usccRaw, nameRaw }).run()
}

const CROSS_TITLE_USCC = '91330211BBBBBBB001X'
const OLD_ONLY_USCC = '91330211BBBBBBB002X'

beforeAll(() => {
  // —— ① 跨称号:企业记的是「创新型中小企业」,可它出现在「专精特新」的**最新**快照里,
  //        而「创新型中小企业」**一张快照都没有**。旧实现正是在这里误判为已移除。
  const crossTitle = enterprise('crossTitle', '宁波跨称号快照企业', CROSS_TITLE_USCC)
  record(crossTitle, 'innovative_sme', 'miit', 2025)

  // —— ② 对照组:只出现在「专精特新」的**旧**快照里,最新快照里没有它 ⇒ 真·已移除。
  const oldOnly = enterprise('oldOnly', '宁波仅旧快照企业', OLD_ONLY_USCC)
  record(oldOnly, 'innovative_sme', 'miit', 2025)

  const oldBatch = snapshotBatch('specialized_sme', 2025, 'sha-sme-2025')
  snapshotRow(oldBatch, 1, OLD_ONLY_USCC, '宁波仅旧快照企业')
  const latestBatch = snapshotBatch('specialized_sme', 2026, 'sha-sme-2026')
  snapshotRow(latestBatch, 1, CROSS_TITLE_USCC, '宁波跨称号快照企业')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const rowOf = (key: string) =>
  listRosterEnterprises(db, { pageSize: 200 }).rows.find((r) => r.enterpriseId === ids[key])!

describe('派生 `rosterState`:快照出现按 USCC 跨称号判定(契约 §5)', () => {
  it('企业出现在**别的称号**的最新快照里 ⇒ current(公布历史不因快照缺失被删)', () => {
    const row = rowOf('crossTitle')
    // 它确实只出现在快照里(没有 jxj 记录),但**它在最新快照里**。
    expect(row.rosterState).toBe('current')
  })

  it('只出现在**旧**快照、已从该称号最新快照消失 ⇒ removed_platform_only(正证据保留)', () => {
    expect(rowOf('oldOnly').rosterState).toBe('removed_platform_only')
  })

  it('两种状态各自可筛,不会互相冒充', () => {
    const removed = listRosterEnterprises(db, { rosterState: 'removed_platform_only', pageSize: 200 }).rows
    expect(removed.map((r) => r.name)).toEqual(['宁波仅旧快照企业'])
    const current = listRosterEnterprises(db, { rosterState: 'current', pageSize: 200 }).rows
    expect(current.map((r) => r.name)).toEqual(['宁波跨称号快照企业'])
  })
})
