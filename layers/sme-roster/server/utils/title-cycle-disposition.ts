import { type Row, positive, dispositionHash, dispositionDependencies, projectCurrentDispositions, dispositionRequestSchema, fail, type DispositionRequest, simulateDispositions, text } from './title-cycle-disposition-model'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as s from '../../../../db/schema'
import type { DispositionFact as Fact } from '../../../../db/title-cycle-disposition'
import { and, desc, eq, gt, inArray, max, notExists } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
type Db = BetterSQLite3Database<typeof s>;
export const revisionTable = s.titleCycleDispositionRevision;
function rows(db: Db, enterpriseIds?: number[], currentOnly = false): Row[] {
    if (enterpriseIds) z.array(positive).max(500).parse(enterpriseIds);
    if (enterpriseIds?.length === 0) return [];
    const newer = alias(revisionTable, 'newer');
    return db.select().from(revisionTable).where(and(
        enterpriseIds ? inArray(revisionTable.enterpriseId, enterpriseIds) : undefined,
        currentOnly ? notExists(db.select().from(newer).where(and(eq(newer.id, revisionTable.id), gt(newer.revision, revisionTable.revision)))) : undefined,
    )).orderBy(revisionTable.revisionId).all();
}
function head(db: Db) { return dispositionHash(db.select({ n: max(revisionTable.revisionId) }).from(revisionTable).get()); }
function dependencies(db: Db, enterpriseId: number, fact: Fact) {
    return dispositionDependencies({
        enterprise: id => db.select().from(s.enterprise).where(eq(s.enterprise.id, id)).get(),
        file: id => db.select().from(s.storedFile).where(eq(s.storedFile.id, id)).get(),
        event: id => db.select().from(s.recordEvent).where(eq(s.recordEvent.id, id)).get(),
        record: id => db.select().from(s.record).where(eq(s.record.id, id)).get(),
        evidence: id => db.select().from(s.recordEvidence).where(eq(s.recordEvidence.recordEventId, id)).all(),
    }, enterpriseId, fact)
}
export function historyDispositions(db: Db, enterpriseIds: number[]) { return db.transaction(() => rows(db, enterpriseIds)); }
export function currentDispositions(db: Db, enterpriseIds: number[]) {
    return db.transaction(() => projectCurrentDispositions(head(db), rows(db, enterpriseIds, true),
        (id, fact) => dependencies(db, id, fact)));
}
function commandEnterprises(db: Db, request: z.infer<typeof dispositionRequestSchema>) {
    return [...new Set(request.operations.map(op => {
        if ('enterpriseId' in op) return op.enterpriseId;
        const row = db.select().from(revisionTable).where(eq(revisionTable.id, op.id)).orderBy(desc(revisionTable.revision)).get();
        if (!row) fail('revision_conflict');
        return row!.enterpriseId;
    }))];
}
/** Ordered lifecycle simulation shared by preflight and transactional commit. */
function simulate(db: Db, request: DispositionRequest, committedAt = '') {
    return simulateDispositions(rows(db, commandEnterprises(db, request), true), request,
        (id, fact) => dependencies(db, id, fact), committedAt)
}
function prepare(db: Db, body: unknown) {
    const request = dispositionRequestSchema.parse(body), requestHash = dispositionHash(request);
    const prior = db.select().from(s.titleCycleDispositionReceipt).where(eq(s.titleCycleDispositionReceipt.key, request.idempotencyKey)).get();
    if (prior && prior.requestHash !== requestHash)
        fail('idempotency_conflict');
    if (prior)
        return { request, requestHash, prior, planHash: dispositionHash({ requestHash }) };
    if (head(db) !== request.expectedVersion)
        fail('version_conflict');
    const { deps } = simulate(db, request);
    return { request, requestHash, prior, planHash: dispositionHash({ requestHash, deps }) };
}
export function preflightDisposition(db: Db, body: unknown) { return db.transaction(() => { const p = prepare(db, body); return { planHash: p.planHash, replay: !!p.prior }; }); }
export function commitDisposition(db: Db, body: unknown) {
    const input = z.strictObject({ request: dispositionRequestSchema, planHash: text }).parse(body);
    return db.transaction(() => {
        const p = prepare(db, input.request);
        // Receipt replay precedes dependency revalidation: immutable successful command response.
        if (p.prior)
            return p.prior.receipt;
        if (p.planHash !== input.planHash)
            fail('plan_conflict');
        const committedAt = new Date().toISOString();
        const { ids, appended } = simulate(db, p.request, committedAt);
        for (const r of appended) db.insert(revisionTable).values(r).run();
        const receipt = { ids, version: head(db), committedAt };
        db.insert(s.titleCycleDispositionReceipt).values({ key: p.request.idempotencyKey, requestHash: p.requestHash, receipt }).run();
        return receipt;
    }, { behavior: 'immediate' });
}
export { dispositionFactSchema, dispositionRequestSchema, dispositionHash, DispositionError, type DispositionRow, type DispositionRequest, type DispositionSources, dispositionDependencies, projectCurrentDispositions, simulateDispositions } from './title-cycle-disposition-model'
