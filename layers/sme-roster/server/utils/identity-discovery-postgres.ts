import { sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { postgresCanonicalEnterpriseId } from '../../../core/server/public'
import { normalizeUscc } from '../../lib/domain'
import { formerPlatformMembers } from '../../lib/roster/enterprise-list-postgres'
import { duplicateCandidatesFromBatch } from '../../lib/roster/duplicate-merge'
import type { RosterImportItemResult, RosterImportPreflight } from '../../lib/roster-import-client'
import { planPostgresPlatformQueries } from './collection-import-postgres'
import { duplicateMergeSourceIdentity, findIndexedUsccEvidence, projectDuplicateMerge, type PlatformEvidenceIndex, type PlatformEvidenceQuery, type PlatformEvidenceRelation } from './roster-duplicate-merge'
import { prepareUsccClaims, type UsccQueryParse } from './uscc-research-query'
import { platformOnlyUsccTargets, selectUsccTargetRows } from './uscc-research-read'
import { pageUsccChecklist, prepareUsccResearch, projectUsccDictionary, projectUsccResearch, projectUsccTargets, type UsccTargetSnapshot } from './uscc-research'

type Reader = Pick<NodePgDatabase, 'execute'>
const bigintArray = (ids: number[]) => sql`${sql.param(ids)}::bigint[]`
const representable = (text: string) => !text.includes('\0') && text.isWellFormed()
const textArray = (values: string[]) => sql`${sql.param(values)}::text[]`
const currentIdentity = sql`NOT EXISTS (SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id=e.id)`
const usccWhitespace = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u200b\u200c\u200d\u2028\u2029\u202f\u205f\u3000\ufeff'
const withoutUsccWhitespace = (column: SQL) => sql`translate(${column},${usccWhitespace},'')`

function potentiallyMatchingUscc(column: SQL, codes: string[]) {
  const stripped = withoutUsccWhitespace(column)
  // JS case folding can expand non-ASCII characters. Recheck those rows with normalizeUscc.
  return sql`(${column}=ANY(${textArray(codes)}) OR upper(${stripped} COLLATE "C")=ANY(${textArray(codes)})
    OR (octet_length(${stripped}) > length(${stripped})
      AND length(${stripped}) <= ${codes.reduce((max, code) => Math.max(max, code.length), 0)}
      ${codes.some(code => code.startsWith('NAME:')) ? sql.empty() : sql`AND lower(left(${stripped},5) COLLATE "C") <> 'name:'`}))`
}

type Owner = Parameters<typeof projectUsccDictionary>[0][number] & { city: string | null }
type Alias = Parameters<typeof projectUsccDictionary>[1][number]

async function readTargets(db: Reader, owners: Owner[], aliases: Alias[], filter: Extract<UsccQueryParse, { ok: true }>["planFilter"]): Promise<UsccTargetSnapshot> {
  const missing = owners.filter(owner => !normalizeUscc(owner.usccNorm))
  const ids = bigintArray(missing.map(owner => owner.id))
  const { rows: records } = await db.execute<UsccTargetSnapshot['records'][number]>(sql`
    SELECT id::float8 AS id, enterprise_id::float8 AS "enterpriseId", title_code AS "titleCode", source, district
    FROM record WHERE enterprise_id=ANY(${ids}) ORDER BY id`)
  const platformOnly = platformOnlyUsccTargets(records)
  const removed = platformOnly.size ? (await formerPlatformMembers(db)).intersection(platformOnly) : new Set<number>()
  const rows = selectUsccTargetRows(missing, records, aliases, removed, filter)
  const selectedIds = new Set(rows.map(row => row.enterpriseId))
  const enterprises = missing.filter(row => selectedIds.has(row.id))
  const selectedRecords = records.filter(row => selectedIds.has(row.enterpriseId))
  const recordIds = bigintArray(selectedRecords.map(row => row.id))
  const keys = [...new Set(enterprises.map(row => 'name:' + row.nameNorm))].filter(representable)
  const { rows: events } = await db.execute<UsccTargetSnapshot['events'][number]>(sql`
    SELECT id::float8 AS id, record_id::float8 AS "recordId" FROM record_event WHERE record_id=ANY(${recordIds}) ORDER BY id`)
  const { rows: evidence } = await db.execute<UsccTargetSnapshot['evidence'][number]>(sql`
    SELECT record_event_id::float8 AS "recordEventId", source_file AS "sourceFile", attachment,
      list_no::float8 AS "listNo", page::float8 AS page FROM record_evidence
    WHERE record_event_id=ANY(${bigintArray(events.map(row => row.id))}) ORDER BY id`)
  const { rows: differences } = await db.execute<UsccTargetSnapshot['differences'][number]>(sql`
    SELECT id::float8 AS id, enterprise_id::float8 AS "enterpriseId", title_code AS "titleCode", direction,
      recorded_at AS "recordedAt", status, reason_code AS "reasonCode", reason_note AS "reasonNote"
    FROM difference_reason WHERE enterprise_id=ANY(${bigintArray([...selectedIds])}) ORDER BY id`)
  const { rows: traces } = await db.execute<UsccTargetSnapshot['queries'][number] & { count: number }>(sql`
    SELECT qa.old_id::float8 AS id, c.interface, c.query_key AS "queryKey", c.rdjb, c.queried_at AS "queriedAt", c.status,
      (SELECT count(*)::float8 FROM platform_business_observation o
        JOIN platform_legacy_relation_alias ra ON ra.observation_id=o.id
        JOIN platform_observation_assignment original ON original.observation_id=o.id AND original.revision=1
        WHERE o.collection_id=c.id) AS count
    FROM platform_collection c JOIN platform_legacy_query_alias qa ON qa.collection_id=c.id
    WHERE c.query_key=ANY(${textArray(keys)}) ORDER BY qa.old_id`)
  return { rows, enterprises, records: selectedRecords, events, evidence, differences,
    queries: traces, relationCounts: traces.map(row => ({ queryId: row.id, count: row.count })) }
}

async function readEvidence(db: Reader, requested: string[]) {
  const codes = [...new Set(requested.map(normalizeUscc).filter(code => code && representable(code)))]
  const wanted = new Set(codes)
  const index: PlatformEvidenceIndex = { queriesByUscc: new Map(), relationsByQuery: new Map() }
  const exportNames = new Map<string, string>()
  if (codes.length) {
    const { rows } = await db.execute<PlatformEvidenceQuery>(sql`
      SELECT qa.old_id::float8 AS id, c.interface, c.query_key AS "queryKey", c.rdjb, c.queried_at AS "queriedAt"
      FROM platform_collection c JOIN platform_legacy_query_alias qa ON qa.collection_id=c.id
      WHERE ${potentiallyMatchingUscc(sql`c.query_key`, codes)} ORDER BY qa.old_id`)
    const queryIds: number[] = []
    for (const query of rows) {
      const code = normalizeUscc(query.queryKey)
      if (!wanted.has(code)) continue
      queryIds.push(query.id)
      const bucket = index.queriesByUscc.get(code) ?? []
      bucket.push(query)
      index.queriesByUscc.set(code, bucket)
    }
    const { rows: relations } = await db.execute<PlatformEvidenceRelation>(sql`
      SELECT ra.old_id::float8 AS id, qa.old_id::float8 AS "queryId", o.sequence_no::float8 AS "sequenceNo",
        o.source_relation_key AS "relationKey", original.name_raw AS "nameRaw", original.uscc_raw AS "usccRaw"
      FROM platform_legacy_query_alias qa JOIN platform_business_observation o ON o.collection_id=qa.collection_id
      JOIN platform_legacy_relation_alias ra ON ra.observation_id=o.id
      JOIN platform_observation_assignment original ON original.observation_id=o.id AND original.revision=1
      WHERE qa.old_id=ANY(${bigintArray(queryIds)}) ORDER BY qa.old_id,o.sequence_no,ra.old_id`)
    for (const relation of relations) {
      const bucket = index.relationsByQuery.get(relation.queryId) ?? []
      bucket.push(relation)
      index.relationsByQuery.set(relation.queryId, bucket)
    }
    const { rows: exports } = await db.execute<{ uscc: string; name: string | null }>(sql`
      SELECT r.uscc_raw AS uscc, r.name_raw AS name FROM platform_export_row r
      JOIN platform_export_batch b ON b.id=r.batch_id
      WHERE ${potentiallyMatchingUscc(sql`r.uscc_raw`, codes)}
      ORDER BY b.year DESC,b.id DESC,r.source_row_no`)
    for (const row of exports) {
      const code = normalizeUscc(row.uscc)
      if (wanted.has(code) && !exportNames.has(code) && row.name?.trim()) exportNames.set(code, row.name.trim())
    }
  }
  return { index, exportName: (code: string) => exportNames.get(code) ?? null }
}

export function readPostgresUsccResearch(db: NodePgDatabase, parsed: Extract<UsccQueryParse, { ok: true }>) {
  return db.transaction(async tx => {
    const { rows: owners } = await tx.execute<Owner>(sql`
      SELECT e.id::float8 AS id, e.name, e.name_norm AS "nameNorm", e.uscc_norm AS "usccNorm", e.district, e.city
      FROM enterprise e WHERE ${currentIdentity} ORDER BY e.id`)
    const { rows: aliases } = await tx.execute<Alias>(sql`
      SELECT a.enterprise_id::float8 AS "enterpriseId", a.name, a.name_norm AS "nameNorm"
      FROM enterprise_alias a JOIN enterprise e ON e.id=a.enterprise_id
      WHERE a.verification_status='confirmed' AND ${currentIdentity} ORDER BY a.id`)
    const targets = projectUsccTargets(await readTargets(tx, owners, aliases, parsed.planFilter))
    const { claims, verdicts } = prepareUsccClaims(parsed)
    const inputs = prepareUsccResearch(targets, projectUsccDictionary(owners, aliases), claims)
    const plan = projectUsccResearch(inputs, await readEvidence(tx, inputs.codes), claims)
    let step = plan.next()
    while (!step.done) {
      const { conflicts } = await planPostgresPlatformQueries(tx, step.value.payload.platformQueries!)
      step = plan.next(conflicts)
    }
    return {
      checklist: pageUsccChecklist(targets, parsed.filter),
      plan: step.value,
      ...(verdicts ? { verdicts } : {}),
    }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function readPostgresDuplicateMerge(db: NodePgDatabase, batchKey: string) {
  if (!representable(batchKey)) return null
  return db.transaction(async tx => {
    const { rows: [batch] } = await tx.execute<{
      batchId: number; items: RosterImportItemResult[] | null; preflight: RosterImportPreflight | null;
    }>(sql`
      SELECT id::float8 AS "batchId", item_results::json AS items, preflight_result::json AS preflight
      FROM import_batch WHERE idempotency_key=${batchKey}`)
    if (!batch) return null
    const duplicateCandidates = duplicateCandidatesFromBatch(batch.items, batch.preflight)
    const { rows: [executed] } = await tx.execute<{ id: number; idempotencyKey: string }>(sql`
      SELECT id::float8 AS id, idempotency_key AS "idempotencyKey" FROM import_batch
      WHERE source_identity=${duplicateMergeSourceIdentity(batchKey)} AND status='committed' ORDER BY id DESC LIMIT 1`)
    const evidence = await readEvidence(tx, duplicateCandidates.map(candidate => normalizeUscc(candidate.newUscc)))
    async function byId(id: number) {
      const canonical = Number.isSafeInteger(id) ? await postgresCanonicalEnterpriseId(tx, id) : null
      if (canonical == null) return null
      const { rows: [owner] } = await tx.execute<{ id: number; name: string; usccNorm: string | null }>(sql`
        SELECT id::float8 AS id, name, uscc_norm AS "usccNorm" FROM enterprise WHERE id=${canonical}`)
      return owner ?? null
    }
    return projectDuplicateMerge(batchKey, { batchId: batch.batchId, duplicateCandidates }, executed, {
      byId,
      async byUscc(uscc) {
        if (!representable(uscc)) return null
        const { rows: [owner] } = await tx.execute<{ id: number }>(sql`SELECT id::float8 AS id FROM enterprise WHERE uscc_norm=${uscc}`)
        return owner ? byId(owner.id) : null
      },
      evidence: (uscc, name) => findIndexedUsccEvidence(evidence.index, { uscc, name }),
      exportName: evidence.exportName,
    })
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
