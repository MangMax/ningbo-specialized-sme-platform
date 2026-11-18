import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { nativeAppAdapter } from '../../support/native-app'
import { createRosterImportClient, type RosterImportRequest, type SupplementAnnouncementRequest } from '../../../layers/sme-roster/lib/roster-import-client'

const dir = mkdtempSync(join(tmpdir(), 'announcement-intake-'))
const token = 'isolated-intake-test'
const app = nativeAppAdapter({ dir, token })
beforeAll(() => app.start())
afterAll(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

const core = '/api/core/enterprises'
const imports = '/api/roster/import'
const original: RosterImportRequest = {
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
  const client = createRosterImportClient({ baseUrl: app.url(''), token })
  expect((await get(core)).rows).toEqual([])
  const staged = await client.commit(original)
  if (staged.status !== 'staged') throw new Error(JSON.stringify(staged))
  expect(staged.rowCount).toBe(2)
  const intake = imports + '/intake/' + staged.intakeId
  expect(await client.readIntake(staged.intakeId)).toMatchObject({ status: 'staged', announcement: original.payload.announcement, review: null })
  expect((await get(core)).rows).toEqual([])
  expect(await submit(imports + '/commit', original)).toEqual(staged)
  await submit(imports + '/commit', { ...original, sourceIdentity: 'changed.xlsx' }, 409)
  await submit(imports + '/commit', { ...original, payload: {} }, 409)

  const target = await submit(core, { name: '核对对象', uscc: '91330226MA2CL6FP2U' })
  expect(await get(core + '/' + target.id + '/sources')).toMatchObject([{ channel: '直接添加' }])
  const review: SupplementAnnouncementRequest = {
    sourceDigest: staged.sourceDigest, basis: '核对合成公告与企业资料',
    rows: [{ action: 'attach', enterpriseId: target.id, expectedRevision: 1 }, { action: 'create', fields: { name: '另一企业' } }],
  }
  await submit(intake + '/supplement', { ...review, sourceDigest: '0'.repeat(64) }, 409)
  await submit(intake + '/supplement', { ...review, rows: [{ action: 'attach', enterpriseId: target.id, expectedRevision: 2 }, review.rows[1]] }, 409)
  await submit(intake + '/supplement', { ...review, rows: [
    { action: 'attach', enterpriseId: target.id, expectedRevision: 1, fields: { name: '临时更名' } },
    { action: 'create', fields: { name: '错误的企业' } },
  ] }, 409)
  expect((await get(core)).rows).toEqual([target])
  expect(await get(`/api/roster/enterprises/${target.id}/profile-history`)).toMatchObject({ total: 0, rows: [] })

  const [receipt, retry] = await Promise.all([
    client.supplement(staged.intakeId, review),
    submit(intake + '/supplement', review),
  ])
  expect(receipt).toEqual(retry)
  expect(receipt).toMatchObject({ status: 'supplemented', owners: [target.id, target.id + 1] })
  if (receipt.status !== 'supplemented') throw new Error(JSON.stringify(receipt))
  await submit(intake + '/supplement', { ...review, basis: '不同决定' }, 409)
  const { rows } = await get(core)
  expect(rows).toMatchObject([{ id: target.id, name: '核对对象', uscc: '91330226MA2CL6FP2U' }, { name: '另一企业', uscc: null }])
  const sources = await get(core + '/' + target.id + '/sources')
  expect(sources).toMatchObject([{ channel: '直接添加' }, { channel: '经信局', listType: '公布名单' }])
  expect((await get(core + '?sourceId=' + sources[1].id)).rows.map((row: { id: number }) => row.id)).toEqual(receipt.owners)

  await client.removeIntake(staged.intakeId, { sourceDigest: staged.sourceDigest, reason: '撤下本次录入' })
  expect(await client.readIntake(staged.intakeId)).toMatchObject({ status: 'removed', announcement: original.payload.announcement, review })
  expect(await get(core + '/' + target.id + '/sources')).toEqual(sources)
  await submit(core + '/' + target.id + '/membership', { expectedRevision: 1, removedReason: '退出基础库' }, 200, 'PATCH')
  expect((await get(core)).rows).toHaveLength(1)
  expect((await get(core + '?includeRemoved=true')).rows).toHaveLength(2)
  await submit(core + '/' + target.id + '/membership', { expectedRevision: 2, removedReason: null }, 200, 'PATCH')
  expect((await get(core)).rows).toHaveLength(2)
})

async function stageSubject(name: string, batchSeq: number) {
  const request: RosterImportRequest = {
    idempotencyKey: `reviewed-profile-${batchSeq}`, sourceKind: 'announcement', sourceIdentity: `reviewed-profile-${batchSeq}.xlsx`,
    payload: { announcement: {
      sourceDocument: { source: 'jxj', title: `合成身份核对 ${batchSeq}` },
      records: [{ enterprise: { name }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2025, batchSeq }] }],
    } },
  }
  const staged = await submit(imports + '/commit', request)
  expect(staged).toMatchObject({ status: 'staged', rowCount: 1 })
  return { supplement: `${imports}/intake/${staged.intakeId}/supplement`, sourceDigest: staged.sourceDigest }
}

test('audits reviewed name and USCC changes and keeps the prior name tied to the enterprise', async () => {
  const name = '资料补充旧名', newName = '资料补充现名', uscc = '913302017133602847'
  const owner = await submit(core, { name })
  const path = `/api/roster/enterprises/${owner.id}`
  const before = await get(path + '/profile')
  const revisionRows = () => app.db.$client.prepare(`SELECT source_version AS sourceVersion, fact_changed AS factChanged
    FROM evidence_revision_113 WHERE enterprise_id=? AND source_kind='identity' ORDER BY id`).all(owner.id)
  const formerNames = () => app.db.$client.prepare(`SELECT a.name, f.uscc, f.renamed_year AS renamedYear
    FROM enterprise_alias a JOIN enterprise_former_name f ON f.alias_id=a.id WHERE a.enterprise_id=?`).all(owner.id)

  const addCode = await stageSubject(name, 11)
  const basis = '已核对旧名、规范名与统一社会信用代码属于同一主体'
  const review: SupplementAnnouncementRequest = {
    sourceDigest: addCode.sourceDigest, basis,
    rows: [{ action: 'attach', enterpriseId: owner.id, expectedRevision: 1, fields: { name: newName, uscc } }],
  }
  const receipt = await submit(addCode.supplement, review)
  expect(receipt).toMatchObject({ status: 'supplemented', owners: [owner.id] })
  expect(await submit(addCode.supplement, review)).toEqual(receipt)
  expect((await get(core)).rows.find((row: { id: number }) => row.id === owner.id)).toMatchObject({ name: newName, uscc, revision: 2 })
  const renamed = await get(path + '/profile')
  expect(renamed.profile).toMatchObject({ name: newName })
  expect(renamed.version).not.toBe(before.version)
  const alias = (await get(path)).aliases[0]
  expect(alias).toMatchObject({ name, verificationStatus: 'confirmed', validFrom: null, validTo: null })
  const firstAudit = await get(path + '/profile-history')
  expect(firstAudit).toMatchObject({ total: 1, rows: [{ before: { name, uscc: null }, after: { name: newName, uscc },
    basis, retainedAliasId: alias.id, aliasCreated: true, beforeVersion: before.version, afterVersion: renamed.version }] })
  expect(formerNames()).toEqual([{ name, uscc, renamedYear: null }])
  expect(revisionRows()).toEqual([{ sourceVersion: `profile:${firstAudit.rows[0].id}`, factChanged: 1 }])

  const clearCode = await stageSubject(name, 12)
  await submit(clearCode.supplement, { sourceDigest: clearCode.sourceDigest, basis: '复核确认应暂留空统代', rows: [
    { action: 'attach', enterpriseId: owner.id, expectedRevision: 2, fields: { uscc: null } },
  ] })
  expect((await get(core)).rows.find((row: { id: number }) => row.id === owner.id)).toMatchObject({ name: newName, uscc: null, revision: 3 })
  const cleared = await get(path + '/profile-history')
  expect(cleared).toMatchObject({ total: 2, rows: [{ before: { name: newName, uscc }, after: { name: newName, uscc: null },
    retainedAliasId: null, aliasCreated: false }, firstAudit.rows[0]] })
  expect(formerNames()).toEqual([{ name, uscc: null, renamedYear: null }])
  expect(revisionRows()).toEqual([
    { sourceVersion: `profile:${firstAudit.rows[0].id}`, factChanged: 1 },
    { sourceVersion: `profile:${cleared.rows[0].id}`, factChanged: 1 },
  ])
})

test('rejects reviewed identity collisions with a current name, confirmed former name or USCC', async () => {
  const name = '冲突核对原名', otherName = '已占用的现名', formerName = '已占用的旧名', uscc = '91330211255994457P'
  const owner = await submit(core, { name })
  const other = await submit(core, { name: formerName, uscc })
  const otherPath = `/api/roster/enterprises/${other.id}`
  await submit(otherPath, {
    idempotencyKey: 'seed-occupied-former-name', expectedVersion: (await get(otherPath + '/profile')).version,
    changes: { name: otherName }, previousName: { name: formerName, sameSubject: true },
    actor: { type: 'agent', id: 'isolated-intake-test' }, basis: '核对合成企业名称',
  }, 200, 'PATCH')
  const staged = await stageSubject(name, 13)
  for (const [fields, code] of [[{ name: '已占用的　现名' }, 'identity_conflict'], [{ name: formerName }, 'identity_conflict'], [{ uscc }, 'uscc_taken']] as const) {
    const result = await submit(staged.supplement, { sourceDigest: staged.sourceDigest, basis: '核对合成身份', rows: [
      { action: 'attach', enterpriseId: owner.id, expectedRevision: 1, fields },
    ] }, 409)
    expect(result.data).toEqual({ code })
  }
  const path = `/api/roster/enterprises/${owner.id}`
  expect((await get(core)).rows.find((row: { id: number }) => row.id === owner.id)).toEqual(owner)
  expect(await get(path + '/profile-history')).toMatchObject({ total: 0, rows: [] })
  expect((await get(path)).aliases).toEqual([])
  expect(await get(staged.supplement.replace(/\/supplement$/, ''))).toMatchObject({ status: 'staged', receipt: null, review: null })
})
