import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { expect, it, vi } from 'vitest'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { minimalPdf } from '../../support/minimal-pdf'
import type { OfficialPublishedRow, RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { stagePostgresAnnouncement } from '../../../layers/sme-roster/server/utils/announcement-intake-postgres'

const openDatabase = useIsolatedPostgresCases()

it('lists immutable announcement versions and gates a real preflight, plan-bound commit and replay', async () => {
  const db = openDatabase()
  const dir = mkdtempSync(join(tmpdir(), 'announcement-browser-'))
  const server = createServer()
  try {
    for (const name of ['defineEventHandler', 'readBody', 'getRouterParam', 'setHeader', 'setResponseStatus', 'createError'] as const) {
      vi.stubGlobal(name, h3[name])
    }
    vi.stubGlobal('defineRouteMeta', () => {})
    vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: dir, apiToken: 'synthetic-test-token' }))
    const [list, detail, supplement, context, tokenDetail] = await Promise.all([
      import('../../../layers/sme-roster/server/api/roster/import/intake/browser.get'),
      import('../../../layers/sme-roster/server/api/roster/import/intake/[id]/browser.get'),
      import('../../../layers/sme-roster/server/api/roster/import/intake/[id]/browser-supplement.post'),
      import('../../../layers/sme-roster/server/api/roster/browser-context.get'),
      import('../../../layers/sme-roster/server/api/roster/import/intake/[id].get'),
    ])
    const intakePath = '/api/roster/import/intake'
    const router = h3.createRouter()
      .get(intakePath + '/browser', list.default)
      .get(intakePath + '/:id/browser', detail.default)
      .get(intakePath + '/:id', tokenDetail.default)
      .post(intakePath + '/:id/browser-supplement', supplement.default)
      .get('/api/roster/browser-context', context.default)
    server.on('request', h3.toNodeListener(h3.createApp().use(router)))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP fixture missing a loopback address')
    const origin = 'http://127.0.0.1:' + address.port

    const path = '合成公告.pdf'
    const bytes = minimalPdf({ pages: 1 })
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(join(dir, path), bytes)
    await db.$client.query(
      "INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES (1,$1,$1,'pdf',$2,$3,'2026-01-01')",
      [path, bytes.length, sha256],
    )
    await db.$client.query("INSERT INTO roster_file_classification(file_id,source,kind) VALUES (1,'jxj','announcement')")
    const sourceDocument = { source: 'jxj' as const, title: '合成公告', docNumber: null, issueDate: '2026-01-01' }
    const publishedRow: OfficialPublishedRow = {
      nameRaw: '同一企业', usccRaw: null, districtRaw: null,
      declaration: { kind: 'independent', sourceDocument: { ...sourceDocument, path }, basis: '合成发布依据' },
      storedFileId: 1, path, sha256, bytes: bytes.length, attachment: null, sectionKey: '名单',
      listNo: 1, page: 1, sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic' }, basis: '合成核实依据',
    }
    const request: RosterImportRequest = {
      sourceKind: 'announcement', sourceIdentity: path, idempotencyKey: 'browser-intake', sourceSha256: sha256,
      payload: { announcement: { sourceDocument, records: [
        { enterprise: { name: '同一企业' }, titleCode: 'specialized_sme', events: [
          { eventType: 'award', year: 2026, batchSeq: 1, evidence: [{ sourceFile: path, page: 1, listNo: 1, publishedRow }] },
        ] },
        { enterprise: { name: '同一企业' }, titleCode: 'little_giant',
          events: [{ eventType: 'award', year: 2026, batchSeq: 2 }] },
      ] } },
    }
    const staged = await stagePostgresAnnouncement(request, [])
    if (staged.status !== 'staged') throw new Error(JSON.stringify(staged))
    const second = await stagePostgresAnnouncement({ ...request, idempotencyKey: 'removed-fixture' }, [])
    if (second.status !== 'staged') throw new Error(JSON.stringify(second))
    await db.$client.query("UPDATE roster_announcement_intake SET removed_reason='撤下' WHERE id=$1", [second.intakeId])

    const url = origin + intakePath + '/' + staged.intakeId
    const listUrl = origin + intakePath + '/browser'
    const state = { id: staged.intakeId, digest: staged.sourceDigest, status: 'staged', sourceKind: 'announcement',
      sourceIdentity: path, sourceName: '合成公告', issueDate: '2026-01-01', rowCount: 2 }
    const listed = await fetch(listUrl)
    expect(listed.headers.get('cache-control')).toBe('no-store')
    expect(await listed.json()).toEqual([{ ...state, id: second.intakeId, digest: second.sourceDigest, status: 'removed' }, state])
    const original = await fetch(url + '/browser')
    expect(original.headers.get('cache-control')).toBe('no-store')
    expect(await original.json()).toEqual({ intakeId: staged.intakeId, sourceDigest: staged.sourceDigest, status: 'staged',
      announcement: request.payload.announcement, officialEvidencePreflightRequired: true })
    expect((await fetch(url)).status).toBe(401)
    expect((await fetch(origin + intakePath + '/9999/browser')).status).toBe(404)
    expect((await fetch(origin + intakePath + '/invalid/browser')).status).toBe(400)

    const review = { sourceDigest: staged.sourceDigest, basis: '核对公告与主体', rows: [
      { action: 'create', fields: { name: '同一企业' } }, { action: 'same_subject', row: 0 },
    ] }
    const post = (body: unknown, headers: Record<string, string> = { origin }) =>
      fetch(url + '/browser-supplement', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const preview = { ...review, preflight: true }
    for (const [headers, status, code] of [
      [{}, 403, 'origin_required'],
      [{ origin: 'https://other.example' }, 403, 'origin_mismatch'],
      [{ origin, 'sec-fetch-site': 'cross-site' }, 403, 'cross_site_request'],
      [{ origin, 'content-type': 'text/plain' }, 415, 'unsupported_media_type'],
    ] as const) {
      const response = await post(preview, headers)
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ error: { code } })
    }

    vi.stubEnv('NUXT_DB_READONLY', '1')
    expect(await (await fetch(origin + '/api/roster/browser-context')).json()).toEqual({ writeEnabled: false })
    expect((await post(preview)).status).toBe(503)
    expect((await post(review)).status).toBe(503)
    vi.stubEnv('NUXT_DB_READONLY', '0')
    expect(await (await fetch(origin + '/api/roster/browser-context')).json()).toEqual({ writeEnabled: true })

    const response = await post(preview)
    expect(response.status).toBe(200)
    const plan = await response.json()
    expect(plan).toEqual({ status: 'preflighted', conflicts: [], officialEvidencePlanHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect((await db.$client.query('SELECT id FROM enterprise')).rows).toEqual([])
    expect((await db.$client.query('SELECT id FROM import_batch')).rows).toEqual([])
    const mismatched = await post({ ...review, basis: '已改变的核实依据', officialEvidencePlanHash: plan.officialEvidencePlanHash })
    expect(await mismatched.json()).toMatchObject({ status: 'failed', items: [expect.objectContaining({ error: expect.objectContaining({ code: 'plan_mismatch' }) })] })
    expect((await db.$client.query('SELECT id FROM enterprise')).rows).toEqual([])

    const command = { ...review, officialEvidencePlanHash: plan.officialEvidencePlanHash }
    const committed = await post(command)
    expect(committed.status).toBe(200)
    const receipt = await committed.json()
    const { rows: [owner] } = await db.$client.query('SELECT id::int FROM enterprise')
    expect(receipt).toMatchObject({ status: 'supplemented', intakeId: staged.intakeId, owners: [owner.id, owner.id] })
    expect(await (await post(command)).json()).toEqual(receipt)
    expect(await (await fetch(listUrl)).json()).toEqual([
      { ...state, id: second.intakeId, digest: second.sourceDigest, status: 'removed' }, { ...state, status: 'supplemented' },
    ])
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)
