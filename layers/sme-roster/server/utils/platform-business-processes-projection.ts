import { platformNormalizationConflict, type PlatformNormalizationConflict } from '../../lib/platform/normalization'
import { withArchiveProcessFacts, type PlatformObservationFact } from '../../lib/platform/observation-facts'
import type { platformBusinessProjection } from '../../../../db/postgresql/platform-tables'

type Projection = typeof platformBusinessProjection.$inferSelect
type Source = Omit<Projection, 'storedStatus' | 'reconciledStatus'> & {
  storedStatus: string | Buffer | null
  reconciledStatus: string | Buffer | null
}

const comparisonFields = ['province', 'status', 'batch', 'declareKind', 'appliedAt', 'awardBatchLabel', 'year'] as const;

const modeledFields = ['declareKind', 'year', 'appliedAt', 'status', 'batch', 'awardBatchLabel', 'province', 'nameRaw', 'usccRaw'] as const;

export function projectBusinessProcessObservationFact(row: {
    relationId: number; source: Source;
    version: Projection | null;
    originalName: string | null; originalUscc: string | null;
}): PlatformObservationFact {
    const source = row.source, version = row.version, typed = version?.versionId != null;
    const normalized = { province: source.reconciledProvince, status: source.reconciledStatus, batch: source.reconciledBatch, declareKind: source.reconciledDeclareKind, appliedAt: source.reconciledAppliedAt, awardBatchLabel: source.reconciledAwardBatchLabel, year: source.reconciledYear };
    const comparisons = {
        province: [source.provinceConflict, source.storedProvince, source.parsedProvince], status: [source.statusConflict, source.storedStatus, source.parsedStatus], batch: [source.batchConflict, source.storedBatch, source.parsedBatch],
        declareKind: [source.declareKindConflict, source.storedDeclareKind, source.parsedDeclareKind], appliedAt: [source.appliedAtConflict, source.storedAppliedAt, source.parsedAppliedAt], awardBatchLabel: [source.awardBatchLabelConflict, source.storedAwardBatchLabel, source.parsedAwardBatchLabel], year: [source.yearConflict, source.storedYear, source.parsedYear],
    } satisfies Record<typeof comparisonFields[number], [
        number | null,
        string | number | Buffer | null,
        string | number | null
    ]>;
    const conflicts: PlatformNormalizationConflict[] = comparisonFields.flatMap(field => {
        const [conflict, storedValue, rawValue] = comparisons[field];
        return conflict && storedValue != null && rawValue != null ? [platformNormalizationConflict(field, storedValue, rawValue)] : [];
    });
    const rawName = typeof row.originalName === 'string' ? row.originalName : null, rawUscc = typeof row.originalUscc === 'string' ? row.originalUscc : null;
    return withArchiveProcessFacts({
        relationId: row.relationId, interface: 'business_list',
        nameRaw: typed ? version.nameRaw : rawName, usccRaw: typed ? version.usccRaw : rawUscc, titleRaw: source.sqlFactTitle,
        validityDateRaw: null, maintenanceYear: null, maintenanceBatch: null, district: null, awardNote: null, normalizationConflicts: conflicts,
        projectionVersionId: typed ? version.versionId : null, projectionRuleVersion: typed ? version.ruleVersion : null, modeledFields: typed ? modeledFields : [],
        declareKind: typed ? version.declareKind : normalized.declareKind, year: typed ? version.businessYear : normalized.year, appliedAt: typed ? version.appliedAt : normalized.appliedAt, status: typed ? version.status : normalized.status,
        batch: typed ? version.batch : normalized.batch, awardBatchLabel: typed ? version.awardBatchLabel : normalized.awardBatchLabel, province: typed ? version.province : normalized.province,
    }, normalized);
}
