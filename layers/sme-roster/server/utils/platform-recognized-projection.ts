import { platformNormalizationConflict } from '../../lib/platform/normalization'
import type { PlatformNormalizationConflict } from '../../lib/platform/normalization'
import { legacyRowTitle, withArchiveProcessFacts, type PlatformObservationFact } from '../../lib/platform/observation-facts'
import type { storedRecognizedProjection as p } from '../../lib/platform/recognized-stored-schema'

export function projectRecognizedObservationFact(row: {
    relationId: number; source: typeof p.$inferSelect;
    version: typeof p.$inferSelect | null;
    originalName: string | null; originalUscc: string | null;
}): PlatformObservationFact {
    const source = row.source, version = row.version, typed = version?.versionId != null;
    const normalized = { province: source.reconciledProvince, status: source.reconciledStatus, batch: source.reconciledBatch, declareKind: source.reconciledDeclareKind, appliedAt: source.reconciledAppliedAt, awardBatchLabel: source.reconciledAwardBatchLabel, year: source.reconciledYear };
    const comparisons = {
        province: [source.provinceConflict, source.storedProvince, source.parsedProvince], status: [source.statusConflict, source.storedStatus, source.parsedStatus], batch: [source.batchConflict, source.storedBatch, source.parsedBatch],
        declareKind: [source.declareKindConflict, source.storedDeclareKind, source.parsedDeclareKind], appliedAt: [source.appliedAtConflict, source.storedAppliedAt, source.parsedAppliedAt], awardBatchLabel: [source.awardBatchLabelConflict, source.storedAwardBatchLabel, source.parsedAwardBatchLabel], year: [source.yearConflict, source.storedYear, source.parsedYear],
    } satisfies Record<keyof typeof normalized, [number | null, string | number | null, string | number | null]>;
    const conflicts: PlatformNormalizationConflict[] = (['province', 'status', 'batch', 'declareKind', 'appliedAt', 'awardBatchLabel', 'year'] as const).flatMap(field => {
        const [conflict, storedValue, rawValue] = comparisons[field];
        return conflict && storedValue != null && rawValue != null ? [platformNormalizationConflict(field, storedValue, rawValue)] : [];
    });
    const title = source.sourceTitleKind === 'text' ? legacyRowTitle({ rdjb: source.sourceTitleText }) : null;
    return withArchiveProcessFacts({
        relationId: row.relationId, interface: 'recognized_list', projectionVersionId: typed ? version.versionId : null, projectionRuleVersion: typed ? version.ruleVersion : null,
        modeledFields: typed ? ['validityDateRaw', 'maintenanceYear', 'maintenanceBatch', 'district', 'awardNote', 'titleRaw', 'nameRaw', 'usccRaw'] : [],
        ...normalized, titleRaw: typed ? version.titleRaw ?? title : title,
        nameRaw: typed ? version.nameRaw : row.originalName, usccRaw: typed ? version.usccRaw : row.originalUscc,
        validityDateRaw: typed ? version.validityDateRaw : null, maintenanceYear: typed ? version.maintenanceYear : null,
        maintenanceBatch: typed ? version.maintenanceBatch : null, district: typed ? version.district : null, awardNote: typed ? version.awardNote : null,
        normalizationConflicts: conflicts,
    }, normalized);
}
