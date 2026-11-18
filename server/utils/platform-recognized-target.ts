import { platformNormalizationConflict } from '../../lib/platform/normalization';
/** Native recognition directory reader. */
import { getTableColumns,and,count,countDistinct,desc,eq,exists,inArray,isNull,max,min,ne,or,sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { alias } from 'drizzle-orm/sqlite-core';
import { groupBy } from 'es-toolkit';
import type * as legacySchema from '../../db/schema';
import { platformBusinessRecord as b,platformCollection as c,enterprise as e,platformLegacyQueryAlias as qa,platformBusinessRecordVersion as v } from '../../db/schema';
import { normalizeName,normalizeUscc } from '../../layers/sme-roster/lib/domain';
import { readObservationCorrespondenceRefs } from '../../lib/platform/correspondence-target';
import type { PlatformFilterOptions } from '../../lib/platform/filter-options';
import type { PlatformNormalizationConflict } from '../../lib/platform/normalization';
import { legacyRowTitle,withArchiveProcessFacts,type PlatformObservationFact } from '../../lib/platform/observation-facts';
import { RECOGNIZED_DIRECTORY_OBSERVATION_LIMIT,RECOGNIZED_DIRECTORY_VERSION_LIMIT,recognizedDirectoryFilterSchema,type RecognizedDirectoryDetail,type RecognizedDirectoryFilter,type RecognizedDirectoryIsolatedRow,type RecognizedDirectoryListResult,type RecognizedDirectoryView } from '../../lib/platform/recognized-directory';
import { recognizedStoredInstalled } from '../../lib/platform/recognized-stored-catalog';
import { storedRecognizedProjection as p } from '../../lib/platform/recognized-stored-schema';
import { sqliteConnection } from '../../lib/platform/target-connection';
import { platformObservationAssignment as a,platformBusinessObservation as o,platformLegacyRelationAlias as ra,platformQueryTitleScope as scope,targetSchema } from '../../lib/platform/target-schema';
import { fail,orderedScopes,pageOf } from './platform-business-read';
type Db = BetterSQLite3Database<typeof targetSchema> | BetterSQLite3Database<typeof legacySchema>;
type TargetIsolatedRow = Omit<RecognizedDirectoryIsolatedRow, 'titleRaw'> & {
    titleRaw: unknown;
};
export type TargetRecognizedListResult = Omit<RecognizedDirectoryListResult, 'rows'> & {
    rows: (Exclude<RecognizedDirectoryListResult['rows'][number], RecognizedDirectoryIsolatedRow> | TargetIsolatedRow)[];
};
export type TargetRecognizedOptions = Omit<PlatformFilterOptions, 'titles'> & {
    titles: unknown[];
};
const previous = alias(a, 'newer_assignment'), original = alias(a, 'original_assignment');
function current(db: Db) { return and(eq(a.observationId, o.id), eq(a.revision, db.select({ revision: max(previous.revision) }).from(previous).where(eq(previous.observationId, o.id)))); }
const isolated = or(ne(o.identityState, 'resolved'), ne(o.contentState, 'verified'), isNull(o.versionId));
function gate(db: Db, selected?: ReturnType<typeof inArray>) {
    if (!recognizedStoredInstalled(sqliteConnection(db)))
        fail(409, 'recognized_target_capture', 'Recognized observations require completed stored-title capture');
    const missing = db.select({ id: o.id }).from(o).innerJoin(c, eq(c.id, o.collectionId)).leftJoin(p, eq(p.observationId, o.id)).leftJoin(a, current(db)).leftJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1))).leftJoin(ra, eq(ra.observationId, o.id)).leftJoin(qa, eq(qa.collectionId, c.id))
        .where(and(selected, eq(c.interface, 'recognized_list'), or(isNull(p.id), isNull(p.exactTitleState), ne(p.exactTitleState, 'captured'), isNull(a.observationId), isNull(original.observationId), isNull(ra.oldId), isNull(qa.oldId)))).limit(1).get();
    if (missing)
        fail(409, 'recognized_target_uncaptured', 'Recognized observation has uncaptured original facts or assignment');
}
function parse(input: unknown) { const r = recognizedDirectoryFilterSchema.safeParse(input); if (!r.success)
    fail(400, 'invalid_recognized_directory_filter', 'Invalid recognized directory query parameters'); return r.data; }
function enterpriseFilter(filter: Pick<RecognizedDirectoryFilter, 'q' | 'enterpriseId'>) { return and(filter.enterpriseId == null ? undefined : eq(a.enterpriseId, filter.enterpriseId), filter.q ? or(sql `${e.nameNorm} like ${`%${normalizeName(filter.q)}%`}`, sql `${e.usccNorm} like ${`%${normalizeUscc(filter.q)}%`}`) : undefined); }
/** Preserve the directory's untrimmed filtering predicate, not its display/conflict predicate. */
function scopeMatch(db: Db, rdjb: string) { return or(sql `instr(',' || ${c.rdjb} || ',', ',' || ${rdjb} || ',') > 0`, exists(db.select({ id: scope.collectionId }).from(scope).where(and(eq(scope.collectionId, c.id), eq(scope.rdjb, rdjb))))); }
function recordFilter(db: Db, f: RecognizedDirectoryFilter) {
    return and(eq(b.interface, 'recognized_list'), f.platformKey ? eq(b.platformKey, f.platformKey) : undefined, f.titleRaw === undefined ? undefined : eq(p.titleRaw, f.titleRaw), f.rddqrq ? eq(p.validityDateRaw, f.rddqrq) : undefined, f.whpcyear == null ? undefined : eq(p.maintenanceYear, f.whpcyear), f.whpc ? eq(p.maintenanceBatch, f.whpc) : undefined, f.szq ? eq(p.district, f.szq) : undefined, f.rdjb ? exists(db.select({ id: o.id }).from(o).innerJoin(c, eq(c.id, o.collectionId)).where(and(eq(o.versionId, v.id), scopeMatch(db, f.rdjb)))) : undefined, f.enterpriseId != null || f.q ? exists(db.select({ id: o.id }).from(o).leftJoin(a, current(db)).leftJoin(e, eq(e.id, a.enterpriseId)).where(and(eq(o.recordId, b.id), enterpriseFilter(f)))) : undefined);
}
function isolatedFilter(db: Db, f: RecognizedDirectoryFilter) { return and(eq(c.interface, 'recognized_list'), isolated, enterpriseFilter(f), f.platformKey ? eq(o.sourceRelationKey, f.platformKey) : undefined, f.titleRaw === undefined ? undefined : eq(p.exactTitleRaw, f.titleRaw), f.rdjb ? scopeMatch(db, f.rdjb) : undefined); }
const versionFields = { versionId: v.id, validityDateRaw: p.validityDateRaw, maintenanceYear: p.maintenanceYear, maintenanceBatch: p.maintenanceBatch, district: p.district, awardNote: p.awardNote, titleRaw: p.titleRaw, nameRaw: p.nameRaw, usccRaw: p.usccRaw, ruleVersion: p.ruleVersion };
const observationFields = { relationId: ra.oldId, queryId: qa.oldId, queriedAt: c.queriedAt, queryKey: c.queryKey, queryStatus: c.status, sequenceNo: o.sequenceNo, enterpriseId: a.enterpriseId, enterpriseName: e.name, identityState: o.identityState, contentState: o.contentState };
function scopesByCollection(db: Db, ids: number[]) {
    if (!ids.length)
        return new Map<number, string[]>();
    const rows = db.select({ id: c.id, rdjb: c.rdjb, indexed: scope.rdjb }).from(c).leftJoin(scope, eq(scope.collectionId, c.id)).where(inArray(c.id, ids)).all();
    const grouped = groupBy(rows, r => String(r.id));
    return new Map(Object.values(grouped).map(rows => [rows[0]!.id, orderedScopes(rows.flatMap(r => [...r.rdjb.split(',').map(t => t.trim()).filter(Boolean), ...(r.indexed ? [r.indexed] : [])]))]));
}
function summaries(db: Db, ids: number[]) {
    const result = new Map<number, {
        enterpriseIds: number[];
        enterpriseNames: string[];
        titleScopes: string[];
        conflicts: string[];
    }>();
    if (!ids.length)
        return result;
    const owners = groupBy(db.selectDistinct({ recordId: o.recordId, enterpriseId: a.enterpriseId, name: e.name }).from(o).leftJoin(a, current(db)).leftJoin(e, eq(e.id, a.enterpriseId)).where(inArray(o.recordId, ids)).orderBy(o.recordId, a.enterpriseId).all(), r => String(r.recordId));
    const queries = db.selectDistinct({ recordId: o.recordId, collectionId: o.collectionId }).from(o).where(inArray(o.recordId, ids)).all();
    const scopes = scopesByCollection(db, [...new Set(queries.map(r => r.collectionId))]);
    const queryGroups = groupBy(queries, r => String(r.recordId));
    const unverifiable = new Set(db.selectDistinct({ id: o.recordId }).from(o).where(and(inArray(o.recordId, ids), eq(o.contentState, 'unverifiable'))).all().map(r => r.id));
    const list = sql `replace(replace(replace(replace(${c.rdjb}, ' ', ''), char(9), ''), char(10), ''), char(13), '')`;
    const conflict = new Set(db.selectDistinct({ id: o.recordId }).from(o).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(p, eq(p.versionId, o.versionId)).where(and(inArray(o.recordId, ids), inArray(p.titleRaw, ['1', '2', '3']), or(sql `replace(${list}, ',', '') <> ''`, exists(db.select({ id: scope.collectionId }).from(scope).where(and(eq(scope.collectionId, c.id), sql `trim(${scope.rdjb}) <> ''`)))), sql `instr(',' || ${list} || ',', ',' || ${p.titleRaw} || ',') = 0`, sql `not ${exists(db.select({ id: scope.collectionId }).from(scope).where(and(eq(scope.collectionId, c.id), eq(scope.rdjb, p.titleRaw))))}`)).all().map(r => r.id));
    for (const id of ids) {
        const assigned = owners[String(id)] ?? [], enterpriseIds = assigned.flatMap(r => r.enterpriseId == null ? [] : [r.enterpriseId]);
        result.set(id, { enterpriseIds, enterpriseNames: assigned.flatMap(r => r.enterpriseId != null && r.name ? [r.name] : []), titleScopes: orderedScopes((queryGroups[String(id)] ?? []).flatMap(r => scopes.get(r.collectionId) ?? [])), conflicts: [...(conflict.has(id) ? ['title_conflict'] : []), ...(unverifiable.has(id) ? ['unverifiable_observation'] : []), ...(enterpriseIds.length > 1 ? ['enterprise_assignment_conflict'] : [])] });
    }
    return result;
}
export function listTargetRecognizedDirectory(input: unknown, db: Db): TargetRecognizedListResult {
    const f = parse(input);
    return db.transaction(tx => {
        gate(tx);
        const { page, pageSize, offset } = pageOf(f);
        if (f.view === 'isolated') {
            if (f.rddqrq != null || f.whpcyear != null || f.whpc != null || f.szq != null)
                return { view: 'isolated', rows: [], total: 0, page, pageSize };
            const where = isolatedFilter(tx, f);
            const total = tx.select({ n: count() }).from(o).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(p, eq(p.observationId, o.id)).leftJoin(a, current(tx)).leftJoin(e, eq(e.id, a.enterpriseId)).where(where).get()!.n;
            const rows = tx.select({ ...observationFields, titleRaw: p.exactTitleRaw, nameRaw: original.nameRaw, usccRaw: original.usccRaw, collectionId: o.collectionId }).from(o).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(qa, eq(qa.collectionId, c.id)).innerJoin(ra, eq(ra.observationId, o.id)).innerJoin(p, eq(p.observationId, o.id)).leftJoin(a, current(tx)).leftJoin(e, eq(e.id, a.enterpriseId)).leftJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1))).where(where).orderBy(desc(c.queriedAt), desc(ra.oldId)).limit(pageSize).offset(offset).all();
            const scopes = scopesByCollection(tx, [...new Set(rows.map(r => r.collectionId))]);
            return { view: 'isolated', rows: rows.map(({ collectionId, ...r }) => ({ ...r, kind: 'observation' as const, titleScopes: scopes.get(collectionId) ?? [] })), total, page, pageSize };
        }
        const where = recordFilter(tx, f);
        const total = tx.select({ n: countDistinct(b.id) }).from(v).innerJoin(b, eq(b.id, v.recordId)).leftJoin(p, eq(p.versionId, v.id)).where(where).get()!.n;
        const matched = tx.$with('matched').as(tx.select({ recordId: v.recordId, ...versionFields, matchedVersionCount: sql<number> `count(*) over (partition by ${v.recordId})`.as('matched_count'), rank: sql<number> `row_number() over (partition by ${v.recordId} order by ${v.id} desc)`.as('rank') }).from(v).innerJoin(b, eq(b.id, v.recordId)).leftJoin(p, eq(p.versionId, v.id)).where(where));
        const activity = tx.$with('activity').as(tx.select({ recordId: o.recordId, latest: sql<string | null> `max(coalesce(${c.lastCollectedAt},${c.queriedAt}))`.as('latest') }).from(o).innerJoin(c, eq(c.id, o.collectionId)).where(inArray(o.recordId, tx.select({ id: matched.recordId }).from(matched))).groupBy(o.recordId));
        const rows = tx.with(matched, activity).select({ matched: { recordId: matched.recordId, versionId: matched.versionId, validityDateRaw: matched.validityDateRaw, maintenanceYear: matched.maintenanceYear, maintenanceBatch: matched.maintenanceBatch, district: matched.district, awardNote: matched.awardNote, titleRaw: matched.titleRaw, nameRaw: matched.nameRaw, usccRaw: matched.usccRaw, ruleVersion: matched.ruleVersion, matchedVersionCount: matched.matchedVersionCount }, platformKey: b.platformKey, latest: activity.latest }).from(matched).innerJoin(b, eq(b.id, matched.recordId)).leftJoin(activity, eq(activity.recordId, matched.recordId)).where(eq(matched.rank, 1)).orderBy(sql `${activity.latest} is null`, desc(activity.latest), desc(matched.recordId)).limit(pageSize).offset(offset).all();
        const ids = rows.map(r => r.matched.recordId);
        if (!ids.length)
            return { view: 'records', rows: [], total, page, pageSize };
        const versions = new Map(tx.select({ id: v.recordId, n: count() }).from(v).where(inArray(v.recordId, ids)).groupBy(v.recordId).all().map(r => [r.id, r.n]));
        const observations = new Map(tx.select({ id: o.recordId, n: count() }).from(o).where(inArray(o.recordId, ids)).groupBy(o.recordId).all().map(r => [r.id, r.n]));
        const summary = summaries(tx, ids);
        return { view: 'records', total, page, pageSize, rows: rows.map(({ matched: m, platformKey, latest }) => { const { recordId, matchedVersionCount, ...matchedVersion } = m; return { kind: 'record' as const, record: { id: recordId, platformKey, interface: 'recognized_list' as const }, matchedVersion, matchedVersionCount, versionCount: versions.get(recordId) ?? 0, observationCount: observations.get(recordId) ?? 0, latestObservationAt: latest, ...summary.get(recordId)! }; }) };
    });
}
export function readTargetRecognizedOptions(view: RecognizedDirectoryView, db: Db): TargetRecognizedOptions {
    return db.transaction(tx => {
        gate(tx);
        const result: TargetRecognizedOptions = { titles: [], declareKinds: [], years: [], statuses: [], batches: [], districts: [], validityDates: [] };
        if (view === 'isolated') {
            result.titles = tx.selectDistinct({ value: p.exactTitleRaw }).from(o).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(p, eq(p.observationId, o.id)).where(and(eq(c.interface, 'recognized_list'), isolated, sql `${p.exactTitleRaw} is not null and trim(${p.exactTitleRaw}) <> ''`)).orderBy(sql `${p.exactTitleRaw} collate binary`).all().map(r => r.value);
            return result;
        }
        const columns = { titles: p.titleRaw, batches: p.maintenanceBatch, districts: p.district, validityDates: p.validityDateRaw };
        for (const key of ['titles', 'batches', 'districts', 'validityDates'] as const) {
            const col = columns[key];
            result[key] = tx.selectDistinct({ value: col }).from(p).innerJoin(v, eq(v.id, p.versionId)).innerJoin(b, eq(b.id, v.recordId)).where(and(eq(b.interface, 'recognized_list'), sql `${col} is not null and trim(${col}) <> ''`)).orderBy(sql `${col} collate binary`).all().map(r => r.value!);
        }
        return result;
    });
}
export function getTargetRecognizedRecord(db: Db, recordId: number): RecognizedDirectoryDetail {
    if (!Number.isSafeInteger(recordId) || recordId < 1)
        fail(400, 'invalid_recognized_record_id', 'recordId must be a positive safe integer');
    return db.transaction(tx => {
        gate(tx);
        const record = tx.select({ id: b.id, platformKey: b.platformKey, identityRuleVersion: b.identityRuleVersion, createdAt: b.createdAt }).from(b).where(and(eq(b.id, recordId), eq(b.interface, 'recognized_list'))).get();
        if (!record)
            fail(404, 'recognized_record_not_found', 'Recognized directory record not found');
        const versionTotal = tx.select({ n: count() }).from(v).where(eq(v.recordId, recordId)).get()!.n;
        const observationTotal = tx.select({ n: count() }).from(o).where(eq(o.recordId, recordId)).get()!.n;
        const stats = tx.$with('version_activity').as(tx.select({ versionId: o.versionId, n: count().as('n'), first: min(c.queriedAt).as('first'), last: sql<string | null> `max(coalesce(${c.lastCollectedAt},${c.queriedAt}))`.as('last') }).from(o).innerJoin(c, eq(c.id, o.collectionId)).where(eq(o.recordId, recordId)).groupBy(o.versionId));
        const versions = tx.with(stats).select({ ...versionFields, hashAlgorithm: v.hashAlgorithm, contentHash: v.contentHash, createdAt: v.createdAt, observationCount: sql<number> `coalesce(${stats.n},0)`, firstObservedAt: stats.first, lastObservedAt: stats.last }).from(v).leftJoin(p, eq(p.versionId, v.id)).leftJoin(stats, eq(stats.versionId, v.id)).where(eq(v.recordId, recordId)).orderBy(desc(v.id)).limit(RECOGNIZED_DIRECTORY_VERSION_LIMIT).all();
        const observations = tx.select({ ...observationFields, collectionId: o.collectionId, keySource: o.keySource, projectionRuleVersion: o.projectionRuleVersion, versionId: o.versionId,
            version: { versionId: p.versionId, validityDateRaw: p.validityDateRaw, maintenanceYear: p.maintenanceYear, maintenanceBatch: p.maintenanceBatch, district: p.district, awardNote: p.awardNote, titleRaw: p.titleRaw, nameRaw: p.nameRaw, usccRaw: p.usccRaw, ruleVersion: p.ruleVersion } }).from(o).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(qa, eq(qa.collectionId, c.id)).innerJoin(ra, eq(ra.observationId, o.id)).leftJoin(a, current(tx)).leftJoin(e, eq(e.id, a.enterpriseId)).leftJoin(p, and(eq(p.versionId, o.versionId), eq(p.recordId, o.recordId))).where(eq(o.recordId, recordId)).orderBy(desc(c.queriedAt), desc(ra.oldId)).limit(RECOGNIZED_DIRECTORY_OBSERVATION_LIMIT).all();
        const versionIds = versions.map(r => r.versionId);
        const queries = versionIds.length ? tx.selectDistinct({ versionId: o.versionId, collectionId: o.collectionId }).from(o).where(inArray(o.versionId, versionIds)).all() : [];
        const scopes = scopesByCollection(tx, [...new Set([...queries.map(r => r.collectionId), ...observations.map(r => r.collectionId)])]);
        const byVersion = groupBy(queries, r => String(r.versionId));
        const relations = observations.map(r => r.relationId);
        const refs = readObservationCorrespondenceRefs(tx,relations);
        const byRelation = groupBy(refs, r => String(r.relationId));
        return { record: { ...record, interface: 'recognized_list' }, versions: versions.map(r => ({ ...r, titleScopes: orderedScopes((byVersion[String(r.versionId)] ?? []).flatMap(q => scopes.get(q.collectionId) ?? [])) })),
            observations: observations.map(({ collectionId, version, ...r }) => {
                if (r.identityState === 'not_indexed' || r.contentState === 'not_indexed' || r.keySource === null || r.projectionRuleVersion === null)
                    fail(409, 'recognized_target_not_indexed', 'Record observation is not indexed');
                const titleScopes = scopes.get(collectionId) ?? [], title = version?.titleRaw ?? null;
                return { ...r, keySource: r.keySource, projectionRuleVersion: r.projectionRuleVersion, identityState: r.identityState, contentState: r.contentState, titleScopes, titleConflict: title !== null && ['1', '2', '3'].includes(title) && titleScopes.length > 0 && !titleScopes.includes(title), correspondenceRefs: (byRelation[String(r.relationId)] ?? []).map(({ id, status, revision }) => ({ id, status, revision })), version: r.versionId === null ? null : { versionId: r.versionId, validityDateRaw: version?.validityDateRaw ?? null, maintenanceYear: version?.maintenanceYear ?? null, maintenanceBatch: version?.maintenanceBatch ?? null, district: version?.district ?? null, awardNote: version?.awardNote ?? null, titleRaw: title, nameRaw: version?.nameRaw ?? null, usccRaw: version?.usccRaw ?? null, ruleVersion: version?.ruleVersion ?? null } };
            }), counts: { versions: versionTotal, observations: observationTotal, versionsTruncated: versionTotal > versions.length, observationsTruncated: observationTotal > observations.length }, conflicts: summaries(tx, [recordId]).get(recordId)!.conflicts };
    });
}

/** Recognition content and reconciled observation facts retain their separate owners. */
export function readTargetRecognizedFacts(db: Db, relationIds: number[]): Map<number, PlatformObservationFact> {
    const result = new Map<number, PlatformObservationFact>();
    if (!relationIds.length) return result;
    return db.transaction(tx => {
        const original = alias(a, 'candidate_recognized_original');
        const vp = alias(p, 'candidate_recognized_version');
        const { id: versionIdentity, ...versionProjectionFields } = getTableColumns(vp);
        const versionColumns = { id: versionIdentity, ...versionProjectionFields };
        for (let start = 0; start < relationIds.length; start += 400) {
            const ids = relationIds.slice(start, start + 400);
            gate(tx, inArray(o.id, tx.select({ id: ra.observationId }).from(ra).where(inArray(ra.oldId, ids))));
            const rows = tx.select({ relationId: ra.oldId, source: p, version: versionColumns, originalName: original.nameRaw, originalUscc: original.usccRaw })
                .from(ra).innerJoin(o, eq(o.id, ra.observationId)).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(p, eq(p.observationId, o.id))
                .leftJoin(vp, and(eq(vp.versionId, o.versionId), eq(vp.recordId, o.recordId)))
                .leftJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
                .where(and(inArray(ra.oldId, ids), eq(c.interface, 'recognized_list'))).all();
            for (const row of rows) {
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
                result.set(row.relationId, withArchiveProcessFacts({
                    relationId: row.relationId, interface: 'recognized_list', projectionVersionId: typed ? version.versionId : null, projectionRuleVersion: typed ? version.ruleVersion : null,
                    modeledFields: typed ? ['validityDateRaw', 'maintenanceYear', 'maintenanceBatch', 'district', 'awardNote', 'titleRaw', 'nameRaw', 'usccRaw'] : [],
                    ...normalized, titleRaw: typed ? version.titleRaw ?? title : title,
                    nameRaw: typed ? version.nameRaw : row.originalName, usccRaw: typed ? version.usccRaw : row.originalUscc,
                    validityDateRaw: typed ? version.validityDateRaw : null, maintenanceYear: typed ? version.maintenanceYear : null,
                    maintenanceBatch: typed ? version.maintenanceBatch : null, district: typed ? version.district : null, awardNote: typed ? version.awardNote : null,
                    normalizationConflicts: conflicts,
                }, normalized));
            }
        }
        return result;
    });
}
