import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import pg from 'pg'
import { nativeAppAdapter } from '../../support/native-app'
import { createRosterImportClient, type RosterImportRequest, type SupplementAnnouncementRequest } from '../../../layers/sme-roster/lib/roster-import-client'

const dir = mkdtempSync(join(tmpdir(), 'announcement-intake-'))
const token = 'isolated-intake-test'
const app = nativeAppAdapter({ dir, token })
let database: pg.Pool | undefined
beforeAll(async () => {
  await app.start()
  database = new pg.Pool({ connectionString: app.postgresUrl })
}, 90_000)
afterAll(async () => {
  await database?.end()
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
  if (receipt.status !== 'supplemented') throw new Error(JSON.stringify(receipt))
  await submit(intake + '/supplement', { ...review, basis: '不同决定' }, 409)
  const { rows } = await get(core)
  expect(rows).toMatchObject([{ id: target.id, name: '核对对象', uscc: '91330226MA2CL6FP2U' }, { name: '另一企业', uscc: null }])
  expect(receipt.owners).toEqual(rows.map((row: { id: number }) => row.id))
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
}, 15_000)

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
  const revisionRows = async () => (await database!.query(`SELECT source_version AS "sourceVersion", fact_changed::int AS "factChanged"
    FROM business.evidence_revision_113 WHERE enterprise_id=$1 AND source_kind='identity' ORDER BY id`, [owner.id])).rows
  const formerNames = async () => (await database!.query(`SELECT a.name, f.uscc, f.renamed_year AS "renamedYear"
    FROM business.enterprise_alias a JOIN business.enterprise_former_name f ON f.alias_id=a.id WHERE a.enterprise_id=$1`, [owner.id])).rows

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
  expect(await formerNames()).toEqual([{ name, uscc, renamedYear: null }])
  expect(await revisionRows()).toEqual([{ sourceVersion: `profile:${firstAudit.rows[0].id}`, factChanged: 1 }])

  const clearCode = await stageSubject(name, 12)
  await submit(clearCode.supplement, { sourceDigest: clearCode.sourceDigest, basis: '复核确认应暂留空统代', rows: [
    { action: 'attach', enterpriseId: owner.id, expectedRevision: 2, fields: { uscc: null } },
  ] })
  expect((await get(core)).rows.find((row: { id: number }) => row.id === owner.id)).toMatchObject({ name: newName, uscc: null, revision: 3 })
  const cleared = await get(path + '/profile-history')
  expect(cleared).toMatchObject({ total: 2, rows: [{ before: { name: newName, uscc }, after: { name: newName, uscc: null },
    retainedAliasId: null, aliasCreated: false }, firstAudit.rows[0]] })
  expect(await formerNames()).toEqual([{ name, uscc: null, renamedYear: null }])
  expect(await revisionRows()).toEqual([
    { sourceVersion: `profile:${firstAudit.rows[0].id}`, factChanged: 1 },
    { sourceVersion: `profile:${cleared.rows[0].id}`, factChanged: 1 },
  ])
}, 15_000)

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

test('updates one registered address and one operating address with the enterprise region and industry', async () => {
  await database!.query(`
    INSERT INTO business.enterprise_region(code,name,parent_code,level) VALUES
      ('330200','宁波市',NULL,1),('330203','海曙区','330200',2),('330203001','月湖街道','330203',3),
      ('330206','北仑区','330200',2),('330206001','新碶街道','330206',3);
    INSERT INTO business.enterprise_industry(code,input_id,name,parent_code,level) VALUES
      ('C','address-test-C','制造业',NULL,0),('34','address-test-34','通用设备制造业','C',1),
      ('344','address-test-344','泵阀制造','34',2),('3444','address-test-3444','液压设备制造','344',3);
  `)
  const enterprise = await submit(core, { name: '企业资料测试' })
  const endpoint = core + '/' + enterprise.id + '/details'
  expect(await get(endpoint)).toMatchObject({ registeredAddress: null, operatingAddress: null, revision: 1 })
  const values = {
    expectedRevision: 1, districtCode: '330203', townshipCode: '330203001', industryCode: '3444',
    registeredAddress: '海曙区登记地址', operatingAddress: '北仑区实际经营地址',
  }
  await submit(endpoint, { ...values, townshipCode: '330206001' }, 409)
  expect(await get(endpoint)).toMatchObject({ registeredAddress: null, operatingAddress: null, revision: 1 })

  const saved = await submit(endpoint, values)
  expect(saved).toMatchObject({
    districtCode: '330203', townshipCode: '330203001', industryCode: '3444',
    registeredAddress: '海曙区登记地址', operatingAddress: '北仑区实际经营地址', revision: 2,
  })
  await submit(endpoint, { ...values, operatingAddress: null }, 409)
  expect(await get(endpoint)).toEqual(saved)

  const cleared = await submit(endpoint, { expectedRevision: 2, registeredAddress: '海曙区登记地址', operatingAddress: null })
  expect(cleared).toMatchObject({
    townshipCode: '330203001', industryCode: '3444', registeredAddress: '海曙区登记地址', operatingAddress: null, revision: 3,
  })
  expect(await get(core + '/' + enterprise.id + '/sources')).toMatchObject([{ channel: '直接添加' }])
})

test('filters and sorts every enterprise column across the full directory before pagination', async () => {
  await database!.query(`
    INSERT INTO business.enterprise_region(code,name,parent_code,level) VALUES
      ('990000','排序市',NULL,1),('990001','Z区','990000',2),('990001001','Y镇','990001',3),
      ('990002','A区','990000',2),('990002001','B镇','990002',3);
    INSERT INTO business.enterprise_industry(code,input_id,name,parent_code,level) VALUES
      ('X','sort-X','测试门类',NULL,0),('98','sort-98','测试大类', 'X',1),
      ('981','sort-981','测试中类','98',2),('9811','sort-9811','Z制造','981',3),('9812','sort-9812','A制造','981',3);
  `)
  const name = '排序核验'
  const beta = await submit(core, { name: name + 'Beta', uscc: '91330200000000001H' })
  const alpha = await submit(core, { name: name + 'Alpha', uscc: '91330200000000002L' })
  const gamma = await submit(core, { name: name + 'Gamma' })
  const profile = (id: number) => core + '/' + id + '/details'
  await submit(profile(alpha.id), { expectedRevision: 1, districtCode: '990001', townshipCode: '990001001',
    industryCode: '9811', registeredAddress: 'A登记地', operatingAddress: 'Y经营地' })
  await submit(profile(beta.id), { expectedRevision: 1, districtCode: '990002', townshipCode: '990002001',
    industryCode: '9812', registeredAddress: 'B登记地', operatingAddress: 'B经营地' })

  const least = { name: alpha.id, uscc: beta.id, district: beta.id, township: beta.id, industry: beta.id,
    registeredAddress: alpha.id, operatingAddress: beta.id }
  for (const [sort, first] of Object.entries(least)) {
    const second = first === alpha.id ? beta.id : alpha.id
    const ordered = new URLSearchParams({ name, sort, limit: '1' })
    expect(await get(core + '?' + ordered)).toMatchObject({ page: 1, total: 3, rows: [{ id: first }] })
    ordered.set('page', '2')
    expect(await get(core + '?' + ordered)).toMatchObject({ page: 2, total: 3, rows: [{ id: second }] })
    ordered.set('page', '1')
    ordered.set('direction', 'desc')
    const descendingFirst = sort === 'name' ? gamma.id : second
    expect(await get(core + '?' + ordered)).toMatchObject({ page: 1, total: 3, rows: [{ id: descendingFirst }] })
    if (sort !== 'name') {
      ordered.set('page', '3')
      expect(await get(core + '?' + ordered)).toMatchObject({ page: 3, total: 3, rows: [{ id: gamma.id }] })
    }
  }

  const criteria = { name, districtCode: '990001', townshipCode: '990001001', industryDivisionCode: '98',
    industryCode: '9811', uscc: '91330200000000002L', registeredAddress: 'A登记', operatingAddress: 'Y经营', page: '1' }
  expect(await get(core + '?' + new URLSearchParams(criteria))).toMatchObject({ total: 1, rows: [{
    id: alpha.id, districtName: 'Z区', townshipName: 'Y镇', industryName: 'Z制造', registeredAddress: 'A登记地', operatingAddress: 'Y经营地',
  }] })
  for (const [field, value] of Object.entries({ districtCode: '990002', townshipCode: '990002001', industryDivisionCode: '97',
    industryCode: '9812', uscc: '91330200000000001H', registeredAddress: 'B登记', operatingAddress: 'B经营' })) {
    expect(await get(core + '?' + new URLSearchParams({ ...criteria, [field]: value }))).toMatchObject({ total: 0, rows: [] })
  }
  expect((await app.request(core + '?sort=addresses')).status).toBe(400)
  expect((await app.request(core + '?sort=name&after=0')).status).toBe(400)
})

test('applies ordered mixed-direction sorts to the full enterprise result before paging', async () => {
  await database!.query(`
    INSERT INTO business.enterprise_region(code,name,parent_code,level) VALUES
      ('980000','多级排序市',NULL,1),('980001','多级排序区','980000',2),
      ('980001001','A街道','980001',3),('980001002','B街道','980001',3);
    INSERT INTO business.enterprise_industry(code,input_id,name,parent_code,level) VALUES
      ('Y','multi-Y','测试门类',NULL,0),('97','multi-97','测试大类','Y',1),
      ('971','multi-971','测试中类','97',2),('9711','multi-9711','Z制造','971',3),('9712','multi-9712','A制造','971',3);
  `)
  const ids = new Map<string, number>()
  for (const [letter, townshipCode, industryCode] of [
    ['F', '980001001', '9711'], ['A', '980001001', '9712'], ['B', '980001002', '9711'],
    ['D', null, '9711'], ['C', '980001001', '9711'],
  ] as const) {
    const enterprise = await submit(core, { name: '多级排序核验' + letter })
    ids.set(letter, enterprise.id)
    await submit(core + '/' + enterprise.id + '/details', { expectedRevision: 1, districtCode: '980001', townshipCode, industryCode,
      registeredAddress: null, operatingAddress: null })
  }
  const query = new URLSearchParams({ name: '多级排序核验', limit: '2' })
  for (const field of ['township', 'industry', 'name']) query.append('sort', field)
  for (const direction of ['asc', 'desc', 'asc']) query.append('direction', direction)
  const expected = [['C', 'F'], ['A', 'B'], ['D']]
  for (const [index, letters] of expected.entries()) {
    query.set('page', String(index + 1))
    const result = await get(core + '?' + query)
    expect(result.total).toBe(5)
    expect(result.rows.map((row: { id: number }) => row.id)).toEqual(letters.map(letter => ids.get(letter)))
  }

  query.delete('sort')
  query.delete('direction')
  query.set('limit', '25')
  query.set('page', '1')
  for (const field of ['industry', 'township', 'name']) query.append('sort', field)
  for (const direction of ['desc', 'asc', 'asc']) query.append('direction', direction)
  const reordered = await get(core + '?' + query)
  expect(reordered.rows.map((row: { id: number }) => row.id)).toEqual(['C', 'F', 'B', 'D', 'A'].map(letter => ids.get(letter)))

  expect((await app.request(core + '?sort=industry&sort=industry')).status).toBe(400)
  expect((await app.request(core + '?sort=industry&sort=name&direction=asc')).status).toBe(400)
  expect((await app.request(core + '?sort=township&sort=name&after=0')).status).toBe(400)
})
