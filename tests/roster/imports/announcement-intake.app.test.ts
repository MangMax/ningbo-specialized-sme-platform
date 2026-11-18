import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { nativeAppAdapter } from '../../support/native-app'

const dir = mkdtempSync(join(tmpdir(), 'announcement-intake-'))
const app = nativeAppAdapter({ dir, token: 'isolated-intake-test' })
beforeAll(() => app.start())
afterAll(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

const core = '/api/core/enterprises'
const imports = '/api/roster/import'
const original = {
  idempotencyKey: 'announcement-2025',
  sourceKind: 'announcement',
  sourceIdentity: 'synthetic-original.xlsx',
  payload: { announcement: {
    sourceDocument: { source: 'jxj', title: '合成公布名单' },
    records: [
      { enterprise: { name: '核对对象', district: '源属地' }, titleCode: 'specialized_sme',
        events: [{ eventType: 'award', year: 2025, batchSeq: 1, evidence: [{ sourceFile: 'synthetic-original.xlsx', listNo: 1 }] }] },
      { enterprise: { name: '另一企业' }, titleCode: 'little_giant',
        events: [{ eventType: 'award', year: 2025, batchSeq: 1 }] },
    ],
  } },
}

async function submit(path: string, value: unknown, status = 200, method = 'POST') {
  const response = await app.request(path, { method, body: JSON.stringify(value) })
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(status)
  return body
}
async function get(path: string) {
  const response = await app.request(path)
  expect(response.status).toBe(200)
  return response.json()
}

test('preserves original rows before a reviewed supplement and retains shared sources after roster removal', async () => {
  expect((await get(core)).rows).toEqual([])
  const staged = await submit(imports + '/commit', original)
  expect(staged).toMatchObject({ status: 'staged', rowCount: 2 })
  const intake = imports + '/intake/' + staged.intakeId
  expect(await get(intake)).toMatchObject({ status: 'staged', announcement: original.payload.announcement })
  expect((await get(core)).rows).toEqual([])
  expect(await submit(imports + '/commit', original)).toEqual(staged)
  await submit(imports + '/commit', { ...original, sourceIdentity: 'changed.xlsx' }, 409)

  const target = await submit(core, { name: '核对对象', uscc: '91330226MA2CL6FP2U' })
  expect(await get(core + '/' + target.id + '/sources')).toMatchObject([{ channel: '直接添加' }])
  const review = {
    sourceDigest: staged.sourceDigest, basis: '核对合成公告与企业资料',
    rows: [{ action: 'attach', enterpriseId: target.id, expectedRevision: 1 }, { action: 'create', fields: { name: '另一企业' } }],
  }
  await submit(intake + '/supplement', { ...review, sourceDigest: '0'.repeat(64) }, 409)
  await submit(intake + '/supplement', { ...review, rows: [
    { action: 'attach', enterpriseId: target.id, expectedRevision: 1, fields: { name: '临时更名' } },
    { action: 'create', fields: { name: '错误的企业' } },
  ] }, 409)
  expect((await get(core)).rows).toEqual([target])

  const [receipt, retry] = await Promise.all([
    submit(intake + '/supplement', review),
    submit(intake + '/supplement', review),
  ])
  expect(receipt).toEqual(retry)
  expect(receipt).toMatchObject({ status: 'supplemented', owners: [target.id, target.id + 1] })
  await submit(intake + '/supplement', { ...review, basis: '不同决定' }, 409)
  const { rows } = await get(core)
  expect(rows).toMatchObject([{ id: target.id, name: '核对对象', uscc: '91330226MA2CL6FP2U' }, { name: '另一企业', uscc: null }])
  const sources = await get(core + '/' + target.id + '/sources')
  expect(sources).toMatchObject([{ channel: '直接添加' }, { channel: '经信局', listType: '公布名单' }])
  expect((await get(core + '?sourceId=' + sources[1].id)).rows.map((row: { id: number }) => row.id)).toEqual(receipt.owners)

  await submit(intake + '/remove', { sourceDigest: staged.sourceDigest, reason: '撤下本次录入' })
  expect(await get(intake)).toMatchObject({ status: 'removed', announcement: original.payload.announcement })
  expect(await get(core + '/' + target.id + '/sources')).toEqual(sources)
  await submit(core + '/' + target.id + '/membership', { expectedRevision: 1, removedReason: '退出基础库' }, 200, 'PATCH')
  expect((await get(core)).rows).toHaveLength(1)
  expect((await get(core + '?includeRemoved=true')).rows).toHaveLength(2)
  await submit(core + '/' + target.id + '/membership', { expectedRevision: 2, removedReason: null }, 200, 'PATCH')
  expect((await get(core)).rows).toHaveLength(2)
})
