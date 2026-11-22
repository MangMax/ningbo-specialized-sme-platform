type DispositionPoint = { precision: 'unknown'; value: null }
    | { precision: 'year' | 'month' | 'day'; value: string };
type EventRevision = { eventId: number; revision: number };

/** Facts persisted with a title cycle disposition revision. */
export interface DispositionFact {
    kind: 'not_applied' | 'not_recommended' | 'formal_failure';
    source: { fileId: number; sha256: string; reference: string; statement: string };
    cycle: EventRevision | null;
    formalEvent?: EventRevision;
    observed: DispositionPoint;
    effective: DispositionPoint;
    effectiveBasis: string | null;
}
