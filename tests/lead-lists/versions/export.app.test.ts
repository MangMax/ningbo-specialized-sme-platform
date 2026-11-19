import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { installLeadListSchema } from '../../../layers/lead-lists/install-schema'
import { qualificationExportFixture } from '../../roster/current-export/fixtures/qualification-export'
import { readDevelopmentDiscovery } from '../../roster/current-export/fixtures/specialized-export'

const fixture = qualificationExportFixture()
const base = '/api/lead-lists'
const filename = 'research-source.csv'
let qualifiedId: number

beforeAll(async () => {
  fixture.db.$client.transaction(() => installLeadListSchema(fixture.db.$client))()
  qualifiedId = fixture.candidate('核对取得资格企业').enterprise.id
  mkdirSync(join(fixture.dir, 'files'))
  writeFileSync(join(fixture.dir, 'files', filename), '企业名称\r\n核对取得资格企业\r\n')
  await fixture.start()
}, 60_000)
afterAll(() => fixture.close())

async function post(path: string, body: object, status: number) {
  const response = await fetch(fixture.url(path), { headers: fixture.headers, method: 'POST', body: JSON.stringify(body) })
  const result = await response.json()
  expect(response.status, JSON.stringify(result)).toBe(status)
  return result
}

it('exports preserved lead rows with effective roster titles for linked enterprises through the public task flow', async () => {
  const discovery = await readDevelopmentDiscovery()
  expect(discovery.paths[`${base}/exports`]?.post).toBeDefined()
  expect(discovery.paths[`${base}/exports/{jobId}/download`]?.get).toBeDefined()
  const file = await post('/api/files/register', { relPath: filename }, 201)
  const version = await post(`${base}/versions`, {
    series: '调研批次', channel: 'research', listType: 'lead', acquiredOn: '2026-11-18', fileId: file.id,
    rows: [{ rowNumber: 3, name: '原表名称', note: '需保留' }, { rowNumber: 8, name: '未关联企业', note: '=1+1' }],
  }, 201)
  const detail = await (await fetch(fixture.url(`${base}/versions/${version.id}`))).json()
  const directory = await (await fetch(fixture.url('/api/core/enterprises?name=核对取得资格企业'))).json()
  const current = await (await fetch(fixture.url('/api/roster/current-enterprises?titleCode=specialized_sme&q=核对取得资格企业'))).json()
  expect(current.rows[0].enterpriseId).toBe(qualifiedId)
  await post(`${base}/versions/${version.id}/supplement`, {
    actor: { type: 'agent', id: '证据核对' }, basis: '人工核实为同一企业',
    decisions: [{ action: 'attach', rowId: detail.rows[0].id, enterpriseId: qualifiedId, expectedRevision: directory.rows[0].revision }],
  }, 200)
  const body = { versionId: version.id, clientRequestId: randomUUID() }
  const accepted = await post(`${base}/exports`, body, 202)
  expect(await post(`${base}/exports`, body, 202)).toEqual(accepted)
  const job = await fixture.terminal(accepted.jobId)
  expect(job).toMatchObject({ kind: 'lead-lists-version-export', state: 'done', result: { versionId: version.id, rowCount: 2 } })
  const tasks = await (await fetch(fixture.url('/api/task-center?tab=lead-lists'), { headers: fixture.headers })).json()
  expect(tasks.rows).toContainEqual(expect.objectContaining({
    id: accepted.jobId, module: 'lead-lists', label: '导出名单版本', group: 'export',
  }))
  const unauthenticated = await fetch(fixture.url(job.result.downloadUrl))
  expect(unauthenticated.status).toBe(401)
  const downloaded = await fetch(fixture.url(job.result.downloadUrl), { headers: fixture.headers })
  expect(downloaded.status).toBe(200)
  expect(downloaded.headers.get('content-type')).toBe('text/csv; charset=utf-8')
  const csv = await downloaded.text()
  expect(csv.trimEnd().split('\r\n')).toEqual([
    '"系列","获取日期","来源原件","原表序号","企业名称","统一社会信用代码","区县","备注","基础库企业编号","有效称号"',
    `"调研批次","2026-11-18","${filename}","3","原表名称","","","需保留","${qualifiedId}","专精特新中小企业、创新型中小企业"`,
    `"调研批次","2026-11-18","${filename}","8","未关联企业","","","'=1+1","",""`,
  ])
}, 120_000)
