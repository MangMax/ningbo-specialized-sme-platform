import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, toNodeListener, defineEventHandler } from 'h3'
import { eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { storedFile } from '../../../db/postgresql/file-tables'
import { importBatch } from '../../../db/postgresql/import-tables'
import { record, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { eventCorrectionAudit, officialEvidenceRowRevision } from '../../../db/postgresql/official-evidence-tables'
import { fileDeclaration669, rosterFileClassification } from '../../../db/postgresql/roster-file-tables'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

const dir = mkdtempSync('/tmp/sync671-')
let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>>
let db: ReturnType<typeof usePostgresDirectoryDb>
const pdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
)
const sha256 = createHash('sha256').update(pdf).digest('hex')
const recordedAt = '2025-01-01T00:00:00Z'
let server: ReturnType<typeof createServer>
beforeAll(async () => {
  runtime = await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', runtime.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  db = usePostgresDirectoryDb()
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('useRuntimeConfig', () => ({
    apiToken: 'test671',
    filesDir: dir,
  }))
  const { fileEventSyncRoute } = await import('../../../layers/sme-roster/server/utils/file-event-sync-route')
  const app = createApp(),
    router = createRouter()
  for (const action of ['preflight', 'commit'] as const) {
    router.post(`/api/files/:id/event-sync/${action}`, fileEventSyncRoute(action))
    router.post(`/api/files/:id/event-sync/browser-${action}`, fileEventSyncRoute(action, true))
  }
  app.use(router)
  server = createServer(toNodeListener(app))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
}, 30_000)
afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()))
  try { await closePostgresDirectoryDb(); runtime?.close() }
  finally { rmSync(dir, { recursive: true, force: true }) }
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
it('preflights and atomically fills only unknown formal coordinates over public HTTP, preserving IDs and replay', async () => {
  const { file, enterprise: owner, record: ledger, event, evidence, post } = await sample()
  const [sourceBatch] = await db.insert(importBatch).values({
    idempotencyKey: 'raw-history-671',
    sourceKind: 'announcement',
    sourceIdentity: file.relPath,
    createdAt: recordedAt,
  }).returning()
  const [originalPublishedRow] = await db.insert(officialEvidenceRowRevision).values({
    evidenceId: evidence.id,
    revision: 1,
    eventId: event.id,
    capturedRecordId: ledger.id,
    capturedEnterpriseId: owner.id,
    nameRaw: '历史公布原名',
    usccRaw: '原文未知',
    districtRaw: '原始属地写法',
    path: file.relPath,
    attachment: '附件1',
    page: 1,
    sourceBindingKnown: 0,
    actor: JSON.stringify({ type: 'agent', id: 'original-import' }),
    basis: '原公布行字面值',
    commandKind: 'import',
    importBatchId: sourceBatch!.id,
    createdAt: recordedAt,
  }).returning()
  const request = {
    idempotencyKey: 'sync-1',
    actor: { type: 'agent', id: 'test' },
    basis: '核实附件1物理页1',
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
  expect((await db.select().from(recordEvent).where(eq(recordEvent.id, event.id)))[0]).toMatchObject({
    id: event.id,
    year: 2025,
    batchSeq: 2,
    revision: 2,
  })
  expect((await db.select().from(recordEvidence).where(eq(recordEvidence.id, evidence.id)))[0]).toEqual(evidence)
  expect(await db.select().from(officialEvidenceRowRevision).where(eq(officialEvidenceRowRevision.evidenceId, evidence.id))).toEqual([originalPublishedRow])
  expect(await db.select().from(eventCorrectionAudit).where(eq(eventCorrectionAudit.eventId, event.id))).toHaveLength(1)
})

it('replays each completed chunk as its original immutable receipt after later chunks', async () => {
  const { event: unchanged, file, post } = await sample(2025, 2)
  // 101 independently owned events force two genuinely bounded transactions.
  const more = await db.transaction(async tx => {
    const owners = await tx.insert(enterprise).values(
      Array.from({ length: 101 }, (_, n) => ({ name: `分块${n}`, nameNorm: `分块${n}` })),
    ).returning()
    const records = await tx.insert(record).values(owners.map<typeof record.$inferInsert>(owner => ({
      enterpriseId: owner.id,
      titleCode: 'specialized_sme',
      source: 'jxj',
      nameRaw: owner.name,
    }))).returning()
    const events = await tx.insert(recordEvent).values(
      records.map<typeof recordEvent.$inferInsert>(ledger => ({ recordId: ledger.id, eventType: 'award' })),
    ).returning()
    await tx.insert(recordEvidence).values(events.map(event => ({
      recordEventId: event.id,
      sourceFile: file.relPath,
      page: 1,
      attachment: '附件1',
    })))
    return events
  })
  const request = {
    idempotencyKey: 'run',
    actor: { type: 'agent', id: 'test' },
    basis: '核实完整分段',
  }
  // A valid public plan must not reserve the first internal correction key.
  const sibling = { ...request, idempotencyKey: 'run:0' }
  expect((await post('preflight', sibling)).status).toBe(200)
  const plan = await post('preflight', request)
  expect(plan.status).toBe(200)
  expect(plan.body.chunks).toBe(2)
  const first = { request, planHash: plan.body.planHash, chunk: 0 }
  const receipt = await post('commit', first)
  expect(receipt.status).toBe(200)
  expect(receipt.body.counts).toMatchObject({ updated: 100, unexecuted: 1 })
  await rejectCorrectionAudit()
  try {
    expect((await post('commit', { ...first, chunk: 1 })).status).toBe(500)
    expect((await post('commit', first)).body.counts).toMatchObject({
      updated: 100,
      unexecuted: 1,
    })
  } finally {
    await allowCorrectionAudit()
  }
  const last = await post('commit', { ...first, chunk: 1 })
  expect(last.body.counts).toMatchObject({ updated: 101, unexecuted: 0 })
  expect(last.status).toBe(200)
  expect(await post('commit', first)).toEqual(receipt)
  expect(await post('commit', { ...first, chunk: 1 })).toEqual(last)
  expect((await post('preflight', request)).body.completed).toEqual([0, 1])
  const audits = await db.select().from(eventCorrectionAudit)
    .where(inArray(eventCorrectionAudit.eventId, [unchanged.id, ...more.map(row => row.id)]))
  expect(audits).toHaveLength(101)
  expect(new Set(audits.map(row => row.eventId))).toEqual(new Set(more.map(row => row.id)))
})

let seq = 0
async function sample(year: number | null = null, batchSeq: number | null = null) {
  const tag = ++seq,
    path = `sample-${tag}.pdf`
  writeFileSync(`${dir}/${path}`, pdf)
  const s = statSync(`${dir}/${path}`, { bigint: true }),
    epoch = [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(':')
  const [file] = await db.insert(storedFile).values({
    relPath: path, filename: path, ext: 'pdf', bytes: BigInt(pdf.length), sha256, createdAt: recordedAt,
  }).returning()
  await db.insert(rosterFileClassification).values({ fileId: file!.id })
  const [owner] = await db.insert(enterprise).values({ name: `反例${tag}`, nameNorm: `反例${tag}` }).returning()
  const [ledger] = await db.insert(record).values({
    enterpriseId: owner!.id, titleCode: 'specialized_sme', source: 'jxj', nameRaw: owner!.name,
  }).returning()
  const [event] = await db.insert(recordEvent).values({
    recordId: ledger!.id, eventType: 'award', year, batchSeq,
  }).returning()
  const [evidence] = await db.insert(recordEvidence).values({
    recordEventId: event!.id, sourceFile: path, page: 1, attachment: '附件1',
  }).returning()
  const part = {
    titleCode: 'specialized_sme', eventKind: 'award', year: 2025, batch: 2, attachment: '附件1', rowCount: 1,
  }
  const [declaration] = await db.insert(fileDeclaration669).values({
    declarationId: randomUUID(),
    fileId: file!.id,
    revision: 1,
    active: 1,
    sha256,
    contentVersion: epoch,
    part: JSON.stringify(part),
    pageRanges: JSON.stringify([{ start: 1, end: 1 }]),
  }).returning()
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
    const r = await fetch(`${base}/api/files/${file!.id}/event-sync/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
    })
    return { status: r.status, body: await r.json() }
  }
  return {
    file: file!,
    event: event!,
    record: ledger!,
    enterprise: owner!,
    evidence: evidence!,
    declaration: declaration!,
    part,
    request,
    post,
  }
}
async function rejectCorrectionAudit() {
  await db.execute(sql`
    CREATE FUNCTION business.reject_test_correction_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic correction audit failure'; END; $$;
    CREATE TRIGGER reject_test_correction_audit BEFORE INSERT ON business.event_correction_audit
    FOR EACH ROW EXECUTE FUNCTION business.reject_test_correction_audit();
  `)
}

async function allowCorrectionAudit() {
  await db.execute(sql`
    DROP TRIGGER reject_test_correction_audit ON business.event_correction_audit;
    DROP FUNCTION business.reject_test_correction_audit();
  `)
}

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
  const f = await sample(
    kind === 'known' ? 2022 : kind === 'same' ? 2025 : null,
    kind === 'same' ? 2 : null,
  )
  if (kind === 'ambiguous')
    await db.insert(fileDeclaration669)
      .values({
        ...f.declaration,
        declarationId: randomUUID(),
        part: JSON.stringify({ ...f.part, year: 2022 }),
      })
  if (kind === 'missing-page')
    await db.update(recordEvidence)
      .set({ page: null })
      .where(eq(recordEvidence.id, f.evidence.id))
  if (kind === 'multi-source')
    await db.insert(recordEvidence)
      .values({
        recordEventId: f.event.id,
        sourceFile: 'elsewhere.pdf',
        page: 1,
        attachment: '附件1',
      })
  if (kind === 'contradictory-sources') {
    await db.insert(fileDeclaration669)
      .values({
        ...f.declaration,
        declarationId: randomUUID(),
        part: JSON.stringify({ ...f.part, year: 2022, attachment: '附件2' }),
      })
    await db.insert(recordEvidence)
      .values({
        recordEventId: f.event.id,
        sourceFile: f.file.relPath,
        page: 1,
        attachment: '附件2',
      })
  }
  if (kind === 'coordinate')
    await db.insert(recordEvent)
      .values({
        recordId: f.record.id,
        eventType: 'award',
        year: 2025,
        batchSeq: 2,
      })
  if (kind === 'unknown-segment')
    await db.update(fileDeclaration669)
      .set({ part: JSON.stringify({ ...f.part, year: null, batch: null }) })
      .where(eq(fileDeclaration669.declarationId, f.declaration.declarationId))
  if (kind === 'other-title')
    await db.update(record)
      .set({ titleCode: 'innovative_sme' })
      .where(eq(record.id, f.record.id))
  if (kind === 'origin') {
    const [origin] = await db
      .insert(recordEvent)
      .values({ recordId: f.record.id, eventType: 'award', year: 2022 })
      .returning()
    await db.update(recordEvent)
      .set({
        eventType: 'review',
        formalValidity: JSON.stringify({
          evidenceId: f.evidence.id,
          sourceSha256: sha256,
          statementPages: [1],
          originAwardEventId: origin!.id,
          continuation: 'until_this_review_results',
        }),
      })
      .where(eq(recordEvent.id, f.event.id))
    await db.update(fileDeclaration669)
      .set({ part: JSON.stringify({ ...f.part, eventKind: 'review' }) })
      .where(eq(fileDeclaration669.declarationId, f.declaration.declarationId))
  }
  const plan = await f.post('preflight')
  expect(plan.status).toBe(200)
  const expected = kind === 'same' || kind === 'unknown-segment' ? 'unchanged' : 'conflict'
  expect(plan.body.rows).toMatchObject([{ eventId: f.event.id, status: expected }])
  expect(plan.body.chunks).toBe(0)
  expect(
    await db
      .select()
      .from(eventCorrectionAudit)
      .where(eq(eventCorrectionAudit.eventId, f.event.id)),
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
  const f = await sample(),
    plan = await f.post('preflight')
  expect(plan.status).toBe(200)
  if (kind === 'new-member') {
    const [e] = await db
      .insert(recordEvent)
      .values({ recordId: f.record.id, eventType: 'review' })
      .returning()
    await db.insert(recordEvidence)
      .values({ recordEventId: e!.id, sourceFile: f.file.relPath, page: 1 })
  }
  if (kind === 'removed-member')
    await db.delete(recordEvidence).where(eq(recordEvidence.id, f.evidence.id))
  if (kind === 'new-source')
    await db.insert(recordEvidence)
      .values({ recordEventId: f.event.id, sourceFile: 'other.pdf', page: 1 })
  if (kind === 'revision')
    await db.update(recordEvent)
      .set({ revision: 2 })
      .where(eq(recordEvent.id, f.event.id))
  if (kind === 'declaration')
    await db.update(fileDeclaration669)
      .set({ revision: 2 })
      .where(eq(fileDeclaration669.declarationId, f.declaration.declarationId))
  if (kind === 'source-sha')
    await db.update(storedFile)
      .set({ sha256: '0'.repeat(64) })
      .where(eq(storedFile.id, f.file.id))
  if (kind === 'coordinate-added')
    await db.insert(recordEvent)
      .values({
        recordId: f.record.id,
        eventType: 'award',
        year: 2025,
        batchSeq: 2,
      })
  const committed = await f.post('commit', {
    request: f.request,
    planHash: plan.body.planHash,
    chunk: 0,
  })
  expect(committed.status).toBe(409)
  expect(
    await db
      .select()
      .from(eventCorrectionAudit)
      .where(eq(eventCorrectionAudit.eventId, f.event.id)),
  ).toHaveLength(0)
})
it('rolls back a whole chunk on a storage failure and safely resumes the same request', async () => {
  const f = await sample(),
    plan = await f.post('preflight')
  expect(plan.status).toBe(200)
  const payload = {
    request: f.request,
    planHash: plan.body.planHash,
    chunk: 0,
  }
  await rejectCorrectionAudit()
  try {
    expect((await f.post('commit', payload)).status).toBe(500)
    expect((await f.post('preflight')).body.counts).toMatchObject({ failed: 1, unexecuted: 0 })
    expect(
      (await db.select().from(recordEvent).where(eq(recordEvent.id, f.event.id)))[0],
    ).toMatchObject({ year: null, batchSeq: null, revision: 1 })
  } finally {
    await allowCorrectionAudit()
  }
  expect((await f.post('commit', payload)).body.counts.updated).toBe(1)
})
it('requires public auth and browser origin plus explicit write capability, without taking actor from the page', async () => {
  const f = await sample()
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

})
it('rejects 3001 source members explicitly instead of truncating the plan', async () => {
  const f = await sample()
  const additional = await db.insert(recordEvent)
    .values(Array.from({ length: 10 }, (): typeof recordEvent.$inferInsert => ({ recordId: f.record.id, eventType: 'award' })))
    .returning({ id: recordEvent.id })
  const events = [f.event, ...additional]
  await db.insert(recordEvidence).values(Array.from({ length: 3000 }, (_, n) => ({
    recordEventId: events[n % events.length]!.id,
    sourceFile: f.file.relPath,
    page: 1,
    attachment: `附件${n}`,
  })))
  expect(await f.post('preflight')).toMatchObject({
    status: 413,
    body: { error: { code: 'capacity' } },
  })
})
it('fills only the missing batch without overwriting known year or formal validity statement pages', async () => {
  const f = await sample(2025),
    fact = {
      evidenceId: f.evidence.id,
      sourceSha256: sha256,
      statementPages: [1],
      interval: { validFrom: '2025-01-01', validThrough: '2027-12-31' },
    }
  await db.update(recordEvent)
    .set({ formalValidity: JSON.stringify(fact), decidedYear: 2025 })
    .where(eq(recordEvent.id, f.event.id))
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
    (await db.select().from(recordEvent).where(eq(recordEvent.id, f.event.id)))[0],
  ).toMatchObject({
    year: 2025,
    batchSeq: 2,
    decidedYear: 2025,
    formalValidity: JSON.stringify(fact),
  })
})

it.each([
  { label: 'plain', key: 'run' },
  { label: 'one suffix', key: 'run:0' },
  { label: 'multiple separators', key: 'a:b:0' },
  { label: 'Unicode with slash', key: '中文/任意:0' },
  { label: 'maximum length', key: 'x'.repeat(120) },
])(
  'accepts a $label public key after a correction without namespace aliasing',
  async ({ key }) => {
    const f = await sample()
    const request = { ...f.request, idempotencyKey: key }
    const plan = await f.post('preflight', request)
    expect(plan.status).toBe(200)
    const commit = { request, planHash: plan.body.planHash, chunk: 0 }
    const receipt = await f.post('commit', commit)
    expect(receipt.status).toBe(200)
    expect(receipt.body.counts).toMatchObject({ updated: 1, unexecuted: 0 })
    // Reverse ordering: create the suffix public plan after the internal chunk exists.
    const suffix = { ...request, idempotencyKey: key.length < 119 ? `${key}:0` : `${key.slice(0, 118)}:0` }
    const later = await f.post('preflight', suffix)
    expect(later.status).toBe(200)
    expect(later.body.counts).toMatchObject({ updated: 0, unchanged: 1 })
    expect(await f.post('commit', commit)).toEqual(receipt)
    expect(await f.post('preflight', suffix)).toEqual(later)
    expect((await f.post('preflight', { ...request, basis: 'different' })).status).toBe(409)
    expect(await db.select().from(eventCorrectionAudit).where(eq(eventCorrectionAudit.eventId, f.event.id))).toHaveLength(1)
  },
)
