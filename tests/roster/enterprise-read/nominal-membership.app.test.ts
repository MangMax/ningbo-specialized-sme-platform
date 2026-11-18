import ExcelJS from 'exceljs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { nativeAppAdapter } from '../../support/native-app'
import { createRosterImportClient, type RosterImportRequest, type SupplementAnnouncementRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { readDevelopmentDiscovery } from '../current-export/fixtures/specialized-export'

const dir = mkdtempSync(join(tmpdir(), 'nominal-membership-'))
const token = 'isolated-nominal-membership'
const app = nativeAppAdapter({ dir, token })
const core = '/api/core/enterprises'
const roster = '/api/roster/enterprises'
const first = 'A名录成员样本'
const shared = 'B名录成员样本'
const directOnly = '0名录成员样本'
const year = Number(new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 4))

beforeAll(async () => {
  const { paths } = await readDevelopmentDiscovery()
  expect(paths[core].post).toBeDefined()
  expect(paths['/api/roster/import/commit'].post).toBeDefined()
  expect(paths['/api/roster/import/intake/{id}/supplement'].post).toBeDefined()
  expect(paths['/api/roster/import/intake/{id}/remove'].post).toBeDefined()
  expect(paths[roster].get).toBeDefined()
  expect(paths['/api/roster/export'].get).toBeDefined()
  await app.start()
}, 120_000)
afterAll(async () => {
  try { await app.close() }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

async function json(path: string, body?: object) {
  const response = await app.request(path, body ? { method: 'POST', body: JSON.stringify(body) } : undefined)
  const result = await response.json()
  expect(response.status, JSON.stringify(result)).toBe(200)
  return result
}

const search = new URLSearchParams({ q: '名录成员样本', sort: 'name', pageSize: '1' }).toString()

async function expectList(page: number, names: string[], total: number, filter = '') {
  const list = await json(`${roster}?${search}&page=${page}${filter}`)
  expect(list).toMatchObject({ counts: { total, titlePairs: total }, page, pageSize: 1 })
  expect(list.rows.map((row: { name: string }) => row.name)).toEqual(names)
}

async function expectWorkbook(names: string[]) {
  const { response, bytes } = await app.download(`/api/roster/export?${search}&page=99`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(bytes).buffer)
  const sheet = workbook.getWorksheet('企业总表')!
  expect(sheet.getCell('A1').text).toContain(`共 ${names.length} 家企业,合计 ${names.length} 个`)
  expect(sheet.rowCount).toBe(names.length + 2)
  expect(names.map((_, index) => sheet.getCell(index + 3, 1).text)).toEqual(names)
}

test('version contributions control nominal list and workbook membership while history and shared sources survive removal', async () => {
  const client = createRosterImportClient({ baseUrl: app.url(''), token })
  const owner = await json(core, { name: first })
  await json(core, { name: directOnly })
  await expectList(1, [], 0)

  async function stage(batchSeq: number, names: string[]) {
    const sourceIdentity = `synthetic-membership-${batchSeq}.xlsx`
    const request: RosterImportRequest = {
      idempotencyKey: `nominal-membership-${batchSeq}`, sourceKind: 'announcement', sourceIdentity,
      payload: { announcement: {
        sourceDocument: { source: 'jxj', title: `合成名录版本 ${batchSeq}` },
        records: names.map((name, index) => ({
          enterprise: { name }, titleCode: 'specialized_sme',
          events: [{ eventType: 'award', year, decidedYear: year, batchSeq, evidence: [{ sourceFile: sourceIdentity, listNo: index + 1 }] }],
        })),
      } },
    }
    const result = await client.commit(request)
    if (result.status !== 'staged') throw new Error(JSON.stringify(result))
    return result
  }

  const v1 = await stage(1, [first, shared])
  await expectList(1, [], 0, '&source=jxj')
  expect((await json(core)).rows.map((row: { name: string }) => row.name)).toEqual([first, directOnly])
  const review: SupplementAnnouncementRequest = { sourceDigest: v1.sourceDigest, basis: '核对合成版本与企业归属', rows: [
    { action: 'attach', enterpriseId: owner.id, expectedRevision: owner.revision },
    { action: 'create', fields: { name: shared } },
  ] }
  const receipt = await client.supplement(v1.intakeId, review)
  if (receipt.status !== 'supplemented') throw new Error(JSON.stringify(receipt))
  const sharedOwner = receipt.owners[1]!
  const v2 = await stage(2, [shared])
  expect(await client.supplement(v2.intakeId, { sourceDigest: v2.sourceDigest, basis: '核对独立版本', rows: [
    { action: 'attach', enterpriseId: sharedOwner, expectedRevision: 1 },
  ] })).toMatchObject({ status: 'supplemented', owners: [sharedOwner] })

  await expectList(1, [first], 2)
  await expectList(2, [shared], 2, '&source=jxj')
  await expectWorkbook([first, shared])
  const sources = await json(`${core}/${owner.id}/sources`)
  expect(sources).toMatchObject([{ channel: '直接添加' }, { channel: '经信局', listType: '公布名单' }])
  const before = await json(`${roster}/${owner.id}`)
  expect(before.events).toMatchObject([{ eventType: 'award', year, batchSeq: 1 }])
  expect(before.evidence).toMatchObject([{ sourceFile: 'synthetic-membership-1.xlsx', listNo: 1 }])
  expect(before.qualificationAssessment.titles).toContainEqual(expect.objectContaining({
    titleCode: 'specialized_sme', effectiveQualification: expect.objectContaining({ status: 'effective' }),
  }))

  await client.removeIntake(v1.intakeId, { sourceDigest: v1.sourceDigest, reason: '撤下名单第一版' })
  expect(await client.supplement(v1.intakeId, review)).toEqual(receipt)
  expect(await client.readIntake(v1.intakeId)).toMatchObject({ status: 'removed', receipt })
  await expectList(1, [shared], 1)
  await expectList(2, [], 1, '&source=jxj')
  await expectWorkbook([shared])
  expect(await json(`${core}/${owner.id}/sources`)).toEqual(sources)
  const after = await json(`${roster}/${owner.id}`)
  expect(after).toMatchObject({ records: before.records, events: before.events, evidence: before.evidence })
  expect(after.qualificationAssessment.titles).toEqual(before.qualificationAssessment.titles)

  await client.removeIntake(v2.intakeId, { sourceDigest: v2.sourceDigest, reason: '撤下名单第二版' })
  await expectList(1, [], 0)
  await expectWorkbook([])
  expect((await json(core)).rows.map((row: { name: string }) => row.name)).toEqual([first, directOnly, shared])
})
