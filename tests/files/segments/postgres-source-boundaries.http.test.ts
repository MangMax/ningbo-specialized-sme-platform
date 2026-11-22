import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createApp, createRouter, defineEventHandler, getQuery, getRouterParam, setHeader, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { minimalPdf } from '../../support/minimal-pdf'

const bin = process.env.ROSTER_TEST_POSTGRES_BIN
const fileId = 9
const filename = 'notice.pdf'
const syncFileId = 10
const syncFilename = 'notice-sync.pdf'
const source = minimalPdf({ pages: 4 })
const sha256 = createHash('sha256').update(source).digest('hex')
const token = 'fixture-segments-api-secret'

describe.runIf(Boolean(bin))('PostgreSQL browser file segments', () => {
  let dir: string
  let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>>
  let server: ReturnType<typeof createServer>
  let base: string

  beforeAll(async () => {
    dir = mkdtempSync('/tmp/file-segments-pg-')
    writeFileSync(join(dir, filename), source)
    writeFileSync(join(dir, syncFilename), source)
    runtime = await postgresRuntimeFixture({ dir, bin })
    runtime.psql(['-c', `
        SET search_path TO business,public;
        INSERT INTO stored_file (id,rel_path,filename,ext,bytes,sha256,created_at) VALUES
          (${fileId},'${filename}','${filename}','pdf',${source.length},'${sha256}','2025-01-01'),
          (${syncFileId},'${syncFilename}','${syncFilename}','pdf',${source.length},'${sha256}','2025-01-01');
        INSERT INTO roster_file_classification(file_id,source,kind,parse_state) VALUES (9,'jxj','announcement','failed'), (10,'jxj','announcement','parsed');
        INSERT INTO enterprise(id,name,name_norm) VALUES (1,'示例企业','示例企业');
        INSERT INTO record(id,enterprise_id,title_code,source) VALUES (1,1,'specialized_sme','jxj');
        INSERT INTO record_event(id,record_id,event_type,year,batch_seq) VALUES (1,1,'award',2022,1), (2,1,'award',NULL,NULL);
        INSERT INTO record_evidence(id,record_event_id,source_file,attachment,page) VALUES (1,1,'notice.pdf','附件1',1), (2,2,'notice-sync.pdf','附件1',1);
        INSERT INTO stored_file_part(file_id,title_code,event_kind,year,batch,attachment,row_count,origin)
          VALUES (9,'specialized_sme','award',2022,1,'附件1',1,'derived'),
            (10,'specialized_sme','award',NULL,NULL,'附件1',1,'derived');

    `])
    vi.stubEnv('NUXT_DB_READONLY', '0')
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', runtime.url)
    vi.stubEnv('NUXT_POSTGRES_LOG_URL', undefined)
    vi.stubGlobal('defineEventHandler', defineEventHandler)
    vi.stubGlobal('getQuery', getQuery)
    vi.stubGlobal('getRouterParam', getRouterParam)
    vi.stubGlobal('setHeader', setHeader)
    vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: token, filesDir: dir }))

    const router = createRouter()
      .get('/api/sme-roster/files', (await import('../../../layers/sme-roster/server/api/sme-roster/files.get')).default)
      .get('/api/files/:id/parse-result/history', (await import('../../../layers/sme-roster/server/api/files/[id]/parse-result/history.get')).default)
      .get('/api/files/:id/segments', (await import('../../../layers/sme-roster/server/api/files/[id]/segments.get')).default)
      .post('/api/files/:id/segments/preflight', (await import('../../../layers/sme-roster/server/api/files/[id]/segments/preflight.post')).default)
      .post('/api/files/:id/segments/commit', (await import('../../../layers/sme-roster/server/api/files/[id]/segments/commit.post')).default)
      .post('/api/files/:id/event-sync/browser-preflight', (await import('../../../layers/sme-roster/server/api/files/[id]/event-sync/browser-preflight.post')).default)
      .post('/api/files/:id/event-sync/browser-commit', (await import('../../../layers/sme-roster/server/api/files/[id]/event-sync/browser-commit.post')).default)
    server = createServer(toNodeListener(createApp({ debug: false }).use(router)))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }, 60_000)

  afterAll(async () => {
    try {
      if (server) await new Promise<void>(resolve => server.close(() => resolve()))
      await closePostgresDirectoryDb()
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
      runtime?.close()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  async function request(action = '', body?: unknown, origin = base, id = fileId, endpoint = 'segments') {
    const response = await fetch(`${base}/api/files/${id}/${endpoint}${action}`, body === undefined ? undefined : {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }

  it('reads source facts, verifies PDF ranges, and persists same-origin segment changes with replay', async () => {
    const initial = await request()
    const coordinate = { titleCode: 'specialized_sme', eventKind: 'award', year: 2022, batch: 1, attachment: '附件1' }
    expect(initial).toMatchObject({ status: 200, body: { writeEnabled: true,
      state: { parseState: 'failed', parts: [{ ...coordinate, rowCount: 1, origin: 'derived' }], declarations: [] },
    } })
    expect(JSON.stringify(initial.body)).not.toContain(token)

    const expectedVersion = initial.body.state.version
    const preflight = { expectedVersion, verifyPhysicalPages: true }
    expect((await request('/preflight', preflight, 'https://other.example')).status).toBe(403)
    const plan = await request('/preflight', preflight)
    expect(plan).toMatchObject({ status: 200, body: { expectedVersion, parseState: 'failed',
      inputRef: { kind: 'file', pages: [], physicalSource: { pageCount: 4 } },
    } })
    const pageRanges = [{ start: 1, end: 2 }, { start: 4, end: 4 }]
    const part = { ...coordinate, rowCount: 3, pageRanges }
    const commit = { ...plan.body, parts: [part], idempotencyKey: 'declare', reason: '登记内容描述' }
    expect((await request('/commit', { ...commit, parseState: 'parsed' })).status).toBe(400)
    expect(await request()).toEqual(initial)

    const saved = await request('/commit', commit)
    expect(saved).toMatchObject({ status: 200, body: { replayed: false, state: { parseState: 'failed',
      parts: [{ ...coordinate, origin: 'agent', hasConflict: true, rowCount: 3 }],
      declarations: [{ part: { ...coordinate, rowCount: 3 }, pageRanges }],
    } } })
    const readback = await request()
    expect(readback).toEqual({ status: 200, body: { writeEnabled: true, state: saved.body.state } })
    expect(readback.body.state.version).not.toBe(expectedVersion)
    expect(await request('/commit', commit)).toEqual({ status: 200, body: { ...saved.body, replayed: true } })
    expect((await request('/preflight', preflight)).status).toBe(409)

    const withdrawalPlan = await request('/preflight', { expectedVersion: readback.body.state.version })
    expect(withdrawalPlan.status).toBe(200)
    const withdrawal = await request('/commit', { ...withdrawalPlan.body, parts: [], idempotencyKey: 'withdraw', reason: '撤回登记' })
    expect(withdrawal.status).toBe(200)
    expect((await request()).body.state).toMatchObject({ parseState: 'failed',
      parts: [{ ...coordinate, rowCount: 1, origin: 'derived' }], declarations: [],
    })
    const firstReceipt = saved.body.receiptId
    const history = `${base}/api/files/${fileId}/parse-result/history`
    const summary = await fetch(history + '?limit=1')
    expect(summary.status).toBe(200)
    expect(await summary.json()).toMatchObject({ nextAfterId: firstReceipt, rows: [{ receiptId: firstReceipt, idempotencyKey: 'declare' }] })
    const detail = await fetch(history + '?receiptId=' + firstReceipt)
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      id: firstReceipt, before: initial.body.state, after: saved.body.state, inputLineage: saved.body.state.inputLineage,
    })
    expect(readFileSync(join(dir, filename))).toEqual(source)
  })

  it('filters the roster file list by source and parse state while keeping per-file parts', async () => {
    const response = await fetch(`${base}/api/sme-roster/files?source=jxj&parseState=failed&pageSize=1`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      total: 1, rows: [{ id: fileId, source: 'jxj', parseState: 'failed', referenceCount: 1,
        parts: [{ titleCode: 'specialized_sme', year: 2022, batch: 1, origin: 'derived' }],
      }],
    })
    const other = await fetch(`${base}/api/sme-roster/files?source=miit&parseState=failed&pageSize=1`)
    expect(other.status).toBe(200)
    expect(await other.json()).toMatchObject({ total: 0, rows: [] })
  })

  it('fills unknown event coordinates from a verified declaration and replays the same PostgreSQL receipt', async () => {
    const segments = (action = '', body?: unknown) => request(action, body, base, syncFileId)
    const sync = (action: string, body: unknown) => request('/browser-' + action, body, base, syncFileId, 'event-sync')
    const initial = await segments()
    expect(initial.body.state.parts).toMatchObject([{ eventKind: 'award', year: null, batch: null, origin: 'derived' }])
    const declaration = await segments('/preflight', { expectedVersion: initial.body.state.version, verifyPhysicalPages: true })
    expect(declaration.status).toBe(200)
    const coordinate = { titleCode: 'specialized_sme', eventKind: 'award', year: 2025, batch: 2, attachment: '附件1' }
    expect((await segments('/commit', { ...declaration.body, idempotencyKey: 'declare-sync', reason: '核对 PDF 附件',
      parts: [{ ...coordinate, rowCount: 1, pageRanges: [{ start: 1, end: 1 }] }],
    })).status).toBe(200)

    const input = { idempotencyKey: 'fill-unknown-2025', basis: '核实附件1物理页1' }
    const preview = await sync('preflight', input)
    expect(preview).toMatchObject({ status: 200, body: { chunks: 1, rows: [{ eventId: 2, status: 'update', before: { year: null, batchSeq: null }, after: { year: 2025, batchSeq: 2 } }] } })
    const command = { request: input, planHash: preview.body.planHash, chunk: 0 }
    const committed = await sync('commit', command)
    expect(committed).toMatchObject({ status: 200, body: { counts: { updated: 1, unexecuted: 0 }, completed: [0] } })
    expect(await sync('commit', command)).toEqual(committed)
    expect((await segments()).body.state.parts).toMatchObject([{ ...coordinate, origin: 'agent', hasConflict: false }])
    expect(readFileSync(join(dir, syncFilename))).toEqual(source)
  })

})
