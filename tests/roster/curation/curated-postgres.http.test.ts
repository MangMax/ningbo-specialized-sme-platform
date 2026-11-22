import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createError, createRouter, defineEventHandler, readBody, setHeader, setResponseStatus, toWebHandler } from 'h3'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'

import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>>
const token = 'curation-fixture-token'
const scope = { enterpriseId: 9401, titleCode: 'specialized_sme', direction: 'missing_in_miit' }
const patch = { uscc: 'exact code', nameNorm: '同名企业', titleCode: scope.titleCode, direction: scope.direction, curated: true }
let folder: string
let path: string
let request: ReturnType<typeof toWebHandler>

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'pg-legacy-curation-'))
  path = join(folder, 'annotations.json')
  postgres = await postgresRuntimeFixture({ dir: folder })
  const url = postgres.url
  const client = new pg.Client({ connectionString: postgres.url })
  await client.connect()
  try {
    await client.query(`
      SET search_path TO business,public;
      INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES
        (9401,'统代企业','统代企业','EXACTCODE'),
        (9402,'同名企业','同名企业',NULL),(9403,'同名企业','同名企业',NULL);
    `)
  } finally { await client.end() }

  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: token, curatedPath: path }))
  for (const [name, fn] of Object.entries({ createError, defineEventHandler, readBody, setHeader, setResponseStatus })) {
    vi.stubGlobal(name, fn)
  }
  const curated = (await import('../../../layers/sme-roster/server/api/comparison/curated.patch')).default
  const decide = (await import('../../../layers/sme-roster/server/api/roster/decision-lifecycle/commands.post')).default
  request = toWebHandler(createApp().use(createRouter()
    .patch('/api/comparison/curated', curated)
    .post('/api/roster/decision-lifecycle/commands', decide)))
}, 60_000)

afterAll(async () => {
  await closePostgresDirectoryDb()
  postgres?.close()
  if (folder) rmSync(folder, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function send(method: string, path: string, body: unknown) {
  return request(new Request('http://localhost' + path, {
    method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  }))
}

const curate = (body: unknown) => send('PATCH', '/api/comparison/curated', body)

it('keeps legacy JSON keys and notes, supports unmatched keys and rejects ambiguous exact names', async () => {
  const first = await curate({ ...patch, note: '原备注' })
  const result = await first.json()
  expect(first.status, JSON.stringify(result)).toBe(200)
  expect(result).toEqual({ curated: true })
  const saved = readFileSync(path, 'utf8')
  expect(JSON.parse(saved)).toEqual({
    '["exact code","specialized_sme","missing_in_miit"]': { at: expect.any(String), note: '原备注' },
  })
  expect((await curate(patch)).status).toBe(200)
  expect(readFileSync(path, 'utf8')).toBe(saved)

  const ambiguous = await curate({ ...patch, uscc: undefined })
  expect(ambiguous.status).toBe(409)
  expect(await ambiguous.json()).toMatchObject({ error: { code: 'ambiguous_enterprise' } })
  expect(readFileSync(path, 'utf8')).toBe(saved)

  const unmatched = { ...patch, uscc: 'NO-EXACT-MATCH' }
  expect((await curate(unmatched)).status).toBe(200)
  expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')))).toContain('["NO-EXACT-MATCH","specialized_sme","missing_in_miit"]')
  expect(await (await curate({ ...unmatched, curated: false })).json()).toEqual({ curated: false })

  expect((await curate({ ...patch, note: '' })).status).toBe(200)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
    '["exact code","specialized_sme","missing_in_miit"]': { at: expect.any(String), note: '' },
  })
})

it('waits for concurrent lifecycle adoption and rejects the legacy file change', async () => {
  const initial = await curate({ ...patch, note: '保留此备注' })
  expect(initial.status).toBe(200)
  const before = readFileSync(path, 'utf8')
  const pin = new pg.Client({ connectionString: postgres.url })
  await pin.connect()
  let adoption: Promise<Response> | undefined
  let annotation: Promise<Response> | undefined
  const waitForQueuedWriters = (count: number) => vi.waitFor(async () => {
    const { rows } = await pin.query(`
      SELECT count(*)::int AS queued FROM pg_locks
      WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND locktype='advisory' AND classid=42458 AND objid=114 AND NOT granted`)
    expect(rows[0]?.queued).toBe(count)
  })
  try {
    await pin.query('BEGIN; SELECT pg_advisory_xact_lock(42458,114)')
    adoption = send('POST', '/api/roster/decision-lifecycle/commands', {
      ...scope, action: 'replace', expectedCurrentId: null, idempotencyKey: 'curation-adoption',
      actor: { type: 'agent', id: 'fixture' }, basis: 'Reviewed scope', ruleVersion: 'fixture',
      effectiveAt: '2026-10-18T00:00:00Z',
      decision: { status: 'confirmed_no_diff', measureCode: 'none', verificationStatus: 'confirmed' },
    })
    await waitForQueuedWriters(1)
    annotation = curate({ ...patch, curated: false })
    await waitForQueuedWriters(2)
    expect(readFileSync(path, 'utf8')).toBe(before)
    await pin.query('COMMIT')

    const approved = await adoption
    const receipt = await approved.json()
    expect(approved.status, JSON.stringify(receipt)).toBe(200)
    expect(receipt).toMatchObject({ action: 'replace', currentId: expect.any(Number) })
    const rejected = await annotation
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({
      error: { code: 'decision_lifecycle_required' },
      replacement: '/api/roster/decision-lifecycle/commands', preview: '/api/roster/decision-lifecycle/legacy-preview',
    })
    expect(readFileSync(path, 'utf8')).toBe(before)
  } finally {
    await pin.end()
    await Promise.allSettled([adoption, annotation])
  }
})
