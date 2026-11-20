import '../../support/compiled-enterprise-reader'
import { enterpriseReads } from '../../../layers/sme-roster/server/utils/enterprise-read'
import { initializeDb } from '../../../db/client'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import pg from 'pg'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { createApp, createRouter, toNodeListener } from 'h3'
import { schema, useDb } from '../../../db'
const dir = mkdtempSync(join(tmpdir(), 'facts-306-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'test.db') })
let server: Server, base: string, seq = 0
let mcp: Record<string, any>
beforeAll(async () => {
  for (const [key, value] of Object.entries(h3)) vi.stubGlobal(key, value)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'facts-token' }))
  vi.doMock('@db', () => ({ useDb: () => db }))
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
  mcp = {}
  for (const name of ['get_enterprise_facts', 'preflight_enterprise_fact', 'commit_enterprise_fact']) mcp[name] = (await import(`../../../layers/sme-roster/server/mcp/tools/${name}.ts`)).default
  const get = (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id]/facts.get')).default
  const preflight = (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id]/facts/preflight.post')).default
  const commit = (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id]/facts/commit.post')).default
  const detail = (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id].get')).default
  server = createServer(toNodeListener(createApp().use(createRouter().get('/:id/detail', detail).get('/:id', get).post('/:id/preflight', preflight).post('/:id/commit', commit))))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await enterpriseReads.start()
})
afterAll(async () => {
  await enterpriseReads.close()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  db.$client.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.doUnmock('@db'); vi.doUnmock('@nuxtjs/mcp-toolkit/server')
})
async function http(id: number, action = '', body?: unknown, auth = true) {
  const response = await fetch(`${base}/${id}${action}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer facts-token' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json() }
}
function seed() {
 const id = db.insert(schema.enterprise).values({ name: `事实合成${++seq}`, nameNorm: `事实合成${seq}` }).returning().get().id
 db.insert(schema.differenceReason).values({ enterpriseId: id, titleCode: 'specialized_sme', direction: 'extra_in_miit', status: 'confirmed_reason', reasonCode: 'moved_in', movedInYear: 2020, verificationStatus: 'confirmed', recordedAt: '2026-01-01' }).run()
 return id
}
const fact = { kind: 'moved_out', source: { reference: 'official:notice:17', statement: '迁出，目的地未载明' }, observed: { value: '2026-11-04', precision: 'day' }, effective: { value: '2024', precision: 'year' }, city: null }
async function command(id: number, changes: object) {
  const read = await http(id)
  return { expectedVersion: read.body.version, idempotencyKey: `facts-${++seq}`, actor: { type: 'agent', id: 'test' }, basis: '正式通知核对', ...changes }
}
async function commit(id: number, request: any) {
  const preview = await http(id, '/preflight', request)
  expect(preview.status).toBe(200)
  return http(id, '/commit', { request, planHash: preview.body.planHash })
}
it('HTTP and MCP preserve sourced facts through confirmation replacement withdrawal and replay', async () => {
  const id = seed()
  expect((await http(id)).body.facts).toEqual([]) // legacy moved_in is not promoted
  const input = await command(id, { action: 'assert', fact })
  const first = await commit(id, input)
  expect(first.status).toBe(200)
  const factId = first.body.factId
  expect((await http(id)).body.facts).toMatchObject([{ factId, status: 'pending', fact }])
  const confirm = await command(id, { action: 'confirm', factId })
  const plan = await mcp.preflight_enterprise_fact.handler({ enterpriseId: id, request: confirm })
  await mcp.commit_enterprise_fact.handler({ enterpriseId: id, request: { request: confirm, planHash: plan.planHash } })
  const replace = await command(id, { action: 'replace', factId, fact: { ...fact, kind: 'cancelled' } })
  await commit(id, replace)
  let read = await mcp.get_enterprise_facts.handler({ enterpriseId: id })
  expect(read.facts).toMatchObject([{ status: 'replaced' }, { status: 'pending', fact: { kind: 'cancelled' } }])
  const replacement = read.facts[1].factId
  await commit(id, await command(id, { action: 'withdraw', factId: replacement }))
  expect((await http(id)).body.facts).toMatchObject([{ status: 'replaced' }, { status: 'withdrawn' }])
  const replayPlan = await http(id, '/preflight', input)
  expect(await http(id, '/commit', { request: input, planHash: replayPlan.body.planHash })).toEqual(first)
  read = (await http(id)).body
  expect(read.history.map((r: any) => r.action)).toEqual(['assert', 'confirm', 'replace', 'replace', 'withdraw'])
  expect(read.history[0]).toMatchObject({ actor: input.actor, basis: input.basis })
})
it('preflight binding CAS auth and illegal transitions leave the same readback', async () => {
  const id = seed(), input = await command(id, { action: 'assert', fact })
  const before = (await http(id)).body
  const plan = (await http(id, '/preflight', input)).body
  expect((await http(id, '/commit', { request: input, planHash: plan.planHash }, false)).status).toBe(401)
  expect((await http(id, '/commit', { request: { ...input, basis: 'changed' }, planHash: plan.planHash })).status).toBe(409)
  expect((await http(id)).body).toEqual(before)
  await commit(id, input)
  expect((await http(id, '/preflight', { ...input, idempotencyKey: 'stale' })).status).toBe(409)
  const current = (await http(id)).body
  expect((await http(id, '/preflight', await command(id, { action: 'withdraw', factId: 999999 }))).status).toBe(409)
  expect((await http(id)).body).toEqual(current)
})
it('same-input shadow retains legacy IDs heads aliases and moved-in columns; failed audit append rolls back', async () => {
  const id = seed()
  db.insert(schema.enterpriseAlias).values({ enterpriseId: id, name: '历史名称', nameNorm: '历史名称', sourceKind: 'manual', verificationStatus: 'confirmed' }).run()
  const legacy = () => ({
    heads: db.select().from(schema.differenceReason).all(),
    aliases: db.select().from(schema.enterpriseAlias).all(),
    enterprise: db.select().from(schema.enterprise).all(),
  })
  const before = legacy(), input = await command(id, { action: 'assert', fact: { ...fact, kind: 'moved_in', effective: { precision: 'unknown', value: null } } })
  await commit(id, input)
  expect(legacy()).toEqual(before)
  const current = (await http(id)).body
  expect(current.facts[0].fact).toMatchObject({ kind: 'moved_in', city: null, effective: { precision: 'unknown', value: null } })
  const request = await command(id, { action: 'replace', factId: current.facts[0].factId, fact })
  const plan = (await http(id, '/preflight', request)).body
  // Simulate storage failure after revisions, before receipt: entire command must roll back.
  db.$client.exec("CREATE TRIGGER reject_fact_receipt BEFORE INSERT ON enterprise_fact_receipt BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END")
  try { expect((await http(id, '/commit', { request, planHash: plan.planHash })).status).toBe(500) }
  finally { db.$client.exec('DROP TRIGGER reject_fact_receipt') }
  expect((await http(id)).body).toEqual(current)
  expect(legacy()).toEqual(before)
  expect((await http(id, '/commit', { request, planHash: plan.planHash })).status).toBe(200)
})

it('confirmed past independent facts exclude through the existing qualification reader without changing legacy storage', async () => {
  const { readCurrentQualificationAssessment } = await import('../../../layers/sme-roster/lib/roster/current-qualification')
  const id = seed()
  const read = () => readCurrentQualificationAssessment(db.$client, id).titles.find(t => t.titleCode === 'specialized_sme')!
  const input = await command(id, { action: 'assert', fact })
  const first = await commit(id, input)
  await commit(id, await command(id, { action: 'confirm', factId: first.body.factId }))
  expect(read().region.status).toBe('outside_ningbo')
  expect(read().group).toBe('excluded')
  const detail = await http(id, '/detail')
  expect(detail.status).toBe(200)
  expect(detail.body.qualificationAssessment.titles.find((t: any) => t.titleCode === 'specialized_sme').region.status).toBe('outside_ningbo')
})
it('conservative intervals preserve precision and unknown registration never implies termination', async () => {
  const { readCurrentQualificationAssessment } = await import('../../../layers/sme-roster/lib/roster/current-qualification')
  for (const [kind, effective, region, subject] of [
    ['moved_out', { precision: 'year', value: '2026' }, 'unresolved', 'unresolved'],
    ['moved_out', { precision: 'month', value: '2026-11' }, 'unresolved', 'unresolved'],
    ['moved_out', { precision: 'unknown', value: null }, 'unresolved', 'unresolved'],
    ['registration_status', { precision: 'year', value: '2024' }, 'unresolved', 'unresolved'],
    ['cancelled', { precision: 'year', value: '2024' }, 'not_established', 'terminated'],
  ] as const) {
    const id = seed()
    const first = await commit(id, await command(id, { action: 'assert', fact: { ...fact, kind, effective } }))
    await commit(id, await command(id, { action: 'confirm', factId: first.body.factId }))
    const read = readCurrentQualificationAssessment(db.$client, id, Date.parse('2026-11-04T00:00:00Z')).titles[0]!
    expect(read.region.status).toBe(region)
    expect(read.subject.status).toBe(subject)
    expect((await http(id)).body.facts[0].fact.effective).toEqual(effective)
  }
})
it('native qualification consumes confirmed facts and withdrawal preserves immutable lifecycle revisions', async () => {
  const { readCurrentQualificationAssessment } = await import('../../../layers/sme-roster/lib/roster/current-qualification')
  const id=seed(),read=()=>readCurrentQualificationAssessment(db.$client,id,Date.parse('2026-11-04T00:00:00Z')).titles.find(t=>t.titleCode==='specialized_sme')!
  expect(read().region.status).toBe('not_established')
  const first=await commit(id,await command(id,{action:'assert',fact}))
  await commit(id,await command(id,{action:'confirm',factId:first.body.factId}))
  const confirmed=(await http(id)).body
  expect(confirmed.facts).toMatchObject([{factId:first.body.factId,status:'confirmed',fact}])
  expect(read().region.status).toBe('outside_ningbo')
  const version=read().versions.facts
  await commit(id,await command(id,{action:'withdraw',factId:first.body.factId}))
  const withdrawn=(await http(id)).body
  expect(withdrawn.facts).toMatchObject([{factId:first.body.factId,status:'withdrawn',fact}])
  expect(withdrawn.history.map((row:any)=>row.action)).toEqual(['assert','confirm','withdraw'])
  expect(withdrawn.history.slice(0,2)).toEqual(confirmed.history)
  expect(read().region.status).toBe('not_established')
  expect(read().versions.facts).not.toBe(version)
})
it('difference commands pin multiple owned confirmed revisions and reject cross-enterprise stale or pending references', async () => {
  const { saveDecision102 } = await import('../../../layers/sme-roster/server/utils/decision-lifecycle-102')
  const id = seed(), other = seed(), refs: any[] = []
  for (const kind of ['moved_out', 'cancelled']) {
    const first = await commit(id, await command(id, { action: 'assert', fact: { ...fact, kind } }))
    await commit(id, await command(id, { action: 'confirm', factId: first.body.factId }))
    refs.push({ enterpriseId: id, factId: first.body.factId, revision: 2, kind })
  }
  const request: any = { enterpriseId: id, titleCode: 'specialized_sme', direction: 'missing_in_miit', action: 'replace', expectedCurrentId: null, idempotencyKey: `decision-${++seq}`, actor: { type: 'agent', id: 'test' }, basis: '核实', ruleVersion: 'test', effectiveAt: '2026-01-01T00:00:00Z', decision: { status: 'confirmed_reason', reasonCode: 'platform_stale', measureCode: 'none', verificationStatus: 'confirmed', factReferences: refs } }
  for (const bad of [{ ...refs[0], enterpriseId: other }, { ...refs[0], revision: 1 }, { ...refs[0], kind: 'moved_in' }]) {
    expect(() => saveDecision102(db, { ...request, decision: { ...request.decision, factReferences: [bad] } })).toThrow()
  }
  const result = saveDecision102(db, request)
  const row = db.$client.prepare('select fact_references from difference_reason where id=?').get(result.versionId) as any
  expect(JSON.parse(row.fact_references)).toEqual(refs)
})
it('overlapping opposite migrations stay pending and confirmed cancellation survives a later migration', async () => {
  const { readCurrentQualificationAssessment } = await import('../../../layers/sme-roster/lib/roster/current-qualification')
  const id = seed(), read = () => readCurrentQualificationAssessment(db.$client, id, Date.parse('2026-11-04T00:00:00Z')).titles[0]!
  for (const kind of ['moved_in', 'moved_out', 'cancelled', 'moved_in']) {
    const first = await commit(id, await command(id, { action: 'assert', fact: { ...fact, kind, effective: { precision: 'year', value: kind === 'moved_in' ? '2024' : '2024' } } }))
    await commit(id, await command(id, { action: 'confirm', factId: first.body.factId }))
    if (kind === 'moved_out') expect(read().region.status).toBe('unresolved')
  }
  expect(read().subject.status).toBe('terminated')
  expect(read().group).toBe('excluded')
})

const pgBin = process.env.TEST_ROSTER_FACTS_PG_BIN
it.runIf(!!pgBin)('shares native fact revisions across HTTP and MCP and rolls back a failed receipt', async () => {
  const enterpriseId = seed()
  const older = await commit(enterpriseId, await command(enterpriseId, { action: 'assert', fact }))
  expect(older.status).toBe(200)
  const original = (await http(enterpriseId)).body
  const confirm = await command(enterpriseId, { action: 'confirm', factId: older.body.factId })
  const sqlitePlan = (await http(enterpriseId, '/preflight', confirm)).body.planHash
  const pgDir = mkdtempSync('/tmp/facts-pg-')
  const { installLeadListSchema } = await import('../../../layers/lead-lists/install-schema')
  const { closePostgresDirectoryDb, usePostgresDirectoryDb } = await import('../../../db/postgresql/client')
  const { readPostgresCurrentQualification } = await import('../../../layers/sme-roster/public')
  installLeadListSchema(db.$client)
  const url = 'postgresql://facts_fixture@localhost/postgres?host=' + encodeURIComponent(pgDir)
  const env = {
    PATH: process.env.PATH, LANG: 'C', PGHOST: pgDir, PGPORT: '5432', PGDATABASE: 'postgres',
    PGUSER: 'facts_fixture', PGSQL_BIN: join(pgBin!, 'psql'),
  }
  const run = (command: string, args: string[]) => execFileSync(join(pgBin!, command), args, { env, stdio: 'pipe' })
  let started = false
  const pool = new pg.Pool({ connectionString: url })
  try {
    run('initdb', ['-A', 'trust', '-E', 'UTF8', '--locale=C', '-U', 'facts_fixture', '-D', join(pgDir, 'pg')])
    run('pg_ctl', ['-w', '-D', join(pgDir, 'pg'), '-l', join(pgDir, 'pg.log'), '-o', "-c listen_addresses='' -k " + pgDir, 'start'])
    started = true
    execFileSync(process.execPath, ['upgrade/postgresql/stage-sqlite.mjs', join(dir, 'test.db'), 'staged'], { env, stdio: 'pipe' })
    for (const name of ['enterprise-directory', 'enterprise-identity', 'jobs', 'file-and-lead-lists', 'roster']) {
      run('psql', ['-X', '-w', '-q', '-v', 'staging=staged', '-f', 'upgrade/postgresql/materialize-' + name + '.sql'])
    }
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', url)
    vi.stubEnv('NUXT_DB_READONLY', '1')

    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_WRITE', '1')
    vi.stubEnv('NUXT_POSTGRES_ROSTER_READ', '1')
    expect((await http(enterpriseId)).body).toEqual(original)
    expect((await http(enterpriseId, '/preflight', confirm)).body.planHash).toBe(sqlitePlan)
    const submitted = { request: confirm, planHash: sqlitePlan }
    expect((await http(enterpriseId, '/commit', submitted, false)).status).toBe(401)
    const results = await Promise.all([
      mcp.commit_enterprise_fact.handler({ enterpriseId, request: submitted }),
      http(enterpriseId, '/commit', submitted).then(result => {
        expect(result.status).toBe(200)
        return result.body
      }),
    ])
    expect(results[0]).toEqual(results[1])
    const confirmed = (await http(enterpriseId)).body
    expect(confirmed.history.map((row: any) => [row.revision, row.status])).toEqual([[1, 'pending'], [2, 'confirmed']])
    expect(await mcp.get_enterprise_facts.handler({ enterpriseId })).toEqual(confirmed)
    expect(db.select().from(schema.enterpriseFactRevision).all().filter(row => row.enterpriseId === enterpriseId)).toEqual(original.history)

    const postgres = usePostgresDirectoryDb()!
    const qualification = await postgres.transaction(tx => readPostgresCurrentQualification(tx, enterpriseId, Date.parse('2026-11-20T00:00:00Z')),
      { isolationLevel: 'repeatable read', accessMode: 'read only' })
    expect(qualification?.titles[0]?.region.status).toBe('outside_ningbo')

    const replacement = await command(enterpriseId, { action: 'replace', factId: older.body.factId, fact: { ...fact, kind: 'cancelled' } })
    const plan = (await http(enterpriseId, '/preflight', replacement)).body
    await pool.query("ALTER TABLE business.enterprise_fact_receipt ADD CONSTRAINT reject_new_receipt CHECK (false) NOT VALID")
    expect((await http(enterpriseId, '/commit', { request: replacement, planHash: plan.planHash })).status).toBe(500)
    expect((await http(enterpriseId)).body).toEqual(confirmed)
    await pool.query('ALTER TABLE business.enterprise_fact_receipt DROP CONSTRAINT reject_new_receipt')
    expect((await http(enterpriseId, '/commit', { request: replacement, planHash: plan.planHash })).status).toBe(200)
  } finally {
    vi.unstubAllEnvs()
    await closePostgresDirectoryDb()
    await pool.end()
    if (started) run('pg_ctl', ['-w', '-D', join(pgDir, 'pg'), '-m', 'fast', 'stop'])
    rmSync(pgDir, { recursive: true, force: true })
  }
}, 90_000)
