import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { initializeDb, schema as s } from '../db/client'
import { readAnnualStatistics } from '../lib/roster/annual-statistics'
import { readDistrictStatistics } from '../lib/roster/district-statistics'

it.each(['annual', 'district'] as const)('reads %s chart summaries and evidence details with retired platform tables absent', kind => {
  const dir = mkdtempSync(join(tmpdir(), 'statistics-retired-'))
  const db = initializeDb({ create: true, dbPath: join(dir, 'native.sqlite') })
  try {
    const enterprise = db.insert(s.enterprise).values({ name:'统计终态企业',nameNorm:'统计终态企业',district:'鄞州区' }).returning().get()
    const record = db.insert(s.record).values({ enterpriseId:enterprise.id,titleCode:'specialized_sme',source:'jxj',nameRaw:enterprise.name }).returning().get()
    const event = db.insert(s.recordEvent).values({ recordId:record.id,eventType:'award',year:2025,batchSeq:1 }).returning().get()
    db.insert(s.recordEvidence).values({ recordEventId:event.id,sourceFile:'synthetic-statistics.pdf',page:2,listNo:1 }).run()
    expect(db.$client.prepare("select name from sqlite_schema where name in ('platform_query','platform_relation')").all()).toEqual([])
    const at = Date.parse('2026-11-14T04:00:00Z')
    const result = kind === 'annual'
      ? readAnnualStatistics(db, { year:2026,title:'specialized_sme',status:'effective',page:1,pageSize:25 },at)
      : readDistrictStatistics(db, { title:'specialized_sme',page:1,pageSize:25 },at)
    expect(result.total).toBe(1)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ enterpriseId:enterprise.id,titleCode:'specialized_sme',status:'effective',district:'鄞州区',evidence:[{page:2}] })
    expect(result.rows[0]!.references).toContainEqual(expect.stringContaining('synthetic-statistics.pdf'))
    const titles = 'years' in result ? result.years.find(row => row.year === 2026)!.titles : result.titles
    expect(titles.find(row => row.titleCode === 'specialized_sme')?.effective).toBe(1)
    expect(db.$client.inTransaction).toBe(false)
  } finally { db.$client.close(); rmSync(dir, { recursive:true,force:true }) }
})
