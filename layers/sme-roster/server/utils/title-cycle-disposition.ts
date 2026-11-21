import { createHash, randomUUID } from 'node:crypto';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import * as s from '../../../../db/schema';
import type { DispositionFact as Fact } from '../../../../db/title-cycle-disposition';
import { and, desc, eq, gt, inArray, max, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
type Db = BetterSQLite3Database<typeof s>;
const positive = z.number().int().positive();
const text = z.string().min(1).max(4000);
const point = z.discriminatedUnion('precision', [
    z.strictObject({ precision: z.literal('unknown'), value: z.null() }),
    z.strictObject({ precision: z.literal('year'), value: z.string().regex(/^\d{4}$/) }),
    z.strictObject({ precision: z.literal('month'), value: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
    z.strictObject({ precision: z.literal('day'), value: z.iso.date() }),
]);
export const dispositionFactSchema = z.strictObject({
    kind: z.enum(['not_applied', 'not_recommended', 'formal_failure']),
    source: z.strictObject({ fileId: positive, sha256: z.string().regex(/^[a-f0-9]{64}$/), reference: text, statement: text }),
    cycle: z.strictObject({ eventId: positive, revision: positive }).nullable(),
    formalEvent: z.strictObject({ eventId: positive, revision: positive }).optional(),
    observed: point, effective: point, effectiveBasis: text.nullable(),
}).refine(f => f.kind === 'formal_failure' ? !!f.formalEvent : !f.formalEvent, 'Formal failure must reference its existing owner') satisfies z.ZodType<Fact>;
const target = { id: text, revision: positive };
export const dispositionRequestSchema = z.strictObject({
    idempotencyKey: text, expectedVersion: text, actor: z.strictObject({ type: z.enum(['user', 'agent']), id: text }), basis: text,
    operations: z.array(z.discriminatedUnion('action', [
        z.strictObject({ action: z.literal('assert'), enterpriseId: positive, fact: dispositionFactSchema }),
        z.strictObject({ action: z.literal('replace'), ...target, fact: dispositionFactSchema }),
        z.strictObject({ action: z.literal('confirm'), ...target }), z.strictObject({ action: z.literal('withdraw'), ...target }),
    ])).min(1).max(100),
});
export const dispositionHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class DispositionError extends Error {
    readonly statusCode = 409;
    constructor(readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new DispositionError(code); };
const revisionTable = s.titleCycleDispositionRevision;
export type DispositionRow = typeof revisionTable.$inferSelect;
type Row = DispositionRow;
export type DispositionRequest = z.infer<typeof dispositionRequestSchema>;
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
export type DispositionSources = {
    enterprise(id: number): typeof s.enterprise.$inferSelect | undefined
    file(id: number): typeof s.storedFile.$inferSelect | undefined
    event(id: number): typeof s.recordEvent.$inferSelect | undefined
    record(id: number): typeof s.record.$inferSelect | undefined
    evidence(eventId: number): Array<typeof s.recordEvidence.$inferSelect>
}

export function dispositionDependencies(source: DispositionSources, enterpriseId: number, f: Fact) {
    const enterprise = source.enterprise(enterpriseId)
    if (!enterprise) fail('enterprise_not_found')
    const file = source.file(f.source.fileId)
    if (!file || file.sha256 !== f.source.sha256 || file.removedAt) fail('source_conflict')
    const event = (ref: { eventId: number; revision: number }, kind: 'award' | 'review') => {
        const e = source.event(ref.eventId)
        const r = e && source.record(e.recordId)
        if (!e || e.revision !== ref.revision || e.eventType !== kind || r?.enterpriseId !== enterpriseId ||
            r.titleCode !== 'little_giant' || r.source !== 'jxj' || (kind === 'review' && e.reviewOutcome !== 'failed')) fail('cycle_conflict')
        return { e, r, evidence: source.evidence(e!.id) }
    }
    const cycle = f.cycle ? event(f.cycle, 'award') : null
    const formal = f.formalEvent ? event(f.formalEvent, 'review') : null
    if (formal && (!cycle || formal.e!.formalValidity?.originAwardEventId !== cycle.e!.id)) fail('cycle_conflict')
    return { enterprise, file, cycle, formal }
}

function dependencies(db: Db, enterpriseId: number, fact: Fact) {
    return dispositionDependencies({
        enterprise: id => db.select().from(s.enterprise).where(eq(s.enterprise.id, id)).get(),
        file: id => db.select().from(s.storedFile).where(eq(s.storedFile.id, id)).get(),
        event: id => db.select().from(s.recordEvent).where(eq(s.recordEvent.id, id)).get(),
        record: id => db.select().from(s.record).where(eq(s.record.id, id)).get(),
        evidence: id => db.select().from(s.recordEvidence).where(eq(s.recordEvidence.recordEventId, id)).all(),
    }, enterpriseId, fact)
}

export function projectCurrentDispositions(version: string, rows: Row[], resolve: (id: number, fact: Fact) => unknown) {
    return {
        version, rows: rows.map(row => {
            let sourceCurrent = true
            try { resolve(row.enterpriseId, row.fact) } catch (error) {
                if (!(error instanceof DispositionError)) throw error
                sourceCurrent = false
            }
            const effectReady = row.status === 'confirmed' && row.kind !== 'formal_failure' && sourceCurrent &&
                !!row.fact.cycle && row.fact.effective.precision === 'day' && !!row.fact.effectiveBasis
            return { ...row, sourceCurrent, effectReady }
        }),
    }
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

export function simulateDispositions(existing: Row[], request: DispositionRequest,
    resolve: (id: number, fact: Fact) => unknown, committedAt: string) {
    const current = new Map(existing.map(r => [r.id, r]))
    const appended: Omit<Row, 'revisionId'>[] = [], ids: string[] = [], deps: unknown[] = [];
    const append = (r: Omit<Row, 'revisionId'>) => {
        const { revisionId: _revisionId, ...value } = { ...r, revisionId: 0 };
        appended.push(value);
        current.set(r.id, { ...r, revisionId: 0 });
    };
    for (const op of request.operations) {
        const old = 'id' in op ? current.get(op.id) : undefined;
        if ('id' in op && (!old || old.revision !== op.revision || ['replaced', 'withdrawn'].includes(old.status))) fail('revision_conflict');
        if (op.action === 'confirm' && old?.status !== 'pending') fail('revision_conflict');
        const fact = 'fact' in op ? op.fact : old!.fact;
        const enterpriseId = 'enterpriseId' in op ? op.enterpriseId : old!.enterpriseId;
        if (op.action !== 'withdraw') deps.push(resolve(enterpriseId, fact));
        const audit = { actor: request.actor, basis: request.basis, action: op.action, committedAt, replaces: op.action === 'replace' ? old!.id : null };
        if (op.action === 'assert' || op.action === 'replace') {
            if (old) append({ ...old, revision: old.revision + 1, status: 'replaced', audit });
            const id = randomUUID();
            append({ id, revision: 1, enterpriseId, titleCode: 'little_giant', cycleEventId: fact.cycle?.eventId ?? null, status: 'pending', kind: fact.kind, fact, audit,
                sourceFileId: fact.source.fileId, sourceSha256: fact.source.sha256, cycleRevision: fact.cycle?.revision ?? null,
                effectivePrecision: fact.effective.precision, effectiveValue: fact.effective.value });
            ids.push(id);
        } else {
            if (op.action === 'confirm' && [...current.values()].some(r => r.id !== old!.id && r.enterpriseId === enterpriseId && r.cycleEventId === old!.cycleEventId && r.status === 'confirmed' && r.kind !== old!.kind)) fail('contradiction');
            append({ ...old!, revision: old!.revision + 1, status: op.action === 'confirm' ? 'confirmed' : 'withdrawn', audit });
            ids.push(old!.id);
        }
    }
    return { deps, appended, ids };
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
