import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import { isPageCapable } from '../../lib/roster/evidence-page'
import { readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import type { RosterImportItemResult, RosterImportPreflight, RosterImportRequest } from '../../lib/roster-import-client'
import { advancePostgresOfficialEventRevision } from './evidence-revision-postgres'
import { lockPostgresFilePaths, refreshPostgresDerivedFileParts } from './file-parts-postgres'
import {
  ambiguousAnnouncementRepoints, evidenceRepointPlanFingerprint, evidenceRepointPlanFromItems, hasOfficialFactInput,
  indexedEvidenceHashes, projectAnnouncementRepoints, validateAnnouncementIdentityAndEvidence, validateAnnouncementRecord,
  validatePlatformProjectionPayload,
} from './roster-import'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Target = NonNullable<ReturnType<typeof evidenceRepointPlanFromItems>>[number]
type Evidence = typeof schema.recordEvidence.$inferSelect
type ReplayItem = { item: RosterImportItemResult; targets: Target[] }
type ReplayPlan = { items: ReplayItem[]; preflight: RosterImportPreflight }
type SourceBatch = { status: string; kind: string; identity: string; sha256: string | null; items: unknown }

const ids = (values: number[]) => sql`${sql.param(values)}::bigint[]`
const pathsSql = (paths: Set<string>) => sql`${sql.param([...paths])}::text[]`
const coordinate = (owner: number, title: string, source: string) => JSON.stringify([owner, title, source])

function errorItem(kind: string, ref: string, code: string, message: string, field?: string): RosterImportItemResult {
  return { ok: false, kind, ref, error: { code, message, ...(field ? { field } : {}) } }
}

function summarize(items: ReplayItem[]): ReplayPlan {
  return { items, preflight: {
    add: 0, remove: 0, review: 0, update: items.filter(row => row.targets.length).length,
    evidenceRepoints: items.reduce((count, row) => count + row.targets.length, 0),
    conflicts: items.filter(row => !row.item.ok).map(row => row.item),
  } }
}

async function findExistingOwners(tx: Tx, requested: { index: number; name: string; uscc: string }[]) {
  const { rows } = await tx.execute<{ index: number; id: number; cycle: boolean }>(sql`
    WITH RECURSIVE wanted AS (
      SELECT * FROM json_to_recordset(${JSON.stringify(requested)}::json) AS w(index integer,name text,uscc text)
    ), matched AS (
      SELECT w.index,e.id FROM wanted w JOIN enterprise e ON e.uscc_norm=w.uscc WHERE w.uscc<>''
      UNION ALL
      SELECT w.index,owner.id FROM wanted w CROSS JOIN LATERAL (
        SELECT id FROM enterprise e WHERE e.name_norm=w.name
          AND NOT EXISTS(SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id=e.id)
        ORDER BY id LIMIT 2
      ) owner WHERE w.uscc=''
    ), chain(index,id) AS (
      SELECT index,id FROM matched
      UNION ALL
      SELECT c.index,m.into_enterprise_id FROM chain c JOIN enterprise_merge m ON m.from_enterprise_id=c.id
    ) CYCLE id SET cycle USING path
    SELECT index,id::float8 AS id,cycle FROM chain c
    WHERE cycle OR NOT EXISTS(SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id=c.id)`)
  if (rows.some(row => row.cycle)) throw new Error('Enterprise identity merge cycle')
  return Map.groupBy(rows, row => row.index)
}

function savedRepoints(recordId: number, evidence: Map<number, Evidence>,
  recordByEvent: Map<number, number>, targets: Target[], taken: Set<number>, hashes: ReturnType<typeof indexedEvidenceHashes>) {
  const selected: Target[] = []
  const hashConflicts = new Set<'unknown' | 'mismatch'>()
  for (const target of targets) {
    const row = evidence.get(target.id)
    if (taken.has(target.id) || !row || row.recordEventId !== target.recordEventId ||
      recordByEvent.get(target.recordEventId) !== recordId || row.sourceFile !== target.fromSourceFile) continue
    const from = hashes.get(target.fromSourceFile), into = hashes.get(target.sourceFile)
    if (from?.size !== 1 || into?.size !== 1) hashConflicts.add('unknown')
    else if (![...from].every(hash => into.has(hash))) hashConflicts.add('mismatch')
    else {
      taken.add(target.id)
      selected.push(target)
    }
  }
  return { targets: selected, hashConflicts }
}

export async function planPostgresAnnouncementReplay(tx: Tx, request: RosterImportRequest, originalBatch?: SourceBatch): Promise<ReplayPlan> {
  const reject = (item: RosterImportItemResult) => summarize([{ item, targets: [] }])
  if (hasOfficialFactInput(request)) {
    return reject(errorItem('official_evidence', 'payload', 'replay_facts_forbidden', 'Replay cannot capture, append or correct official facts'))
  }
  const payloadError = validatePlatformProjectionPayload(request.payload as Record<string, unknown>, request.sourceKind)
  if (payloadError) return reject(errorItem('platform_observation', 'payload', 'projection_payload_invalid', payloadError, 'platformRecordObservations'))

  const announcement = request.payload.announcement
  if (!announcement) return summarize([])
  const identityErrors = validateAnnouncementIdentityAndEvidence(announcement)
  if (identityErrors.length) return summarize(identityErrors.map(item => ({ item, targets: [] })))
  if (announcement.sourceDocument?.source !== 'jxj' && announcement.sourceDocument?.source !== 'miit') {
    return reject(errorItem('announcement', 'announcement', 'source_document_invalid',
      'announcement.sourceDocument.source 必须是 jxj / miit', 'sourceDocument.source'))
  }

  const records = Array.isArray(announcement.records) ? announcement.records : []
  const checked = records.map((record, index) => validateAnnouncementRecord(announcement, record, index))
  const wanted = checked.flatMap((row, index) => row.error ? [] : [{
    index, name: normalizeName(row.name), uscc: normalizeUscc(records[index]!.enterprise.uscc),
  }])
  const matches = wanted.length ? await findExistingOwners(tx, wanted) : new Map<number, { id: number }[]>()
  const owners = new Map(wanted.flatMap(({ index }) => {
    const candidates = matches.get(index)
    return candidates?.length === 1 ? [[index, candidates[0]!.id] as const] : []
  }))
  const stored = owners.size ? await readPostgresRosterRowsById(tx, schema.record, sql`
    FROM record p WHERE enterprise_id=ANY(${ids([...new Set(owners.values())])})`) : []
  const byCoordinate = new Map(stored.map(row => [coordinate(row.enterpriseId, row.titleCode, row.source), row.id]))
  const recordByIndex = new Map(checked.flatMap((row, index) => {
    const owner = owners.get(index)
    const id = row.error || owner === undefined ? undefined : byCoordinate.get(coordinate(owner, row.titleCode, row.source))
    return id === undefined ? [] : [[index, id] as const]
  }))
  const recordIds = [...new Set(recordByIndex.values())]
  let events = recordIds.length ? await readPostgresRosterRowsById(tx, schema.recordEvent, sql`
    FROM record_event p WHERE record_id=ANY(${ids(recordIds)})`) : []
  const eventIds = events.map(row => row.id)
  const readEvidence = () => readPostgresRosterRowsById(tx, schema.recordEvidence, sql`
    FROM record_evidence p WHERE record_event_id=ANY(${ids(eventIds)})`)

  const sameSource = originalBatch?.status === 'committed' && originalBatch.kind === request.sourceKind &&
    originalBatch.identity === request.sourceIdentity && originalBatch.sha256 === (request.sourceSha256 ?? null)
  const saved = sameSource ? evidenceRepointPlanFromItems(originalBatch.items, evidenceRepointPlanFingerprint(request)) : undefined
  const savedByRecord = Map.groupBy(saved ?? [], target => target.recordId)
  const paths = new Set([request.sourceIdentity])
  for (const row of checked) if (!row.error) {
    for (const event of row.events) {
      for (const evidence of event.evidence ?? []) paths.add(evidence.sourceFile.trim())
    }
  }
  for (const target of saved ?? []) paths.add(target.fromSourceFile).add(target.sourceFile)
  let evidenceRows = eventIds.length ? await readEvidence() : []
  for (const row of evidenceRows) paths.add(row.sourceFile)

  if (eventIds.length) {
    await lockPostgresFilePaths(tx, paths)
    await tx.execute(sql`SELECT id FROM record_event WHERE id=ANY(${ids(eventIds)}) ORDER BY id FOR UPDATE`)
    events = await readPostgresRosterRowsById(tx, schema.recordEvent, sql`FROM record_event p WHERE id=ANY(${ids(eventIds)})`)
    evidenceRows = await readEvidence()
  }
  if (evidenceRows.some(row => !paths.has(row.sourceFile))) {
    return reject(errorItem('record_evidence', 'announcement', 'stale_revision', 'Evidence path changed while planning replay'))
  }
  const { rows: sources } = evidenceRows.length ? await tx.execute<{ path: string; sha256: string | null }>(sql`
    SELECT rel_path AS path,sha256 FROM stored_file WHERE rel_path=ANY(${pathsSql(paths)})
    UNION ALL
    SELECT source_identity,source_sha256 FROM import_batch WHERE status='committed' AND source_kind='announcement'
      AND source_identity=ANY(${pathsSql(paths)})`) : { rows: [] }
  const hashes = indexedEvidenceHashes(request, sources)
  const ambiguous = saved === undefined ? ambiguousAnnouncementRepoints(records, recordByIndex, events, evidenceRows, hashes) : new Set<number>()
  const taken = new Set<number>()
  const eventsByRecord = Map.groupBy(events, row => row.recordId)
  const evidenceById = new Map(evidenceRows.map(row => [row.id, row]))
  const recordByEvent = new Map(events.map(event => [event.id, event.recordId]))
  const evidenceByRecord = Map.groupBy(evidenceRows, row => recordByEvent.get(row.recordEventId))
  return summarize(checked.map((row, index) => {
    const skip = (item: RosterImportItemResult) => ({ item, targets: [] as Target[] })
    if (row.error) return skip(row.error)
    const ref = 'record:' + index
    if ((matches.get(index)?.length ?? 0) > 1) {
      return skip(errorItem('record', ref, 'enterprise_ambiguous',
        '归一化名称命中多家既有企业，缺少统一社会信用代码无法唯一定位；请补充统代后重试', 'enterprise.uscc'))
    }
    const recordId = recordByIndex.get(index)
    const item = { ok: true, kind: 'record', ref: recordId === undefined ? ref : 'record:' + recordId,
      detail: { enterpriseId: owners.get(index) ?? null, titleCode: row.titleCode, source: row.source } }
    if (recordId === undefined) return skip(item)
    const plan = saved === undefined
      ? projectAnnouncementRepoints(recordId, row.events, eventsByRecord.get(recordId) ?? [], evidenceByRecord.get(recordId) ?? [],
        taken, ambiguous, hashes)
      : savedRepoints(recordId, evidenceById, recordByEvent, savedByRecord.get(recordId) ?? [], taken, hashes)
    if (plan.hashConflicts.size) {
      const mismatch = plan.hashConflicts.has('mismatch')
      return skip(errorItem('record_evidence', ref, mismatch ? 'evidence_content_hash_mismatch' : 'evidence_content_hash_unknown',
        mismatch ? '旧出处与目标文件 SHA-256 不同，保留旧出处；请人工核对是否需要追加独立出处'
          : '旧出处或目标文件缺少唯一可验证的 SHA-256，保留旧出处；请人工核对来源身份', 'evidence.sourceFile'))
    }
    return { item, targets: plan.targets }
  }))
}

export async function writePostgresAnnouncementReplay(tx: Tx, request: RosterImportRequest, plan: ReplayPlan) {
  const items: RosterImportItemResult[] = []
  if (plan.preflight.conflicts.length) return { items: plan.items.map(row => row.item), update: 0, evidenceRepointed: 0 }

  const fingerprint = evidenceRepointPlanFingerprint(request)
  const changedEvents = new Map<number, number>()
  const paths = new Set<string>()
  let update = 0, evidenceRepointed = 0
  for (const { item, targets } of plan.items) {
    if (targets.length === 0) { items.push(item); continue }
    let count = 0
    for (const target of targets) {
      const keepPage = isPageCapable(target.sourceFile)
      const { rows: [changed] } = await tx.execute<{ lostPage: boolean; revision: number }>(sql`
        WITH previous AS (
          SELECT v.id,v.page,e.revision FROM record_evidence v JOIN record_event e ON e.id=v.record_event_id
          WHERE v.id=${target.id} AND v.source_file=${target.fromSourceFile}
            AND e.id=${target.recordEventId} AND e.record_id=${target.recordId}
        )
        UPDATE record_evidence v SET source_file=${target.sourceFile},page=CASE WHEN ${keepPage} THEN v.page ELSE NULL END
        FROM previous p WHERE v.id=p.id AND v.source_file=${target.fromSourceFile}
        RETURNING (NOT ${keepPage} AND p.page IS NOT NULL) AS "lostPage",p.revision::float8 AS revision`)
      if (!changed) continue
      count++
      if (changed.lostPage) changedEvents.set(target.recordEventId, changed.revision)
      paths.add(target.fromSourceFile).add(target.sourceFile)
    }
    update++
    evidenceRepointed += count
    items.push({ ...item, detail: {
      enterpriseId: item.detail?.enterpriseId, recordId: targets[0]!.recordId, evidenceRepointed: count,
      evidenceRepointTargets: targets, evidenceRepointPlanFingerprint: fingerprint, skipped: 0, rowsWritten: 0,
    } })
  }
  for (const [eventId, revision] of changedEvents) await advancePostgresOfficialEventRevision(tx, eventId, revision)
  await refreshPostgresDerivedFileParts(tx, paths)
  return { items, update, evidenceRepointed }
}
