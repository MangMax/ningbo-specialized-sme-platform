import { expect, it } from 'vitest'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise as enterpriseTable } from '../../../db/postgresql/enterprise-tables'
import { storedFile } from '../../../db/postgresql/file-tables'
import { record as recordTable, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { dispositionRequestSchema } from '../../../layers/sme-roster/server/utils/title-cycle-disposition-model'
import {
  commitPostgresDisposition, preflightPostgresDisposition, readPostgresDispositions,
} from '../../../layers/sme-roster/server/utils/title-cycle-disposition-postgres'
import { singlePostgresFixtureRow, useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'

const openCase = useIsolatedPostgresCases()
const preflightDisposition = (db: NodePgDatabase, request: unknown) => preflightPostgresDisposition(db, dispositionRequestSchema.parse(request))
const commitDisposition = (db: NodePgDatabase, body: { request: unknown; planHash: string }) =>
  commitPostgresDisposition(db, dispositionRequestSchema.parse(body.request), body.planHash)
const historyDispositions = async (db: NodePgDatabase, ids: number[]) => (await readPostgresDispositions(db, ids, false)).rows

async function fixture() {
    const db = openCase()
    const enterprise = singlePostgresFixtureRow(await db.insert(enterpriseTable).values({ name: '合成企业', nameNorm: '合成企业' }).returning());
    const record = singlePostgresFixtureRow(await db.insert(recordTable).values({ enterpriseId: enterprise.id, titleCode: 'little_giant', source: 'jxj' }).returning());
    const event = singlePostgresFixtureRow(await db.insert(recordEvent).values({ recordId: record.id, eventType: 'award', year: 2021 }).returning());
    const file = singlePostgresFixtureRow(await db.insert(storedFile).values({ relPath: 'synthetic.pdf', filename: 'synthetic.pdf', ext: 'pdf', bytes: 1n, sha256: 'a'.repeat(64), createdAt: '2026-01-01' }).returning());
    const fact = { kind: 'not_applied', source: { fileId: file.id, sha256: file.sha256, reference: 'page 1', statement: '未申请' }, cycle: { eventId: event.id, revision: 1 }, observed: { precision: 'day', value: '2024-01-01' }, effective: { precision: 'unknown', value: null }, effectiveBasis: null };
    const read = () => readPostgresDispositions(db, [enterprise.id], true);
    const request = async (operations: unknown[], key: string) => ({ idempotencyKey: key, expectedVersion: (await read() as { version: string }).version, actor: { type: 'agent', id: 'test' }, basis: 'synthetic evidence', operations });
    const commit = async (r: unknown) => commitDisposition(db, { request: r, planHash: (await preflightDisposition(db, r)).planHash });
    return { db, enterprise, event, file, fact, read, request, commit };
}
it('retains pending, confirmed, replacement and withdrawal history without reviving old assertions', async () => {
    const f = await fixture();
    const a = await f.commit(await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }], 'a'));
    expect((await f.read()).rows).toMatchObject([{ status: 'pending', revision: 1, fact: { effective: { precision: 'unknown', value: null } } }]);
    await f.commit(await f.request([{ action: 'confirm', id: a.ids[0], revision: 1 }], 'b'));
    expect((await f.read()).rows).toMatchObject([{ status: 'confirmed', revision: 2, effectReady: false }]);
    await f.commit(await f.request([{ action: 'replace', id: a.ids[0], revision: 2, fact: { ...f.fact, kind: 'not_recommended' } }], 'c'));
    expect((await f.read()).rows.map(r => r.status)).toEqual(['replaced', 'pending']);
    await f.commit(await f.request([{ action: 'withdraw', id: (await f.read()).rows[1]!.id, revision: 1 }], 'd'));
    expect((await f.read()).rows.map(r => r.status)).toEqual(['replaced', 'withdrawn']);
    expect((await historyDispositions(f.db, [f.enterprise.id])).map(r => [r.revision, r.status])).toEqual([[1, 'pending'], [2, 'confirmed'], [3, 'replaced'], [1, 'pending'], [2, 'withdrawn']]);
    await expect(async () => f.commit(await f.request([{ action: 'confirm', id: a.ids[0], revision: 3 }], 'revive'))).rejects.toThrow(/revision_conflict/);
});
it('replays receipts and rejects changed payload, stale head and changed source with zero partial writes', async () => {
    const f = await fixture(), r = await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }], 'a');
    const plan = await preflightDisposition(f.db, r), receipt = await commitDisposition(f.db, { request: r, planHash: plan.planHash });
    expect(await commitDisposition(f.db, { request: r, planHash: plan.planHash })).toEqual(receipt);
    await expect(async () => preflightDisposition(f.db, { ...r, basis: 'changed' })).rejects.toThrow(/idempotency_conflict/);
    const next = await f.request([{ action: 'confirm', id: receipt.ids[0], revision: 1 }], 'b'), p = await preflightDisposition(f.db, next);
    await f.db.update(storedFile).set({ sha256: 'b'.repeat(64) });
    await expect(async () => commitDisposition(f.db, { request: next, planHash: p.planHash })).rejects.toThrow(/source_conflict/);
    expect((await f.read()).rows[0]).toMatchObject({status:'pending',sourceCurrent:false,effectReady:false});
    await expect(async () => f.commit({ ...next, expectedVersion: 'stale' })).rejects.toThrow(/version_conflict/);
});
it('rolls back a batch when a later command contradicts a confirmed assertion', async () => {
    const f = await fixture();
    const a = await f.commit(await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }], 'a'));
    await f.commit(await f.request([{ action: 'confirm', id: a.ids[0], revision: 1 }], 'b'));
    const b = await f.commit(await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, kind: 'not_recommended' } }], 'c'));
    const before = await f.read();
    await expect(async () => f.commit(await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, cycle: null } }, { action: 'confirm', id: b.ids[0], revision: 1 }], 'd'))).rejects.toThrow();
    expect(await f.read()).toEqual(before);
    await expect(async () => f.commit(await f.request([{ action: 'confirm', id: b.ids[0], revision: 1 }], 'e'))).rejects.toThrow(/contradiction/);
});
it('pins cycle versions, preserves coarse dates and isolates a new award cycle', async () => {
    const f = await fixture();
    const unknown = await f.commit(await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, cycle: null, effective: { precision: 'year', value: '2024' } } }], 'unknown'));
    await f.commit(await f.request([{ action: 'confirm', id: unknown.ids[0], revision: 1 }], 'confirm-unknown'));
    expect((await f.read()).rows[0]).toMatchObject({ effectReady: false, fact: { cycle: null, effective: { precision: 'year', value: '2024' } } });
    const r = await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }], 'pin'), p = await preflightDisposition(f.db, r);
    await f.db.update(recordEvent).set({ revision: 2 });
    await expect(async () => commitDisposition(f.db, { request: r, planHash: p.planHash })).rejects.toThrow(/cycle_conflict/);
    expect((await f.read()).rows).toHaveLength(1);
    const newCycle = singlePostgresFixtureRow(await f.db.insert(recordEvent).values({ recordId: f.event.recordId, eventType: 'award', year: 2025 }).returning());
    const a = await f.commit(await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, cycle: { eventId: newCycle.id, revision: 1 }, effective: { precision: 'day', value: '2028-01-01' }, effectiveBasis: 'explicit source date' } }], 'new'));
    await f.commit(await f.request([{ action: 'confirm', id: a.ids[0], revision: 1 }], 'confirm-new'));
    expect((await f.read()).rows[1]).toMatchObject({ cycleEventId: newCycle.id, effectReady: true, fact: { effective: { value: '2028-01-01' } } });
});
it('refuses fabricated formal failure and keeps the original formal event as owner', async () => {
    const f = await fixture();
    await expect(async () => f.commit(await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, kind: 'formal_failure' } }], 'fake'))).rejects.toThrow();
    const evidence = singlePostgresFixtureRow(await f.db.insert(recordEvidence).values({
      recordEventId: f.event.id, sourceFile: f.file.relPath, page: 1,
    }).returning());
    const failure = singlePostgresFixtureRow(await f.db.insert(recordEvent).values({ recordId: f.event.recordId, eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'failed', formalValidity: JSON.stringify({ originAwardEventId: f.event.id, evidenceId: evidence.id, sourceSha256: 'a'.repeat(64), statementPages: [1], continuation: 'until_this_review_results' }) }).returning());
    const a = await f.commit(await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, kind: 'formal_failure', formalEvent: { eventId: failure.id, revision: 1 } } }], 'formal'));
    await f.commit(await f.request([{ action: 'confirm', id: a.ids[0], revision: 1 }], 'confirm'));
    expect((await f.read()).rows[0]).toMatchObject({ kind: 'formal_failure', effectReady: false, fact: { formalEvent: { eventId: failure.id, revision: 1 } } });

});

it('rejects a stale head and a mismatched plan without recording new history', async () => {
 const f=await fixture(), stale=await f.request([{action:'assert',enterpriseId:f.enterprise.id,fact:f.fact}],'stale');
 const plan=await preflightDisposition(f.db,stale);
 await f.commit(await f.request([{action:'assert',enterpriseId:f.enterprise.id,fact:{...f.fact,cycle:null}}],'other'));
 const before=await historyDispositions(f.db,[f.enterprise.id]);
 await expect(async () => commitDisposition(f.db,{request:stale,planHash:plan.planHash})).rejects.toThrow(/version_conflict/);
 const current=await f.request([{action:'assert',enterpriseId:f.enterprise.id,fact:f.fact}],'mismatch');
 await expect(async () => commitDisposition(f.db,{request:current,planHash:'wrong'})).rejects.toThrow(/plan_conflict/);
 expect(await historyDispositions(f.db,[f.enterprise.id])).toEqual(before);
});
it('rejects contradictory confirmation at preflight and commit without changing public history', async () => {
    const f = await fixture();
    const a = await f.commit(await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }], 'a'));
    await f.commit(await f.request([{ action: 'confirm', id: a.ids[0], revision: 1 }], 'b'));
    const b = await f.commit(await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, kind: 'not_recommended' } }], 'c'));
    const before = await historyDispositions(f.db, [f.enterprise.id]);
    const request = await f.request([{ action: 'confirm', id: b.ids[0], revision: 1 }], 'contradict');
    await expect(async () => preflightDisposition(f.db, request)).rejects.toThrow(/contradiction/);
    await expect(async () => commitDisposition(f.db, { request, planHash: 'unusable' })).rejects.toThrow(/contradiction/);
    expect(await historyDispositions(f.db, [f.enterprise.id])).toEqual(before);
});
it('simulates ordered confirmation and withdrawal in one batch and replays its receipt', async () => {
    const f = await fixture();
    const a = await f.commit(await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }], 'a'));
    const request = await f.request([{ action: 'confirm', id: a.ids[0], revision: 1 }, { action: 'withdraw', id: a.ids[0], revision: 2 }], 'batch');
    const plan = await preflightDisposition(f.db, request);
    const receipt = await commitDisposition(f.db, { request, planHash: plan.planHash });
    expect((await f.read()).rows).toMatchObject([{ id: a.ids[0], revision: 3, status: 'withdrawn' }]);
    expect((await historyDispositions(f.db, [f.enterprise.id])).map(r => r.status)).toEqual(['pending', 'confirmed', 'withdrawn']);
    expect(await commitDisposition(f.db, { request, planHash: plan.planHash })).toEqual(receipt);
});
it('rejects two contradictory pending confirmations in the same preflight batch', async () => {
    const f = await fixture();
    const a = await f.commit(await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }, { action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, kind: 'not_recommended' } }], 'a'));
    const request = await f.request(a.ids.map(id => ({ action: 'confirm', id, revision: 1 })), 'batch');
    const before = await f.read();
    await expect(async () => preflightDisposition(f.db, request)).rejects.toThrow(/contradiction/);
    await expect(async () => commitDisposition(f.db, { request, planHash: 'unused' })).rejects.toThrow(/contradiction/);
    expect(await f.read()).toEqual(before);
});
it('rolls back revisions when receipt persistence fails and allows the unchanged plan to retry', async () => {
    const f = await fixture();
    const request = await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }], 'retry');
    const plan = await preflightDisposition(f.db, request), before = await f.read();
    // Fail receipt persistence after revision insertion to exercise transaction rollback.
    await f.db.$client.query(`
      CREATE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'receipt unavailable'; END;
      $$;
      CREATE TRIGGER reject_receipt BEFORE INSERT ON title_cycle_disposition_receipt
      FOR EACH ROW EXECUTE FUNCTION reject_receipt();
    `);
    await expect(async () => commitDisposition(f.db, { request, planHash: plan.planHash })).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'receipt unavailable' }) });
    expect(await f.read()).toEqual(before);
    expect(await historyDispositions(f.db, [f.enterprise.id])).toEqual([]);
    await f.db.$client.query('DROP TRIGGER reject_receipt ON title_cycle_disposition_receipt');
    const receipt = await commitDisposition(f.db, { request, planHash: plan.planHash });
    expect((await f.read()).rows).toMatchObject([{ id: receipt.ids[0], status: 'pending', revision: 1 }]);
    expect(await commitDisposition(f.db, { request, planHash: plan.planHash })).toEqual(receipt);
});

it('rejects a platform snapshot award as a formal disposition cycle without writes', async () => {
    const f = await fixture();
    const record = singlePostgresFixtureRow(await f.db.insert(recordTable).values({ enterpriseId: f.enterprise.id, titleCode: 'little_giant', source: 'miit' }).returning());
    const event = singlePostgresFixtureRow(await f.db.insert(recordEvent).values({ recordId: record.id, eventType: 'award', year: 2021 }).returning());
    const before = await f.read();
    const request = await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: { ...f.fact, cycle: { eventId: event.id, revision: 1 } } }], 'platform-cycle');
    await expect(async () => preflightDisposition(f.db, request)).rejects.toThrow(/cycle_conflict/);
    expect(await f.read()).toEqual(before);
});

it('propagates unexpected dependency read errors instead of reporting stale sources', async () => {
    const f = await fixture()
    await f.commit(await f.request([{ action: 'assert', enterpriseId: f.enterprise.id, fact: f.fact }], 'a'))
    await f.db.$client.query('ALTER TABLE stored_file RENAME TO unavailable_stored_file')
    await expect(f.read()).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42P01' }) })
})
