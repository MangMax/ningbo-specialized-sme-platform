import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { nativeAppAdapter } from '../../support/native-app'
import { createRosterImportClient, type RosterImportRequest, type SupplementAnnouncementRequest } from '../../../layers/sme-roster/lib/roster-import-client'

const dir = mkdtempSync(join(tmpdir(), 'announcement-source-version-'))
const token = 'synthetic-version-test'
const app = nativeAppAdapter({ dir, token })
beforeAll(() => app.start(), 90_000)
afterAll(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

async function storedVersion(filename: string, contents: string) {
  const relativeDirectory = 'jxj/announcement/2025/1'
  const directory = join(dir, 'files', relativeDirectory)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, filename), contents)
  const relPath = relativeDirectory + '/' + filename
  const sha256 = createHash('sha256').update(contents).digest('hex')
  const response = await app.request('/api/files/register', {
    method: 'POST',
    body: JSON.stringify({ relPath, source: 'jxj', kind: 'announcement', year: 2025, batch: 1 }),
  })
  const file = await response.json()
  expect(response.status, JSON.stringify(file)).toBe(201)
  expect(file).toMatchObject({ relPath, sha256, source: 'jxj', kind: 'announcement' })
  return { relPath, fileId: file.id as number, sha256 }
}

test('keeps both registered file versions when the declaration identity is reused', async () => {
  const client = createRosterImportClient({ baseUrl: app.url(''), token })
  async function supplement(filename: string, sha256: string, subject: SupplementAnnouncementRequest['rows'][number]) {
    const request: RosterImportRequest = {
      idempotencyKey: filename,
      sourceKind: 'announcement',
      sourceIdentity: filename,
      sourceSha256: sha256,
      payload: { announcement: {
        sourceDocument: { source: 'jxj', title: '同一公告', docNumber: '合成〔2025〕1号' },
        records: [{ enterprise: { name: '来源版本测试企业' }, titleCode: 'specialized_sme',
          events: [{ eventType: 'award', year: 2025, batchSeq: 1 }] }],
      } },
    }
    const staged = await client.commit(request)
    if (staged.status !== 'staged') throw new Error(JSON.stringify(staged))
    const result = await client.supplement(staged.intakeId, {
      sourceDigest: staged.sourceDigest, basis: '核对名单文件版本', rows: [subject],
    })
    if (result.status !== 'supplemented') throw new Error(JSON.stringify(result))
    return result
  }

  const first = await storedVersion('first.xlsx', 'First synthetic announcement')
  const initial = await supplement(first.relPath, first.sha256, {
    action: 'create', fields: { name: '来源版本测试企业' },
  })
  const enterpriseId = initial.owners[0]!
  const second = await storedVersion('second.xlsx', 'Second synthetic announcement')
  const newer = await supplement(second.relPath, second.sha256, {
    action: 'attach', enterpriseId, expectedRevision: 1,
  })
  const response = await app.request('/api/core/enterprises/' + enterpriseId + '/sources')
  expect(response.status).toBe(200)
  const sources = await response.json()
  expect(sources).toMatchObject([
    { fileId: first.fileId, sha256: first.sha256 },
    { fileId: second.fileId, sha256: second.sha256 },
  ])
  expect(newer.sourceIds).toEqual([sources[1].id])
})
