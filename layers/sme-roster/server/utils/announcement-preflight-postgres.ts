import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { postgresCanonicalEnterpriseId } from '../../../core/server/public'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import { diagnoseOfficialEventFields } from '../../lib/roster/current-qualification'
import { readPostgresLegacyQualification } from '../../lib/roster/current-qualification-postgres'
import { readPostgresRosterRowsById } from '../../lib/roster/postgres-rows'
import { usccFormatVerdict } from '../../lib/roster/uscc-research'
import type {
  RosterImportEvent, RosterImportItemResult, RosterImportPreflight, RosterImportQualificationDiagnostic, RosterImportRequest,
} from '../../lib/roster-import-client'
import {
  checkOfficialOuterDocument, officialFactFailure, officialPlanDigest, officialPublishedRowSchema,
  projectOfficialDeclaration, type OfficialClaimChange, type OfficialCoordinate, type OfficialEvidenceLocatorMove,
} from './official-evidence-plan'
import { planPostgresOfficialEvidenceChanges } from './official-evidence-plan-postgres'
import {
  ambiguousAnnouncementRepoints, announcementEvidenceCoordinate, eventCoordinates, groupNewAnnouncementEvidence,
  hasOfficialFactInput, indexedEvidenceHashes, matchesEventCoordinates, projectAnnouncementRepoints,
  validateAnnouncementIdentityAndEvidence, validateAnnouncementRecord,
} from './roster-import'
import { validateRosterImportPageCounts } from './roster-import-page-validation'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Enterprise = { id: number; name: string; nameNorm: string; usccNorm: string | null }
type Announcement = NonNullable<RosterImportRequest['payload']['announcement']>
type Options = { pageCountErrors?: readonly RosterImportItemResult[]; filesDir?: string }

const texts = (values: Iterable<string>) => sql`${sql.param([...new Set(values)])}::text[]`
const ids = (values: Iterable<number>) => sql`${sql.param([...new Set(values)])}::bigint[]`
const identityKey = (nameNorm: string, uscc: string | null) => uscc ? `uscc:${uscc}` : `name:${nameNorm}`
const recordKey = (owner: number, title: string, source: string) => JSON.stringify([owner, title, source])

async function readIdentities(tx: Tx, records: Announcement['records']) {
  const input = records.map(row => {
    const name = typeof row?.enterprise?.name === 'string' ? row.enterprise.name.trim() : ''
    return { name, nameNorm: normalizeName(name), requestedUscc: normalizeUscc(row?.enterprise?.uscc) || null }
  })
  const names = texts(input.map(row => row.nameNorm))
  const codes = texts(input.flatMap(row => row.requestedUscc ? [row.requestedUscc] : []))
  const { rows } = await tx.execute<Enterprise & { merged: boolean }>(sql`
    SELECT id::float8 AS id, name, name_norm AS "nameNorm", uscc_norm AS "usccNorm",
      EXISTS (SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id=e.id) AS merged
    FROM enterprise e WHERE name_norm=ANY(${names}) OR uscc_norm=ANY(${codes}) ORDER BY id`)
  const byName = Map.groupBy(rows.filter(row => !row.merged), row => row.nameNorm)
  const byUscc = new Map<string, number>()
  for (const row of rows) {
    if (!row.usccNorm) continue
    const owner = row.merged ? await postgresCanonicalEnterpriseId(tx, row.id) : row.id
    if (owner !== null) byUscc.set(row.usccNorm, owner)
  }
  const batchCodes = Map.groupBy(input.filter(row => row.name && row.requestedUscc), row => row.nameNorm)
  const identities = input.map(({ name, nameNorm, requestedUscc }) => {
    const existing = byName.get(nameNorm) ?? []
    let uscc = requestedUscc
    let ambiguous = false
    if (!uscc && name) {
      const candidates = new Map<string, string | null>()
      for (const row of existing) {
        const code = usccFormatVerdict(row.usccNorm) === 'ok' ? normalizeUscc(row.usccNorm) : null
        candidates.set(code ? identityKey(nameNorm, code) : `enterprise:${row.id}`, code)
      }
      for (const row of batchCodes.get(nameNorm) ?? []) {
        candidates.set(identityKey(nameNorm, row.requestedUscc), row.requestedUscc)
      }
      ambiguous = candidates.size > 1 || existing.length > 1
      if (candidates.size === 1) uscc = candidates.values().next().value ?? null
    }
    const owner = (uscc ? byUscc.get(uscc) : existing[0]?.id) ?? null
    return { name, nameNorm, requestedUscc, uscc, owner, ambiguous, key: identityKey(nameNorm, uscc) }
  })
  return { identities, byName }
}

async function readQualification(tx: Tx, request: RosterImportRequest, result: RosterImportPreflight,
  targets: ReadonlyMap<string, number | null>, diagnostics: RosterImportQualificationDiagnostic[]) {
  if (!diagnostics.length) return
  result.qualificationDiagnostics = diagnostics
  if (result.conflicts.length) return
  if (Object.entries(request.payload).some(([key, value]) =>
    key !== 'announcement' && key !== 'officialEvidencePlanHash' && value != null && (!Array.isArray(value) || value.length > 0))) {
    result.qualificationReadback = { stage: 'before', status: 'not_retained', target: null, reason: 'scope_not_established' }
    return
  }
  if (targets.size > 1) {
    const enterpriseIds = [...new Set([...targets.values()].filter((id): id is number => id !== null))].sort((a, b) => a - b)
    result.qualificationReadback = { stage: 'before', status: 'not_retained', reason: 'multiple_targets', target: null, enterpriseIds }
    return
  }
  const enterpriseId = targets.values().next().value ?? null
  if (enterpriseId === null) {
    result.qualificationReadback = { stage: 'before', status: 'not_retained', reason: 'new_target', target: null }
    return
  }
  const target = { enterpriseId }
  try {
    const assessment = await tx.transaction(nested => readPostgresLegacyQualification(nested, enterpriseId, Date.now()))
    const captured = { stage: 'before' as const, status: 'captured' as const, target, assessment }
    const requiredBytes = Buffer.byteLength(JSON.stringify(captured), 'utf8')
    result.qualificationReadback = requiredBytes <= 65536 ? captured
      : { stage: 'before', status: 'unavailable', reason: 'response_limit', target, requiredBytes }
  } catch {
    result.qualificationReadback = { stage: 'before', status: 'unavailable', reason: 'read_unavailable', target }
  }
}

async function planRawCaptureHash(tx: Tx, request: RosterImportRequest, announcement: Announcement,
  identities: Awaited<ReturnType<typeof readIdentities>>['identities'],
  prior: ReadonlyMap<number, number>, eventsByRecord: ReadonlyMap<number, typeof schema.recordEvent.$inferSelect[]>,
  repoints: readonly OfficialEvidenceLocatorMove[], filesDir?: string) {
  const { records } = announcement
  if (!Array.isArray(records)) officialFactFailure('invalid_input', 'announcement.records must be an array', 409)
  const rawEvents = records.map(row => Array.isArray(row.events) ? row.events : [])
  const count = rawEvents.flat().reduce((n, event) => n + (Array.isArray(event.evidence)
    ? event.evidence.filter(link => link.publishedRow !== undefined).length : 0), 0)
  if (count > 100) officialFactFailure('input_limit', 'At most 100 new official fact operations', 400)
  if (!count) officialFactFailure('invalid_input', 'Opt-in official request has no fact operations', 409)

  const exists = (index: number, event: RosterImportEvent) => {
    const stored = prior.get(index)
    return stored !== undefined && eventsByRecord.get(stored)?.some(row => matchesEventCoordinates(row, eventCoordinates(stored, event)))
  }
  const ownerToken = (index: number) => {
    const { owner, key } = identities[index]!
    return owner === null ? 'pending:' + key : 'enterprise:' + owner
  }
  const grouped = groupNewAnnouncementEvidence(announcement, records, index => ({ key: ownerToken(index) }),
    (index, _title, _source, event) => !!exists(index, event))
  const changes: OfficialClaimChange[] = []
  const unknownClaims: { ref: string; coordinate: OfficialCoordinate }[] = []
  const coordinateKinds = new Map<string, boolean>()
  const declarations = new Map<number, typeof schema.sourceDocument.$inferSelect>()

  for (const [index, record] of records.entries()) {
    const owner = ownerToken(index)
    const plannedEvents = grouped.eventsByRecord.get(index) ?? []
    for (const event of plannedEvents) {
      if (Array.isArray(event.evidence) && event.evidence.length > 300 && event.evidence.some(link => link.publishedRow !== undefined)) {
        officialFactFailure('source_limit', 'Final new event evidence exceeds 300', 413)
      }
    }
    for (const [eventIndex, event] of rawEvents[index]!.entries()) {
      const eventKey = `${owner}:${record.titleCode}:${officialPlanDigest(eventCoordinates(0, event))}`
      const links = Array.isArray(event.evidence) ? event.evidence : []
      const groupedOccurrence = grouped.groupedOccurrences.has(`${index}:${eventIndex}`)
      for (const link of links) {
        const key = officialPlanDigest({ eventKey, ...announcementEvidenceCoordinate(link, groupedOccurrence) })
        const typed = link.publishedRow !== undefined
        if (coordinateKinds.has(key) && (typed || coordinateKinds.get(key))) {
          officialFactFailure('ambiguous_target', 'Typed new capture coordinate must be stated once across the batch', 409)
        }
        coordinateKinds.set(key, typed)
      }
      if (!links.some(link => link.publishedRow !== undefined)) continue
      if ((record.source ?? announcement.sourceDocument.source) !== 'jxj') {
        officialFactFailure('target_mismatch', 'Published facts belong to official jxj events', 409)
      }
      if (links.length > 300) officialFactFailure('source_limit', 'Event evidence exceeds 300', 413)
      if (exists(index, event)) {
        officialFactFailure('explicit_append_required', 'Existing event requires exact officialEvidenceAppends; ordinary duplicate import adds no facts', 409)
      }
      for (const [linkIndex, link] of links.entries()) {
        if (link.publishedRow === undefined) continue
        const parsed = officialPublishedRowSchema.safeParse(link.publishedRow)
        if (!parsed.success) officialFactFailure('invalid_input', 'Full explicit publishedRow required', 409)
        const { declaration } = link.publishedRow
        if (declaration.kind === 'existing' && !declarations.has(declaration.sourceDocumentId)) {
          const [doc] = await readPostgresRosterRowsById(tx, schema.sourceDocument, sql`
            FROM source_document p WHERE p.id=${declaration.sourceDocumentId}`)
          if (doc) declarations.set(doc.id, doc)
        }
        checkOfficialOuterDocument(projectOfficialDeclaration(declaration,
          declaration.kind === 'existing' ? declarations.get(declaration.sourceDocumentId) : undefined), announcement.sourceDocument)
        const ref = `capture:${index}:${eventIndex}:${linkIndex}`
        changes.push({ ref, evidenceId: ref, eventId: 'event:' + eventKey, owner, titleCode: record.titleCode,
          coordinate: announcementEvidenceCoordinate(link), publishedRow: link.publishedRow, expectedRowRevision: 0 })
      }
    }
    for (const [eventIndex, event] of plannedEvents.entries()) {
      if (exists(index, event)) continue
      const links = Array.isArray(event.evidence) ? event.evidence : []
      for (const [linkIndex, link] of links.entries()) {
        if (link.publishedRow === undefined) unknownClaims.push({ ref: `legacy:${index}:${eventIndex}:${linkIndex}`, coordinate: announcementEvidenceCoordinate(link) })
      }
    }
  }
  const facts = await planPostgresOfficialEvidenceChanges(tx, changes, filesDir, undefined, unknownClaims, repoints)
  const { officialEvidencePlanHash: _provided, ...payload } = request.payload
  return officialPlanDigest({ request: { ...request, sourceSha256: request.sourceSha256 ?? null, payload },
    facts: facts.planHash, originalVersions: [], ownerMap: [] })
}

/** Preview raw rows before intake review on the caller's repeatable-read snapshot. */
export async function planPostgresRawAnnouncementPreflight(tx: Tx, request: RosterImportRequest, options: Options = {}): Promise<RosterImportPreflight> {
  const announcement = request.payload.announcement
  const conflicts = [
    ...validateAnnouncementIdentityAndEvidence(announcement),
    ...(options.pageCountErrors ?? (options.filesDir ? await validateRosterImportPageCounts(request, options.filesDir) : [])),
  ]
  const duplicateCandidates: NonNullable<RosterImportPreflight['duplicateCandidates']> = []
  const result: RosterImportPreflight = { add: 0, update: 0, remove: 0, review: 0, conflicts, evidenceRepoints: 0, duplicateCandidates }
  if (conflicts.length || !announcement) return result
  const source = announcement.sourceDocument?.source
  if (!announcement.sourceDocument || !schema.record.source.enumValues.includes(source)) {
    conflicts.push({ ok: false, kind: 'announcement', ref: 'announcement', error: {
      code: 'source_document_invalid', message: 'announcement.sourceDocument.source 必须是 jxj / miit', field: 'sourceDocument.source',
    } })
    return result
  }
  const records = Array.isArray(announcement.records) ? announcement.records : []
  const { identities, byName } = await readIdentities(tx, records)
  const checked = records.map((row, index) => validateAnnouncementRecord(announcement, row, index))
  const owners = identities.flatMap(row => row.owner ?? [])
  const stored = owners.length ? await readPostgresRosterRowsById(tx, schema.record, sql`
    FROM record p WHERE enterprise_id=ANY(${ids(owners)})`) : []
  const byCoordinate = new Map([...stored].reverse().map(row => [recordKey(row.enterpriseId, row.titleCode, row.source), row.id]))
  const prior = new Map(checked.flatMap((row, index) => {
    const { owner, ambiguous } = identities[index]!
    if (row.error || owner === null || ambiguous) return []
    const id = byCoordinate.get(recordKey(owner, row.titleCode, row.source))
    return id === undefined ? [] : [[index, id] as const]
  }))
  const events = prior.size ? await readPostgresRosterRowsById(tx, schema.recordEvent, sql`
    FROM record_event p WHERE record_id=ANY(${ids(prior.values())})`) : []
  const evidence = events.length ? await readPostgresRosterRowsById(tx, schema.recordEvidence, sql`
    FROM record_evidence p WHERE record_event_id=ANY(${ids(events.map(row => row.id))})`) : []
  const paths = texts([...evidence.map(row => row.sourceFile), ...checked.flatMap(row =>
    row.events?.flatMap(event => Array.isArray(event.evidence)
      ? event.evidence.map(link => announcementEvidenceCoordinate(link).sourceFile) : []) ?? [])])
  const { rows: hashes } = evidence.length ? await tx.execute<{ path: string; sha256: string | null }>(sql`
    SELECT rel_path AS path, sha256 FROM stored_file WHERE rel_path=ANY(${paths})
    UNION ALL
    SELECT source_identity, source_sha256 FROM import_batch WHERE status='committed' AND source_kind='announcement'
      AND source_identity=ANY(${paths})`) : { rows: [] }
  const hashIndex = indexedEvidenceHashes(request, hashes)
  const ambiguousRepoints = ambiguousAnnouncementRepoints(records, prior, events, evidence, hashIndex)
  const eventsByRecord = Map.groupBy(events, row => row.recordId)
  const claimed = new Set<number>()
  const planned = new Set<string>()
  const creates = new Set<string>()
  const earlierByName = new Map<string, Omit<Enterprise, 'id'>[]>()
  const targets = new Map<string, number | null>()
  const diagnostics: RosterImportQualificationDiagnostic[] = []
  const repoints: OfficialEvidenceLocatorMove[] = []
  for (const [index, row] of checked.entries()) {
    const ref = `record:${index}`
    const { name, owner, ambiguous, key, nameNorm, uscc, requestedUscc } = identities[index]!
    const raw = records[index]
    const title = typeof raw?.titleCode === 'string' ? raw.titleCode.trim() : ''
    const channel = (typeof raw?.source === 'string' && raw.source.trim()) || source
    const coordinate = JSON.stringify([key, title, channel])
    const reusedInBatch = planned.has(coordinate)
    const create = name.length > 0 && owner === null && !ambiguous && !creates.has(key)
    const earlier = earlierByName.get(nameNorm) ?? []
    // Preserve the raw preview's first-create accounting even when that row has an item error.
    if (create) {
      creates.add(key)
      planned.add(coordinate)
      earlierByName.set(nameNorm, [...earlier, { name, nameNorm, usccNorm: uscc }])
    }
    if (row.error) {
      conflicts.push(row.error)
      continue
    }
    if (ambiguous) {
      conflicts.push({ ok: false, kind: 'record', ref, error: { code: 'enterprise_ambiguous', field: 'enterprise.uscc',
        message: '归一化名称命中多家既有企业，缺少统一社会信用代码无法唯一定位；请补充统代后重试' } })
      continue
    }
    const recordId = prior.get(index)
    if (recordId !== undefined) {
      const repoint = projectAnnouncementRepoints(recordId, row.events, eventsByRecord.get(recordId) ?? [], evidence, claimed, ambiguousRepoints, hashIndex)
      if (repoint.hashConflicts.size) {
        const mismatch = repoint.hashConflicts.has('mismatch')
        conflicts.push({ ok: false, kind: 'record_evidence', ref, error: { field: 'evidence.sourceFile',
          code: mismatch ? 'evidence_content_hash_mismatch' : 'evidence_content_hash_unknown',
          message: mismatch ? '旧出处与目标文件 SHA-256 不同，保留旧出处；请人工核对是否需要追加独立出处'
            : '旧出处或目标文件缺少唯一可验证的 SHA-256，保留旧出处；请人工核对来源身份' } })
        continue
      }
      if (repoint.targets.length) {
        result.update++
        result.evidenceRepoints += repoint.targets.length
        repoints.push(...repoint.targets)
      }
    } else if (!reusedInBatch) result.add++
    if (!requestedUscc) result.review++
    const targetKey = owner === null ? `new:${key}` : `enterprise:${owner}`
    if (row.source === 'jxj') diagnostics.push(...row.events.map((event, eventIndex) =>
      ({ ref: `${ref}#${eventIndex}`, eventType: event.eventType, ...diagnoseOfficialEventFields(event) })))
    targets.set(targetKey, owner)

    if (!create) continue
    for (const twin of [...(byName.get(nameNorm) ?? []), ...earlier.map(row => ({ ...row, id: null }))]) {
      duplicateCandidates.push({ basis: 'same_name_norm', nameNorm, name: row.name, sourceRef: ref,
        existingEnterpriseId: twin.id, existingEnterpriseName: twin.name, existingUscc: twin.usccNorm,
        newEnterpriseId: null, newUscc: uscc })
    }
  }
  if (!conflicts.length && hasOfficialFactInput(request) &&
      request.payload.officialEvidenceAppends === undefined && request.payload.officialEvidenceCorrections === undefined) {
    try {
      result.officialEvidencePlanHash = await planRawCaptureHash(tx, request, announcement, identities, prior, eventsByRecord, repoints, options.filesDir)
      result.update++
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || !('statusCode' in error)) throw error
      conflicts.push({ ok: false, kind: 'official_evidence', ref: 'payload', error: { code: String(error.code), message: error.message } })
    }
  }
  await readQualification(tx, request, result, targets, diagnostics)
  return result
}
