import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { nativeAppAdapter } from '../../support/native-app'
import { createClassifiedFile } from '../../../layers/sme-roster/server/utils/roster-file-classification'
import { createRosterImportClient, type RosterImportRequest, type SupplementAnnouncementRequest } from '../../../layers/sme-roster/lib/roster-import-client'

const dir = mkdtempSync(join(tmpdir(), 'announcement-source-version-'))
const token = 'synthetic-version-test'
const app = nativeAppAdapter({ dir, token })
beforeAll(() => app.start())
afterAll(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

function storedVersion(filename: string, contents: string) {
  const filesDir = join(dir, 'files')
  mkdirSync(filesDir, { recursive: true })
  writeFileSync(join(filesDir, filename), contents)
  const sha256 = createHash('sha256').update(contents).digest('hex')
  const file = createClassifiedFile(app.db, {
    relPath: filename, filename, ext: 'xlsx', bytes: Buffer.byteLength(contents), sha256,
  }, { kind: 'announcement', source: 'jxj' })
  return { fileId: file.id, sha256 }
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

  const first = storedVersion('first.xlsx', 'First synthetic announcement')
  const initial = await supplement('first.xlsx', first.sha256, {
    action: 'create', fields: { name: '来源版本测试企业' },
  })
  const enterpriseId = initial.owners[0]!
  const second = storedVersion('second.xlsx', 'Second synthetic announcement')
  const newer = await supplement('second.xlsx', second.sha256, {
    action: 'attach', enterpriseId, expectedRevision: 1,
  })
  const response = await app.request('/api/core/enterprises/' + enterpriseId + '/sources')
  expect(response.status).toBe(200)
  const sources = await response.json()
  expect(sources).toMatchObject([first, second])
  expect(newer.sourceIds).toEqual([sources[1].id])
})
