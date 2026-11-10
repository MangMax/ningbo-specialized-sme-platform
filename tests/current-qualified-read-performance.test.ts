import Database from 'better-sqlite3'
import { afterAll, expect, it, vi } from 'vitest'
import { currentExport118Fixture, year } from './helpers/current-export-118'
import { listCurrentQualified } from '../lib/roster/current-qualified-query'
import { schema as s } from '../db/client'
import { readCurrentQualificationAssessment } from '../lib/roster/current-qualification'

const f = currentExport118Fixture()
afterAll(() => f.close())

it('counts independently effective titles while retaining full giant evidence and fresh inherited eligibility', () => {
  f.resetBusiness()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${year}-06-01T00:00:00Z`))
  const candidates = Array.from({ length: 30 }, (_, i) => f.candidate('Independent ' + i))
  for (const { enterprise } of candidates) f.addRecord(enterprise.id, enterprise.name, [{ eventType: 'award', year, batchSeq: 1 }], 'little_giant')
  const inherited = f.candidate('Inherited', [{ eventType: 'award', year: year - 8, batchSeq: 1 }])
  const giant = f.addRecord(inherited.enterprise.id, inherited.enterprise.name, [{ eventType: 'award', year, batchSeq: 1 }], 'little_giant')
  const db = f.db.$client, prepare = db.prepare.bind(db)
  let giantEventReads = 0
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql)
    if (sql.startsWith('select e.id,e.event_type as eventType,')) {
      const all = statement.all.bind(statement)
      statement.all = ((...args: any[]) => {
        if (args[1] === 'little_giant') giantEventReads++
        return all(...args)
      }) as any
    }
    return statement
  })
  try {
    const result = listCurrentQualified(db, { titleCode: 'specialized_sme', pageSize: 1 })
    const diagnosticReads = giantEventReads
    expect(result.total).toBe(31)
    expect(result.options.recognitionYears).toEqual([year - 8, year])
    expect(result.rows.map(row => row.enterpriseId)).toEqual([candidates[0]!.enterprise.id])
    const full = readCurrentQualificationAssessment(db, candidates[0]!.enterprise.id, Date.now())
    expect(result.rows[0]!.qualificationAssessment).toEqual(full)
    expect(full.titles[0]!.evidence).toEqual([expect.objectContaining({ eventType: 'award', year })])
    expect(result.rows[0]!.notes.join(' ')).toContain('按有效小巨人资格计入')
    db.prepare('update record_event set year=? where record_id=?').run(year - 8, giant.id)
    const next = listCurrentQualified(db, { titleCode: 'specialized_sme', pageSize: 200 })
    expect(next.total).toBe(30)
    expect(next.rows.map(row => row.enterpriseId)).toEqual(candidates.map(c => c.enterprise.id))
    // Diagnostic budget only; the independent assertions above establish behavior.
    expect(diagnosticReads).toBeLessThan(10)
  } finally { spy.mockRestore(); vi.useRealTimers() }
})

it('bounds repeated preparation and display reference reads while counting every candidate', () => {
  f.resetBusiness()
  const ids: number[] = []
  f.db.$client.transaction(() => {
    for (let i=0; i<60; i++) {
      const c=f.candidate('Prepared '+String(i).padStart(3,'0'))
      ids.push(c.enterprise.id)
      const query=f.db.insert(s.platformQuery).values({interface:'business_list',queryKey:c.enterprise.usccNorm!,titleCode:'specialized_sme',rdjb:'2',queriedAt:'2026-01-01T00:00:00Z',status:'failed'}).returning().get()
      f.db.insert(s.platformRelation).values({queryId:query.id,enterpriseId:c.enterprise.id,sequenceNo:1,verificationStatus:'pending'}).run()
    }
  })()
  const db=f.db.$client, original=db.prepare.bind(db)
  let displayReads=0
  const prepared=vi.spyOn(db,'prepare').mockImplementation((sql:string) => {
    const statement=original(sql)
    if (sql.startsWith('select r.id,r.query_id as queryId,') && sql.includes('from platform_relation r join platform_query q')) {
      const all=statement.all.bind(statement)
      statement.all=((...args:any[]) => { displayReads++; return all(...args) }) as any
    }
    return statement
  })
  try {
    const result=listCurrentQualified(db,{titleCode:'specialized_sme',page:2,pageSize:3})
    expect(result).toMatchObject({total:60,uncertainTotal:0,options:{recognitionYears:[year]},rows:ids.slice(3,6).map(enterpriseId=>({enterpriseId,group:'eligible',recognition:{precision:'year',year}}))})
    expect(result.rows.every(row=>row.references.some(ref=>ref.startsWith('platform-relation:')))).toBe(true)
    expect(displayReads).toBe(3)
    // Correspondence reads still prepare once per candidate; the hot fixed SQL
    // and six head lookups must not reintroduce per-candidate preparation.
    expect(prepared.mock.calls.length).toBeLessThan(ids.length+40)
  } finally { prepared.mockRestore() }
})

it('ignores all six legacy decision scopes including withdrawals and out-of-order history', () => {
  f.resetBusiness()
  const c=f.candidate('Six scopes')
  const expected: number[]=[]
  for (const titleCode of ['little_giant','specialized_sme','innovative_sme'] as const) {
    for (const direction of ['missing_in_miit','extra_in_miit'] as const) {
      const insert=(recordedAt:string,lifecycleAction:'replace'|'withdraw',reasonCode:'moved_out'|null) => f.db.insert(s.differenceReason).values({enterpriseId:c.enterprise.id,titleCode,direction,status:'needs_review',measureCode:'none',reasonCode,verificationStatus:'pending',recordedAt,lifecycleAction}).returning().get()
      insert('2026-01-01T00:00:00Z','replace','moved_out')
      insert('2026-02-01T00:00:00Z','replace','moved_out')
      const head=insert('2026-03-01T00:00:00Z','withdraw',null)
      expected.push(head.id)
      // Later insertion with an older timestamp cannot become the head.
      insert('2026-01-15T00:00:00Z','replace','moved_out')
    }
  }
  const result=listCurrentQualified(f.db.$client,{titleCode:'specialized_sme'})
  expect(result.total).toBe(1)
  expect(result.rows[0]!.group).toBe('eligible')
  expect(result.rows[0]!.references.filter(ref=>ref.startsWith('decision:'))).toEqual([])
  expect(result.rows[0]!.notes.filter(note=>note==='旧决定已撤回，不作为当前排除依据')).toHaveLength(0)
  expect(f.db.$client.prepare("select id from difference_reason where recorded_at='2026-03-01T00:00:00Z' order by id").all()).toEqual(expected.map(id => ({ id })))
})

it('hydrates the page from the pinned snapshot and observes later writes only in the next request', () => {
  f.resetBusiness()
  const first=f.candidate('Pinned first'), second=f.candidate('Pinned second')
  const db=f.db.$client, prepare=db.prepare.bind(db)
  let wrote=false
  const prepared=vi.spyOn(db,'prepare').mockImplementation((sql:string) => {
    const statement=prepare(sql)
    if (sql.startsWith('select r.id,r.query_id as queryId,') && sql.includes('from platform_relation r join platform_query q')) {
      const all=statement.all.bind(statement)
      statement.all=((...args:any[]) => {
        if (!wrote) {
          wrote=true
          const writer=new Database(f.dbPath)
          try {
            writer.prepare('update enterprise set district=? where id=?').run('海曙区',first.enterprise.id)
            writer.prepare("insert into difference_reason (enterprise_id,title_code,direction,status,measure_code,verification_status,reason_code,recorded_at,created_at) values (?,'little_giant','missing_in_miit','needs_review','none','pending','moved_out','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run(second.enterprise.id)
          } finally { writer.close() }
          vi.setSystemTime(new Date(`${year+5}-06-01T00:00:00Z`))
        }
        return all(...args)
      }) as any
    }
    return statement
  })
  vi.useFakeTimers({toFake:['Date']})
  vi.setSystemTime(new Date(`${year}-06-01T00:00:00Z`))
  try {
    const pinned=listCurrentQualified(db,{titleCode:'specialized_sme',pageSize:1})
    expect(wrote).toBe(true)
    expect(pinned).toMatchObject({snapshotStartedAt:`${year}-06-01T00:00:00.000Z`,total:2,options:{recognitionYears:[year]},rows:[{enterpriseId:first.enterprise.id,name:'Pinned first',district:'鄞州区',group:'eligible'}]})
    vi.setSystemTime(new Date(`${year}-06-01T00:00:00Z`))
    const fresh=listCurrentQualified(db,{titleCode:'specialized_sme',pageSize:1})
    expect(fresh).toMatchObject({total:2,rows:[{enterpriseId:first.enterprise.id,name:'Pinned first',district:'海曙区',group:'eligible'}]})
  } finally { vi.useRealTimers(); prepared.mockRestore() }
})
