import { createClassifiedFile } from '../../../server/utils/roster-file-classification'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { initializeDb, schema } from '../../../db/client'
import { handleComparisonScopeProofRequest } from '../../../server/utils/comparison-scope-proof-api'

const dirs: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'spec63-proof-'))
  dirs.push(dir)
  const db = initializeDb({ create: true,  dbPath: join(dir, 'synthetic.db') })
  const file = createClassifiedFile(db, { relPath: 'synthetic/notice.pdf', filename: 'notice.pdf', ext: 'pdf', bytes: 8, sha256: 'a'.repeat(64) }, { source: 'jxj', kind: 'announcement' })
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Synthetic notice', path: file.relPath }).returning().get()
  const enterprise = db.insert(schema.enterprise).values({ name: 'Synthetic', nameNorm: 'Synthetic', usccNorm: '91330211255994475A' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: 3, listNo: 2 }).run()
  return { db, file, doc, enterprise, event }
}
afterAll(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))
const auth = { authorization: 'Bearer synthetic-token' }
function request(input: ReturnType<typeof fixture>, action: 'preflight' | 'commit' | 'list' | 'get' | 'audit' | 'batch', body?: unknown, id?: number) {
  return handleComparisonScopeProofRequest({ action, method: ['preflight', 'commit'].includes(action) ? 'POST' : 'GET', body, id, headers: auth }, { db: input.db, apiToken: 'synthetic-token' })
}
function official(input: ReturnType<typeof fixture>) { return { idempotencyKey: 'proof-one', sourceIdentity: 'synthetic/notice.pdf', actor: { type: 'agent', id: 'test-agent' }, basis: 'Reviewed full synthetic 2024 announcement and its scoped roster', ruleId: 'manual-scope', ruleVersion: '1', operations: [{ action: 'create', kind: 'official_coverage', status: 'confirmed', evidence: { titleCode: 'specialized_sme', fromYear: 2024, throughYear: 2024, enterpriseIds: null, fullRange: true, sourceDocuments: [{ id: input.doc.id, fileId: input.file.id, sha256: input.file.sha256, reference: { field: 'record_evidence.source_file', page: 3, listNo: 2 } }] } }] } }

describe('comparison scope proof service', () => {
  it('registers confirmed official scope with immutable audit and idempotent receipt', () => {
    const input = fixture(); const req = official(input)
    const plan = request(input, 'preflight', req).body as any
    expect(plan).toMatchObject({ batchStatus: 'preflight', impact: { created: 1, audit: 2 } })
    const receipt = request(input, 'commit', { request: req, planHash: plan.planHash }).body as any
    expect(receipt.proofIds).toHaveLength(1)
    expect(request(input, 'commit', { request: req, planHash: plan.planHash }).body).toEqual(receipt)
    const proof = request(input, 'get', undefined, receipt.proofIds[0]).body as any
    expect(proof).toMatchObject({ id: receipt.proofIds[0], kind: 'official_coverage', status: 'confirmed', revision: 2, valid: true })
    expect((request(input, 'audit', undefined, proof.id).body as any).rows.map((row: any) => row.toStatus)).toEqual(['candidate', 'confirmed'])
  })
})

describe('comparison scope proof source and decision boundaries', () => {
  it('rejects unauthenticated writes, missing basis, and mismatched official file hashes', () => {
    const input = fixture(); const req = official(input)
    const noToken = handleComparisonScopeProofRequest({ action: 'preflight', method: 'POST', body: req }, { db: input.db, apiToken: 'synthetic-token' })
    expect(noToken).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } })
    expect(request(input, 'preflight', { ...req, basis: '' })).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } })
    const wrong = structuredClone(req) as any
    wrong.operations[0].evidence.sourceDocuments[0].sha256 = 'b'.repeat(64)
    expect(request(input, 'preflight', wrong)).toMatchObject({ status: 422, body: { error: { code: 'source_mismatch' } } })
    expect((request(input, 'list').body as any).total).toBe(0)
  })

  it('keeps stale plan atomic, then confirms and revokes a candidate with append-only audit', () => {
    const input = fixture(); const candidate = structuredClone(official(input)) as any
    candidate.operations[0].status = 'candidate'
    const first = request(input, 'preflight', candidate).body as any
    input.db.update(schema.storedFile).set({ sha256: 'b'.repeat(64) }).run()
    expect(request(input, 'commit', { request: candidate, planHash: first.planHash })).toMatchObject({ status: 422, body: { error: { code: 'source_mismatch' } } })
    expect((request(input, 'list').body as any).total).toBe(0)
    input.db.update(schema.storedFile).set({ sha256: input.file.sha256 }).run()
    const second = request(input, 'preflight', candidate).body as any
    const receipt = request(input, 'commit', { request: candidate, planHash: second.planHash }).body as any
    const proofId = receipt.proofIds[0]
    expect((request(input, 'get', undefined, proofId).body as any).status).toBe('candidate')
    const confirm = { ...candidate, idempotencyKey: 'proof-confirm', operations: [{ action: 'decide', proofId, expectedRevision: 1, status: 'confirmed' }] }
    const confirmedPlan = request(input, 'preflight', confirm).body as any
    expect(request(input, 'commit', { request: confirm, planHash: confirmedPlan.planHash }).status).toBe(200)
    expect((request(input, 'get', undefined, proofId).body as any)).toMatchObject({ status: 'confirmed', revision: 2, valid: true })
    expect(request(input, 'preflight', confirm)).toMatchObject({ status: 200, body: { batchStatus: 'committed' } })
    const revoke = { ...candidate, idempotencyKey: 'proof-revoke', operations: [{ action: 'decide', proofId, expectedRevision: 2, status: 'revoked' }] }
    const revokedPlan = request(input, 'preflight', revoke).body as any
    expect(request(input, 'commit', { request: revoke, planHash: revokedPlan.planHash }).status).toBe(200)
    expect((request(input, 'get', undefined, proofId).body as any)).toMatchObject({ status: 'revoked', revision: 3, valid: false })
    expect((request(input, 'audit', undefined, proofId).body as any).rows.map((row: any) => row.toStatus)).toEqual(['candidate', 'confirmed', 'revoked'])
  })

  it('invalidates an old confirmed scope after official source row drift without deleting audit', () => {
    const input = fixture(); const req = official(input)
    const plan = request(input, 'preflight', req).body as any
    const receipt = request(input, 'commit', { request: req, planHash: plan.planHash }).body as any
    const proofId = receipt.proofIds[0]
    input.db.update(schema.recordEvidence).set({ page: 4 }).run()
    expect((request(input, 'get', undefined, proofId).body as any)).toMatchObject({ status: 'confirmed', valid: false, invalidReason: 'source_drift_or_missing' })
    expect((request(input, 'audit', undefined, proofId).body as any).total).toBe(2)
    const revoke = { ...req, idempotencyKey: 'drift-revoke', operations: [{ action: 'decide', proofId, expectedRevision: 2, status: 'revoked' }] }
    const revokePlan = request(input, 'preflight', revoke).body as any
    expect(request(input, 'commit', { request: revoke, planHash: revokePlan.planHash }).status).toBe(200)
    expect((request(input, 'audit', undefined, proofId).body as any).rows.map((row: any) => row.toStatus)).toEqual(['candidate', 'confirmed', 'revoked'])
  })

  it('rejects same idempotency key with changed request and credential echoes before persistence', () => {
    const input = fixture(); const req = official(input)
    expect(request(input, 'preflight', req).status).toBe(200)
    expect(request(input, 'preflight', { ...req, basis: 'different archived basis' })).toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } })
    expect(request(input, 'preflight', { ...req, idempotencyKey: 'secret-test', basis: 'Cookie: synthetic-secret' })).toMatchObject({ status: 400, body: { error: { code: 'credential_in_evidence' } } })
  })
})
