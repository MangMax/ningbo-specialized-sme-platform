import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { installLeadListSchema } from '../../../layers/lead-lists/install-schema'
import { nativeAppAdapter } from '../../support/native-app'

const dir = mkdtempSync(join(tmpdir(), 'lead-list-version-'))
const app = nativeAppAdapter({ dir, token: 'isolated-lead-list-token' })
const endpoint = '/api/lead-lists/versions'
const sourcePath = 'research-example.csv'
const raw = '企业名称\r\n样例企业\r\n'
const input = {
  series: '年度走访', channel: 'research', listType: 'lead', acquiredOn: '2026-11-18',
  rows: [{ rowNumber: 4, name: '样例企业', uscc: '原表格式待核对', district: '鄞州区' }, { rowNumber: 7, name: '后来匹配企业' }],
}
beforeAll(async () => {
  app.db.$client.transaction(() => installLeadListSchema(app.db.$client))()
  mkdirSync(join(dir, 'files'))
  writeFileSync(join(dir, 'files', sourcePath), raw)
  await app.start()
}, 60_000)
afterAll(async () => {
  try { await app.close() } finally { rmSync(dir, { force: true, recursive: true }) }
})

async function post(path: string, body: object, status: number) {
  const response = await app.request(path, { method: 'POST', body: JSON.stringify(body) })
  const result = await response.json()
  expect(response.status, JSON.stringify(result)).toBe(status)
  return result
}

it('registers the original file and immutable rows before explicit atomic enterprise supplementation', async () => {
  const registeredFile = await post('/api/files/register', { relPath: sourcePath }, 201)
  const payload = { ...input, fileId: registeredFile.id }
  const unauthorized = await fetch(app.url(endpoint), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  expect(unauthorized.status).toBe(401)
  await post(endpoint, { ...payload, acquiredOn: '2026-02-30' }, 400)
  const first = await post(endpoint, payload, 201)
  expect(await post(endpoint, { ...payload, rows: payload.rows.toReversed() }, 200)).toEqual({ id: first.id, created: false })
  await post(endpoint, { ...payload, rows: [{ rowNumber: 4, name: '不同的名单' }] }, 409)
  const version = (await (await app.request(`${endpoint}/${first.id}`)).json())
  expect(version.rows).toMatchObject([
    { rowNumber: 4, name: '样例企业', uscc: '原表格式待核对', district: '鄞州区', enterpriseId: null },
    { rowNumber: 7, name: '后来匹配企业', enterpriseId: null },
  ])
  expect((await (await app.request('/api/core/enterprises')).json()).rows).toEqual([])
  const fileList = await (await app.request('/api/files?leadListUsage=source')).json()
  expect(fileList.rows.map(({ id, referenceCount }: { id: number; referenceCount: number }) => ({ id, referenceCount }))).toEqual([{ id: registeredFile.id, referenceCount: 1 }])
  const maintenance = await (await app.request(`/api/files/${registeredFile.id}/maintenance`)).json()
  const quarantine = await app.request(`/api/files/${registeredFile.id}?deleteDisk=1`, {
    method: 'DELETE', body: JSON.stringify({ expectedRevision: maintenance.revision, idempotencyKey: 'protect-lead-source',
      actor: 'fixture', basis: '测试原件保护' }),
  })
  expect(quarantine.status).toBe(409)
  const original = await app.request(`${endpoint}/${first.id}/source`)
  expect(original.status).toBe(200)
  expect(await original.text()).toBe(raw)
  const supplement = `${endpoint}/${first.id}/supplement`
  const review = { actor: { type: 'user', id: '复核人' }, basis: '核对原件' }
  const create = { action: 'create', rowId: version.rows[0].id, fields: { name: '样例企业' } }
  await post(supplement, { ...review, decisions: [create, { action: 'attach', rowId: version.rows[1].id, enterpriseId: 999, expectedRevision: 1 }] }, 404)
  expect((await (await app.request('/api/core/enterprises')).json()).rows).toEqual([])
  const enterprise = await post('/api/core/enterprises', { name: '后来匹配企业' }, 200)
  const attach = { action: 'attach', rowId: version.rows[1].id, enterpriseId: enterprise.id, expectedRevision: enterprise.revision }
  const confirmation = { ...review, decisions: [create, attach] }
  const linked = await post(supplement, confirmation, 200)
  expect(await post(supplement, confirmation, 200)).toEqual(linked)
  expect(linked.rows[1].enterpriseId).toBe(enterprise.id)
  const sources = await (await app.request(`/api/core/enterprises/${enterprise.id}/sources`)).json()
  expect(sources.rows ?? sources).toEqual(expect.arrayContaining([expect.objectContaining({
    module: 'lead-lists', series: '年度走访', acquiredOn: '2026-11-18', fileId: registeredFile.id, sha256: registeredFile.sha256,
  })]))
  const reloaded = await (await app.request(`${endpoint}/${first.id}`)).json()
  expect(reloaded.rows.map((row: { name: string; enterpriseId: number }) => [row.name, row.enterpriseId])).toEqual([
    ['样例企业', linked.rows[0].enterpriseId], ['后来匹配企业', enterprise.id],
  ])
  const roster = await (await app.request('/api/roster/enterprises')).json()
  expect(roster.rows).toEqual([])
})
