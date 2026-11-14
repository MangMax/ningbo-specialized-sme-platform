import { readFileSync } from 'node:fs'
import { join,dirname } from 'node:path'
import { expect,it,vi } from 'vitest'
import { fileMatrix408 } from './helpers/current-qualified-408'
import { currentCandidateBindings,currentCandidateReadSqlFor } from '../upgrade/frozen/current-candidates'
import type { CurrentCandidateReader } from '../lib/roster/current-candidate-reader'
import { listCurrentQualified,listCurrentQualifiedWithCandidates } from '../lib/roster/current-qualified-query'
import { writeCurrentWorkbook,writeCurrentWorkbookWithCandidates } from '../lib/roster/current-workbook'
import { readExportWorkbook } from './helpers/read-export-workbook'

it('explicit candidate seam preserves qualified assessment asOf versions and workbook cells with one enumeration in the owner snapshot',async()=>{
  const f=fileMatrix408()
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-12T00:00:00Z'))
  try{
    const formal=f.formal('Seam candidate',[{eventType:'award',year:2026,decidedYear:2026,batchSeq:1}],{title:'specialized_sme'})
    const calls:{title:string;sort:string|undefined;snapshot:boolean}[]=[]
    const provider:CurrentCandidateReader={connection:f.sqlite,iterate(title,sort){
      calls.push({title,sort,snapshot:f.sqlite.inTransaction})
      return f.sqlite.prepare(`SELECT id FROM (${currentCandidateReadSqlFor(f.sqlite)}) ORDER BY id`).iterate(currentCandidateBindings(title)) as Iterable<{id:number}>
    }}
    const filter={titleCode:'specialized_sme' as const,page:1,pageSize:1}
    const baseline=listCurrentQualified(f.sqlite,filter)
    expect(baseline.rows[0]!.enterpriseId).toBe(formal.enterprise.id)
    const injected=listCurrentQualifiedWithCandidates(f.sqlite,filter,provider)
    expect(injected).toEqual(baseline)
    expect(calls).toEqual([{title:'specialized_sme',sort:undefined,snapshot:true}])
    calls.length=0
    const root=dirname(f.sqlite.name),a=join(root,'baseline.xlsx'),b=join(root,'injected.xlsx')
    const baselineSummary=await writeCurrentWorkbook(f.sqlite,'specialized_sme',a,()=>{})
    const injectedSummary=await writeCurrentWorkbookWithCandidates(f.sqlite,'specialized_sme',b,()=>{},provider)
    expect(injectedSummary).toEqual(baselineSummary)
    expect(calls).toEqual([{title:'specialized_sme',sort:undefined,snapshot:true}])
    const values=async(path:string)=>{
      const workbook=await readExportWorkbook(readFileSync(path))
      return workbook.worksheets.map(s=>({name:s.name,rows:(s.getRows(1,s.rowCount)??[]).map(row=>row.values)}))
    }
    expect(await values(b)).toEqual(await values(a))
    expect(f.sqlite.inTransaction).toBe(false)
    const other=fileMatrix408()
    try {
      const mismatched={...provider,connection:other.sqlite}
      expect(()=>listCurrentQualifiedWithCandidates(f.sqlite,filter,mismatched)).toThrow('caller connection')
      await expect(writeCurrentWorkbookWithCandidates(f.sqlite,'specialized_sme',join(root,'invalid.xlsx'),()=>{},mismatched)).rejects.toThrow('caller connection')
    }finally{other.close()}
  }finally{vi.useRealTimers();f.close()}
},30000)
