import type Database from 'better-sqlite3'
import type { CurrentRow, CurrentTitle } from './current-qualification'

type EventFact = { id: number; eventType: string; year: number | null; batchSeq: number | null; decidedYear: number | null; reviewOutcome: string | null; source: string }
type EvidenceFact = { eventId: number; sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }
type MigrationFact = { currentQualification: string | null; lifecycleAction: string | null }

const outcome: Record<string, string> = { passed: '通过', failed: '未通过' }
const queryName: Record<string, string> = { recognized_list: '已认定企业名单', business_list: '企业信息查询', apply_list: '申报信息查询' }

function fileName(path: string) {
  // The stored source path is an application location, not a user-facing citation.
  return path.replaceAll('\\', '/').split('/').at(-1) ?? ''
}

function businessNote(note: string) {
  // Qualification is projected from event facts below. This mapping only removes
  // technical trace tokens from the existing Chinese explanation of its limits.
  return note
    .replace(/event:\d+(?:@\d+)?/g, '认定或复核记录')
    .replace(/decision:\d+/g, '已存决定')
    .replace(/explanationValidity:(?:valid|evidence_changed|premise_invalid|unknown)/g, '解释依据适用性待核')
    .replace(/queryCoverage:(?:complete|partial|failed|unknown|not_queried|no_record)/g, '查询范围待核')
    .replace('正式出处按稳定企业标识关联，未将现名补作公布名', '未将现名补作公布名')
}

/** Read-only facts for the three-title workbook. Adjudication remains in readCurrentCandidate. */
export function currentWorkbookValues(db: Database.Database, title: CurrentTitle, row: CurrentRow, serial: number): (string | null)[] {
  const events = db.prepare(`select e.id,e.event_type as eventType,e.year,e.batch_seq as batchSeq,e.decided_year as decidedYear,e.review_outcome as reviewOutcome,r.source
    from record_event e join record r on r.id=e.record_id where r.enterprise_id=? and r.title_code=? order by e.year,e.batch_seq,e.id`).all(row.enterpriseId,title) as EventFact[]
  const evidence = db.prepare(`select e.id as eventId,v.source_file as sourceFile,v.attachment,v.list_no as listNo,v.page
    from record_evidence v join record_event e on e.id=v.record_event_id join record r on r.id=e.record_id
    where r.enterprise_id=? and r.title_code=? order by v.id`).all(row.enterpriseId,title) as EvidenceFact[]
  const supported = new Set(evidence.map(item => item.eventId))
  const qualifications = events.filter(event => event.source === 'jxj' && (event.eventType === 'award' || event.eventType === 'review')).map(event => {
    const origin = event.year == null ? '原认定年份待核' : `${event.year}年`
    const batch = event.batchSeq == null ? '' : `第${event.batchSeq}批`
    const citation = supported.has(event.id) ? '' : '（正式出处待核）'
    if (event.eventType === 'award') return `${origin}${batch}认定${citation}`
    const conclusion = event.decidedYear == null ? '结论年份待核' : `${event.decidedYear}年`
    return `${origin}${batch}原认定批次，${conclusion}复核${outcome[event.reviewOutcome ?? ''] ?? '结论待核'}${citation}`
  })
  const migration = db.prepare(`select current_qualification as currentQualification,lifecycle_action as lifecycleAction from difference_reason
    where enterprise_id=? and title_code=? and reason_code='moved_in' and current_qualification is not null
    order by recorded_at desc,id desc limit 1`).get(row.enterpriseId,title) as MigrationFact | undefined
  if (migration?.currentQualification && migration.lifecycleAction !== 'withdraw') {
    const fact = JSON.parse(migration.currentQualification) as {validFrom?:string;validUntil?:string;awardYear?:number;basis?:string;publicationCheck?:{scope?:string}}
    const current = row.notes.includes('迁入资格已确认')
    qualifications.push([current ? '已确认迁入资格' : '历史迁入资格依据',fact.awardYear == null ? null : `明确认定年份：${fact.awardYear}年`,
      fact.validFrom && fact.validUntil ? `核验有效期：${fact.validFrom.slice(0,10)}至${fact.validUntil.slice(0,10)}` : null,
      fact.basis && !/(?:event:|decision:|sha256:|[\\/]api[\\/]|[A-Za-z]:[\\/])/.test(fact.basis) ? `依据：${fact.basis}` : null].filter(Boolean).join('，'))
  }
  const official = evidence.map(item => [
    `宁波市经信局《${fileName(item.sourceFile)}》`,
    item.attachment ? `附件：${item.attachment}` : null,
    item.page == null || !/\.pdf$/i.test(fileName(item.sourceFile)) ? null : `PDF第${item.page}页`,
    item.listNo == null ? null : `名单序号${item.listNo}`,
  ].filter(Boolean).join('，'))
  const platformIds = row.references.flatMap(ref => /^platform-relation:(\d+) query:\d+$/.exec(ref)?.[1] ? [Number(/^platform-relation:(\d+)/.exec(ref)![1])] : [])
  const platform = platformIds.length ? db.prepare(`select distinct q.interface,q.queried_at as queriedAt from platform_query q
    join platform_relation r on r.query_id=q.id where r.id in (${platformIds.map(() => '?').join(',')})
    order by q.queried_at,q.id`).all(...platformIds) as {interface:string;queriedAt:string}[] : []
  const platformSources = platform.map(item => `工信部${queryName[item.interface] ?? '平台查询'}，采集时间：${item.queriedAt}`)
  const missing = events.filter(event => event.source === 'jxj' && (event.eventType === 'award' || event.eventType === 'review') && !supported.has(event.id))
  const references = [...official,...platformSources,...(missing.length ? [`${missing.length}条认定或复核记录正式出处待核`] : [])]
  const notes = row.notes.map(businessNote)
  if (row.references.some(ref => ref.startsWith('correspondence:') && ref.includes('来源需重新核实'))) notes.push('公布与平台对应关系的来源需重新核实')
  return [String(serial),row.name,row.uscc,row.district,title === 'little_giant' ? '专精特新“小巨人”' : title === 'specialized_sme' ? '专精特新中小企业' : '创新型中小企业',
    row.firstYear == null ? null : String(row.firstYear),qualifications.join('\n') || null,row.publishedNames.join('\n') || null,row.aliases.join('\n') || null,
    row.publication,notes.join('；') || null,references.join('\n') || null]
}
