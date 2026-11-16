
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'

import { businessIdentity, expectedBusinessIdentity, matchesBusinessIdentity } from './fixtures/specialized-export'
import { reviewCurrentExportDecision } from '../fixtures/qualification-decisions'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { initializeDb, schema as s } from '../../../db/client'

import { writeCurrentWorkbook } from '../../../lib/roster/current-workbook'
const dir=mkdtempSync(join(tmpdir(),'innovative-sme-native-'))
let generation=0
let db=initializeDb({create:true,dbPath:join(dir,'initial.db')})
const titleCode='innovative_sme'
const year=new Date().getFullYear()
type Event = Pick<typeof s.recordEvent.$inferInsert, 'eventType' | 'year' | 'decidedYear' | 'reviewOutcome' | 'batchSeq'>
const award: Event={eventType:'award',year,batchSeq:1}
beforeEach(()=>{db.$client.close();db=initializeDb({create:true,dbPath:join(dir,String(++generation)+'.db')})})
afterAll(()=>{db.$client.close();rmSync(dir,{recursive:true,force:true})})
async function workbook(key:string){const filename=join(dir,key+'.xlsx');const result=await writeCurrentWorkbook(db.$client,titleCode,filename,()=>{});const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(filename);return {wb,result}}
function record(enterpriseId: number, name: string, events: Event[] = [award], title = titleCode) {
  const row = db.insert(s.record).values({ enterpriseId, titleCode: title, source: 'jxj', nameRaw: name }).returning().get()
  const eventRows = events.map(event => {
    const rowEvent = db.insert(s.recordEvent).values({ recordId: row.id, ...event }).returning().get()
    db.insert(s.recordEvidence).values({ recordEventId: rowEvent.id, sourceFile: `jxj/announcement/${title}-synthetic.xlsx`, attachment: '合成名单', listNo: rowEvent.id }).run()
    return rowEvent
  })
  return { record: row, events: eventRows }
}
function candidate(name: string, events: Event[] = [award], title = titleCode) {
  const enterprise = db.insert(s.enterprise).values({ name, nameNorm: name, usccNorm: `TEST-119-${name}`, district: '鄞州区', city: '宁波市' }).returning().get()
  return { enterprise, ...record(enterprise.id, name, events, title) }
}
function rows(wb: ExcelJS.Workbook, sheet: string) {
  const ws = wb.getWorksheet(sheet)!
  return ws.getRows(2, Math.max(0, ws.rowCount - 1))?.map(row => row.values as any[]) ?? []
}
function decision(enterpriseId: number, reasonCode: 'moved_out' | 'moved_in' | 'deregistered' | 'pending_review' | 'other', extra = {}) {
  const decision = db.insert(s.differenceReason).values({ enterpriseId, titleCode, direction: 'extra_in_miit', status: 'confirmed_reason', reasonCode, verificationStatus: 'confirmed', lifecycleAction: 'replace', basis: '合成已确认主体事实', effectiveAt: '2025-01-01T00:00:00Z', recordedAt: new Date().toISOString(), ...extra }).returning().get()
  reviewCurrentExportDecision(db,decision)
  return decision
}
function query(enterprise: typeof s.enterprise.$inferSelect, status: 'success' | 'failed' | 'no_record', key = enterprise.usccNorm!, rowStatus?: string) {
  const native = submitNativePlatformQuery(db, { interface: 'business_list', queryKey: key, rdjb: '1', titleCode, queriedAt: new Date().toISOString(), status, rawResponse: JSON.stringify({ status, rowStatus: rowStatus ?? null }), relations: rowStatus == null ? [] : [{ sequenceNo: 1, enterpriseId: enterprise.id, nameRaw: enterprise.name, usccRaw: enterprise.usccNorm, status: rowStatus, declareKind: 'update', verificationStatus: 'confirmed', matchBasis: 'uscc' }] })
  return { id: native.queryId, relationIds: native.relationIds }
}
it('创新型按自身认定周期复核并保留恢复与同年冲突', async () => {
  candidate('新认定')
  candidate('复核通过', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'review', year: year - 4, batchSeq: 1, decidedYear: year - 1, reviewOutcome: 'passed' }])
  const restored = candidate('失败后恢复', [{ eventType: 'award', year: year - 5, batchSeq: 1 }, { eventType: 'review', year: year - 5, batchSeq: 1, decidedYear: year - 2, reviewOutcome: 'failed' }, { eventType: 'award', year: year - 1, batchSeq: 2 }])
  candidate('旧周期晚失败', [{ eventType: 'award', year: year - 5, batchSeq: 1 }, { eventType: 'award', year: year - 1, batchSeq: 2 }, { eventType: 'review', year: year - 5, batchSeq: 1, decidedYear: year, reviewOutcome: 'failed' }])
  const failed = candidate('本周期失败', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'review', year: year - 4, batchSeq: 1, decidedYear: year - 1, reviewOutcome: 'failed' }])
  // Own failure remains history; valid specialized qualification independently includes innovative.
  record(failed.enterprise.id, '本周期失败', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'review', year: year - 4, batchSeq: 1, decidedYear: year - 1, reviewOutcome: 'passed' }], 'specialized_sme')
  candidate('到期结果未知', [{ eventType: 'award', year: year - 3, batchSeq: 1 }])
  candidate('复核缺结论年', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'review', year: year - 4, batchSeq: 1, reviewOutcome: 'passed' }])
  candidate('同年复核冲突', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'review', year: year - 4, batchSeq: 1, decidedYear: year - 1, reviewOutcome: 'failed' }, { eventType: 'review', year: year - 4, batchSeq: 1, decidedYear: year - 1, reviewOutcome: 'passed' }])
  candidate('同年恢复顺序未知', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'review', year: year - 4, batchSeq: 1, decidedYear: year, reviewOutcome: 'failed' }, { eventType: 'award', year, batchSeq: 2 }])
  candidate('复核原周期未知', [{ eventType: 'award', year: year - 1 }, { eventType: 'review', year: null, decidedYear: year, reviewOutcome: 'failed' }])
  candidate('纯培育', [{ eventType: 'nurture', year }])
  const { wb, result } = await workbook('119-cycles')
  expect(rows(wb, '有效企业').map(row => row[2])).toEqual(['新认定', '复核通过', '失败后恢复', '本周期失败'])
  expect(rows(wb, '未认定').map(row => row[2])).toEqual(['纯培育'])
  expect(rows(wb, '已到期').map(row => row[2])).toEqual(['旧周期晚失败', '到期结果未知', '复核缺结论年', '同年复核冲突', '同年恢复顺序未知', '复核原周期未知'])
  expect(result.counts).toEqual({ eligible: 4, pending: 0, excluded: 7 })
  const restoreRow = rows(wb, '有效企业').find(row => matchesBusinessIdentity(db, row, restored.enterprise.id))!
  expect(restoreRow[6]).toBe(String(year - 5))
  expect(restoreRow[7].split('\n')).toHaveLength(restored.events.length)
  expect(restoreRow[7]).toContain('复核未通过')
  expect(rows(wb, '有效企业')[1]![7]).toContain(`${year - 1}年复核通过`)
  for (const name of ['同年复核冲突', '同年恢复顺序未知']) expect(rows(wb, '已到期').find(row => row[2] === name)![15]).toContain('复核明确不通过')
})
it('创新型迁入更名双备注与主体排除不越过证据边界', async () => {
  // Historical case name retained; #355/#379 display legacy unknown per source,
  // preserve the confirmed alias, and remove the unsupported rename inference.
  const renamed = candidate('迁入现名')
  db.update(s.record).set({ nameRaw: '公布旧名' }).where(eq(s.record.id, renamed.record.id)).run()
  const alias = db.insert(s.enterpriseAlias).values({ enterpriseId: renamed.enterprise.id, name: '公布旧名', nameNorm: '公布旧名', sourceKind: 'manual', verificationStatus: 'confirmed' }).returning().get()
  decision(renamed.enterprise.id, 'moved_in', { movedInTitleCode: titleCode })
  const out = candidate('外迁排除'); const outDecision = decision(out.enterprise.id, 'moved_out')
  const deregistered = candidate('注销排除'); decision(deregistered.enterprise.id, 'deregistered')
  const returned = candidate('迁出后迁回')
  const prior = decision(returned.enterprise.id, 'moved_out', { recordedAt: '2025-01-01T00:00:00Z' })
  decision(returned.enterprise.id, 'moved_in', { previousId: prior.id, effectiveAt: '2026-01-01T00:00:00Z', movedInTitleCode: titleCode })
  const migrant = candidate('迁入缺本称号资格', [])
  decision(migrant.enterprise.id, 'moved_in', { movedInTitleCode: titleCode, movedInYear: year })
  record(migrant.enterprise.id, '迁入缺本称号资格', [award], 'little_giant')
  const unknown = candidate('未确认旧名')
  db.update(s.record).set({ nameRaw: '待确认公布名' }).where(eq(s.record.id, unknown.record.id)).run()
  const partial = candidate('缺正式出处')
  db.delete(s.recordEvidence).where(eq(s.recordEvidence.recordEventId, partial.events[0]!.id)).run()
  const conflict = candidate('统代冲突')
  db.update(s.record).set({ usccRaw: 'OTHER-IDENTITY' }).where(eq(s.record.id, conflict.record.id)).run()
  const stale = candidate('旧解释前提未知')
  const staleDecision = decision(stale.enterprise.id, 'moved_out', { lifecycleAction: null, basis: null, reasonNote: '历史缺码无法查询' })
  const terminated = candidate('终止周期未结构化')
  decision(terminated.enterprise.id, 'other', { reasonNote: '正式取消/终止，但缺对应周期结构化依据' })
  const expectedDisplay = Object.freeze({
    8: `${year}年第1批认定，《innovative_sme-synthetic.xlsx》：未逐出处核实`,
    9: '公布旧名',
    11: '历史诊断（不参与有效判定）：迁入资格来源版本或归属需重新核实（已存决定）；逐出处公布名见公布名称列；现用名见企业名称列；已确认曾用名仅见该列',
    12: `${year}年第1批认定：宁波市经信局公布资料\n《innovative_sme-synthetic.xlsx》，附件：合成名单，名单序号${renamed.events[0]!.id}，未逐出处核实`,
  })
  const { wb, result } = await workbook('119-identity')
  expect(rows(wb, '有效企业').map(row => row[2])).toEqual(['迁入现名', '外迁排除', '注销排除', '迁出后迁回', '迁入缺本称号资格', '未确认旧名', '缺正式出处', '统代冲突', '旧解释前提未知', '终止周期未结构化'])
  expect(rows(wb, '已迁出')).toEqual([]); expect(rows(wb, '已注销（吊销）')).toEqual([])
  expect(rows(wb, '未认定').map(row => row[2])).toEqual([])
  expect(result.counts).toEqual({ eligible: 10, pending: 0, excluded: 0 })
  const renameRow = rows(wb, '有效企业')[0]!
  expect({ 8: renameRow[8], 9: renameRow[9], 11: renameRow[11], 12: renameRow[12] }).toEqual(expectedDisplay); expect(renameRow[9]).toBe('公布旧名')
  expect(renameRow[11]).not.toContain('已确认迁入宁波')
  expect(renameRow[11]).not.toContain('现已更名为')
  expect(renameRow[11]).not.toContain('未见宁波')
  expect(renameRow[11]).not.toContain('原城市：')
  expect(renameRow[9]).toBe(alias.name)
  expect(rows(wb, '有效企业').find(row => row[2] === '外迁排除')![13]).toBe('有效企业')
  expect(outDecision.id).toBeGreaterThan(0)
  const inherited = rows(wb, '有效企业').find(row => row[2] === '迁入缺本称号资格')!
  expect(inherited[6] ?? null).toBeNull()
  expect(inherited[7] ?? null).toBeNull()
  expect(inherited[11]).toContain('按有效小巨人资格计入')
  expect(rows(wb, '有效企业').find(row => row[2] === '旧解释前提未知')![13]).toBe('有效企业')
  expect(staleDecision.id).toBeGreaterThan(0)
  expect(rows(wb, '有效企业').find(row => row[2] === '统代冲突')![11]).toContain('身份冲突')
})
it('创新型查询失败退回待审与旧决定不冒充资格失效', async () => {
  for (const status of ['failed', 'no_record'] as const) query(candidate('查询' + status).enterprise, status)
  for (const status of ['退回', '待审核']) {
    const c = candidate('更新' + status)
    query(c.enterprise, 'success', c.enterprise.usccNorm!, status)
  }
  const pending = candidate('更新待审决定'); decision(pending.enterprise.id, 'pending_review', { measureCode: 'follow_review' })
  const withdrawn = candidate('撤回旧外迁')
  const old = decision(withdrawn.enterprise.id, 'moved_out', { recordedAt: '2025-01-01T00:00:00Z' })
  decision(withdrawn.enterprise.id, 'moved_out', { lifecycleAction: 'withdraw', previousId: old.id })
  const stale = candidate('补码后旧按名证据')
  const staleQuery = query(stale.enterprise, 'failed', 'name:' + stale.enterprise.nameNorm)
  const staleDecision = decision(stale.enterprise.id, 'moved_out', { evidenceQueryId: staleQuery.id })
  const onlyPlatform = db.insert(s.enterprise).values({ name: '仅平台通过', nameNorm: '仅平台通过', usccNorm: 'ONLY-PLATFORM-119' }).returning().get()
  const q = query(onlyPlatform, 'success', onlyPlatform.usccNorm!, '认定通过')
  const relation = { id: q.relationIds[0]! }
  const unconfirmed = candidate('候选对应非资格', [{ eventType: 'maintain', year }])
  db.update(s.record).set({ source: 'miit' }).where(eq(s.record.id, unconfirmed.record.id)).run()
  const edge = db.insert(s.recordCorrespondence).values({ edgeKey: 'candidate-119', type: 'event_process', role: 'award', eventId: unconfirmed.events[0]!.id, enterpriseId: unconfirmed.enterprise.id, titleCode, status: 'candidate', revision: 1, targetIdentity: {}, provenance: {}, sourceFingerprint: 'synthetic-119', ruleId: 'manual', ruleVersion: '1', createdAt: new Date().toISOString() }).returning().get()
  const { wb, result } = await workbook('119-platform-boundary')
  expect(rows(wb, '有效企业').map(row => row[2])).toEqual(['查询failed', '查询no_record', '更新退回', '更新待审核', '更新待审决定', '撤回旧外迁', '补码后旧按名证据'])
  expect(rows(wb, '未认定').map(row => row[2])).toEqual(['仅平台通过', '候选对应非资格'])
  expect(result.counts).toEqual({ eligible: 7, pending: 0, excluded: 2 })
  expect(rows(wb, '有效企业').find(row => row[2] === '补码后旧按名证据')![13]).toBe('有效企业')
  expect(rows(wb, '未认定')[0]![15]).toContain('缺少已确认认定及资格依据')
  expect(rows(wb, '未认定')[1]![13]).toBe('未认定'); expect(rows(wb, '未认定')[1]![15]).toContain('缺少已确认认定及资格依据')
  expect(staleDecision.id).toBeGreaterThan(0); expect(relation.id).toBeGreaterThan(0); expect(edge.id).toBeGreaterThan(0)
})
it('创新型超页全量文本安全与业务只读', async () => {
  const fixtures = db.transaction(() => Array.from({ length: 251 }, (_, index) => candidate('超页合成' + index)))
  const textNames = ['=HYPERLINK("https://invalid.example","合成")', '+SUM(1,2)', '-1+2', '@SUM(1,2)', '长名称😀' + '宁波'.repeat(80)]
  for (const [index, name] of textNames.entries()) {
    const c = candidate(name)
    db.update(s.enterprise).set({ usccNorm: `00123456789012345${index}` }).where(eq(s.enterprise.id, c.enterprise.id)).run()
  }
  const sourceDigest = () => {
    const hash = createHash('sha256')
    for (const table of ['enterprise', 'record', 'record_event', 'record_evidence', 'enterprise_alias', 'platform_collection', 'platform_business_observation', 'difference_reason', 'record_correspondence']) {
      for (const row of db.$client.prepare(`select * from ${table} order by id`).iterate()) hash.update(JSON.stringify(row))
    }
    for (const { name } of db.$client.prepare("select name from sqlite_master where type='table' and name like 'platform_%' order by name").all() as Array<{ name: string }>) {
      hash.update(name)
      for (const row of db.$client.prepare(`select * from "${name}" order by rowid`).iterate()) hash.update(JSON.stringify(row))
    }
    return hash.digest('hex')
  }
  const before = sourceDigest()
  const { wb, result } = await workbook('119-pages-text')
  expect(result.counts).toEqual({ eligible: 256, pending: 0, excluded: 0 })
  expect(result.total).toBe(256)
  expect(rows(wb, '有效企业').slice(0, 251).map(row => businessIdentity(row))).toEqual(fixtures.map(c => expectedBusinessIdentity(db,c.enterprise.id)))
  const ws = wb.getWorksheet('有效企业')!
  for (const [index, name] of textNames.entries()) {
    const row = ws.getRow(253 + index)
    expect(row.getCell(2).value).toBe(name)
    expect(row.getCell(2).type).toBe(ExcelJS.ValueType.String)
    expect(row.getCell(3).value).toBe(`00123456789012345${index}`)
    expect(row.getCell(3).type).toBe(ExcelJS.ValueType.String)
  }
  expect(sourceDigest()).toBe(before)
})
