import type { CurrentRow, CurrentTitle, CurrentWorkbookFacts } from './current-qualification'

const outcome: Record<string, string> = { passed: '通过', failed: '未通过' }
const queryName: Record<string, string> = { recognized_list: '已认定企业名单', business_list: '企业信息查询', apply_list: '申报信息查询' }
const coverageName: Record<string, string> = { complete:'完整', partial:'部分', failed:'查询失败', unknown:'未知', not_queried:'尚未查询', no_record:'无记录' }
const validityName: Record<string, string> = { valid:'适用', evidence_changed:'证据已变化', premise_invalid:'适用前提无效', no_review:'尚未复核', not_applicable:'不适用', unknown:'未知' }

/** One named contract for exported column order, labels, widths, and values. */
export const CURRENT_COLUMNS = [
  {key:'serial',header:'序号',width:7},
  {key:'name',header:'企业名称',width:30},
  {key:'uscc',header:'统一社会信用代码',width:24},
  {key:'district',header:'区县',width:12},
  {key:'title',header:'称号',width:19},
  {key:'firstYear',header:'首次认定年份',width:13},
  {key:'qualification',header:'认定及复核情况',width:32},
  {key:'publishedNames',header:'公布名称',width:25},
  {key:'aliases',header:'已确认曾用名',width:25},
  {key:'publication',header:'公布对应情况',width:22},
  {key:'notes',header:'情况说明',width:38},
  {key:'references',header:'来源及页码',width:45},
] as const
type CurrentColumnKey = typeof CURRENT_COLUMNS[number]['key']

function fileName(path: string) { return path.replaceAll('\\','/').split('/').at(-1) ?? '' }

/** Archive directories are not designation or publication facts. */
function documentName(path: string) {
  return `《${fileName(path)}》`
}

function eventLabel(event: CurrentWorkbookFacts['events'][number]) {
  const origin = event.year == null ? '原认定年份待核' : `${event.year}年`
  const batch = event.batchSeq == null ? '' : `第${event.batchSeq}批`
  if (event.eventType === 'award') return `${origin}${batch}认定`
  if (event.eventType === 'review') {
    const conclusion = event.decidedYear == null ? '结论年份待核' : `${event.decidedYear}年`
    return `${origin}${batch}原认定批次，${conclusion}复核${outcome[event.reviewOutcome ?? ''] ?? '结论待核'}`
  }
  return event.eventType === 'maintain' ? '平台维护记录' : event.eventType === 'nurture' ? '培育记录' : '来源事件待核'
}

/** Free-text evidence is reduced to readable business clauses, never copied verbatim. */
function safeBusinessReason(value: string) {
  const clauses = value.split(/[；;\n]+/).map(clause => {
    const withoutTraces = clause.replace(/\{[^;；\n]*\}/g,' ')
      .replace(/(?:^|[\s，。])(?:[A-Za-z]:[\\/]|[\\/]|[^\s，。]+[\\/][^\s，。]+[\\/])\S*/g,' ')
      .replace(/["“”][^"“”\n]{1,100}["“”]\s*:/g,' ')
      .replace(/\b[A-Za-z_][\w.:-]*:[^\s，。；;]+/g,' ')
      .replace(/\b[A-Za-z][\w.]*_[\w.]*\b/g,' ')
      .replace(/\b[A-Za-z]*[a-z][A-Z][A-Za-z]*\b/g,' ')
      .replace(/\b[A-Fa-f0-9]{16,}\b/g,' ')
    const tokens = withoutTraces.match(/(?:19|20|21)\d{2}-\d{2}-\d{2}|(?:19|20|21)\d{2}年|第\d{1,2}批|[A-Z]?[a-z]+(?:\s+[A-Z]?[a-z]+){2,}|[\p{Script=Han}]+|[，。、《》（）“”‘’、：？!！]/gu) ?? []
    return tokens.join(' ').replace(/\s+([，。、《）（）“”‘’、：？!！])/g,'$1').replace(/([，。、《）（）“”‘’、：？!！])\s+/g,'$1').trim()
  }).filter(clause => /[\p{Script=Han}]/u.test(clause) || /[A-Z]?[a-z]+(?:\s+[A-Z]?[a-z]+){2,}/.test(clause))
  return clauses.join('；') || null
}

function businessNote(note: string) {
  return note
    .replace(/event:\d+(?:@\d+)?/g,'认定或复核记录')
    .replace(/decision:\d+/g,'已存决定')
    .replace(/explanationValidity:[a-z_]+/g,'')
    .replace(/queryCoverage:[a-z_]+/g,'')
    .replace('正式出处按稳定企业标识关联，未将现名补作公布名','未将现名补作公布名')
    .replace(/；\s*；/g,'；').replace(/；\s*）/g,'）')
}

/** Read-only projection. The qualification reader owns every adjudication. */
export function currentWorkbookValues(title: CurrentTitle, row: CurrentRow, serial: number): (string | null)[] {
  const facts = row.workbookFacts
  if (!facts) throw new Error('Current workbook facts are unavailable')
  const evidenceByEvent = new Map<number, CurrentWorkbookFacts['evidence']>()
  for (const item of facts.evidence) evidenceByEvent.set(item.eventId,[...(evidenceByEvent.get(item.eventId) ?? []),item])
  const events = [...facts.events].sort((a,b) => (a.year ?? 0)-(b.year ?? 0) || (a.batchSeq ?? 0)-(b.batchSeq ?? 0) || a.id-b.id)
  const formal = events.filter(event => event.source === 'jxj' && (event.eventType === 'award' || event.eventType === 'review'))
  const qualifications = formal.map(event => eventLabel(event) + (evidenceByEvent.has(event.id) ? '' : '（正式出处待核）'))
  for (const fact of facts.migration) qualifications.push([
    row.notes.includes('迁入资格已确认') ? '已确认迁入资格' : '历史迁入资格依据',
    fact.awardYear == null ? null : `明确认定年份：${fact.awardYear}年`,
    `核验有效期：${fact.validFrom.slice(0,10)}至${fact.validUntil.slice(0,10)}`,
    safeBusinessReason(fact.basis) ? `依据：${safeBusinessReason(fact.basis)}` : '依据文字含无法安全展示的追踪内容，原始依据请在系统内核对',
  ].filter(Boolean).join('，'))
  const citations = events.flatMap(event => (evidenceByEvent.get(event.id) ?? []).map(item => [
    `${eventLabel(event)}：${event.source === 'jxj' ? title === 'little_giant' ? '宁波经信来源资料' : '宁波市经信局公布资料' : event.source === 'miit' ? '工信部平台导出快照' : '来源属性待核'}\n${documentName(item.sourceFile)}`,
    item.attachment ? `附件：${item.attachment}` : null,
    item.page == null || !/\.pdf$/i.test(fileName(item.sourceFile)) ? null : `PDF第${item.page}页`,
    item.listNo == null ? null : `名单序号${item.listNo}`,
  ].filter(Boolean).join('，')))
  const platform = facts.platform.map(item => `工信部${queryName[item.interface] ?? '平台查询'}，采集时间：${item.queriedAt}`)
  const missing = formal.filter(event => !evidenceByEvent.has(event.id))
  const references = [...citations,...platform,...(missing.length ? [`${missing.length}条认定或复核记录正式出处待核`] : [])]
  const notes = row.notes.filter(note => !note.startsWith('迁入资格断言；公布核对范围：')).map(businessNote)
  for (const scope of facts.migration.map(fact => safeBusinessReason(fact.publicationScope)).filter((value): value is string => !!value)) notes.push('迁入资格断言；公布核对范围：' + scope)
  for (const assessment of facts.assessments) notes.push(`解释依据：${validityName[assessment.explanationValidity] ?? '未知'}；查询覆盖：${coverageName[assessment.queryCoverage] ?? '未知'}${assessment.noRecord ? '；已核对范围内无记录' : ''}`)
  if (facts.correspondenceNeedsRevalidation) notes.push('公布与平台对应关系的来源需重新核实')
  const values: Record<CurrentColumnKey,string|null> = {
    serial:String(serial),name:row.name,uscc:row.uscc,district:row.district,
    title:title === 'little_giant' ? '专精特新“小巨人”' : title === 'specialized_sme' ? '专精特新中小企业' : '创新型中小企业',
    firstYear:row.firstYear == null ? null : String(row.firstYear),qualification:qualifications.join('\n') || null,
    publishedNames:row.publishedNames.join('\n') || null,aliases:row.aliases.join('\n') || null,
    publication:row.publication,notes:notes.join('；') || null,references:references.join('\n') || null,
  }
  return CURRENT_COLUMNS.map(column => values[column.key])
}
