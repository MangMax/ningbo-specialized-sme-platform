/** #428 real public handler HTTP chain; does not claim compiled Nitro evidence. */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import * as schema from '../db/schema'
import { TITLE_SEED } from '../db/titles'
import type { RosterImportRequest } from '../lib/roster-import-client'
import { createCurrentQualificationAssessmentReader } from '../lib/roster/current-qualification'
import { handleRosterImportRequest } from '../server/utils/roster-import-http'
import { preflightRosterImport, commitRosterImport } from '../server/utils/roster-import'
import { handleRecordCorrespondenceRequest } from '../server/utils/record-correspondence-api'
import { handleEventAnnualProcessRequest } from '../server/utils/event-annual-process-api'
import { startHttpFixture, type HttpFixture, type FixtureRequest } from './helpers/http-fixture'

it('P_closed_public_award', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue428-public-'))
  const sqlite = new Database(join(dir, 'synthetic.sqlite'))
  let api: HttpFixture | undefined
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  try {
    sqlite.pragma('foreign_keys=ON')
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: 'db/migrations' })
    db.insert(schema.title).values([...TITLE_SEED]).run()
    const name = '合成428公开闭合', uscc = '91330211255994457P', title = 'specialized_sme' as const
    // Only the pre-existing official container and file registry are bootstrapped.
    // Published evidence, archives, indexed business identity and decisions use public writes.
    const enterprise = db.insert(schema.enterprise).values({ name, nameNorm: name, usccNorm: uscc }).returning().get()
    const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: title, nameRaw: name, usccRaw: uscc }).returning().get()
    const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024, decidedYear: 2024, batchSeq: 1 }).returning().get()
    const source = `2024年正式认定合成名单\n1 ${name} ${uscc}\n`
    writeFileSync(join(dir, 'notice.txt'), source)
    const file = db.insert(schema.storedFile).values({ relPath: 'notice.txt', filename: 'notice.txt', ext: 'txt', source: 'jxj', kind: 'announcement', titleCode: title, bytes: Buffer.byteLength(source), sha256: hash(source) }).returning().get()
    const document = db.insert(schema.sourceDocument).values({ source: 'jxj', title: '2024年正式认定合成名单', path: 'notice.txt' }).returning().get()
    const token = 'synthetic428-only'
    api = await startHttpFixture({ routes: {
      ...Object.fromEntries((['preflight', 'commit'] as const).map(action => [`/api/roster/import/${action}`, (request: FixtureRequest) => handleRosterImportRequest(action, request, {
        db, apiToken: token, filesDir: dir,
        executeImport: async (database, phase, body, errors, context, options) => phase === 'preflight'
          ? preflightRosterImport(database, body, errors, { ...context, ...options })
          : commitRosterImport(database, body, errors, { ...context, ...options, deferCandidateTasks: true }),
      })])),
      ...Object.fromEntries((['preflight', 'commit'] as const).map(action => [`/api/roster/correspondences/${action}`, (request: FixtureRequest) => handleRecordCorrespondenceRequest({ ...request, action }, { db, apiToken: token })])),
    }, getRoutes: {
      [`/api/roster/events/${event.id}/annual-process`]: request => handleEventAnnualProcessRequest({ ...request, id: event.id }, { db }),
      '/api/roster/correspondences': request => handleRecordCorrespondenceRequest({ ...request, action: 'list' }, { db, apiToken: token }),
    } })
    async function post(path: string, body: unknown) {
      const response = await fetch(api!.baseUrl + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const value = await response.json()
      expect(response.status, JSON.stringify(value)).toBe(200)
      return value
    }
    async function importPublic(input: RosterImportRequest) {
      const plan = await post('/api/roster/import/preflight', input)
      expect(plan.preflight.conflicts).toEqual([])
      if (plan.preflight.officialEvidencePlanHash) input.payload.officialEvidencePlanHash = plan.preflight.officialEvidencePlanHash
      const committed = await post('/api/roster/import/commit', input)
      expect(committed.status, JSON.stringify(committed)).toBe('committed')
    }
    await importPublic({ idempotencyKey: '428-public-evidence', sourceKind: 'announcement', sourceIdentity: 'synthetic/428', payload: {
      officialEvidenceAppends: [{ eventId: event.id, recordId: record.id, enterpriseId: enterprise.id, expectedVersion: 1,
        evidence: { sourceFile: 'notice.txt', attachment: null, listNo: 1, page: null, publishedRow: {
          nameRaw: name, usccRaw: uscc, districtRaw: null, declaration: { kind: 'existing', sourceDocumentId: document.id, basis: '合成声明' },
          storedFileId: file.id, path: file.relPath, sha256: file.sha256!, bytes: file.bytes!, attachment: null, sectionKey: 'awards', listNo: 1, page: null,
          sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic428' }, basis: '真实合成文件逐行捕获',
        } } }],
    } })
    const raw = { id: 'SQ-428-A', qymc: name, tyshxydm: uscc, sblx: '申请', sqsj: '2024-03-01 09:00:00', year: '2024', cszt: '终审通过' }
    const body = JSON.stringify({ zrarData: { grid: { businessListGrid: { pageSet: [raw], page: 1, pageSize: 50, maxCount: 1, maxPage: 1 } } } })
    await importPublic({ idempotencyKey: '428-public-archive', sourceKind: 'platform_archive', sourceIdentity: 'synthetic/428', payload: {
      platformQueries: [{ interface: 'business_list', queryKey: uscc, rdjb: '2', titleCode: title, queriedAt: '2026-05-31T00:00:00Z', status: 'success', rawResponse: body,
        collectionEvidence: { source: 'businessList', status: 'success', effectiveConditions: { uscc, combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] },
          queriedAt: '2026-05-31T00:00:00Z', completedAt: '2026-05-31T00:00:01Z', rows: [raw],
          rawData: { version: 1, rows: [raw], pages: [{ source: 'businessList', rdjb: '2', page: 1, format: 'json', body }] },
          pages: [{ source: 'businessList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }],
          fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
          limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 } },
        relations: [{ sequenceNo: 1, relationKey: raw.id, nameRaw: name, usccRaw: uscc, enterpriseId: enterprise.id, verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields: raw }],
      }],
    } })
    const relations = db.select().from(schema.platformRelation).all()
    expect(relations).toHaveLength(1)
    await importPublic({ idempotencyKey: '428-public-projection', sourceKind: 'platform_archive', sourceIdentity: 'synthetic/428', payload: { platformRecordObservations: [{ relationId: relations[0]!.id }] } })
    expect(db.select().from(schema.platformBusinessObservation).all()).toHaveLength(1)
    const decision = { idempotencyKey: '428-public-support', sourceIdentity: 'synthetic/428', actor: { type: 'user', id: 'synthetic428' }, basis: '逐行核对', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', role: 'supports_award', eventId: event.id, relationId: relations[0]!.id } }] }
    const plan = await post('/api/roster/correspondences/preflight', decision)
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/)
    await post('/api/roster/correspondences/commit', { request: decision, planHash: plan.planHash })
    sqlite.pragma('query_only=ON')
    const changes = sqlite.prepare('SELECT total_changes() n').get()
    const reader = createCurrentQualificationAssessmentReader(sqlite), asOf = Date.parse('2026-06-01T00:00:00Z')
    const legacy = reader.read(enterprise.id, asOf).snapshot
    const legacyBytes = JSON.stringify(legacy)
    try {
      const support = await fetch(`${api.baseUrl}/api/roster/correspondences?eventId=${event.id}`)
      expect(support.status).toBe(200)
      expect((await support.json()).rows).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'confirmed', role: 'supports_award' })]))
      const response = await fetch(`${api.baseUrl}/api/roster/events/${event.id}/annual-process?pageSize=1`)
      expect(response.status).toBe(200)
      const annual = await response.json()
      expect(annual.process.finalQualification.status).toBe('confirmed')
      expect(annual.process.finalQualification.decisionRefs).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'confirmed', requiresRevalidation: false })]))
      expect(annual.sourceGeneration).toBe(hash(JSON.stringify(annual.sourceRefs)))
      expect(legacy.titles).toHaveLength(3)
      const { snapshotId, titles, ...scope } = legacy
      expect(scope).toEqual({ enterpriseId: enterprise.id, asOf: '2026-06-01T00:00:00.000Z', ruleVersion: 'current-roster-116-v8', assessmentVersion: 'enterprise-qualification-407-v1' })
      expect(snapshotId).toBe(hash(JSON.stringify([scope, titles])))
      expect(titles.find(t => t.titleCode === title)!.officialQualification.group).toBe('eligible')
      expect(JSON.stringify(reader.read(enterprise.id, asOf).snapshot)).toBe(legacyBytes)
      expect(sqlite.prepare('SELECT total_changes() n').get()).toEqual(changes)
      console.info('P_closed_public_award guards reached: public support/annual confirmed/full legacy hash/zero-write')
      expect(reader.readPlatformComparison(enterprise.id, asOf, title).comparison.state).toBe('synchronized')
    } finally {
      expect(JSON.stringify(reader.read(enterprise.id, asOf).snapshot)).toBe(legacyBytes)
      expect(sqlite.prepare('SELECT total_changes() n').get()).toEqual(changes)
      expect(sqlite.pragma('query_only', { simple: true })).toBe(1)
    }
  } finally {
    await api?.close()
    sqlite.close()
    // Preserve this owned small database and source file under the lane TMPDIR.
    console.info('P_closed_public_award fixture retained', dir)
  }
})

// Independent public partitions; original P fixture above remains byte-identical.
import { readPlatformComparisonProcesses } from '../server/utils/platform-comparison-input'
type PublicPartition428 = {title:'innovative_sme'|'specialized_sme'|'little_giant';eventType:'award'|'review';opposite:boolean;trace?:'P'|'Z';change?:'unlinked'|'rejected'|'ended'|'candidate'|'source_hash'|'event_revision'|'version_change'|'ABA'|'history_interface'|'future'|'tie'|'unknown_status'|'retry_same'|'potential_later'|'unknown_normalization'}
async function publicPartition428(spec:PublicPartition428) {
  const dir = mkdtempSync(join(tmpdir(), 'issue428-public-'))
  const sqlite = new Database(join(dir, 'synthetic.sqlite'))
  let api: HttpFixture | undefined
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  try {
    sqlite.pragma('foreign_keys=ON')
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: 'db/migrations' })
    db.insert(schema.title).values([...TITLE_SEED]).run()
    const name = '合成428公开闭合', uscc = '91330211255994457P', title = spec.title
    const rdjb = ({innovative_sme:'1',specialized_sme:'2',little_giant:'3'} as const)[title]
    const businessYear=spec.eventType==='review'?2025:2024
    const role=spec.eventType==='review'?'supports_review':'supports_award'
    // Only the pre-existing official container and file registry are bootstrapped.
    // Published evidence, archives, indexed business identity and decisions use public writes.
    const enterprise = db.insert(schema.enterprise).values({ name, nameNorm: name, usccNorm: uscc }).returning().get()
    const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: title, nameRaw: name, usccRaw: uscc }).returning().get()
    const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: spec.eventType, year: 2024, decidedYear: businessYear, reviewOutcome: spec.eventType==='review'?'passed':null, batchSeq: 1 }).returning().get()
    const source = `2024年正式认定合成名单\n1 ${name} ${uscc}\n`
    writeFileSync(join(dir, 'notice.txt'), source)
    const file = db.insert(schema.storedFile).values({ relPath: 'notice.txt', filename: 'notice.txt', ext: 'txt', source: 'jxj', kind: 'announcement', titleCode: title, bytes: Buffer.byteLength(source), sha256: hash(source) }).returning().get()
    const document = db.insert(schema.sourceDocument).values({ source: 'jxj', title: '2024年正式认定合成名单', path: 'notice.txt' }).returning().get()
    const token = 'synthetic428-only'
    api = await startHttpFixture({ routes: {
      ...Object.fromEntries((['preflight', 'commit'] as const).map(action => [`/api/roster/import/${action}`, (request: FixtureRequest) => handleRosterImportRequest(action, request, {
        db, apiToken: token, filesDir: dir,
        executeImport: async (database, phase, body, errors, context, options) => phase === 'preflight'
          ? preflightRosterImport(database, body, errors, { ...context, ...options })
          : commitRosterImport(database, body, errors, { ...context, ...options, deferCandidateTasks: true }),
      })])),
      ...Object.fromEntries((['preflight', 'commit'] as const).map(action => [`/api/roster/correspondences/${action}`, (request: FixtureRequest) => handleRecordCorrespondenceRequest({ ...request, action }, { db, apiToken: token })])),
    }, getRoutes: {
      [`/api/roster/events/${event.id}/annual-process`]: request => handleEventAnnualProcessRequest({ ...request, id: event.id }, { db }),
      '/api/roster/correspondences': request => handleRecordCorrespondenceRequest({ ...request, action: 'list' }, { db, apiToken: token }),
    } })
    async function post(path: string, body: unknown) {
      const response = await fetch(api!.baseUrl + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const value = await response.json()
      expect(response.status, JSON.stringify(value)).toBe(200)
      return value
    }
    async function importPublic(input: RosterImportRequest) {
      const plan = await post('/api/roster/import/preflight', input)
      expect(plan.preflight.conflicts).toEqual([])
      if (plan.preflight.officialEvidencePlanHash) input.payload.officialEvidencePlanHash = plan.preflight.officialEvidencePlanHash
      const committed = await post('/api/roster/import/commit', input)
      expect(committed.status, JSON.stringify(committed)).toBe('committed')
    }
    await importPublic({ idempotencyKey: '428-public-evidence', sourceKind: 'announcement', sourceIdentity: 'synthetic/428', payload: {
      officialEvidenceAppends: [{ eventId: event.id, recordId: record.id, enterpriseId: enterprise.id, expectedVersion: 1,
        evidence: { sourceFile: 'notice.txt', attachment: null, listNo: 1, page: null, publishedRow: {
          nameRaw: name, usccRaw: uscc, districtRaw: null, declaration: { kind: 'existing', sourceDocumentId: document.id, basis: '合成声明' },
          storedFileId: file.id, path: file.relPath, sha256: file.sha256!, bytes: file.bytes!, attachment: null, sectionKey: 'awards', listNo: 1, page: null,
          sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic428' }, basis: '真实合成文件逐行捕获',
        } } }],
    } })
    if(spec.trace==='Z') {
      await importPublic({idempotencyKey:'428-trace-zero',sourceKind:'platform_archive',sourceIdentity:'synthetic/428',payload:{platformQueries:[{
        interface:'recognized_list',queryKey:uscc,rdjb,titleCode:title,queriedAt:'2026-05-31T00:00:00Z',status:'no_record',
        collectionEvidence:{source:'queryBusList',status:'no_record',effectiveConditions:{uscc,combination:'and'},titleScope:{mode:'selected',rdjb:[rdjb]},queriedAt:'2026-05-31T00:00:00Z',completedAt:'2026-05-31T00:00:01Z',rows:[],
          pages:[{source:'queryBusList',rdjb,page:1,status:'success',fetchedCount:0,declaredTotal:0,error:null}],fetchedCount:0,declaredTotal:0,completeness:'complete',fullRange:true,unfinished:[],error:null,
          limits:{maxRequests:100,maxRows:5000,maxDurationMs:60000,pageSize:50}},relations:[]
      }]}})
      sqlite.pragma('query_only=ON')
      traceSmall428(sqlite,enterprise.id,title,'Z',dir)
      return
    }
    const raw = { id: 'SQ-428-A', qymc: name, tyshxydm: uscc, sblx: spec.eventType==='review'?'复核':'申请', sqsj: `${businessYear}-03-01 09:00:00`, year: String(businessYear), cszt: spec.opposite?'终审不通过':'终审通过' }
    const body = JSON.stringify({ zrarData: { grid: { businessListGrid: { pageSet: [raw], page: 1, pageSize: 50, maxCount: 1, maxPage: 1 } } } })
    await importPublic({ idempotencyKey: '428-public-archive', sourceKind: 'platform_archive', sourceIdentity: 'synthetic/428', payload: {
      platformQueries: [{ interface: 'business_list', queryKey: uscc, rdjb, titleCode: title, queriedAt: '2026-05-31T00:00:00Z', status: 'success', rawResponse: body,
        collectionEvidence: { source: 'businessList', status: 'success', effectiveConditions: { uscc, combination: 'and' }, titleScope: { mode: 'selected', rdjb: [rdjb] },
          queriedAt: '2026-05-31T00:00:00Z', completedAt: '2026-05-31T00:00:01Z', rows: [raw],
          rawData: { version: 1, rows: [raw], pages: [{ source: 'businessList', rdjb, page: 1, format: 'json', body }] },
          pages: [{ source: 'businessList', rdjb, page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }],
          fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
          limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 } },
        relations: [{ sequenceNo: 1, relationKey: raw.id, nameRaw: name, usccRaw: uscc, enterpriseId: enterprise.id, verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields: raw }],
      }],
    } })
    const relations = db.select().from(schema.platformRelation).all()
    expect(relations).toHaveLength(1)
    await importPublic({ idempotencyKey: '428-public-projection', sourceKind: 'platform_archive', sourceIdentity: 'synthetic/428', payload: { platformRecordObservations: [{ relationId: relations[0]!.id }] } })
    expect(db.select().from(schema.platformBusinessObservation).all()).toHaveLength(1)
    // Rejection has its own candidate baseline, never a claimed synchronized P.
    const rejectingCandidate = spec.change === 'rejected'
    const initialStatus = rejectingCandidate ? 'candidate' : 'confirmed'
    const decision = { idempotencyKey: '428-public-support', sourceIdentity: 'synthetic/428', actor: { type: 'user', id: 'synthetic428' }, basis: '逐行核对', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create', status: initialStatus, edge: { type: 'event_process', role, eventId: event.id, relationId: relations[0]!.id } }] }
    const plan = await post('/api/roster/correspondences/preflight', decision)
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/)
    await post('/api/roster/correspondences/commit', { request: decision, planHash: plan.planHash })
    sqlite.pragma('query_only=ON')
    let changes = sqlite.prepare('SELECT total_changes() n').get()
    const reader = createCurrentQualificationAssessmentReader(sqlite), asOf = Date.parse('2026-06-01T00:00:00Z')
    const legacy = reader.read(enterprise.id, asOf).snapshot
    let legacyBytes = JSON.stringify(legacy)
    let completedRead = false
    try {
      const support = await fetch(`${api.baseUrl}/api/roster/correspondences?eventId=${event.id}`)
      expect(support.status).toBe(200)
      expect((await support.json()).rows).toEqual(expect.arrayContaining([expect.objectContaining({ status: initialStatus, role, revision: rejectingCandidate ? 1 : 2 })]))
      const response = await fetch(`${api.baseUrl}/api/roster/events/${event.id}/annual-process?pageSize=1`)
      expect(response.status).toBe(200)
      const annual = await response.json()
      expect(annual.process.finalQualification.status).toBe(rejectingCandidate?'eligible':spec.opposite?'none':'confirmed')
      if(rejectingCandidate) {
        expect(annual.process.finalQualification.reasons).toEqual(['decision_required'])
        expect(annual.process.finalQualification.decisionRefs).toEqual([])
      } else if(spec.opposite)expect(annual.process.finalQualification.reasons).toContain('official_result_mismatch')
      else expect(annual.process.finalQualification.decisionRefs).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'confirmed', requiresRevalidation: false })]))
      expect(annual.sourceGeneration).toBe(hash(JSON.stringify(annual.sourceRefs)))
      expect(legacy.titles).toHaveLength(3)
      const { snapshotId, titles, ...scope } = legacy
      expect(scope).toEqual({ enterpriseId: enterprise.id, asOf: '2026-06-01T00:00:00.000Z', ruleVersion: 'current-roster-116-v8', assessmentVersion: 'enterprise-qualification-407-v1' })
      expect(snapshotId).toBe(hash(JSON.stringify([scope, titles])))
      expect(titles.find(t => t.titleCode === title)!.officialQualification.group).toBe('eligible')
      expect(JSON.stringify(reader.read(enterprise.id, asOf).snapshot)).toBe(legacyBytes)
      expect(sqlite.prepare('SELECT total_changes() n').get()).toEqual(changes)
      const processes=sqlite.transaction(()=>readPlatformComparisonProcesses(sqlite,{enterpriseId:enterprise.id,titleCode:title,eventIds:[event.id],selectedQueryIds:db.select().from(schema.platformQuery).all().map(q=>q.id)}))()
      expect(processes).toHaveLength(1)
      expect(processes[0]!.sourceGeneration).toBe(annual.sourceGeneration)
      expect(JSON.stringify(processes[0]!.sourceRefs)).toBe(JSON.stringify(annual.sourceRefs))
      if(rejectingCandidate)expect(processes[0]!.currentDecisionRefs).toEqual(expect.arrayContaining([expect.objectContaining({status:'candidate',revision:1,eventId:event.id,role})]))
      else expect(processes[0]!.currentDecisionRefs).toEqual(expect.arrayContaining([expect.objectContaining({status:'confirmed',revision:2,requiresRevalidation:false,eventId:event.id,role})]))
      const indexed=db.select().from(schema.platformBusinessObservation).all()
      expect(indexed).toHaveLength(1)
      expect(indexed[0]).toMatchObject({identityState:'resolved',contentState:'verified'})
      expect(processes[0]!.sourceRefs.observations.map(o=>[o.recordId,o.versionId])).toEqual([[indexed[0]!.recordId,indexed[0]!.versionId]])
      const comparison=reader.readPlatformComparison(enterprise.id,asOf,title)
      expect(comparison.observation.state).toBe('records')
      expect(comparison.comparison.state).toBe(rejectingCandidate?'not_established':spec.opposite?'unsynchronized':'synchronized')
      expect(comparison.comparison.cycles).toHaveLength(1)
      expect(comparison.comparison.cycles[0]!.reasons).toContain(rejectingCandidate?'source_requires_revalidation':spec.opposite?'same_event_result_not_reflected':'same_event_result_agrees')
      if(spec.change) {
        const generation=annual.sourceGeneration
        const firstObservation=indexed[0]!
        sqlite.pragma('query_only=OFF') // deliberate fixture transition, outside measured reads
        try {
        if(spec.change==='unlinked'||spec.change==='rejected') {
          const current=db.select().from(schema.recordCorrespondence).all()
          expect(current).toHaveLength(1)
          expect(current[0]).toMatchObject(spec.change==='unlinked'?{status:'confirmed',revision:2}:{status:'candidate',revision:1})
          const request={...decision,idempotencyKey:`428-${spec.change}`,operations:[{action:'decide',correspondenceId:current[0]!.id,expectedRevision:current[0]!.revision,status:spec.change}]}
          const preview=await post('/api/roster/correspondences/preflight',request)
          await post('/api/roster/correspondences/commit',{request,planHash:preview.planHash})
        } else if(spec.change==='ended') sqlite.prepare('update record_correspondence set ended_at=?').run('2026-06-01T00:00:00Z')
        else if(spec.change==='candidate') sqlite.prepare("update record_correspondence set status='candidate'").run()
        else if(spec.change==='source_hash') sqlite.prepare('update stored_file set sha256=? where id=?').run('b'.repeat(64),file.id)
        else if(spec.change==='event_revision') sqlite.prepare('update record_event set revision=revision+1 where id=?').run(event.id)
        else if(spec.change==='history_interface') sqlite.prepare("update platform_business_record set interface='apply_list' where id=?").run(firstObservation.recordId)
        else {
          async function archiveNext(status:string,at:string,key:string) {
            const nextRaw={...raw,cszt:status,...(spec.change==='potential_later'?{id:'SQ-428-LATER',year:'',sqsj:`${businessYear}-12-01 09:00:00`}:spec.change==='unknown_normalization'?{id:'SQ-428-UNKNOWN',year:'未知',sblx:'未来业务',sqsj:`${businessYear}-12-01 09:00:00`}:{})}
            const nextBody=JSON.stringify({zrarData:{grid:{businessListGrid:{pageSet:[nextRaw],page:1,pageSize:50,maxCount:1,maxPage:1}}}})
            await importPublic({idempotencyKey:key,sourceKind:'platform_archive',sourceIdentity:'synthetic/428',payload:{platformQueries:[{
              interface:'business_list',queryKey:uscc,rdjb,titleCode:title,queriedAt:at,status:'success',rawResponse:nextBody,
              collectionEvidence:{source:'businessList',status:'success',effectiveConditions:{uscc,combination:'and'},titleScope:{mode:'selected',rdjb:[rdjb]},queriedAt:at,completedAt:at,
                rows:[nextRaw],rawData:{version:1,rows:[nextRaw],pages:[{source:'businessList',rdjb,page:1,format:'json',body:nextBody}]},
                pages:[{source:'businessList',rdjb,page:1,status:'success',fetchedCount:1,declaredTotal:1,error:null}],fetchedCount:1,declaredTotal:1,completeness:'complete',fullRange:true,unfinished:[],error:null,
                limits:{maxRequests:100,maxRows:5000,maxDurationMs:60000,pageSize:50}},
              relations:[{sequenceNo:1,relationKey:nextRaw.id,nameRaw:name,usccRaw:uscc,enterpriseId:enterprise.id,verificationStatus:'confirmed',matchBasis:'uscc',rawFields:nextRaw}]
            }]}})
            const all=db.select().from(schema.platformRelation).all()
            await importPublic({idempotencyKey:key+'-index',sourceKind:'platform_archive',sourceIdentity:'synthetic/428',payload:{platformRecordObservations:[{relationId:all.at(-1)!.id}]}})
          }
          const nextAt=spec.change==='future'?'2027-05-31T00:00:00Z':spec.change==='tie'?'2026-05-31T08:00:00+08:00':'2026-05-31T01:00:00Z'
          if(spec.change==='tie') {
            expect(nextAt).not.toBe('2026-05-31T00:00:00Z')
            expect(Date.parse(nextAt)).toBe(Date.parse('2026-05-31T00:00:00Z'))
          }
          if(spec.change==='future')expect(Date.parse(nextAt)).toBeGreaterThan(asOf)
          await archiveNext(['future','retry_same'].includes(spec.change)?'终审通过':spec.change==='unknown_status'?'未来未知状态':['potential_later','unknown_normalization'].includes(spec.change)?'审核中':'终审不通过',nextAt,'428-version-B')
          if(spec.change==='ABA')await archiveNext('终审通过','2026-05-31T02:00:00Z','428-version-A2')
          const versions=db.select().from(schema.platformBusinessObservation).all()
          expect(versions).toHaveLength(spec.change==='ABA'?3:2)
          if(['potential_later','unknown_normalization'].includes(spec.change))expect(versions[1]!.recordId).not.toBe(firstObservation.recordId)
          else expect(versions.map(o=>o.recordId)).toEqual(Array(versions.length).fill(firstObservation.recordId))
          if(['future','retry_same'].includes(spec.change))expect(versions[1]!.versionId).toBe(firstObservation.versionId)
          else expect(versions[1]!.versionId).not.toBe(firstObservation.versionId)
          if(spec.change==='ABA')expect(versions[2]!.versionId).toBe(firstObservation.versionId)
        }
        } finally {
          // Restore read safety even if public preflight/commit throws. Do not
          // run success assertions here: they must not replace the primary error.
          sqlite.pragma('query_only=ON')
        }
        changes=sqlite.prepare('SELECT total_changes() n').get()
        legacyBytes=JSON.stringify(reader.read(enterprise.id,asOf).snapshot)
        if(spec.change==='history_interface') {
          expect(()=>reader.readPlatformComparison(enterprise.id,asOf,title)).toThrowError(new Error('platform_comparison_scope_unavailable'))
        } else {
          const after=reader.readPlatformComparison(enterprise.id,asOf,title)
          expect(after.comparison.state).toBe('not_established')
          if(['future','tie','unknown_status','potential_later','unknown_normalization'].includes(spec.change))expect(after.comparison.cycles[0]!.reasons).toEqual([['future','potential_later','unknown_normalization'].includes(spec.change)?'coverage_incomplete':'platform_status_unmapped'])
          else expect(after.comparison.cycles[0]!.reasons).toContain('source_requires_revalidation')
          const next=sqlite.transaction(()=>readPlatformComparisonProcesses(sqlite,{enterpriseId:enterprise.id,titleCode:title,eventIds:[event.id],selectedQueryIds:db.select().from(schema.platformQuery).all().map(q=>q.id)}))()
          expect(next).toHaveLength(1)
          if(['future','tie','unknown_status','retry_same','potential_later','unknown_normalization'].includes(spec.change)) {
            expect(next[0]!.sourceRefs.observations).toHaveLength(2)
            const nextResponse=await fetch(`${api.baseUrl}/api/roster/events/${event.id}/annual-process?pageSize=1`)
            expect(nextResponse.status).toBe(200)
            const result=await nextResponse.json()
            expect(result.sourceGeneration).toBe(next[0]!.sourceGeneration)
            if(['tie','unknown_status'].includes(spec.change))expect(result.process.reasons).toContain('latest_status_not_terminal')
            if(spec.change==='tie')expect(result.process.steps[0]!.reasons).toContain('latest_observation_conflict')
            if(spec.change==='unknown_status')expect(result.process.latestStepSummary!.status).toBe('未来未知状态')
            if(['potential_later','unknown_normalization'].includes(spec.change)) {
              expect(result.process.reasons).toContain('potential_later_business_unresolved')
              // Two distinct business identities belong to the complete scope;
              // the public endpoint deliberately returns only the first page.
              expect(result).toMatchObject({ total: 2, page: 1, pageSize: 1 })
              expect(result.process.steps).toHaveLength(1)
              expect(new Set(next[0]!.sourceRefs.observations.map(o => o.recordId)).size).toBe(2)
            }
            if(spec.change==='retry_same') {
              const latestRelation=next[0]!.sourceRefs.observations.at(-1)!.relationId
              expect(next[0]!.currentDecisionRefs.some(d=>d.relationId===latestRelation&&d.status==='confirmed')).toBe(false)
            }
          }
          if(['unlinked','rejected','ended','candidate'].includes(spec.change))expect(next[0]!.sourceGeneration).toBe(generation)
          else expect(next[0]!.sourceGeneration).not.toBe(generation)
          if(spec.change==='unlinked'||spec.change==='rejected')expect(next[0]!.currentDecisionRefs).toEqual(expect.arrayContaining([expect.objectContaining({status:spec.change,revision:spec.change==='unlinked'?3:2})]))
          if(spec.change==='ABA')expect(next[0]!.sourceRefs.observations).toHaveLength(3)
        }
      }
      if(spec.trace==='P')traceSmall428(sqlite,enterprise.id,title,'P',dir)
      completedRead = true
    } finally {
      // A failed fixture/read retains its original error. Successful paths still
      // require all default-byte, zero-write and query-only invariants.
      if (completedRead) {
      expect(JSON.stringify(reader.read(enterprise.id, asOf).snapshot)).toBe(legacyBytes)
      expect(sqlite.prepare('SELECT total_changes() n').get()).toEqual(changes)
      expect(sqlite.pragma('query_only', { simple: true })).toBe(1)
      }
    }
  } finally {
    await api?.close()
    sqlite.close()
    // Preserve this owned small database and source file under the lane TMPDIR.
    console.info('matrix428 fixture retained',spec.title,spec.eventType,spec.opposite?'N':'P',dir)
  }
}
it('matrix428_P_innovative_sme_award',()=>publicPartition428({title:'innovative_sme',eventType:'award',opposite:false}))
it('matrix428_N_innovative_sme_award',()=>publicPartition428({title:'innovative_sme',eventType:'award',opposite:true}))
it('matrix428_P_innovative_sme_review',()=>publicPartition428({title:'innovative_sme',eventType:'review',opposite:false}))
it('matrix428_N_innovative_sme_review',()=>publicPartition428({title:'innovative_sme',eventType:'review',opposite:true}))
it('matrix428_P_specialized_sme_award',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false}))
it('matrix428_N_specialized_sme_award',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:true}))
it('matrix428_P_specialized_sme_review',()=>publicPartition428({title:'specialized_sme',eventType:'review',opposite:false}))
it('matrix428_N_specialized_sme_review',()=>publicPartition428({title:'specialized_sme',eventType:'review',opposite:true}))
it('matrix428_P_little_giant_award',()=>publicPartition428({title:'little_giant',eventType:'award',opposite:false}))
it('matrix428_N_little_giant_award',()=>publicPartition428({title:'little_giant',eventType:'award',opposite:true}))
it('matrix428_P_little_giant_review',()=>publicPartition428({title:'little_giant',eventType:'review',opposite:false}))
it('matrix428_N_little_giant_review',()=>publicPartition428({title:'little_giant',eventType:'review',opposite:true}))
it('transition428_unlinked',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,change:'unlinked'}))
it('transition428_rejected',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,change:'rejected'}))
it('transition428_ended',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,change:'ended'}))
it('transition428_candidate',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,change:'candidate'}))
it('transition428_source_hash',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,change:'source_hash'}))
it('transition428_event_revision',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,change:'event_revision'}))
it('transition428_version_change',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,change:'version_change'}))
it('transition428_ABA',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,change:'ABA'}))
it('transition428_history_interface',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,change:'history_interface'}))

// Instrument only this owned handle. SQL bindings and returned rows stay in memory;
// artifacts contain template hashes/classes/byte counts and EXPLAIN detail only.
function traceSmall428(sqlite:Database.Database, enterpriseId:number, title:PublicPartition428['title'], kind:'P'|'Z', dir:string) {
  type Call={sql:string;method:string;args:unknown[];bytes:number;stack:string;inTransaction:boolean}
  let active:Call[]|null=null
  let transactions:{nested:boolean;mode:string}[]|null=null
  const originalPrepare=sqlite.prepare, originalTransaction=sqlite.transaction
  const digest=(s:string)=>createHash('sha256').update(s).digest('hex')
  const bytes=(x:unknown)=>Buffer.byteLength(JSON.stringify(x??null,(_k,v)=>typeof v==='bigint'?String(v):v))
  sqlite.prepare=function(this:Database.Database,sql:string) {
    const target=originalPrepare.call(this,sql)
    const proxy=new Proxy(target,{get(target,key) {
      const value=Reflect.get(target,key,target)
      if(typeof value!=='function')return value
      if(['get','all','run'].includes(String(key)))return (...args:unknown[])=>{
        const stack=new Error().stack??''
        const result=Reflect.apply(value,target,args)
        if(active)active.push({sql,method:String(key),args,bytes:bytes(result),stack,inTransaction:sqlite.inTransaction})
        return result
      }
      return (...args:unknown[])=>{const result=Reflect.apply(value,target,args);return result===target?proxy:result}
    }})
    return proxy
  } as typeof sqlite.prepare
  sqlite.transaction=function(this:Database.Database,fn: (...args:never[])=>unknown) {
    const target=originalTransaction.call(this,fn)
    const wrap=(value:Function,mode:string):Function=>new Proxy(value,{apply(f,self,args){
      if(transactions)transactions.push({nested:sqlite.inTransaction,mode})
      return Reflect.apply(f,self,args)
    },get(f,key){const v=Reflect.get(f,key,f);return ['default','deferred','immediate','exclusive'].includes(String(key))?wrap(v,String(key)):v}})
    return wrap(target,'default')
  } as typeof sqlite.transaction
  const unchanged=sqlite.prepare('select total_changes() n').get()
  let evidence:Record<string,unknown>={kind,policy:{E:1,S:kind==='P'?1:0,U_RT:kind==='P'?1:0,U_obs:kind==='P'?1:0,emptyIncrement:5,presentIncrement:43,globalEmpty:83,globalPresent:667,W:'policy only, not heap/RSS bound'}}
  try {
    const reader=createCurrentQualificationAssessmentReader(sqlite), asOf=Date.parse('2026-06-01T00:00:00Z')
    const base:Call[]=[],explicit:Call[]=[]
    const baseTx:{nested:boolean;mode:string}[]=[],explicitTx:{nested:boolean;mode:string}[]=[]
    active=base;transactions=baseTx;const legacy=reader.read(enterpriseId,asOf).snapshot
    active=explicit;transactions=explicitTx;const result=reader.readPlatformComparison(enterpriseId,asOf,title)
    active=null;transactions=null
    const signature=(c:Call)=>digest(c.sql+'\n'+c.method)
    const baseCounts=new Map<string,number>()
    for(const c of base)baseCounts.set(signature(c),(baseCounts.get(signature(c))??0)+1)
    const increment:Call[]=[]
    for(const c of explicit){const key=signature(c),n=baseCounts.get(key)??0;if(n)baseCounts.set(key,n-1);else increment.push(c)}
    function classify(c:Call):string {
      if(!/^(select|with)\b/i.test(c.sql.trim()))return /^(begin|commit|rollback|savepoint|release)\b/i.test(c.sql.trim())?'transaction':'UNCLASSIFIED'
      if(c.stack.includes('readQueryComparisonWitnesses'))return 'witness'
      if(c.stack.includes('record-correspondence-ref-validity')||c.stack.includes('annual-correspondence.ts'))return 'enrichment'
      if(c.stack.includes('platform-business-record-read'))return c.sql.includes('platform_business_observation')?'metadata':'group_decisions'
      if(c.stack.includes('event-annual-process-read')) {
        if(c.method==='get')return c.sql.includes('record_event')&&!c.sql.trimStart().startsWith('with')?'header':'admission'
        if(c.method==='all'&&c.sql.trimStart().startsWith('select')) {
          if(c.sql.includes('from "record_evidence"'))return 'F'
          if(c.sql.includes('platform-verify-aclass'))return 'sourceR'
          if(c.sql.includes('collection_evidence'))return 'sourceQ'
          if(c.sql.includes('relation_key'))return 'sourceT'
        }
        if(c.method==='all'&&c.sql.trimStart().startsWith('with'))return 'history'
      }
      return 'UNCLASSIFIED'
    }
    const classified=increment.map(c=>({templateSHA256:signature(c),class:classify(c),method:c.method,payloadBytes:c.bytes,inTransaction:c.inTransaction}))
    const counts:Record<string,number>={};for(const c of classified)counts[c.class]=(counts[c.class]??0)+1
    const explain=increment.filter(c=>classify(c)==='admission').slice(0,1).map(c=>{
      const statement=originalPrepare.call(sqlite,'EXPLAIN QUERY PLAN '+c.sql)
      return {templateSHA256:signature(c),plan:Reflect.apply(statement.all,statement,c.args)}
    })
    evidence={...evidence,defaultD:base.length,explicit:explicit.length,increment:increment.length,defaultInverseRemaining:[...baseCounts.values()].reduce((a,b)=>a+b,0),counts,templates:classified,
      defaultPayloadBytes:base.reduce((n,c)=>n+c.bytes,0),explicitPayloadBytes:explicit.reduce((n,c)=>n+c.bytes,0),projectionBytes:bytes(result),legacyBytes:bytes(legacy),transactions:{default:baseTx,explicit:explicitTx},explain}
    // Freeze receipt before assertions, including overlimit/unclassified failures.
    writeFileSync(join(dir,'sql-control.json'),JSON.stringify(evidence,null,2))
    expect(result.comparison.state).toBe(kind==='P'?'synchronized':'unsynchronized')
    expect(result.scope.legacySnapshotId).toBe(legacy.snapshotId)
    expect([...baseCounts.values()].every(n=>n===0)).toBe(true)
    expect(counts.UNCLASSIFIED??0).toBe(0)
    expect(counts.witness).toBe(2)
    expect(increment.length).toBeLessThanOrEqual(kind==='P'?43:5)
    expect(classified.every(c=>c.inTransaction)).toBe(true)
    expect(baseTx).toHaveLength(1);expect(explicitTx).toHaveLength(1)
    if(kind==='P') {
      expect(counts.F).toBe(1)
      expect([counts.sourceQ,counts.sourceR,counts.sourceT]).toEqual([1,1,1])
      expect(counts.enrichment).toBeLessThanOrEqual(4)
    } else expect(['F','sourceQ','sourceR','sourceT','history','metadata','group_decisions','enrichment'].every(k=>!counts[k])).toBe(true)
    expect(JSON.stringify(reader.read(enterpriseId,asOf).snapshot)).toBe(JSON.stringify(legacy))
    expect(sqlite.prepare('select total_changes() n').get()).toEqual(unchanged)
    expect(sqlite.pragma('query_only',{simple:true})).toBe(1)
  } finally {
    active=null;transactions=null
    sqlite.prepare=originalPrepare;sqlite.transaction=originalTransaction
    writeFileSync(join(dir,'sql-control.json'),JSON.stringify(evidence,null,2))
    console.info('trace428 receipt retained',kind,join(dir,'sql-control.json'))
  }
}
it('trace428_empty_Z',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,trace:'Z'}))
it('trace428_closed_P',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,trace:'P'}))

it('temporal428_future',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,change:'future'}))

it('temporal428_tie',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,change:'tie'}))

it('temporal428_unknown_status',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,change:'unknown_status'}))

it('business428_retry_same',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,change:'retry_same'}))

it('business428_potential_later',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,change:'potential_later'}))

it('business428_unknown_normalization',()=>publicPartition428({title:'specialized_sme',eventType:'award',opposite:false,change:'unknown_normalization'}))
