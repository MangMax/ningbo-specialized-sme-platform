import { createHash, randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { enterpriseSource } from '../../../db/postgresql/enterprise-source-tables'
import { storedFile } from '../../../db/postgresql/file-tables'
import { postgresLeadListRow, postgresLeadListVersion } from '../../../db/postgresql/lead-tables'
import { postgresLeadFixture } from './fixtures/postgres-leads'

const versions = '/api/lead-lists/versions'
const agent = { actor: { type: 'agent', id: 'lead-review' }, basis: '逐行核对原件' }
const sourceBytes = Buffer.from('name\n原始企业\n')
const sourceSha = createHash('sha256').update(sourceBytes).digest('hex')

describe('PostgreSQL lead versions', () => {
  const fixture = postgresLeadFixture()
  const { app, dir } = fixture
  let db: pg.Pool

  beforeAll(async () => {
    await fixture.start(async ({ db: seed, filesDir }) => {
      const filename = 'fixture.csv'
      const acquiredOn = '2026-11-18'
      writeFileSync(join(filesDir, filename), sourceBytes)
      await seed.insert(storedFile).values({
        id: 91, relPath: filename, filename, ext: 'csv', sha256: sourceSha, bytes: BigInt(sourceBytes.length), createdAt: acquiredOn,
      })
      const version = { channel: 'research', listType: 'lead', acquiredOn, fileId: 91, fileSha256: sourceSha, createdAt: acquiredOn }
      await seed.insert(postgresLeadListVersion).values([
        { ...version, id: 11, series: '走访名单', requestHash: 'request-one' },
        { ...version, id: 12, series: '另一个名单', requestHash: 'request-two' },
      ])
      await seed.insert(postgresLeadListRow).values([
        { id: 101, versionId: 11, rowNumber: 2, name: '原始企业', uscc: '待核对' },
        { id: 102, versionId: 11, rowNumber: 3, name: '另一行' },
        { id: 201, versionId: 12, rowNumber: 2, name: '其他名单行' },
        { id: 202, versionId: 12, rowNumber: 3, name: '同一名单另一行' },
      ])
      await seed.insert(enterpriseSource).values({
        id: 71, module: 'lead-lists', businessTable: 'lead_list_version', versionKey: '11',
        channelCode: 'research', listTypeCode: 'lead', acquiredOn, series: '走访名单', fileId: 91, sha256: sourceSha,
      })
    })
    const connectionString = app.postgresUrl
    if (!connectionString) throw new Error('Lead list fixture did not create a PostgreSQL connection')
    db = new pg.Pool({ connectionString, options: '-c search_path=business,public' })
  }, 60_000)

  afterAll(async () => {
    try { await db?.end() }
    finally { await fixture.close() }
  })

  const submit = (id: number, body: object, headers: HeadersInit = app.headers) =>
    app.request(`${versions}/${id}/supplement`, { method: 'POST', headers, body: JSON.stringify(body) })

  it('rolls back foreign rows and returns one provenance receipt across concurrent repeats', async () => {
    const create = { action: 'create', rowId: 101, fields: { name: '已核对企业' } }
    const wrongVersion = await submit(11, { ...agent, decisions: [create, { ...create, rowId: 201 }] })
    expect(wrongVersion.status, await wrongVersion.text()).toBe(404)
    expect(await (await app.request('/api/core/enterprises')).json()).toMatchObject({ rows: [] })
    const rollback = await submit(11, {
      ...agent, decisions: [create, { action: 'attach', rowId: 102, enterpriseId: 999, expectedRevision: 1 }],
    })
    expect(rollback.status, await rollback.text()).toBe(404)
    expect(await (await app.request('/api/core/enterprises')).json()).toMatchObject({ rows: [] })

    const body = { ...agent, decisions: [create] }
    const responses = await Promise.all([submit(11, body), submit(11, body)])
    const receipts = await Promise.all(responses.map(response => response.json()))
    expect(responses.map(response => response.status), JSON.stringify(receipts)).toEqual([200, 200])
    const id = receipts[0].rows[0].enterpriseId
    expect(receipts).toEqual(Array(2).fill({ sourceId: 71, rows: [{ rowId: 101, enterpriseId: id }] }))
    expect(typeof id).toBe('number')
    const changed = await submit(11, { ...body, basis: '另一次核对' })
    expect(changed.status).toBe(409)

    const details = await (await app.request(`${versions}/11`)).json()
    expect(details.rows).toMatchObject([
      { id: 101, name: '原始企业', uscc: '待核对', enterpriseId: id }, { id: 102, enterpriseId: null },
    ])
    const sources = await (await app.request(`/api/core/enterprises/${id}/sources`)).json()
    expect(sources).toMatchObject([{ id: 71, fileId: 91, sha256: sourceSha, versionKey: '11' }])
    expect((await db.query('SELECT review_actor,review_basis FROM lead_list_row WHERE id=101')).rows).toEqual([
      { review_actor: JSON.stringify(agent.actor), review_basis: agent.basis },
    ])
    expect((await (await app.request('/api/roster/enterprises')).json()).rows).toEqual([])
  })

  it('checks browser access and revision, then retains the alias, profile audit and roster identity work', async () => {
    const created = await app.request('/api/core/enterprises', {
      method: 'POST', body: JSON.stringify({ name: '原资料现名' }),
    })
    expect(created.status).toBe(200)
    const target = await created.json()
    const detailsPath = `/api/core/enterprises/${target.id}/details`
    const uscc = '913302017133602847'
    const decision = {
      action: 'attach', rowId: 201, enterpriseId: target.id, expectedRevision: 1,
      fields: { name: '核对后现名', uscc },
    }
    const browserHeaders = {
      'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
      'x-lead-list-browser': '1', origin: new URL(app.url('/')).origin,
    }
    const body = { decisions: [decision] }
    expect((await submit(12, body, { ...browserHeaders, 'sec-fetch-site': 'cross-site' })).status).toBe(401)
    const stale = await submit(12, { decisions: [{ ...decision, expectedRevision: 2 }] }, browserHeaders)
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ data: { code: 'enterprise_changed' } })

    expect(await (await app.request(detailsPath)).json()).toMatchObject({ name: '原资料现名', uscc: null, revision: 1 })
    expect((await (await app.request(`${versions}/12`)).json()).rows[0].enterpriseId).toBeNull()
    expect((await db.query('SELECT id FROM enterprise_profile_audit WHERE enterprise_id=$1', [target.id])).rows).toEqual([])
    const sourcesPath = `/api/core/enterprises/${target.id}/sources`
    expect(await (await app.request(sourcesPath)).json()).toMatchObject([{ module: 'core' }])

    await db.query("INSERT INTO record(id,enterprise_id,title_code,source) VALUES (301,$1,'specialized_sme','jxj')", [target.id])
    await db.query("INSERT INTO record_event(id,record_id,event_type,year,batch_seq) VALUES (302,301,'award',2024,1)")

    const response = await submit(12, body, browserHeaders)
    const receipt = await response.json()
    expect(response.status, JSON.stringify(receipt)).toBe(200)
    expect(receipt.rows).toEqual([{ rowId: 201, enterpriseId: target.id }])
    const replay = await submit(12, body, browserHeaders)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(receipt)
    expect(await (await app.request(detailsPath)).json()).toMatchObject({ name: '核对后现名', uscc, revision: 2 })
    const audit = (await db.query(`
      SELECT p.id, p.idempotency_key, p.before, p.after, p.actor, p.basis, a.name, a.verification_status, f.uscc
      FROM enterprise_profile_audit p JOIN enterprise_alias a ON a.id=p.retained_alias_id
      JOIN enterprise_former_name f ON f.alias_id=a.id WHERE p.enterprise_id=$1
    `, [target.id])).rows
    expect(audit).toEqual([expect.objectContaining({
      idempotency_key: 'lead-lists:201', name: '原资料现名', verification_status: 'confirmed', uscc,
      actor: '{"type":"user","id":"lead-lists-page"}', basis: '线索名单页面补充',
      before: JSON.stringify({ enterpriseId: target.id, name: '原资料现名', city: null, district: null, uscc: null }),
      after: JSON.stringify({ enterpriseId: target.id, name: '核对后现名', city: null, district: null, uscc }),
    })])
    expect((await db.query('SELECT id FROM record_event ORDER BY id')).rows).toEqual([{ id: '302' }])
    expect(await (await app.request(sourcesPath)).json()).toMatchObject([
      { module: 'core' }, { id: receipt.sourceId, module: 'lead-lists', versionKey: '12', fileId: 91 },
    ])

    const attach = { action: 'attach', rowId: 202, enterpriseId: target.id, expectedRevision: 2 }
    const unchanged = await submit(12, { ...agent, decisions: [{ ...attach, fields: { name: '核对后现名' } }] })
    expect(unchanged.status).toBe(200)
    expect(await unchanged.json()).toEqual({ sourceId: receipt.sourceId, rows: [{ rowId: 202, enterpriseId: target.id }] })
    expect(await (await app.request(detailsPath)).json()).toMatchObject({ name: '核对后现名', uscc, revision: 3 })
    expect((await db.query('SELECT id FROM enterprise_profile_audit WHERE enterprise_id=$1', [target.id])).rowCount).toBe(1)
  })

  it('commits concurrent versions that attach the same companies in opposite order', async () => {
    const create = async (name: string) => {
      const response = await app.request('/api/core/enterprises', {
        method: 'POST', body: JSON.stringify({ name }),
      })
      expect(response.status).toBe(200)
      return (await response.json()).id
    }
    const a = await create('并发核对企业甲')
    const b = await create('并发核对企业乙')
    await db.query(`
      INSERT INTO lead_list_version (id,series,channel_code,list_type_code,acquired_on,file_id,file_sha256,request_hash,created_at)
        VALUES (31,'并发名单甲','research','lead','2026-11-18',91,'${sourceSha}','concurrent-first','2026-11-18'),
               (32,'并发名单乙','research','lead','2026-11-18',91,'${sourceSha}','concurrent-second','2026-11-18');
      INSERT INTO lead_list_row (id,version_id,row_number,name)
        VALUES (311,31,2,'甲'),(312,31,3,'乙'),(321,32,2,'乙'),(322,32,3,'甲');
      CREATE FUNCTION hold_concurrent_review() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock_shared(730016);
        RETURN NEW;
      END $$;
      CREATE TRIGGER hold_concurrent_review AFTER UPDATE ON lead_list_row
        FOR EACH ROW WHEN (NEW.id IN (311,321)) EXECUTE FUNCTION hold_concurrent_review();
    `)
    const gate = await db.connect()
    await gate.query('SELECT pg_advisory_lock(730016)')
    const attach = (rowId: number, enterpriseId: number) => ({ action: 'attach', rowId, enterpriseId, expectedRevision: 1 })
    const requests = Promise.allSettled([
      submit(31, { ...agent, decisions: [attach(311, a), attach(312, b)] }),
      submit(32, { ...agent, decisions: [attach(321, b), attach(322, a)] }),
    ])
    try {
      await expect.poll(async () => {
        const result = await db.query("SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()")
        return result.rows[0].waiting
      }, { timeout: 5_000 }).toBe(2)
    } finally {
      await gate.query('SELECT pg_advisory_unlock(730016)')
      gate.release()
    }
    const settled = await requests
    for (const response of settled) if (response.status === 'rejected') throw response.reason
    const responses = settled.flatMap(response => response.status === 'fulfilled' ? [response.value] : [])
    const receipts = await Promise.all(responses.map(response => response.json()))
    expect(responses.map(response => response.status), JSON.stringify(receipts)).toEqual([200, 200])
    expect(receipts.map(receipt => receipt.rows)).toEqual([
      [{ rowId: 311, enterpriseId: a }, { rowId: 312, enterpriseId: b }],
      [{ rowId: 321, enterpriseId: b }, { rowId: 322, enterpriseId: a }],
    ])
  }, 10_000)

  it('exports native lead rows and inherited titles as CSV through the durable job routes', async () => {
    const detail = await (await app.request(`${versions}/11`)).json()
    const linked = detail.rows[0].enterpriseId
    const year = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()))
    const result = await db.query(`INSERT INTO record(enterprise_id,title_code,source)
      VALUES ($1,'little_giant','jxj') RETURNING id`, [linked])
    const event = await db.query(`INSERT INTO record_event(record_id,event_type,year,batch_seq)
      VALUES ($1,'award',$2,1) RETURNING id`, [result.rows[0].id, year])
    await db.query("INSERT INTO record_evidence(record_event_id,source_file,list_no) VALUES ($1,'notice.pdf',1)", [event.rows[0].id])
    await db.query("UPDATE lead_list_row SET note='=1+1' WHERE id=102")
    await db.query("INSERT INTO lead_list_row (version_id,row_number,name) VALUES (11,1,'补录首行')")
    const snapshot = await (await app.request(`${versions}/11`)).json()
    expect(snapshot).toMatchObject({
      fileName: 'fixture.csv', fileAvailable: true,
      rows: [
        { rowNumber: 1, name: '补录首行', uscc: null, district: null, note: null, enterpriseId: null },
        { rowNumber: 2, name: '原始企业', enterpriseId: linked },
        { rowNumber: 3, name: '另一行', note: '=1+1', enterpriseId: null },
      ],
    })
    const base = '/api/lead-lists/exports'
    const request = { versionId: 11, clientRequestId: randomUUID() }
    const exportList = () => app.request(base, { method: 'POST', body: JSON.stringify(request) })
    const accepted = await exportList()
    const receipt = await accepted.json()
    expect(accepted.status, JSON.stringify(receipt)).toBe(202)
    expect(await (await exportList()).json()).toEqual(receipt)
    const job = await app.terminal(receipt.jobId)
    expect(job).toMatchObject({ kind: 'lead-lists-version-export', state: 'done', result: { versionId: 11, rowCount: 3 } })
    expect((await fetch(app.url(job.result.downloadUrl))).status).toBe(401)
    const download = await app.download(job.result.downloadUrl)
    expect(download.response.status).toBe(200)
    expect(download.response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(download.bytes.toString()).toBe([
      '\uFEFF"系列","获取日期","来源原件","原表序号","企业名称","统一社会信用代码","区县","备注","基础库企业编号","有效称号"',
      '"走访名单","2026-11-18","fixture.csv","1","补录首行","","","","",""',
      `"走访名单","2026-11-18","fixture.csv","2","原始企业","待核对","","","${linked}","专精特新“小巨人”、专精特新中小企业、创新型中小企业"`,
      '"走访名单","2026-11-18","fixture.csv","3","另一行","","","\'=1+1","",""',
      '',
    ].join('\r\n'))
  })

  it('registers verified source bytes once and rejects a conflicting registration in PostgreSQL-only mode', async () => {
    const input = {
      series: '新登记名单', channel: 'research', listType: 'lead', acquiredOn: '2026-11-19',
      fileId: 91, rows: [{ rowNumber: 2, name: '新登记企业' }],
    }
    const register = (body: typeof input) => app.request(versions, { method: 'POST', body: JSON.stringify(body) })
    const registered = await register(input)
    const receipt = await registered.json()
    expect(registered.status, JSON.stringify(receipt)).toBe(201)
    const repeat = await register(input)
    expect(repeat.status).toBe(200)
    expect(await repeat.json()).toMatchObject({ id: receipt.id })
    expect((await register({ ...input, rows: [{ rowNumber: 2, name: '内容冲突' }] })).status).toBe(409)
    expect(await (await app.request(`${versions}/${receipt.id}`)).json()).toMatchObject({
      rows: [{ rowNumber: 2, name: '新登记企业' }],
    })
    const catalog = await app.request(versions)
    expect(catalog.status).toBe(200)
    expect(await catalog.json()).toMatchObject({
      versions: expect.arrayContaining([expect.objectContaining({ id: receipt.id, series: '新登记名单', fileId: 91 })]),
    })
    const path = `${versions}/${receipt.id}/source`
    const download = await app.download(path)
    expect(download.response.status).toBe(200)
    expect(download.bytes).toEqual(sourceBytes)
    expect((await app.request(`${versions}/999999/source`)).status).toBe(404)
    expect(existsSync(join(dir, 'legacy-runtime'))).toBe(false)
    expect(existsSync(join(dir, 'legacy-logs'))).toBe(false)
  })

  it('maintains linked directory details and paginates literal filters on PostgreSQL', async () => {
    await db.query(`
      INSERT INTO enterprise_region (code,name,parent_code,level)
        VALUES ('330200','验收市',NULL,1), ('330201','验收区','330200',2), ('330201001','验收镇','330201',3);
      INSERT INTO enterprise_industry (code,input_id,name,parent_code,level)
        VALUES ('A','test-section','验收门类',NULL,0), ('01','test-division','验收大类','A',1),
          ('011','test-group','验收中类','01',2), ('0111','test-detail','验收小类','011',3);
    `)
    const directory = '/api/core/enterprises'
    const create = async (name: string) => {
      const response = await app.request(directory, { method: 'POST', body: JSON.stringify({ name }) })
      const row = await response.json()
      expect(response.status, JSON.stringify(row)).toBe(200)
      return row.id as number
    }
    const z = await create('验收目录%_Z')
    const a = await create('验收目录%_a')
    await create('验收目录xxb')
    const details = `${directory}/${a}/details`
    const input = {
      expectedRevision: 1, districtCode: '330201', townshipCode: '330201001', industryCode: '0111',
      registeredAddress: '验收路 1_号', operatingAddress: null,
    }
    const save = (body: typeof input) => app.request(details, { method: 'POST', body: JSON.stringify(body) })
    expect((await save({ ...input, townshipCode: '330201002' })).status).toBe(409)
    const saved = await save(input)
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({
      id: a, revision: 2, districtName: '验收区', townshipName: '验收镇',
      industryName: '验收小类', industryDivisionCode: '01', registeredAddress: '验收路 1_号',
    })
    expect((await save(input)).status).toBe(409)
    const filtered = `${directory}?name=${encodeURIComponent('验收目录%_')}&sort=name&limit=1`
    const first = await app.request(filtered)
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ total: 2, page: 1, rows: [{ id: a }] })
    expect(await (await app.request(filtered + '&page=10')).json()).toMatchObject({ total: 2, page: 2, rows: [{ id: z }] })
    expect(await (await app.request(directory + '?industryDivisionCode=01&registeredAddress=1_')).json())
      .toMatchObject({ rows: [{ id: a }], nextAfter: null })
  })

  it('serializes concurrent edits to a PostgreSQL source dictionary', async () => {
    const path = '/api/core/dictionaries/list-sources'
    const headers = {
      'content-type': 'application/json', origin: app.url(''), 'sec-fetch-site': 'same-origin', 'x-dictionary-browser': '1',
    }
    const save = (body: object) => app.request(path, { method: 'POST', headers, body: JSON.stringify(body) })
    const responses = await Promise.all([save({ name: '验收新渠道' }), save({ name: '验收新渠道' })])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    const created = await responses.find(response => response.ok)!.json()
    const rename = await save({ code: created.code, previousName: '验收新渠道', name: '验收渠道更新' })
    expect(rename.status).toBe(200)
    expect((await save({ code: created.code, previousName: '验收新渠道', name: '验收渠道再次更新' })).status).toBe(409)
    expect(await (await app.request(path)).json()).toContainEqual({ code: created.code, name: '验收渠道更新' })
  })
})
