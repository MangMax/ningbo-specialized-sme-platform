import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, toNodeListener, defineEventHandler } from 'h3'
import { afterAll, expect, it, vi } from 'vitest'
import { useDb, schema } from '../db/client'
const oldDbPath = process.env.NUXT_DB_PATH
const dir = mkdtempSync('/tmp/sync671-'),
  db = useDb({ dbPath: `${dir}/test.db` })
const pdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
)
writeFileSync(`${dir}/notice.pdf`, pdf)
const sha256 = createHash('sha256').update(pdf).digest('hex')
const s = statSync(`${dir}/notice.pdf`, { bigint: true }),
  epoch = [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(':')
const file = db
  .insert(schema.storedFile)
  .values({
    relPath: 'notice.pdf',
    filename: 'notice.pdf',
    ext: 'pdf',
    bytes: pdf.length,
    sha256,
  })
  .returning()
  .get()
const enterprise = db
  .insert(schema.enterprise)
  .values({ name: '同步合成企业', nameNorm: '同步合成企业' })
  .returning()
  .get()
const record = db
  .insert(schema.record)
  .values({
    enterpriseId: enterprise.id,
    titleCode: 'specialized_sme',
    source: 'jxj',
    nameRaw: enterprise.name,
  })
  .returning()
  .get()
const event = db
  .insert(schema.recordEvent)
  .values({
    recordId: record.id,
    eventType: 'award',
    year: null,
    batchSeq: null,
  })
  .returning()
  .get()
const evidence = db
  .insert(schema.recordEvidence)
  .values({
    recordEventId: event.id,
    sourceFile: 'notice.pdf',
    page: 1,
    attachment: '附件1',
  })
  .returning()
  .get()
db.insert(schema.fileDeclaration669)
  .values({
    declarationId: randomUUID(),
    fileId: file.id,
    revision: 1,
    active: true,
    sha256,
    contentVersion: epoch,
    part: {
      titleCode: 'specialized_sme',
      eventKind: 'award',
      year: 2025,
      batch: 2,
      attachment: '附件1',
      rowCount: 1,
    },
    pageRanges: [{ start: 1, end: 1 }],
  })
  .run()
const sourceBatch = db
  .insert(schema.importBatch)
  .values({
    idempotencyKey: 'raw-history-671',
    sourceKind: 'announcement',
    sourceIdentity: 'notice.pdf',
  })
  .returning()
  .get()
const originalPublishedRow = db
  .insert(schema.officialEvidenceRowRevision)
  .values({
    evidenceId: evidence.id,
    revision: 1,
    eventId: event.id,
    capturedRecordId: record.id,
    capturedEnterpriseId: enterprise.id,
    nameRaw: '历史公布原名',
    usccRaw: '原文未知',
    districtRaw: '原始属地写法',
    path: 'notice.pdf',
    attachment: '附件1',
    page: 1,
    sourceBindingKnown: false,
    actor: { type: 'agent', id: 'original-import' },
    basis: '原公布行字面值',
    commandKind: 'import',
    importBatchId: sourceBatch.id,
    createdAt: '2025-01-01T00:00:00Z',
  })
  .returning()
  .get()
let server: ReturnType<typeof createServer>
async function service() {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('useRuntimeConfig', () => ({
    apiToken: 'test671',
    filesDir: dir,
    browserReviewEnabled: true,
  }))
  process.env.NUXT_DB_PATH = `${dir}/test.db`
  const { fileEventSyncRoute } = await import('../server/utils/file-event-sync-route')
  const app = createApp(),
    router = createRouter()
  for (const action of ['preflight', 'commit'] as const) {
    router.post(`/api/files/:id/event-sync/${action}`, fileEventSyncRoute(action))
    router.post(`/api/files/:id/event-sync/browser-${action}`, fileEventSyncRoute(action, true))
  }
  app.use(router)
  server = createServer(toNodeListener(app))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()))
  db.$client.close()
  if (process.env.KEEP_671) console.log('RETAINED_671=' + dir)
  else rmSync(dir, { recursive: true, force: true })
  if (oldDbPath == null) delete process.env.NUXT_DB_PATH
  else process.env.NUXT_DB_PATH = oldDbPath
  vi.unstubAllGlobals()
})
it('preflights and atomically fills only unknown formal coordinates over public HTTP, preserving IDs and replay', async () => {
  const base = await service(),
    request = {
      idempotencyKey: 'sync-1',
      actor: { type: 'agent', id: 'test' },
      basis: '核实附件1物理页1',
    }
  const post = async (action: string, body: unknown) => {
    const r = await fetch(`${base}/api/files/${file.id}/event-sync/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test671',
      },
      body: JSON.stringify(body),
    })
    return { status: r.status, body: await r.json() }
  }
  const plan = await post('preflight', request)
  expect(plan.status).toBe(200)
  expect(plan.body.rows).toMatchObject([
    {
      eventId: event.id,
      status: 'update',
      before: { year: null, batchSeq: null },
      after: { year: 2025, batchSeq: 2 },
    },
  ])
  const commit = { request, planHash: plan.body.planHash, chunk: 0 }
  const receipt = await post('commit', commit)
  expect(receipt.status).toBe(200)
  expect(receipt.body.counts).toMatchObject({ updated: 1, unexecuted: 0 })
  expect(await post('commit', commit)).toEqual(receipt)
  expect((await post('preflight', { ...request, basis: '同键不同依据' })).status).toBe(409)
  expect(db.select().from(schema.recordEvent).get()).toMatchObject({
    id: event.id,
    year: 2025,
    batchSeq: 2,
    revision: 2,
  })
  expect(db.select().from(schema.recordEvidence).get()).toEqual(evidence)
  expect(db.select().from(schema.officialEvidenceRowRevision).get()).toEqual(originalPublishedRow)
  expect(db.select().from(schema.eventCorrectionAudit).all()).toHaveLength(1)
})

it('replays each completed chunk as its original immutable receipt after later chunks', async () => {
  // 101 independently owned events force two genuinely bounded transactions.
  const more = []
  for (let n = 0; n < 101; n++) {
    const enterprise = db
      .insert(schema.enterprise)
      .values({ name: `分块${n}`, nameNorm: `分块${n}` })
      .returning()
      .get()
    const record = db
      .insert(schema.record)
      .values({
        enterpriseId: enterprise.id,
        titleCode: 'specialized_sme',
        source: 'jxj',
        nameRaw: enterprise.name,
      })
      .returning()
      .get()
    more.push(
      db
        .insert(schema.recordEvent)
        .values({ recordId: record.id, eventType: 'award' })
        .returning()
        .get(),
    )
    db.insert(schema.recordEvidence)
      .values({
        recordEventId: more.at(-1)!.id,
        sourceFile: 'notice.pdf',
        page: 1,
        attachment: '附件1',
      })
      .run()
  }
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = async (action: string, body: unknown) => {
    const r = await fetch(`${base}/api/files/${file.id}/event-sync/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test671',
      },
      body: JSON.stringify(body),
    })
    return { status: r.status, body: await r.json() }
  }
  const request = {
    idempotencyKey: 'two-chunks',
    actor: { type: 'agent', id: 'test' },
    basis: '核实完整分段',
  }
  const plan = await post('preflight', request)
  expect(plan.body.chunks).toBe(2)
  const first = { request, planHash: plan.body.planHash, chunk: 0 }
  const receipt = await post('commit', first)
  expect(receipt.body.counts).toMatchObject({ updated: 100, unexecuted: 1 })
  db.$client.exec(
    "CREATE TRIGGER fail671chunk BEFORE INSERT ON event_correction_audit BEGIN SELECT RAISE(ABORT,'second chunk failure'); END",
  )
  try {
    expect((await post('commit', { ...first, chunk: 1 })).status).toBe(500)
    expect((await post('commit', first)).body.counts).toMatchObject({
      updated: 100,
      unexecuted: 1,
    })
  } finally {
    db.$client.exec('DROP TRIGGER fail671chunk')
  }
  const last = await post('commit', { ...first, chunk: 1 })
  expect(last.body.counts).toMatchObject({ updated: 101, unexecuted: 0 })
  expect(await post('commit', first)).toEqual(receipt)
})

let seq = 0
function sample(year: number | null = null, batchSeq: number | null = null) {
  const tag = ++seq,
    path = `sample-${tag}.pdf`
  writeFileSync(`${dir}/${path}`, pdf)
  const s = statSync(`${dir}/${path}`, { bigint: true }),
    epoch = [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(':')
  const f = db
    .insert(schema.storedFile)
    .values({
      relPath: path,
      filename: path,
      ext: 'pdf',
      bytes: pdf.length,
      sha256,
    })
    .returning()
    .get()
  const enterprise = db
    .insert(schema.enterprise)
    .values({ name: `反例${tag}`, nameNorm: `反例${tag}` })
    .returning()
    .get()
  const record = db
    .insert(schema.record)
    .values({
      enterpriseId: enterprise.id,
      titleCode: 'specialized_sme',
      source: 'jxj',
      nameRaw: enterprise.name,
    })
    .returning()
    .get()
  const event = db
    .insert(schema.recordEvent)
    .values({ recordId: record.id, eventType: 'award', year, batchSeq })
    .returning()
    .get()
  const evidence = db
    .insert(schema.recordEvidence)
    .values({
      recordEventId: event.id,
      sourceFile: path,
      page: 1,
      attachment: '附件1',
    })
    .returning()
    .get()
  const declaration = db
    .insert(schema.fileDeclaration669)
    .values({
      declarationId: randomUUID(),
      fileId: f.id,
      revision: 1,
      active: true,
      sha256,
      contentVersion: epoch,
      part: {
        titleCode: 'specialized_sme',
        eventKind: 'award',
        year: 2025,
        batch: 2,
        attachment: '附件1',
        rowCount: 1,
      },
      pageRanges: [{ start: 1, end: 1 }],
    })
    .returning()
    .get()
  const request = {
    idempotencyKey: `sample-${tag}`,
    actor: { type: 'agent', id: 'test' },
    basis: '核实正式附件与物理页',
  }
  const post = async (
    action: string,
    body: unknown = request,
    extra: Record<string, string> = { authorization: 'Bearer test671' },
  ) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const r = await fetch(`${base}/api/files/${f.id}/event-sync/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
    })
    return { status: r.status, body: await r.json() }
  }
  return {
    file: f,
    event,
    record,
    enterprise,
    evidence,
    declaration,
    request,
    post,
  }
}
import { eq } from 'drizzle-orm'
it.each([
  'known',
  'ambiguous',
  'missing-page',
  'multi-source',
  'contradictory-sources',
  'coordinate',
  'origin',
  'unknown-segment',
  'same',
  'other-title',
] as const)('isolates %s without guessing or changing raw sources', async (kind) => {
  const f = sample(
    kind === 'known' ? 2022 : kind === 'same' ? 2025 : null,
    kind === 'same' ? 2 : null,
  )
  if (kind === 'ambiguous')
    db.insert(schema.fileDeclaration669)
      .values({
        ...f.declaration,
        declarationId: randomUUID(),
        part: { ...f.declaration.part, year: 2022 },
      })
      .run()
  if (kind === 'missing-page')
    db.update(schema.recordEvidence)
      .set({ page: null })
      .where(eq(schema.recordEvidence.id, f.evidence.id))
      .run()
  if (kind === 'multi-source')
    db.insert(schema.recordEvidence)
      .values({
        recordEventId: f.event.id,
        sourceFile: 'elsewhere.pdf',
        page: 1,
        attachment: '附件1',
      })
      .run()
  if (kind === 'contradictory-sources') {
    db.insert(schema.fileDeclaration669)
      .values({
        ...f.declaration,
        declarationId: randomUUID(),
        part: { ...f.declaration.part, year: 2022, attachment: '附件2' },
      })
      .run()
    db.insert(schema.recordEvidence)
      .values({
        recordEventId: f.event.id,
        sourceFile: f.file.relPath,
        page: 1,
        attachment: '附件2',
      })
      .run()
  }
  if (kind === 'coordinate')
    db.insert(schema.recordEvent)
      .values({
        recordId: f.record.id,
        eventType: 'award',
        year: 2025,
        batchSeq: 2,
      })
      .run()
  if (kind === 'unknown-segment')
    db.update(schema.fileDeclaration669)
      .set({ part: { ...f.declaration.part, year: null, batch: null } })
      .where(eq(schema.fileDeclaration669.declarationId, f.declaration.declarationId))
      .run()
  if (kind === 'other-title')
    db.update(schema.record)
      .set({ titleCode: 'innovative_sme' })
      .where(eq(schema.record.id, f.record.id))
      .run()
  if (kind === 'origin') {
    const origin = db
      .insert(schema.recordEvent)
      .values({ recordId: f.record.id, eventType: 'award', year: 2022 })
      .returning()
      .get()
    db.update(schema.recordEvent)
      .set({
        eventType: 'review',
        formalValidity: {
          evidenceId: f.evidence.id,
          sourceSha256: sha256,
          statementPages: [1],
          originAwardEventId: origin.id,
          continuation: 'until_this_review_results',
        },
      })
      .where(eq(schema.recordEvent.id, f.event.id))
      .run()
    db.update(schema.fileDeclaration669)
      .set({ part: { ...f.declaration.part, eventKind: 'review' } })
      .where(eq(schema.fileDeclaration669.declarationId, f.declaration.declarationId))
      .run()
  }
  const plan = await f.post('preflight')
  expect(plan.status).toBe(200)
  const expected = kind === 'same' || kind === 'unknown-segment' ? 'unchanged' : 'conflict'
  expect(plan.body.rows).toMatchObject([{ eventId: f.event.id, status: expected }])
  expect(plan.body.chunks).toBe(0)
  expect(
    db
      .select()
      .from(schema.eventCorrectionAudit)
      .where(eq(schema.eventCorrectionAudit.eventId, f.event.id))
      .all(),
  ).toHaveLength(0)
})
it.each([
  'new-member',
  'removed-member',
  'new-source',
  'revision',
  'declaration',
  'source-sha',
  'coordinate-added',
] as const)('rejects a stale whole plan after %s', async (kind) => {
  const f = sample(),
    plan = await f.post('preflight')
  expect(plan.status).toBe(200)
  if (kind === 'new-member') {
    const e = db
      .insert(schema.recordEvent)
      .values({ recordId: f.record.id, eventType: 'review' })
      .returning()
      .get()
    db.insert(schema.recordEvidence)
      .values({ recordEventId: e.id, sourceFile: f.file.relPath, page: 1 })
      .run()
  }
  if (kind === 'removed-member')
    db.delete(schema.recordEvidence).where(eq(schema.recordEvidence.id, f.evidence.id)).run()
  if (kind === 'new-source')
    db.insert(schema.recordEvidence)
      .values({ recordEventId: f.event.id, sourceFile: 'other.pdf', page: 1 })
      .run()
  if (kind === 'revision')
    db.update(schema.recordEvent)
      .set({ revision: 2 })
      .where(eq(schema.recordEvent.id, f.event.id))
      .run()
  if (kind === 'declaration')
    db.update(schema.fileDeclaration669)
      .set({ revision: 2 })
      .where(eq(schema.fileDeclaration669.declarationId, f.declaration.declarationId))
      .run()
  if (kind === 'source-sha')
    db.update(schema.storedFile)
      .set({ sha256: '0'.repeat(64) })
      .where(eq(schema.storedFile.id, f.file.id))
      .run()
  if (kind === 'coordinate-added')
    db.insert(schema.recordEvent)
      .values({
        recordId: f.record.id,
        eventType: 'award',
        year: 2025,
        batchSeq: 2,
      })
      .run()
  const committed = await f.post('commit', {
    request: f.request,
    planHash: plan.body.planHash,
    chunk: 0,
  })
  expect(committed.status).toBe(409)
  expect(
    db
      .select()
      .from(schema.eventCorrectionAudit)
      .where(eq(schema.eventCorrectionAudit.eventId, f.event.id))
      .all(),
  ).toHaveLength(0)
})
it('rolls back a whole chunk on a storage failure and safely resumes the same request', async () => {
  const f = sample(),
    plan = await f.post('preflight')
  expect(plan.status).toBe(200)
  const payload = {
    request: f.request,
    planHash: plan.body.planHash,
    chunk: 0,
  }
  db.$client.exec(
    `CREATE TRIGGER fail671 BEFORE INSERT ON event_correction_audit BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`,
  )
  try {
    expect((await f.post('commit', payload)).status).toBe(500)
    expect((await f.post('preflight')).body.counts).toMatchObject({ failed: 1, unexecuted: 0 })
    expect(
      db.select().from(schema.recordEvent).where(eq(schema.recordEvent.id, f.event.id)).get(),
    ).toMatchObject({ year: null, batchSeq: null, revision: 1 })
  } finally {
    db.$client.exec('DROP TRIGGER fail671')
  }
  expect((await f.post('commit', payload)).body.counts.updated).toBe(1)
})
it('requires public auth and browser origin plus explicit write capability, without taking actor from the page', async () => {
  const f = sample()
  expect((await f.post('preflight', f.request, {})).status).toBe(401)
  const business = { idempotencyKey: 'browser-test', basis: '浏览器核实附件1' }
  expect((await f.post('browser-preflight', business, {})).status).toBe(403)
  expect(
    (
      await f.post('browser-preflight', business, {
        origin: 'https://foreign.invalid',
      })
    ).status,
  ).toBe(403)
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  expect((await f.post('browser-preflight', f.request, { origin })).status).toBe(400)
  expect((await f.post('browser-preflight', business, { origin })).status).toBe(200)
  vi.stubGlobal('useRuntimeConfig', () => ({
    apiToken: 'test671',
    filesDir: dir,
    browserReviewEnabled: false,
  }))
  expect((await f.post('browser-preflight', business, { origin })).status).toBe(403)
  vi.stubGlobal('useRuntimeConfig', () => ({
    apiToken: 'test671',
    filesDir: dir,
    browserReviewEnabled: true,
  }))
})
it('retains a fresh unknown-year fixture for manual browser and workbook acceptance when requested', () => {
  const f = sample()
  console.log(
    'BROWSER_671=' +
      JSON.stringify({
        dir,
        fileId: f.file.id,
        eventId: f.event.id,
        enterpriseId: f.enterprise.id,
      }),
  )
})
it('rejects 3001 source members explicitly instead of truncating the plan', async () => {
  const f = sample()
  const insert = db.$client.prepare(
    'insert into record_evidence(record_event_id,source_file,page,attachment) values (?,?,1,?)',
  )
  db.$client.transaction(() => {
    for (let n = 0; n < 3000; n++) insert.run(f.event.id, f.file.relPath, `附件${n}`)
  })()
  expect((await f.post('preflight')).status).toBe(413)
})
it('fills only the missing batch without overwriting known year or formal validity statement pages', async () => {
  const f = sample(2025),
    fact = {
      evidenceId: f.evidence.id,
      sourceSha256: sha256,
      statementPages: [1],
      interval: { validFrom: '2025-01-01', validThrough: '2027-12-31' },
    }
  db.update(schema.recordEvent)
    .set({ formalValidity: fact, decidedYear: 2025 })
    .where(eq(schema.recordEvent.id, f.event.id))
    .run()
  const plan = await f.post('preflight')
  expect(plan.body.rows[0]).toMatchObject({
    before: { year: 2025, batchSeq: null },
    after: { year: 2025, batchSeq: 2 },
  })
  expect(
    (
      await f.post('commit', {
        request: f.request,
        planHash: plan.body.planHash,
        chunk: 0,
      })
    ).status,
  ).toBe(200)
  expect(
    db.select().from(schema.recordEvent).where(eq(schema.recordEvent.id, f.event.id)).get(),
  ).toMatchObject({
    year: 2025,
    batchSeq: 2,
    decidedYear: 2025,
    formalValidity: fact,
  })
})
