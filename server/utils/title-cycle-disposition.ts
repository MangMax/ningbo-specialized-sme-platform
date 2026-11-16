import { createHash, randomUUID } from 'node:crypto';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import * as s from '../../db/schema';
import { eq } from 'drizzle-orm';
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
}).refine(f => f.kind === 'formal_failure' ? !!f.formalEvent : !f.formalEvent, 'Formal failure must reference its existing owner');
export type DispositionFact = z.infer<typeof dispositionFactSchema>;
type Fact = DispositionFact;
const target = { id: text, revision: positive };
export const dispositionRequestSchema = z.strictObject({
    idempotencyKey: text, expectedVersion: text, actor: z.strictObject({ type: z.enum(['user', 'agent']), id: text }), basis: text,
    operations: z.array(z.discriminatedUnion('action', [
        z.strictObject({ action: z.literal('assert'), enterpriseId: positive, fact: dispositionFactSchema }),
        z.strictObject({ action: z.literal('replace'), ...target, fact: dispositionFactSchema }),
        z.strictObject({ action: z.literal('confirm'), ...target }), z.strictObject({ action: z.literal('withdraw'), ...target }),
    ])).min(1).max(100),
});
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class DispositionError extends Error {
    readonly statusCode = 409;
    constructor(readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new DispositionError(code); };
type Row = {
    revisionId: number;
    id: string;
    revision: number;
    enterpriseId: number;
    titleCode: 'little_giant';
    cycleEventId: number | null;
    status: 'pending' | 'confirmed' | 'replaced' | 'withdrawn';
    kind: Fact['kind'];
    fact: Fact;
    audit: unknown;
};
function rows(db: Db, enterpriseIds?: number[], currentOnly = false): Row[] {
    if (enterpriseIds)
        z.array(positive).max(500).parse(enterpriseIds);
    if (enterpriseIds?.length === 0)
        return [];
    const clauses: string[] = [];
    if (enterpriseIds)
        clauses.push(`enterprise_id IN (${enterpriseIds.map(() => '?').join(',')})`);
    if (currentOnly)
        clauses.push('NOT EXISTS (SELECT 1 FROM title_cycle_disposition_revision newer WHERE newer.id=outer_row.id AND newer.revision>outer_row.revision)');
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    return (db.$client.prepare(`SELECT revision_id revisionId,id,revision,enterprise_id enterpriseId,title_code titleCode,cycle_event_id cycleEventId,status,kind,fact,audit FROM title_cycle_disposition_revision outer_row${where} ORDER BY revision_id`).all(...enterpriseIds ?? []) as (Omit<Row, 'fact' | 'audit'> & {
        fact: string;
        audit: string;
    })[]).map(r => ({ ...r, fact: JSON.parse(r.fact), audit: JSON.parse(r.audit) }));
}
function head(db: Db) { return hash(db.$client.prepare('SELECT max(revision_id) n FROM title_cycle_disposition_revision').get()); }
function dependencies(db: Db, enterpriseId: number, f: Fact) {
    const enterprise = db.select().from(s.enterprise).where(eq(s.enterprise.id, enterpriseId)).get();
    if (!enterprise)
        fail('enterprise_not_found');
    const file = db.select().from(s.storedFile).where(eq(s.storedFile.id, f.source.fileId)).get();
    if (!file || file.sha256 !== f.source.sha256 || file.removedAt)
        fail('source_conflict');
    const event = (ref: {
        eventId: number;
        revision: number;
    }, kind: 'award' | 'review') => {
        const e = db.select().from(s.recordEvent).where(eq(s.recordEvent.id, ref.eventId)).get();
        const r = e && db.select().from(s.record).where(eq(s.record.id, e.recordId)).get();
        if (!e || e.revision !== ref.revision || e.eventType !== kind || r?.enterpriseId !== enterpriseId || r.titleCode !== 'little_giant' || (kind === 'review' && e.reviewOutcome !== 'failed'))
            fail('cycle_conflict');
        const evidence = db.select().from(s.recordEvidence).where(eq(s.recordEvidence.recordEventId, e!.id)).all();
        return { e, r, evidence };
    };
    const cycle = f.cycle ? event(f.cycle, 'award') : null, formal = f.formalEvent ? event(f.formalEvent, 'review') : null;
    if (formal && (!cycle || formal.e!.formalValidity?.originAwardEventId !== cycle.e!.id))
        fail('cycle_conflict');
    return { enterprise, file, cycle, formal };
}
export function historyDispositions(db: Db, enterpriseIds: number[]) { return db.$client.transaction(() => rows(db, enterpriseIds))(); }
export function currentDispositions(db: Db, enterpriseIds: number[]) {
    return db.$client.transaction(() => ({ version: head(db), rows: rows(db, enterpriseIds, true).map(r => {
            let sourceCurrent = true;
            try {
                dependencies(db, r.enterpriseId, r.fact);
            }
            catch {
                sourceCurrent = false;
            }
            return { ...r, sourceCurrent, effectReady: r.status === 'confirmed' && r.kind !== 'formal_failure' && sourceCurrent && !!r.fact.cycle && r.fact.effective.precision === 'day' && !!r.fact.effectiveBasis };
        }) }))();
}
function commandEnterprises(db: Db, request: z.infer<typeof dispositionRequestSchema>) {
    return [...new Set(request.operations.map(op => {
        if ('enterpriseId' in op) return op.enterpriseId;
        const row = db.$client.prepare('SELECT enterprise_id enterpriseId FROM title_cycle_disposition_revision WHERE id=? ORDER BY revision DESC LIMIT 1').get(op.id) as { enterpriseId: number } | undefined;
        if (!row) fail('revision_conflict');
        return row!.enterpriseId;
    }))];
}
function prepare(db: Db, body: unknown) {
    const request = dispositionRequestSchema.parse(body), requestHash = hash(request);
    const prior = db.$client.prepare('SELECT request_hash hash,receipt FROM title_cycle_disposition_receipt WHERE key=?').get(request.idempotencyKey) as {
        hash: string;
        receipt: string;
    } | undefined;
    if (prior && prior.hash !== requestHash)
        fail('idempotency_conflict');
    if (prior)
        return { request, requestHash, prior, planHash: hash({ requestHash }) };
    if (head(db) !== request.expectedVersion)
        fail('version_conflict');
    const current = rows(db, commandEnterprises(db, request), true);
    const deps: unknown[] = [];
    for (const op of request.operations) {
        const old = 'id' in op ? current.find(r => r.id === op.id) : undefined;
        if ('id' in op && (!old || old.revision !== op.revision || ['replaced', 'withdrawn'].includes(old.status)))
            fail('revision_conflict');
        if (op.action === 'confirm' && old?.status !== 'pending')
            fail('revision_conflict');
        const fact = 'fact' in op ? op.fact : old!.fact;
        if (op.action !== 'withdraw')
            deps.push(dependencies(db, 'enterpriseId' in op ? op.enterpriseId : old!.enterpriseId, fact));
    }
    return { request, requestHash, prior, planHash: hash({ requestHash, deps }) };
}
export function preflightDisposition(db: Db, body: unknown) { return db.$client.transaction(() => { const p = prepare(db, body); return { planHash: p.planHash, replay: !!p.prior }; })(); }
export function commitDisposition(db: Db, body: unknown) {
    const input = z.strictObject({ request: dispositionRequestSchema, planHash: text }).parse(body);
    return db.$client.transaction(() => {
        const p = prepare(db, input.request);
        // Receipt replay precedes dependency revalidation: immutable successful command response.
        if (p.prior)
            return JSON.parse(p.prior.receipt) as {
                ids: string[];
                version: string;
                committedAt: string;
            };
        if (p.planHash !== input.planHash)
            fail('plan_conflict');
        const ids: string[] = [], committedAt = new Date().toISOString();
        const append = (r: Omit<Row, 'revisionId'>) => db.$client.prepare('INSERT INTO title_cycle_disposition_revision(id,revision,enterprise_id,title_code,cycle_event_id,status,kind,source_file_id,source_sha256,cycle_revision,effective_precision,effective_value,fact,audit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(r.id, r.revision, r.enterpriseId, r.titleCode, r.cycleEventId, r.status, r.kind, r.fact.source.fileId, r.fact.source.sha256, r.fact.cycle?.revision ?? null, r.fact.effective.precision, r.fact.effective.value, JSON.stringify(r.fact), JSON.stringify(r.audit));
        for (const op of p.request.operations) {
            const current = rows(db, commandEnterprises(db, p.request), true), old = 'id' in op ? current.find(r => r.id === op.id) : undefined;
            if ('id' in op && (!old || old.revision !== op.revision || ['replaced', 'withdrawn'].includes(old.status)))
                fail('revision_conflict');
            const audit = { actor: p.request.actor, basis: p.request.basis, action: op.action, committedAt, replaces: op.action === 'replace' ? old!.id : null };
            if (op.action === 'assert' || op.action === 'replace') {
                if (old)
                    append({ ...old, revision: old.revision + 1, status: 'replaced', audit });
                const id = randomUUID(), fact = op.fact;
                append({ id, revision: 1, enterpriseId: op.action === 'assert' ? op.enterpriseId : old!.enterpriseId, titleCode: 'little_giant', cycleEventId: fact.cycle?.eventId ?? null, status: 'pending', kind: fact.kind, fact, audit });
                ids.push(id);
            }
            else {
                if (op.action === 'confirm' && current.some(r => r.id !== old!.id && r.enterpriseId === old!.enterpriseId && r.cycleEventId === old!.cycleEventId && r.status === 'confirmed' && r.kind !== old!.kind))
                    fail('contradiction');
                append({ ...old!, revision: old!.revision + 1, status: op.action === 'confirm' ? 'confirmed' : 'withdrawn', audit });
                ids.push(old!.id);
            }
        }
        const receipt = { ids, version: head(db), committedAt };
        db.$client.prepare('INSERT INTO title_cycle_disposition_receipt VALUES(?,?,?)').run(p.request.idempotencyKey, p.requestHash, JSON.stringify(receipt));
        return receipt;
    }).immediate();
}
