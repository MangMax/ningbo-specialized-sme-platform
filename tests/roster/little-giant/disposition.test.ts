import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDb } from '../../../db/client';
import * as s from '../../../db/schema';
import { currentDispositions, historyDispositions, preflightDisposition, commitDisposition } from '../../../server/utils/title-cycle-disposition';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(f => f()));
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'disposition-'));
    const db = initializeDb({ create: true, dbPath: join(dir, 'db') });
    cleanup.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }); });
    const enterprise = db.insert(s.enterprise).values({ name: '合成企业', nameNorm: '合成企业' }).returning().get();
    const record = db.insert(s.record).values({ enterpriseId: enterprise.id, titleCode: 'little_giant', source: 'jxj' }).returning().get();
    const event = db.insert(s.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2021 }).returning().get();
    const file = db.insert(s.storedFile).values({ relPath: 'synthetic.pdf', filename: 'synthetic.pdf', ext: 'pdf', bytes: 1, sha256: 'a'.repeat(64), createdAt: '2026-01-01' }).returning().get();
    const fact = { kind: 'not_applied', source: { fileId: file.id, sha256: file.sha256, reference: 'page 1', statement: '未申请' }, cycle: { eventId: event.id, revision: 1 }, observed: { precision: 'day', value: '2024-01-01' }, effective: { precision: 'unknown', value: null }, effectiveBasis: null };
    const read = () => currentDispositions(db, [enterprise.id]);
    const request = (operations: unknown[], key: string) => ({ idempotencyKey: key, expectedVersion: read().version, actor: { type: 'agent', id: 'test' }, basis: 'synthetic evidence', operations });
    const commit = (r: unknown) => commitDisposition(db, { request: r, planHash: preflightDisposition(db, r).planHash });
    return { db, enterprise, event, file, fact, read, request, commit };
}
it('retains pending, confirmed, replacement and withdrawal history without reviving old assertions', () => {
    const f = fixture();
    const a = f.commit(f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }], 'a'));
    expect(f.read().rows).toMatchObject([{ status: 'pending', revision: 1, fact: { effective: { precision: 'unknown', value: null } } }]);
    f.commit(f.request([{ action: 'confirm', id: a.ids[0], revision: 1 }], 'b'));
    expect(f.read().rows).toMatchObject([{ status: 'confirmed', revision: 2, effectReady: false }]);
    f.commit(f.request([{ action: 'replace', id: a.ids[0], revision: 2, fact: { ...f.fact, kind: 'not_recommended' } }], 'c'));
    expect(f.read().rows.map(r => r.status)).toEqual(['replaced', 'pending']);
    f.commit(f.request([{ action: 'withdraw', id: f.read().rows[1]!.id, revision: 1 }], 'd'));
    expect(f.read().rows.map(r => r.status)).toEqual(['replaced', 'withdrawn']);
    expect(historyDispositions(f.db, [f.enterprise.id]).map(r => [r.revision, r.status])).toEqual([[1, 'pending'], [2, 'confirmed'], [3, 'replaced'], [1, 'pending'], [2, 'withdrawn']]);
    expect(() => f.commit(f.request([{ action: 'confirm', id: a.ids[0], revision: 3 }], 'revive'))).toThrow(/revision_conflict/);
});
it('replays receipts and rejects changed payload, stale head and changed source with zero partial writes', () => {
    const f = fixture(), r = f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }], 'a');
    const plan = preflightDisposition(f.db, r), receipt = commitDisposition(f.db, { request: r, planHash: plan.planHash });
    expect(commitDisposition(f.db, { request: r, planHash: plan.planHash })).toEqual(receipt);
    expect(() => preflightDisposition(f.db, { ...r, basis: 'changed' })).toThrow(/idempotency_conflict/);
    const next = f.request([{ action: 'confirm', id: receipt.ids[0], revision: 1 }], 'b'), p = preflightDisposition(f.db, next);
    f.db.update(s.storedFile).set({ sha256: 'b'.repeat(64) }).run();
    expect(() => commitDisposition(f.db, { request: next, planHash: p.planHash })).toThrow(/source_conflict/);
    expect(f.read().rows[0]).toMatchObject({status:'pending',sourceCurrent:false,effectReady:false});
    expect(() => f.commit({ ...next, expectedVersion: 'stale' })).toThrow(/version_conflict/);
});
it('rolls back a batch when a later command contradicts a confirmed assertion', () => {
    const f = fixture();
    const a = f.commit(f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }], 'a'));
    f.commit(f.request([{ action: 'confirm', id: a.ids[0], revision: 1 }], 'b'));
    const b = f.commit(f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, kind: 'not_recommended' } }], 'c'));
    const before = f.read();
    expect(() => f.commit(f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, cycle: null } }, { action: 'confirm', id: b.ids[0], revision: 1 }], 'd'))).toThrow();
    expect(f.read()).toEqual(before);
    expect(() => f.commit(f.request([{ action: 'confirm', id: b.ids[0], revision: 1 }], 'e'))).toThrow(/contradiction/);
});
it('pins cycle versions, preserves coarse dates and isolates a new award cycle', () => {
    const f = fixture();
    const unknown = f.commit(f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, cycle: null, effective: { precision: 'year', value: '2024' } } }], 'unknown'));
    f.commit(f.request([{ action: 'confirm', id: unknown.ids[0], revision: 1 }], 'confirm-unknown'));
    expect(f.read().rows[0]).toMatchObject({ effectReady: false, fact: { cycle: null, effective: { precision: 'year', value: '2024' } } });
    const r = f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }], 'pin'), p = preflightDisposition(f.db, r);
    f.db.update(s.recordEvent).set({ revision: 2 }).run();
    expect(() => commitDisposition(f.db, { request: r, planHash: p.planHash })).toThrow(/cycle_conflict/);
    expect(f.read().rows).toHaveLength(1);
    const newCycle = f.db.insert(s.recordEvent).values({ recordId: f.event.recordId, eventType: 'award', year: 2025 }).returning().get();
    const a = f.commit(f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, cycle: { eventId: newCycle.id, revision: 1 }, effective: { precision: 'day', value: '2028-01-01' }, effectiveBasis: 'explicit source date' } }], 'new'));
    f.commit(f.request([{ action: 'confirm', id: a.ids[0], revision: 1 }], 'confirm-new'));
    expect(f.read().rows[1]).toMatchObject({ cycleEventId: newCycle.id, effectReady: true, fact: { effective: { value: '2028-01-01' } } });
});
it('refuses fabricated formal failure and keeps the original formal event as owner', () => {
    const f = fixture();
    expect(() => f.commit(f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, kind: 'formal_failure' } }], 'fake'))).toThrow();
    const failure = f.db.insert(s.recordEvent).values({ recordId: f.event.recordId, eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'failed', formalValidity: { originAwardEventId: f.event.id, evidenceId: 1, sourceSha256: 'a'.repeat(64), statementPages: [1], continuation: 'until_this_review_results' } }).returning().get();
    const a = f.commit(f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, kind: 'formal_failure', formalEvent: { eventId: failure.id, revision: 1 } } }], 'formal'));
    f.commit(f.request([{ action: 'confirm', id: a.ids[0], revision: 1 }], 'confirm'));
    expect(f.read().rows[0]).toMatchObject({ kind: 'formal_failure', effectReady: false, fact: { formalEvent: { eventId: failure.id, revision: 1 } } });

});

it('rejects a stale head and a mismatched plan without recording new history', () => {
 const f=fixture(), stale=f.request([{action:'assert',enterpriseId:f.enterprise.id,fact:f.fact}],'stale');
 const plan=preflightDisposition(f.db,stale);
 f.commit(f.request([{action:'assert',enterpriseId:f.enterprise.id,fact:{...f.fact,cycle:null}}],'other'));
 const before=historyDispositions(f.db,[f.enterprise.id]);
 expect(()=>commitDisposition(f.db,{request:stale,planHash:plan.planHash})).toThrow(/version_conflict/);
 const current=f.request([{action:'assert',enterpriseId:f.enterprise.id,fact:f.fact}],'mismatch');
 expect(()=>commitDisposition(f.db,{request:current,planHash:'wrong'})).toThrow(/plan_conflict/);
 expect(historyDispositions(f.db,[f.enterprise.id])).toEqual(before);
});
it('rejects contradictory confirmation at preflight and commit without changing public history', () => {
    const f = fixture();
    const a = f.commit(f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }], 'a'));
    f.commit(f.request([{ action: 'confirm', id: a.ids[0], revision: 1 }], 'b'));
    const b = f.commit(f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, kind: 'not_recommended' } }], 'c'));
    const before = historyDispositions(f.db, [f.enterprise.id]);
    const request = f.request([{ action: 'confirm', id: b.ids[0], revision: 1 }], 'contradict');
    expect(() => preflightDisposition(f.db, request)).toThrow(/contradiction/);
    expect(() => commitDisposition(f.db, { request, planHash: 'unusable' })).toThrow(/contradiction/);
    expect(historyDispositions(f.db, [f.enterprise.id])).toEqual(before);
});
it('simulates ordered confirmation and withdrawal in one batch and replays its receipt', () => {
    const f = fixture();
    const a = f.commit(f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }], 'a'));
    const request = f.request([{ action: 'confirm', id: a.ids[0], revision: 1 }, { action: 'withdraw', id: a.ids[0], revision: 2 }], 'batch');
    const plan = preflightDisposition(f.db, request);
    const receipt = commitDisposition(f.db, { request, planHash: plan.planHash });
    expect(f.read().rows).toMatchObject([{ id: a.ids[0], revision: 3, status: 'withdrawn' }]);
    expect(historyDispositions(f.db, [f.enterprise.id]).map(r => r.status)).toEqual(['pending', 'confirmed', 'withdrawn']);
    expect(commitDisposition(f.db, { request, planHash: plan.planHash })).toEqual(receipt);
});
it('rejects two contradictory pending confirmations in the same preflight batch', () => {
    const f = fixture();
    const a = f.commit(f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }, { action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, kind: 'not_recommended' } }], 'a'));
    const request = f.request(a.ids.map(id => ({ action: 'confirm', id, revision: 1 })), 'batch');
    const before = f.read();
    expect(() => preflightDisposition(f.db, request)).toThrow(/contradiction/);
    expect(() => commitDisposition(f.db, { request, planHash: 'unused' })).toThrow(/contradiction/);
    expect(f.read()).toEqual(before);
});
it('rolls back revisions when receipt persistence fails and allows the unchanged plan to retry', () => {
    const f = fixture();
    const request = f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }], 'retry');
    const plan = preflightDisposition(f.db, request), before = f.read();
    // Infrastructure fault injection after revision inserts, through the real SQLite transaction.
    f.db.$client.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON title_cycle_disposition_receipt BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END");
    expect(() => commitDisposition(f.db, { request, planHash: plan.planHash })).toThrow(/receipt unavailable/);
    expect(f.read()).toEqual(before);
    expect(historyDispositions(f.db, [f.enterprise.id])).toEqual([]);
    f.db.$client.exec('DROP TRIGGER reject_receipt');
    const receipt = commitDisposition(f.db, { request, planHash: plan.planHash });
    expect(f.read().rows).toMatchObject([{ id: receipt.ids[0], status: 'pending', revision: 1 }]);
    expect(commitDisposition(f.db, { request, planHash: plan.planHash })).toEqual(receipt);
});
