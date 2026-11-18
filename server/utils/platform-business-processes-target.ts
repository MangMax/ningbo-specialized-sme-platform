/** Native business process reader. */
import { getTableColumns,and,count,countDistinct,desc,eq,exists,inArray,isNull,max,min,ne,or,sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { alias } from 'drizzle-orm/sqlite-core';
import { groupBy } from 'es-toolkit';
import { platformBusinessRecord as b,platformCollection as c,enterprise as e,platformLegacyQueryAlias as qa,platformBusinessRecordVersion as v } from '../../db/schema';
import { normalizeName,normalizeUscc } from '../../layers/sme-roster/lib/domain';
import { BUSINESS_PROCESS_OBSERVATION_LIMIT,BUSINESS_PROCESS_VERSION_LIMIT,businessProcessFilterSchema,type BusinessProcessDetail,type BusinessProcessFilter,type BusinessProcessIsolatedRow,type BusinessProcessListResult,type BusinessProcessView } from '../../lib/platform/business-processes';
import { readObservationCorrespondenceRefs } from '../../lib/platform/correspondence-target';
import type { PlatformFilterOptions } from '../../lib/platform/filter-options';
import { normalizeDeclareKind } from '../../lib/platform/identity';
import { platformNormalizationConflict,type PlatformNormalizationConflict } from '../../lib/platform/normalization';
import { withArchiveProcessFacts,type PlatformObservationFact } from '../../lib/platform/observation-facts';
import { processStoredInstalled } from '../../lib/platform/process-stored-catalog';
import { storedProcessProjection as p } from '../../lib/platform/process-stored-schema';
import { sqliteConnection } from '../../lib/platform/target-connection';
import { platformObservationAssignment as a,platformBusinessObservation as o,platformLegacyRelationAlias as ra,platformQueryTitleScope as scope,targetSchema } from '../../lib/platform/target-schema';
import { fail,orderedScopes,pageOf } from './platform-business-read';
// Explicit table queries use the injected session/logger, never db.query.
type Db = BetterSQLite3Database<typeof targetSchema> | BetterSQLite3Database<typeof import('../../db/schema')>;
// SQLite's original non-STRICT cells can be BLOB/REAL; keep that explicit here.
type TargetIsolatedRow = Omit<BusinessProcessIsolatedRow, 'titleRaw' | 'declareKind' | 'businessYear' | 'appliedAt' | 'status' | 'batch' | 'awardBatchLabel' | 'province'> & {
    titleRaw: unknown; declareKind: unknown; businessYear: unknown; appliedAt: unknown; status: unknown; batch: unknown; awardBatchLabel: unknown; province: unknown;
};
export type TargetBusinessProcessListResult = Omit<BusinessProcessListResult, 'rows'> & {
    rows: (Exclude<BusinessProcessListResult['rows'][number], BusinessProcessIsolatedRow> | TargetIsolatedRow)[];
};
export type TargetBusinessProcessOptions = Omit<PlatformFilterOptions, 'titles' | 'declareKinds' | 'statuses' | 'batches'> & {
    titles: unknown[]; declareKinds: unknown[]; statuses: unknown[]; batches: unknown[];
};
const previous = alias(a, 'newer_assignment'), original = alias(a, 'original_assignment');
function current(db: Db) { return and(eq(a.observationId, o.id), eq(a.revision, db.select({ revision: max(previous.revision) }).from(previous).where(eq(previous.observationId, o.id)))); }
const isolated = or(ne(o.identityState, 'resolved'), ne(o.contentState, 'verified'), isNull(o.versionId));
/** Capture readiness covers every process observation before business predicates.
 * NULL facts remain readable; absent capture, assignment or aliases never disappear in a join. */
function gate(db: Db, selected?: ReturnType<typeof inArray>) {
    if (!processStoredInstalled(sqliteConnection(db)))
        fail(409, 'process_target_capture', 'Process observations require completed stored capture');
    const missing = db.select({ id: o.id }).from(o).innerJoin(c, eq(c.id, o.collectionId)).leftJoin(p, eq(p.observationId, o.id)).leftJoin(a, current(db)).leftJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1))).leftJoin(ra, eq(ra.observationId, o.id)).leftJoin(qa, eq(qa.collectionId, c.id))
        .where(and(selected, eq(c.interface, 'business_list'), or(isNull(p.id), isNull(p.exactStoredState), ne(p.exactStoredState, 'captured'), isNull(p.sqlFactTitleState), ne(p.sqlFactTitleState, 'captured'), isNull(p.exactStoredRule), ne(p.exactStoredRule, 'process-stored-cells-v1'), isNull(p.sqlFactTitleRule), ne(p.sqlFactTitleRule, 'process-legacy-sql-fact-title-v1'), isNull(a.observationId), isNull(original.observationId), isNull(ra.oldId), isNull(qa.oldId)))).limit(1).get();
    if (missing)
        fail(409, 'process_target_uncaptured', 'Process observation has uncaptured original facts or assignment');
}
function parse(input: unknown) { const r = businessProcessFilterSchema.safeParse(input); if (!r.success)
    fail(400, 'invalid_business_process_filter', 'Invalid business process query parameters'); return r.data; }
function enterpriseFilter(filter: Pick<BusinessProcessFilter, 'q' | 'enterpriseId'>) { return and(filter.enterpriseId == null ? undefined : eq(a.enterpriseId, filter.enterpriseId), filter.q ? or(sql `${e.nameNorm} like ${`%${normalizeName(filter.q)}%`}`, sql `${e.usccNorm} like ${`%${normalizeUscc(filter.q)}%`}`) : undefined); }
/** Preserve the process's untrimmed filtering predicate, not its display/conflict predicate. */
function scopeMatch(db: Db, rdjb: string) { return or(sql `instr(',' || ${c.rdjb} || ',', ',' || ${rdjb} || ',') > 0`, exists(db.select({ id: scope.collectionId }).from(scope).where(and(eq(scope.collectionId, c.id), eq(scope.rdjb, rdjb))))); }
function recordFilter(db: Db, f: BusinessProcessFilter) {
    const kind = normalizeDeclareKind(f.declareKind);
    return and(eq(b.interface, 'business_list'), f.platformKey ? eq(b.platformKey, f.platformKey) : undefined, f.titleRaw === undefined ? undefined : eq(p.titleRaw, f.titleRaw), kind ? eq(p.declareKind, kind) : undefined, f.year == null ? undefined : eq(p.businessYear, f.year), f.status ? eq(p.status, f.status) : undefined, f.batch ? eq(p.batch, f.batch) : undefined, f.rdjb ? exists(db.select({ id: o.id }).from(o).innerJoin(c, eq(c.id, o.collectionId)).where(and(eq(o.versionId, v.id), scopeMatch(db, f.rdjb)))) : undefined, f.enterpriseId != null || f.q ? exists(db.select({ id: o.id }).from(o).leftJoin(a, current(db)).leftJoin(e, eq(e.id, a.enterpriseId)).where(and(eq(o.recordId, b.id), enterpriseFilter(f)))) : undefined);
}
function isolatedFilter(db: Db, f: BusinessProcessFilter) { return and(eq(c.interface, 'business_list'), isolated, enterpriseFilter(f), f.platformKey ? eq(o.sourceRelationKey, f.platformKey) : undefined, f.titleRaw === undefined ? undefined : eq(p.exactTitleRaw, f.titleRaw), f.declareKind ? eq(p.exactDeclareKind, normalizeDeclareKind(f.declareKind)) : undefined, f.year == null ? undefined : eq(p.exactYear, f.year), f.status ? eq(p.exactStatus, f.status) : undefined, f.batch ? eq(p.exactBatch, f.batch) : undefined, f.rdjb ? scopeMatch(db, f.rdjb) : undefined); }
const versionFields = { versionId: v.id, declareKind: p.declareKind, businessYear: p.businessYear, appliedAt: p.appliedAt, status: p.status, batch: p.batch, awardBatchLabel: p.awardBatchLabel, province: p.province, titleRaw: p.titleRaw, nameRaw: p.nameRaw, usccRaw: p.usccRaw, ruleVersion: p.ruleVersion };
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
    for (const id of ids) {
        const assigned = owners[String(id)] ?? [], enterpriseIds = assigned.flatMap(r => r.enterpriseId == null ? [] : [r.enterpriseId]);
        result.set(id, { enterpriseIds, enterpriseNames: assigned.flatMap(r => r.enterpriseId != null && r.name ? [r.name] : []), titleScopes: orderedScopes((queryGroups[String(id)] ?? []).flatMap(r => scopes.get(r.collectionId) ?? [])), conflicts: [...(unverifiable.has(id) ? ['unverifiable_observation'] : []), ...(enterpriseIds.length > 1 ? ['enterprise_assignment_conflict'] : [])] });
    }
    return result;
}
export function listTargetBusinessProcesses(input: unknown, db: Db): TargetBusinessProcessListResult {
    const f = parse(input);
    return db.transaction(tx => {
        gate(tx);
        const { page, pageSize, offset } = pageOf(f);
        if (f.view === 'isolated') {
            const where = isolatedFilter(tx, f);
            const total = tx.select({ n: count() }).from(o).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(p, eq(p.observationId, o.id)).leftJoin(a, current(tx)).leftJoin(e, eq(e.id, a.enterpriseId)).where(where).get()!.n;
            const rows = tx.select({ ...observationFields, titleRaw: p.exactTitleRaw, declareKind: p.exactDeclareKind, businessYear: p.exactYear, appliedAt: p.exactAppliedAt, status: p.exactStatus, batch: p.exactBatch, awardBatchLabel: p.exactAwardBatchLabel, province: p.exactProvince, nameRaw: original.nameRaw, usccRaw: original.usccRaw, collectionId: o.collectionId }).from(o).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(qa, eq(qa.collectionId, c.id)).innerJoin(ra, eq(ra.observationId, o.id)).innerJoin(p, eq(p.observationId, o.id)).leftJoin(a, current(tx)).leftJoin(e, eq(e.id, a.enterpriseId)).leftJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1))).where(where).orderBy(desc(c.queriedAt), desc(ra.oldId)).limit(pageSize).offset(offset).all();
            const scopes = scopesByCollection(tx, [...new Set(rows.map(r => r.collectionId))]);
            return { view: 'isolated', rows: rows.map(({ collectionId, ...r }) => ({ ...r, kind: 'observation' as const, titleScopes: scopes.get(collectionId) ?? [] })), total, page, pageSize };
        }
        const where = recordFilter(tx, f);
        const total = tx.select({ n: countDistinct(b.id) }).from(v).innerJoin(b, eq(b.id, v.recordId)).leftJoin(p, eq(p.versionId, v.id)).where(where).get()!.n;
        const matched = tx.$with('matched').as(tx.select({ recordId: v.recordId, ...versionFields, matchedVersionCount: sql<number> `count(*) over (partition by ${v.recordId})`.as('matched_count'), rank: sql<number> `row_number() over (partition by ${v.recordId} order by (${p.appliedAt} is null), ${p.appliedAt} desc, ${v.id} desc)`.as('rank') }).from(v).innerJoin(b, eq(b.id, v.recordId)).leftJoin(p, eq(p.versionId, v.id)).where(where));
        const activity = tx.$with('activity').as(tx.select({ recordId: o.recordId, latest: sql<string | null> `max(coalesce(${c.lastCollectedAt},${c.queriedAt}))`.as('latest') }).from(o).innerJoin(c, eq(c.id, o.collectionId)).where(inArray(o.recordId, tx.select({ id: matched.recordId }).from(matched))).groupBy(o.recordId));
        const rows = tx.with(matched, activity).select({ matched: { recordId: matched.recordId, versionId: matched.versionId, declareKind: matched.declareKind, businessYear: matched.businessYear, appliedAt: matched.appliedAt, status: matched.status, batch: matched.batch, awardBatchLabel: matched.awardBatchLabel, province: matched.province, titleRaw: matched.titleRaw, nameRaw: matched.nameRaw, usccRaw: matched.usccRaw, ruleVersion: matched.ruleVersion, matchedVersionCount: matched.matchedVersionCount }, platformKey: b.platformKey, latest: activity.latest }).from(matched).innerJoin(b, eq(b.id, matched.recordId)).leftJoin(activity, eq(activity.recordId, matched.recordId)).where(eq(matched.rank, 1)).orderBy(sql `${activity.latest} is null`, desc(activity.latest), desc(matched.recordId)).limit(pageSize).offset(offset).all();
        const ids = rows.map(r => r.matched.recordId);
        if (!ids.length)
            return { view: 'records', rows: [], total, page, pageSize };
        const versions = new Map(tx.select({ id: v.recordId, n: count() }).from(v).where(inArray(v.recordId, ids)).groupBy(v.recordId).all().map(r => [r.id, r.n]));
        const observations = new Map(tx.select({ id: o.recordId, n: count() }).from(o).where(inArray(o.recordId, ids)).groupBy(o.recordId).all().map(r => [r.id, r.n]));
        const summary = summaries(tx, ids);
        return { view: 'records', total, page, pageSize, rows: rows.map(({ matched: m, platformKey, latest }) => { const { recordId, matchedVersionCount, ...matchedVersion } = m; return { kind: 'record' as const, record: { id: recordId, platformKey, interface: 'business_list' as const }, matchedVersion, matchedVersionCount, versionCount: versions.get(recordId) ?? 0, observationCount: observations.get(recordId) ?? 0, latestObservationAt: latest, ...summary.get(recordId)! }; }) };
    });
}
export function readTargetBusinessProcessOptions(view: BusinessProcessView, db: Db): TargetBusinessProcessOptions {
    return db.transaction(tx => {
        gate(tx);
        const result: TargetBusinessProcessOptions = { titles: [], declareKinds: [], years: [], statuses: [], batches: [], districts: [], validityDates: [] };
        const columns = view === 'isolated' ? { titles: p.exactTitleRaw, declareKinds: p.exactDeclareKind, statuses: p.exactStatus, batches: p.exactBatch } : { titles: p.titleRaw, declareKinds: p.declareKind, statuses: p.status, batches: p.batch };
        for (const key of ['titles', 'declareKinds', 'statuses', 'batches'] as const) {
            const col = columns[key];
            const base = view === 'isolated'
                ? tx.selectDistinct({ value: col }).from(o).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(p, eq(p.observationId, o.id)).where(and(eq(c.interface, 'business_list'), isolated, sql`${col} is not null and trim(${col}) <> ''`))
                : tx.selectDistinct({ value: col }).from(p).innerJoin(v, eq(v.id, p.versionId)).innerJoin(b, eq(b.id, v.recordId)).where(and(eq(b.interface, 'business_list'), sql`${col} is not null and trim(${col}) <> ''`));
            result[key] = base.orderBy(sql`${col} collate binary`).all().map(r => r.value);
        }
        const year = view === 'isolated' ? p.exactYear : p.businessYear;
        const years = view === 'isolated'
            ? tx.selectDistinct({ value: year }).from(o).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(p, eq(p.observationId, o.id)).where(and(eq(c.interface, 'business_list'), isolated, sql`${year} is not null`))
            : tx.selectDistinct({ value: year }).from(p).innerJoin(v, eq(v.id, p.versionId)).innerJoin(b, eq(b.id, v.recordId)).where(and(eq(b.interface, 'business_list'), sql`${year} is not null`));
        result.years = years.orderBy(desc(year)).all().map(r => r.value).filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
        return result;
    });
}
export function getTargetBusinessProcess(db: Db, recordId: number): BusinessProcessDetail {
    if (!Number.isSafeInteger(recordId) || recordId < 1)
        fail(400, 'invalid_business_process_id', 'recordId must be a positive safe integer');
    return db.transaction(tx => {
        gate(tx);
        const record = tx.select({ id: b.id, platformKey: b.platformKey, identityRuleVersion: b.identityRuleVersion, createdAt: b.createdAt }).from(b).where(and(eq(b.id, recordId), eq(b.interface, 'business_list'))).get();
        if (!record)
            fail(404, 'business_process_not_found', 'Business process record not found');
        const versionTotal = tx.select({ n: count() }).from(v).where(eq(v.recordId, recordId)).get()!.n;
        const observationTotal = tx.select({ n: count() }).from(o).where(eq(o.recordId, recordId)).get()!.n;
        const stats = tx.$with('version_activity').as(tx.select({ versionId: o.versionId, n: count().as('n'), first: min(c.queriedAt).as('first'), last: sql<string | null> `max(coalesce(${c.lastCollectedAt},${c.queriedAt}))`.as('last') }).from(o).innerJoin(c, eq(c.id, o.collectionId)).where(eq(o.recordId, recordId)).groupBy(o.versionId));
        const versions = tx.with(stats).select({ ...versionFields, hashAlgorithm: v.hashAlgorithm, contentHash: v.contentHash, createdAt: v.createdAt, observationCount: sql<number> `coalesce(${stats.n},0)`, firstObservedAt: stats.first, lastObservedAt: stats.last }).from(v).leftJoin(p, eq(p.versionId, v.id)).leftJoin(stats, eq(stats.versionId, v.id)).where(eq(v.recordId, recordId)).orderBy(desc(v.id)).limit(BUSINESS_PROCESS_VERSION_LIMIT).all();
        const observations = tx.select({ ...observationFields, collectionId: o.collectionId, keySource: o.keySource, projectionRuleVersion: o.projectionRuleVersion, versionId: o.versionId,
            version: { versionId: p.versionId, declareKind: p.declareKind, businessYear: p.businessYear, appliedAt: p.appliedAt, status: p.status, batch: p.batch, awardBatchLabel: p.awardBatchLabel, province: p.province, titleRaw: p.titleRaw, nameRaw: p.nameRaw, usccRaw: p.usccRaw, ruleVersion: p.ruleVersion } }).from(o).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(qa, eq(qa.collectionId, c.id)).innerJoin(ra, eq(ra.observationId, o.id)).leftJoin(a, current(tx)).leftJoin(e, eq(e.id, a.enterpriseId)).leftJoin(p, and(eq(p.versionId, o.versionId), eq(p.recordId, o.recordId))).where(eq(o.recordId, recordId)).orderBy(desc(c.queriedAt), desc(ra.oldId)).limit(BUSINESS_PROCESS_OBSERVATION_LIMIT).all();
        const versionIds = versions.map(r => r.versionId);
        const queries = versionIds.length ? tx.selectDistinct({ versionId: o.versionId, collectionId: o.collectionId }).from(o).where(inArray(o.versionId, versionIds)).all() : [];
        const scopes = scopesByCollection(tx, [...new Set([...queries.map(r => r.collectionId), ...observations.map(r => r.collectionId)])]);
        const byVersion = groupBy(queries, r => String(r.versionId));
        const relations = observations.map(r => r.relationId);
        const refs = readObservationCorrespondenceRefs(tx,relations);
        const byRelation = groupBy(refs, r => String(r.relationId));
        return { record: { ...record, interface: 'business_list' }, versions: versions.map(r => ({ ...r, titleScopes: orderedScopes((byVersion[String(r.versionId)] ?? []).flatMap(q => scopes.get(q.collectionId) ?? [])) })),
            observations: observations.map(({ collectionId, version, ...r }) => {
                if (r.identityState === 'not_indexed' || r.contentState === 'not_indexed' || r.keySource === null || r.projectionRuleVersion === null)
                    fail(409, 'process_target_not_indexed', 'Record observation is not indexed');
                const titleScopes = scopes.get(collectionId) ?? [];
                return { ...r, keySource: r.keySource, projectionRuleVersion: r.projectionRuleVersion, identityState: r.identityState, contentState: r.contentState, titleScopes, correspondenceRefs: (byRelation[String(r.relationId)] ?? []).map(({ id, status, revision }) => ({ id, status, revision })), version: r.versionId === null ? null : { versionId: r.versionId, declareKind: version?.declareKind ?? null, businessYear: version?.businessYear ?? null, appliedAt: version?.appliedAt ?? null, status: version?.status ?? null, batch: version?.batch ?? null, awardBatchLabel: version?.awardBatchLabel ?? null, province: version?.province ?? null, titleRaw: version?.titleRaw ?? null, nameRaw: version?.nameRaw ?? null, usccRaw: version?.usccRaw ?? null, ruleVersion: version?.ruleVersion ?? null } };
            }), counts: { versions: versionTotal, observations: observationTotal, versionsTruncated: versionTotal > versions.length, observationsTruncated: observationTotal > observations.length } };
    });
}

const vp = alias(p, 'version_projection');
const { id: versionIdentity, ...versionProjectionFields } = getTableColumns(vp);
const versionColumns = { id: versionIdentity, ...versionProjectionFields };
const comparisonFields = ['province', 'status', 'batch', 'declareKind', 'appliedAt', 'awardBatchLabel', 'year'] as const;
const modeledFields = ['declareKind', 'year', 'appliedAt', 'status', 'batch', 'awardBatchLabel', 'province', 'nameRaw', 'usccRaw'] as const;
export function readTargetBusinessProcessFacts(db: Db, relationIds: number[], options: { scope?: 'selected' } = {}): Map<number, PlatformObservationFact> {
    const result = new Map<number, PlatformObservationFact>();
    return db.transaction(tx => {
        if (options.scope !== 'selected') gate(tx);
        const original = alias(a, 'original_assignment');
        for (let start = 0; start < relationIds.length; start += 400) {
            const ids = relationIds.slice(start, start + 400);
            if (options.scope === 'selected') gate(tx, inArray(o.id, tx.select({ id: ra.observationId }).from(ra).where(inArray(ra.oldId, ids))));
            const rows = tx.select({ relationId: ra.oldId, source: p, version: versionColumns, originalName: original.nameRaw, originalUscc: original.usccRaw })
                .from(ra).innerJoin(o, eq(o.id, ra.observationId)).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(p, eq(p.observationId, o.id))
                .leftJoin(vp, and(eq(vp.versionId, o.versionId), eq(vp.recordId, o.recordId)))
                .leftJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
                .where(and(inArray(ra.oldId, ids), eq(c.interface, 'business_list'))).all();
            for (const row of rows) {
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
                result.set(row.relationId, withArchiveProcessFacts({
                    relationId: row.relationId, interface: 'business_list',
                    nameRaw: typed ? version.nameRaw : rawName, usccRaw: typed ? version.usccRaw : rawUscc, titleRaw: source.sqlFactTitle,
                    validityDateRaw: null, maintenanceYear: null, maintenanceBatch: null, district: null, awardNote: null, normalizationConflicts: conflicts,
                    projectionVersionId: typed ? version.versionId : null, projectionRuleVersion: typed ? version.ruleVersion : null, modeledFields: typed ? modeledFields : [],
                    declareKind: typed ? version.declareKind : normalized.declareKind, year: typed ? version.businessYear : normalized.year, appliedAt: typed ? version.appliedAt : normalized.appliedAt, status: typed ? version.status : normalized.status,
                    batch: typed ? version.batch : normalized.batch, awardBatchLabel: typed ? version.awardBatchLabel : normalized.awardBatchLabel, province: typed ? version.province : normalized.province,
                }, normalized));
            }
        }
        return result;
    });
}
