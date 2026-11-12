/** Explicit 71608 apply reader. Public runtime routing remains with R1b. */
import { and, count, countDistinct, desc, eq, exists, inArray, isNull, max, min, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { groupBy } from 'es-toolkit';
import { targetSchema, platformBusinessObservation as o, platformObservationAssignment as a, platformLegacyRelationAlias as ra } from '../../lib/platform/target-schema';
import { storedApplyProjection as p } from '../../lib/platform/apply-stored-schema';
import { processStoredInstalled } from '../../lib/platform/process-stored-catalog';
import { sqliteConnection } from '../../lib/platform/target-connection';
import { platformCollection as c, platformLegacyQueryAlias as qa, platformBusinessRecord as b, platformBusinessRecordVersion as v, enterprise as e } from '../../db/schema';
import { normalizeName, normalizeUscc } from '../../lib/domain';
import { normalizeDeclareKind } from '../../lib/platform/identity';
import { declarationFilterSchema, DECLARATION_OBSERVATION_LIMIT, DECLARATION_VERSION_LIMIT, type DeclarationFilter, type DeclarationListResult, type DeclarationDetail, type DeclarationView, type DeclarationIsolatedRow, type DeclarationRecordRow } from '../../lib/platform/declarations';
import type { PlatformFilterOptions } from '../../lib/platform/filter-options';
import { fail, pageOf } from './platform-business-read';
// The old public DTO understates SQLite's legal cells. Keep target cells unknown
// at this explicit boundary rather than asserting that a BLOB/REAL is a string/int.
import { withArchiveProcessFacts, type PlatformObservationFact } from '../../lib/platform/observation-facts';
import type { PlatformNormalizationConflict } from '../../lib/platform/normalization';
type ExactCells = { titleRaw: unknown; declareKind: unknown; declarationYear: unknown; appliedAt: unknown; status: unknown };
export type TargetDeclarationListResult = Omit<DeclarationListResult, 'rows'> & {
    rows: (DeclarationRecordRow | (Omit<DeclarationIsolatedRow, keyof ExactCells> & ExactCells))[];
};
export type TargetDeclarationOptions = Omit<PlatformFilterOptions, 'titles' | 'declareKinds' | 'statuses'> & {
    titles: unknown[]; declareKinds: unknown[]; statuses: unknown[];
};
// Queries use explicit target table declarations, never relational db.query.
// Accept the existing connection injection seam without rebuilding its session/logger.
// The 71608 gate below still owns schema compatibility; this is not a selector.
type Db = BetterSQLite3Database<typeof targetSchema> | BetterSQLite3Database<typeof import('../../db/schema')>;
const previous = alias(a, 'newer_assignment');
const vp = alias(p, 'version_projection');
function current(db: Db) { return and(eq(a.observationId, o.id), eq(a.revision, db.select({ revision: max(previous.revision) }).from(previous).where(eq(previous.observationId, o.id)))); }
const isolated = or(ne(o.identityState, 'resolved'), ne(o.contentState, 'verified'), isNull(o.versionId));
/** Gate the entire apply request domain, before any business filtering or paging.
 * PRAGMA is schema infrastructure; no archive or legacy entity is consulted. */
function gate(db: Db, domain?: SQL, annualFacts = false) {
    const phase = db.get<{ user_version: number }>(sql`PRAGMA user_version`)?.user_version;
    if (phase !== 71608 && !(annualFacts && (phase === 71611 || phase === 71612) && processStoredInstalled(sqliteConnection(db))))
        fail(409, 'apply_target_phase', 'Declaration reader requires 71608');
    const missing = db.select({ id: o.id }).from(o).innerJoin(c, eq(c.id, o.collectionId)).leftJoin(p, eq(p.observationId, o.id))
        .where(and(eq(c.interface, 'apply_list'), domain, or(isNull(p.id), ne(p.exactStoredState, 'captured'), ne(p.sqlFactTitleState, 'captured'), isNull(p.exactStoredState), isNull(p.sqlFactTitleState)))).limit(1).get();
    if (missing)
        fail(409, 'apply_stored_uncaptured', 'Declaration observation has uncaptured stored facts');
}
function parse(input: unknown) {
    const result = declarationFilterSchema.safeParse(input);
    if (!result.success)
        fail(400, 'invalid_declaration_filter', 'Invalid declaration query parameters');
    return result.data;
}
function enterpriseFilter(filter: Pick<DeclarationFilter, 'enterpriseId' | 'q'>): SQL | undefined {
    return and(filter.enterpriseId == null ? undefined : eq(a.enterpriseId, filter.enterpriseId), filter.q ? or(sql `${e.nameNorm} LIKE ${`%${normalizeName(filter.q)}%`}`, sql `${e.usccNorm} LIKE ${`%${normalizeUscc(filter.q)}%`}`) : undefined);
}
function recordFilter(db: Db, filter: DeclarationFilter) {
    const kind=filter.declareKind ? normalizeDeclareKind(filter.declareKind) : null;
    const owner = filter.enterpriseId != null || filter.q ? exists(db.select({ id: o.id }).from(o).leftJoin(a, current(db)).leftJoin(e, eq(e.id, a.enterpriseId)).where(and(eq(o.recordId, b.id), enterpriseFilter(filter)))) : undefined;
    return and(eq(b.interface, 'apply_list'), filter.platformKey ? eq(b.platformKey, filter.platformKey) : undefined, filter.titleRaw === undefined ? undefined : eq(p.titleRaw, filter.titleRaw), kind ? eq(p.declareKind, kind) : undefined, filter.year == null ? undefined : eq(p.declarationYear, filter.year), filter.status ? eq(p.status, filter.status) : undefined, owner);
}
function isolatedFilter(filter: DeclarationFilter) {
    const kind=filter.declareKind ? normalizeDeclareKind(filter.declareKind) : null;
    return and(eq(c.interface, 'apply_list'), isolated, enterpriseFilter(filter), filter.platformKey ? eq(o.sourceRelationKey, filter.platformKey) : undefined, filter.titleRaw === undefined ? undefined : eq(p.exactTitleRaw, filter.titleRaw), kind ? eq(p.exactDeclareKind, kind) : undefined, filter.year == null ? undefined : eq(p.exactYear, filter.year), filter.status ? eq(p.exactStatus, filter.status) : undefined);
}
const exactFields = { titleRaw: p.exactTitleRaw, declareKind: p.exactDeclareKind, declarationYear: p.exactYear, appliedAt: p.exactAppliedAt, status: p.exactStatus };
const versionFields = { versionId: v.id, titleRaw: p.titleRaw, declareKind: p.declareKind, declarationYear: p.declarationYear, appliedAt: p.appliedAt, status: p.status, nameRaw: p.nameRaw, usccRaw: p.usccRaw, ruleVersion: p.ruleVersion };
const observationFields = { relationId: ra.oldId, queryId: qa.oldId, queriedAt: c.queriedAt, queryKey: c.queryKey, queryStatus: c.status, sequenceNo: o.sequenceNo, identityState: o.identityState, contentState: o.contentState, enterpriseId: a.enterpriseId, enterpriseName: e.name };
export function listTargetDeclarations(input: unknown, db: Db): TargetDeclarationListResult {
    const filter = parse(input);
    return db.transaction(tx => {
        gate(tx);
        const { page, pageSize, offset } = pageOf(filter);
        if (filter.view === 'isolated') {
            const original = alias(a, 'original_assignment');
            const query = tx.select({ ...observationFields, ...exactFields, nameRaw: original.nameRaw, usccRaw: original.usccRaw }).from(o)
                .innerJoin(c, eq(c.id, o.collectionId)).innerJoin(qa, eq(qa.collectionId, c.id)).innerJoin(ra, eq(ra.observationId, o.id))
                .innerJoin(p, eq(p.observationId, o.id)).leftJoin(a, current(tx)).leftJoin(e, eq(e.id, a.enterpriseId))
                .leftJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
                .where(isolatedFilter(filter));
            const totals = tx.select({ total: count() }).from(o).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(p, eq(p.observationId, o.id)).leftJoin(a, current(tx)).leftJoin(e, eq(e.id, a.enterpriseId)).where(isolatedFilter(filter)).get()!;
            const rows = query.orderBy(desc(c.queriedAt), desc(ra.oldId)).limit(pageSize).offset(offset).all();
            return { view: 'isolated', rows: rows.map(row => ({ ...row, kind: 'observation' })), total: totals.total, page, pageSize };
        }
        const where = recordFilter(tx, filter);
        const total = tx.select({ n: countDistinct(b.id) }).from(v).innerJoin(b, eq(b.id, v.recordId)).leftJoin(p, eq(p.versionId, v.id)).where(where).get()!.n;
        const matched = tx.$with('matched').as(tx.select({ recordId: v.recordId, ...versionFields,
            matchedVersionCount: sql<number> `count(*) over (partition by ${v.recordId})`.as('matched_count'),
            rank: sql<number> `row_number() over (partition by ${v.recordId} order by ${p.appliedAt} is null, ${p.appliedAt} desc, ${v.id} desc)`.as('rank'),
        }).from(v).innerJoin(b, eq(b.id, v.recordId)).leftJoin(p, eq(p.versionId, v.id)).where(where));
        const activity = tx.$with('activity').as(tx.select({ recordId: o.recordId, latest: sql<string | null> `max(coalesce(${c.lastCollectedAt},${c.queriedAt}))`.as('latest') }).from(o).innerJoin(c, eq(c.id, o.collectionId)).where(inArray(o.recordId, tx.select({ id: matched.recordId }).from(matched))).groupBy(o.recordId));
        const pageRows = tx.with(matched, activity).select({ matched: { recordId: matched.recordId, versionId: matched.versionId, titleRaw: matched.titleRaw, declareKind: matched.declareKind, declarationYear: matched.declarationYear, appliedAt: matched.appliedAt, status: matched.status, nameRaw: matched.nameRaw, usccRaw: matched.usccRaw, ruleVersion: matched.ruleVersion, matchedVersionCount: matched.matchedVersionCount }, platformKey: b.platformKey, latest: activity.latest }).from(matched).innerJoin(b, eq(b.id, matched.recordId)).leftJoin(activity, eq(activity.recordId, matched.recordId)).where(eq(matched.rank, 1))
            .orderBy(sql `${activity.latest} is null`, desc(activity.latest), desc(matched.recordId)).limit(pageSize).offset(offset).all();
        const ids = pageRows.map(row => row.matched.recordId);
        if (!ids.length)
            return { view: 'records', rows: [], total, page, pageSize };
        const versions = new Map(tx.select({ id: v.recordId, n: count() }).from(v).where(inArray(v.recordId, ids)).groupBy(v.recordId).all().map(r => [r.id, r.n]));
        const observations = new Map(tx.select({ id: o.recordId, n: count(), unverifiable: sql<number> `max(${o.contentState} = 'unverifiable')` }).from(o).where(inArray(o.recordId, ids)).groupBy(o.recordId).all().map(r => [r.id, r]));
        const owners = groupBy(tx.selectDistinct({ recordId: o.recordId, enterpriseId: a.enterpriseId, name: e.name }).from(o).leftJoin(a, current(tx)).leftJoin(e, eq(e.id, a.enterpriseId)).where(inArray(o.recordId, ids)).orderBy(o.recordId, a.enterpriseId).all(), row => String(row.recordId));
        return { view: 'records', total, page, pageSize, rows: pageRows.map(({ matched: m, platformKey, latest }) => {
                const assigned = owners[String(m.recordId)] ?? [], enterpriseIds = assigned.flatMap(r => r.enterpriseId == null ? [] : [r.enterpriseId]);
                const { recordId, matchedVersionCount, ...matchedVersion } = m;
                return { kind: 'record', record: { id: recordId, platformKey, interface: 'apply_list' }, matchedVersion, matchedVersionCount, versionCount: versions.get(recordId) ?? 0, observationCount: observations.get(recordId)?.n ?? 0, latestObservationAt: latest,
                    enterpriseIds, enterpriseNames: assigned.flatMap(r => r.enterpriseId != null && r.name ? [r.name] : []), conflicts: [...(observations.get(recordId)?.unverifiable ? ['unverifiable_observation'] : []), ...(enterpriseIds.length > 1 ? ['enterprise_assignment_conflict'] : [])] };
            }) };
    });
}
export function readTargetDeclarationOptions(view: DeclarationView, db: Db): TargetDeclarationOptions {
    return db.transaction(tx => {
        gate(tx);
        const result: TargetDeclarationOptions = { titles: [], declareKinds: [], years: [], statuses: [], batches: [], districts: [], validityDates: [] };
        const columns = view === 'records' ? { titles: p.titleRaw, declareKinds: p.declareKind, years: p.declarationYear, statuses: p.status } : { titles: p.exactTitleRaw, declareKinds: p.exactDeclareKind, years: p.exactYear, statuses: p.exactStatus };
        for (const key of ['titles', 'declareKinds', 'years', 'statuses'] as const) {
            const col = columns[key];
            const conditions = and(sql `${col} is not null`, key === 'years' ? undefined : sql `trim(${col}) <> ''`);
            const selection = { value: sql<unknown> `${col}` };
            const rows = view === 'records'
                ? tx.selectDistinct(selection).from(p).innerJoin(v, eq(v.id, p.versionId)).innerJoin(b, eq(b.id, v.recordId)).where(and(eq(b.interface, 'apply_list'), conditions)).orderBy(key === 'years' ? desc(col) : sql `${col} collate binary`).all()
                : tx.selectDistinct(selection).from(o).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(p, eq(p.observationId, o.id)).where(and(eq(c.interface, 'apply_list'), isolated, conditions)).orderBy(key === 'years' ? desc(col) : sql `${col} collate binary`).all();
            if (key === 'years')
                result.years = rows.flatMap(({ value }) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? [value] : []);
            else {
                // The old DTO/driver permits BLOB cells as well as TEXT; do not stringify.
                result[key] = rows.map(({ value }) => value);
            }
        }
        return result;
    });
}
export function getTargetDeclaration(db: Db, recordId: number): DeclarationDetail {
    if (!Number.isSafeInteger(recordId) || recordId < 1)
        fail(400, 'invalid_declaration_id', 'recordId must be a positive safe integer');
    return db.transaction(tx => {
        const record = tx.select({ id: b.id, platformKey: b.platformKey, interface: b.interface, identityRuleVersion: b.identityRuleVersion, createdAt: b.createdAt }).from(b).where(and(eq(b.id, recordId), eq(b.interface, 'apply_list'))).get();
        if (!record)
            fail(404, 'declaration_not_found', 'Declaration record not found');
        gate(tx, eq(o.recordId, recordId));
        const versionsTotal = tx.select({ n: count() }).from(v).where(eq(v.recordId, recordId)).get()!.n;
        const observationTotal = tx.select({ n: count() }).from(o).where(eq(o.recordId, recordId)).get()!.n;
        const stats = tx.$with('version_activity').as(tx.select({ versionId: o.versionId, n: count().as('n'), first: min(c.queriedAt).as('first'), last: sql<string | null> `max(coalesce(${c.lastCollectedAt},${c.queriedAt}))`.as('last') }).from(o).innerJoin(c, eq(c.id, o.collectionId)).where(eq(o.recordId, recordId)).groupBy(o.versionId));
        const versions = tx.with(stats).select({ ...versionFields, hashAlgorithm: v.hashAlgorithm, contentHash: v.contentHash, createdAt: v.createdAt, observationCount: sql<number> `coalesce(${stats.n},0)`, firstObservedAt: stats.first, lastObservedAt: stats.last }).from(v).leftJoin(p, eq(p.versionId, v.id)).leftJoin(stats, eq(stats.versionId, v.id)).where(eq(v.recordId, recordId)).orderBy(desc(v.id)).limit(DECLARATION_VERSION_LIMIT).all();
        const observations = tx.select({ ...observationFields, keySource: o.keySource, projectionRuleVersion: o.projectionRuleVersion, versionId: o.versionId,
            version: { versionId: vp.versionId, titleRaw: vp.titleRaw, declareKind: vp.declareKind, declarationYear: vp.declarationYear, appliedAt: vp.appliedAt, status: vp.status, nameRaw: vp.nameRaw, usccRaw: vp.usccRaw, ruleVersion: vp.ruleVersion } }).from(o).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(qa, eq(qa.collectionId, c.id)).innerJoin(ra, eq(ra.observationId, o.id)).leftJoin(a, current(tx)).leftJoin(e, eq(e.id, a.enterpriseId)).leftJoin(vp, and(eq(vp.versionId, o.versionId), eq(vp.recordId, o.recordId))).where(eq(o.recordId, recordId)).orderBy(desc(c.queriedAt), desc(ra.oldId)).limit(DECLARATION_OBSERVATION_LIMIT).all();
        return { record: { ...record, interface: 'apply_list' }, versions, observations: observations.map(row => {
            if(row.identityState==='not_indexed' || row.contentState==='not_indexed' || row.keySource==null || row.projectionRuleVersion==null) fail(409,'apply_target_not_indexed','Declaration observation is not indexed');
            return {...row, keySource:row.keySource,projectionRuleVersion:row.projectionRuleVersion,identityState:row.identityState,contentState:row.contentState,version:row.versionId==null?null:{versionId:row.versionId,titleRaw:row.version?.titleRaw??null,declareKind:row.version?.declareKind??null,declarationYear:row.version?.declarationYear??null,appliedAt:row.version?.appliedAt??null,status:row.version?.status??null,nameRaw:row.version?.nameRaw??null,usccRaw:row.version?.usccRaw??null,ruleVersion:row.version?.ruleVersion??null}};
        }), counts: { versions: versionsTotal, observations: observationTotal, versionsTruncated: versionsTotal > versions.length, observationsTruncated: observationTotal > observations.length } };
    });
}
const modeledFields = ['declareKind', 'year', 'appliedAt', 'status', 'nameRaw', 'usccRaw'] as const;
const comparisonFields = ['province', 'status', 'batch', 'declareKind', 'appliedAt', 'awardBatchLabel', 'year'] as const;
/** Alias inputs retain their namespace. No unindexed legacy lookup or archive fallback. */
export function readTargetDeclarationFacts(db: Db, relationIds: number[]): Map<number, PlatformObservationFact> {
    const result = new Map<number, PlatformObservationFact>();
    if (!relationIds.length)
        return result;
    return db.transaction(tx => {
        const original = alias(a, 'original_assignment');
        for (let start = 0; start < relationIds.length; start += 400) {
            const ids = relationIds.slice(start, start + 400);
            gate(tx, inArray(o.id, tx.select({ id: ra.observationId }).from(ra).where(inArray(ra.oldId, ids))), true);
            const rows = tx.select({ relationId: ra.oldId, source: p, version: vp, originalName: original.nameRaw, originalUscc: original.usccRaw })
                .from(ra).innerJoin(o, eq(o.id, ra.observationId)).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(p, eq(p.observationId, o.id))
                .leftJoin(vp, and(eq(vp.versionId, o.versionId), eq(vp.recordId, o.recordId)))
                .leftJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
                .where(and(inArray(ra.oldId, ids), eq(c.interface, 'apply_list'))).all();
            for (const row of rows) {
                const source = row.source, version = row.version, typed = version?.versionId != null;
                const normalized = { province: source.reconciledProvince, status: source.reconciledStatus, batch: source.reconciledBatch, declareKind: source.reconciledDeclareKind, appliedAt: source.reconciledAppliedAt, awardBatchLabel: source.reconciledAwardBatchLabel, year: source.reconciledYear };
                const comparisons = {
                    province: [source.provinceConflict, source.storedProvince, source.parsedProvince], status: [source.statusConflict, source.storedStatus, source.parsedStatus], batch: [source.batchConflict, source.storedBatch, source.parsedBatch],
                    declareKind: [source.declareKindConflict, source.storedDeclareKind, source.parsedDeclareKind], appliedAt: [source.appliedAtConflict, source.storedAppliedAt, source.parsedAppliedAt], awardBatchLabel: [source.awardBatchLabelConflict, source.storedAwardBatchLabel, source.parsedAwardBatchLabel], year: [source.yearConflict, source.storedYear, source.parsedYear],
                } satisfies Record<typeof comparisonFields[number], [
                    number | null,
                    string | number | null,
                    string | number | null
                ]>;
                const conflicts: PlatformNormalizationConflict[] = comparisonFields.flatMap(field => {
                    const [conflict, storedValue, rawValue] = comparisons[field];
                    return conflict && storedValue != null && rawValue != null ? [{ field, storedValue, rawValue }] : [];
                });
                const rawName = typeof row.originalName === 'string' ? row.originalName : null, rawUscc = typeof row.originalUscc === 'string' ? row.originalUscc : null;
                result.set(row.relationId, withArchiveProcessFacts({
                    relationId: row.relationId, interface: 'apply_list', projectionVersionId: typed ? version.versionId : null, projectionRuleVersion: typed ? version.ruleVersion : null, modeledFields: typed ? modeledFields : [],
                    titleRaw: source.sqlFactTitle, nameRaw: typed ? version.nameRaw : rawName, usccRaw: typed ? version.usccRaw : rawUscc,
                    declareKind: typed ? version.declareKind : normalized.declareKind, year: typed ? version.declarationYear : normalized.year, appliedAt: typed ? version.appliedAt : normalized.appliedAt, status: typed ? version.status : normalized.status,
                    batch: normalized.batch, awardBatchLabel: normalized.awardBatchLabel, province: normalized.province,
                    validityDateRaw: null, maintenanceYear: null, maintenanceBatch: null, district: null, awardNote: null, normalizationConflicts: conflicts,
                }, normalized));
            }
        }
        return result;
    });
}
