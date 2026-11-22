import type { OfficialEventRow, RosterRecordRow } from './roster-event-version-model'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { enterprise as EnterpriseTable } from '../../../../db/postgresql/enterprise-tables'
import type { storedFile as StoredFileTable } from '../../../../db/postgresql/file-tables'
import type { recordEvidence as RecordEvidenceTable } from '../../../../db/postgresql/ledger-tables'
import type { DispositionFact as Fact } from '../../../../db/title-cycle-disposition'
import type { titleCycleDispositionRevision } from '../../../../db/postgresql/qualification-tables'

export const positive = z.number().int().positive();

export const text = z.string().min(1).max(4000);

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

export type DispositionRow = Omit<typeof titleCycleDispositionRevision.$inferSelect, 'fact' | 'audit'> & { fact: Fact; audit: unknown };

export type DispositionRequest = z.infer<typeof dispositionRequestSchema>;

export type DispositionSources = {
    enterprise(id: number): typeof EnterpriseTable.$inferSelect | undefined
    file(id: number): Pick<typeof StoredFileTable.$inferSelect, 'sha256' | 'removedAt'> | undefined
    event(id: number): OfficialEventRow | undefined
    record(id: number): RosterRecordRow | undefined
    evidence(eventId: number): Array<typeof RecordEvidenceTable.$inferSelect>
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

export function projectCurrentDispositions(version: string, rows: DispositionRow[], resolve: (id: number, fact: Fact) => unknown) {
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

export function simulateDispositions(existing: DispositionRow[], request: DispositionRequest,
    resolve: (id: number, fact: Fact) => unknown, committedAt: string) {
    const current = new Map(existing.map(r => [r.id, r]))
    const appended: Omit<DispositionRow, 'revisionId'>[] = [], ids: string[] = [], deps: unknown[] = [];
    const append = (r: Omit<DispositionRow, 'revisionId'>) => {
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
