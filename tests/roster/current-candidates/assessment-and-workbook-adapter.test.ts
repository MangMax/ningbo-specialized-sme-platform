import { createHash } from 'node:crypto'
import { readCurrentQualificationAssessment } from '../../../lib/roster/current-qualification'
import { readFileSync } from 'node:fs'
import { join,dirname } from 'node:path'
import { expect,it,vi } from 'vitest'
import { qualificationFileFixture } from '../fixtures/qualification-matrix'
import type { CurrentCandidateReader } from '../../../lib/roster/current-candidate-reader'
import { listCurrentQualified,listCurrentQualifiedWithCandidates } from '../../../lib/roster/current-qualified-query'
import { writeCurrentWorkbook,writeCurrentWorkbookWithCandidates } from '../../../lib/roster/current-workbook'
import { readExportWorkbook } from '../../support/read-workbook'

it('explicit candidate seam preserves qualified assessment asOf versions and workbook cells with one enumeration in the owner snapshot',async()=>{
  const f=qualificationFileFixture()
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-12T00:00:00Z'))
  try{
    const formal=f.formal('Seam candidate',[{eventType:'award',year:2026,decidedYear:2026,batchSeq:1}],{title:'specialized_sme'})
    const calls:{title:string;sort:string|undefined;snapshot:boolean}[]=[]
    const provider:CurrentCandidateReader={connection:f.sqlite,iterate(title,sort){
      calls.push({title,sort,snapshot:f.sqlite.inTransaction})
      return f.sqlite.prepare(`SELECT DISTINCT enterprise_id AS id FROM record WHERE title_code=? ORDER BY enterprise_id`).iterate(title) as Iterable<{id:number}>
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
    // Independently serialize the documented hash envelope. No production digest
    // function, copied current hash, or version constant supplies the expectation.
    const scope={enterpriseId:formal.enterprise.id,asOf:'2026-11-12T00:00:00.000Z',ruleVersion:'current-roster-116-v14',assessmentVersion:'enterprise-qualification-807-v7'}
    const assessment=readCurrentQualificationAssessment(f.sqlite,formal.enterprise.id,Date.parse(scope.asOf))
    expect(assessment).toMatchObject(scope)
    expect(assessment.titles.find(t=>t.titleCode==='specialized_sme')).toMatchObject({group:'eligible',effectiveQualification:{status:'effective'}})
    const digest=async(path:string,namespace:string,scoped:boolean)=>{
      const workbook=await readExportWorkbook(readFileSync(path))
      const sheet=workbook.getWorksheet('有效企业')!
      expect(sheet.rowCount).toBe(2)
      expect(sheet.getRow(2).getCell(2).value).toBe('Seam candidate')
      expect(sheet.getRow(2).getCell(3).value).toBe(formal.enterprise.usccNorm)
      const cells=Array.from({length:15},(_,i)=>sheet.getRow(2).getCell(i+1).value)
      const titles=scoped?assessment.titles.filter(t=>t.titleCode==='specialized_sme'):assessment.titles
      const snapshotId=createHash('sha256').update(JSON.stringify([scope,titles])).digest('hex')
      const lines=[JSON.stringify([namespace,'enterprise-qualification-807-v7','current-roster-116-v14',2026,'specialized_sme']),JSON.stringify(['effective',formal.enterprise.id,scope,snapshotId,cells]),'']
      return 'sha256:'+createHash('sha256').update(lines.join('\n')).digest('hex')
    }
    expect(baselineSummary.dataVersion).toBe(await digest(a,'current-export-assessment-title-v3',true))
    expect(injectedSummary).toEqual({...baselineSummary,dataVersion:await digest(b,'current-export-assessment-409-v2',false)})
    expect(calls).toEqual([{title:'specialized_sme',sort:undefined,snapshot:true}])
    const values=async(path:string)=>{
      const workbook=await readExportWorkbook(readFileSync(path))
      return workbook.worksheets.map(s=>({name:s.name,rows:(s.getRows(1,s.rowCount)??[]).map(row=>row.values)}))
    }
    expect(await values(b)).toEqual(await values(a))
    expect(f.sqlite.inTransaction).toBe(false)
    const other=qualificationFileFixture()
    try {
      const mismatched={...provider,connection:other.sqlite}
      expect(()=>listCurrentQualifiedWithCandidates(f.sqlite,filter,mismatched)).toThrow('caller connection')
      await expect(writeCurrentWorkbookWithCandidates(f.sqlite,'specialized_sme',join(root,'invalid.xlsx'),()=>{},mismatched)).rejects.toThrow('caller connection')
    }finally{other.close()}
  }finally{vi.useRealTimers();f.close()}
},30000)
