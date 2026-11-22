import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { postgresLeadFixture } from './fixtures/postgres-leads'

const fixture = postgresLeadFixture()
const { app, dir } = fixture
const endpoint = '/api/lead-lists/versions'
const sourcePath = 'research-example.csv'
const raw = '企业名称\r\n样例企业\r\n'
const input = {
  series: '年度走访', channel: 'research', listType: 'lead', acquiredOn: '2026-11-18',
  rows: [{ rowNumber: 4, name: '样例企业', uscc: '原表格式待核对', district: '鄞州区' }, { rowNumber: 7, name: '后来匹配企业' }],
}
beforeAll(async () => {
  await fixture.start(({ filesDir }) => writeFileSync(join(filesDir, sourcePath), raw))
}, 60_000)
afterAll(fixture.close)

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
  const directory = '/api/core/enterprises'
  const firstPage = await (await app.request(directory + '?page=1&limit=1')).json()
  const secondPage = await (await app.request(directory + '?page=2&limit=1')).json()
  expect(firstPage).toMatchObject({ page: 1, total: 2, rows: [{ id: enterprise.id }] })
  expect(secondPage).toMatchObject({ page: 2, total: 2, rows: [{ id: linked.rows[0].enterpriseId }] })
  expect(await (await app.request(directory + '?page=200&limit=1')).json()).toEqual(secondPage)
  const matched = await (await app.request(directory + '?page=2&name=' + encodeURIComponent('后来匹配'))).json()
  expect(matched).toMatchObject({ page: 1, total: 1, rows: [{ id: enterprise.id }] })
  expect(await (await app.request(directory + '?limit=1')).json()).toEqual({ rows: firstPage.rows, nextAfter: enterprise.id })
  expect((await app.request(directory + '?page=2&after=1')).status).toBe(400)
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

  const browserPath = `${endpoint}/browser-create`
  const browserPayload = { ...payload, series: '网页新增名单' }
  const origin = new URL(app.url('/')).origin
  const browserHeaders = {
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    'x-lead-list-browser': '1',
    origin,
  }
  async function browserPost(path: string, headers: Record<string, string>, body: unknown = browserPayload) {
    return fetch(app.url(path), { method: 'POST', headers, body: JSON.stringify(body) })
  }
  expect((await browserPost(endpoint, browserHeaders)).status).toBe(401)
  const { 'x-lead-list-browser': _marker, ...withoutMarker } = browserHeaders
  for (const headers of [
    withoutMarker,
    { ...withoutMarker, 'x-task-center-browser': '1' },
    { ...browserHeaders, origin: 'http://example.invalid', 'x-forwarded-host': 'example.invalid' },
    { ...browserHeaders, 'sec-fetch-site': 'cross-site' },
    { ...browserHeaders, 'content-type': 'text/plain' },
  ]) {
    expect((await browserPost(browserPath, headers)).status).toBe(403)
  }
  const beforeCreate = await (await app.request(endpoint)).json()
  expect(beforeCreate.versions.map((version: { id: number }) => version.id)).toEqual([first.id])
  expect((await browserPost(browserPath, browserHeaders, { ...browserPayload, rows: [] })).status).toBe(400)
  const created = await browserPost(browserPath, browserHeaders)
  expect(created.status).toBe(201)
  const browserVersion = await created.json()
  expect(await post(endpoint, browserPayload, 200)).toEqual({ id: browserVersion.id, created: false })
  const browserDetail = await (await app.request(`${endpoint}/${browserVersion.id}`)).json()
  expect(browserDetail.rows.map(({ rowNumber, enterpriseId }: { rowNumber: number; enterpriseId: number | null }) => [rowNumber, enterpriseId])).toEqual([[4, null], [7, null]])
  const browserSupplement = `${endpoint}/${browserVersion.id}/supplement`
  const corrected = {
    decisions: [
      { action: 'create', rowId: browserDetail.rows[0].id, fields: { name: '新录入企业' } },
      { action: 'attach', rowId: browserDetail.rows[1].id, enterpriseId: enterprise.id, expectedRevision: enterprise.revision,
        fields: { name: '后来匹配企业新名称' } },
    ],
  }
  expect((await browserPost(browserSupplement, withoutMarker, corrected)).status).toBe(401)
  expect((await browserPost(browserSupplement, { ...browserHeaders, 'sec-fetch-site': 'cross-site' }, corrected)).status).toBe(401)
  expect((await browserPost(browserSupplement, browserHeaders, { decisions: [] })).status).toBe(400)
  const browserSaved = await browserPost(browserSupplement, browserHeaders, corrected)
  expect(browserSaved.status).toBe(200)
  const receipt = await browserSaved.json()
  expect(await (await browserPost(browserSupplement, browserHeaders, corrected)).json()).toEqual(receipt)
  const sourceEnterprises = await (await app.request(`${directory}?sourceId=${receipt.sourceId}`)).json()
  expect(sourceEnterprises.rows.map(({ name }: { name: string }) => name)).toEqual(['后来匹配企业新名称', '新录入企业'])
  const preserved = await (await app.request(`${endpoint}/${browserVersion.id}`)).json()
  expect(preserved.rows).toMatchObject([
    { name: '样例企业', uscc: '原表格式待核对', enterpriseId: receipt.rows[0].enterpriseId },
    { name: '后来匹配企业', enterpriseId: enterprise.id },
  ])
})

it('uses managed dictionary options in new lead lists and preserves references when a name changes', async () => {
  const origin = new URL(app.url('/')).origin
  const headers = {
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    'x-dictionary-browser': '1',
    origin,
  }
  const sources = '/api/core/dictionaries/list-sources'
  const types = '/api/core/dictionaries/list-types'
  const saveEntry = (path: string, body: object, requestHeaders = headers) =>
    fetch(app.url(path), { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) })

  expect((await saveEntry(sources, { name: '行业协会' }, { ...headers, origin: 'http://example.invalid' })).status).toBe(403)
  expect((await saveEntry('/api/core/dictionaries/regions', { name: '测试' })).status).toBe(404)
  const addSource = await saveEntry(sources, { name: '行业协会' })
  expect(addSource.status).toBe(200)
  const source = await addSource.json()
  const addType = await saveEntry(types, { name: '对接清单' })
  expect(addType.status).toBe(200)
  const type = await addType.json()
  expect((await saveEntry(sources, { name: ' 行业协会 ' })).status).toBe(409)
  expect((await saveEntry(sources, { code: 'direct', previousName: '直接添加', name: '测试' })).status).toBe(403)

  const dictionaryFile = 'dictionary-example.csv'
  writeFileSync(join(dir, 'files', dictionaryFile), raw + '字典验收企业\r\n')
  const uploaded = await post('/api/files/register', { relPath: dictionaryFile }, 201)
  const version = await post(endpoint, {
    ...input, series: '字典验收', fileId: uploaded.id, channel: source.code, listType: type.code,
  }, 201)

  const renamed = await saveEntry(sources, { code: source.code, previousName: source.name, name: '行业商协会' })
  expect(renamed.status).toBe(200)
  expect(await renamed.json()).toEqual({ code: source.code, name: '行业商协会' })
  expect((await saveEntry(sources, { code: source.code, previousName: source.name, name: '商会' })).status).toBe(409)
  const catalog = await (await app.request(endpoint)).json()
  expect(catalog.channels).toContainEqual({ code: source.code, name: '行业商协会' })
  expect(catalog.listTypes).toContainEqual(type)
  expect(catalog.versions.find(({ id }: { id: number }) => id === version.id)).toMatchObject({
    channel: source.code, listType: type.code,
  })
  const titles = await (await app.request('/api/roster/dictionaries/titles')).json()
  expect(titles.map(({ code }: { code: string }) => code)).toContain('little_giant')
})
