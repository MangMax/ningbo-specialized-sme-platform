import { afterAll, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { initializeDb } from '../../../db/client'
import { planOfficialEvidenceChanges, type OfficialClaimChange } from '../../../layers/sme-roster/server/utils/official-evidence-plan'

const dir = mkdtempSync(join(tmpdir(), 'claim-priority-'))
const db = initializeDb({ dbPath: join(dir, 'domain.db'), create: true })
const text = 'Independent literal published row\n'
writeFileSync(join(dir, 'notice.txt'), text)
afterAll(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
const orders = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]
for (const variant of ['owner','raw','only-unknown'] as const) for (const order of orders) {
  it(`whole-K domain ${variant} priority in order ${order.join('')}`, () => {
    const row: OfficialClaimChange['publishedRow'] = {
      nameRaw: 'Alpha original', usccRaw: 'printed code', districtRaw: 'printed district',
      declaration: { kind: 'independent', sourceDocument: { source:'jxj', title:'Declared publication', docNumber:null, issueDate:null, path:'notice.txt' }, basis:'Explicit verified declaration' },
      storedFileId:null, path:'notice.txt', sha256:createHash('sha256').update(text).digest('hex'), bytes:Buffer.byteLength(text),
      attachment:null, sectionKey:'awards', listNo:10, page:null, sourceBindingKnown:true,
      actor:{type:'agent',id:'synthetic'}, basis:'Verified row',
    }
    const changes: OfficialClaimChange[] = [0,1,2].map(i => ({
      ref:'proposal-'+i, evidenceId:'new-'+i, eventId:'event-'+(i===1?0:i),
      owner:variant==='owner' && i===2 ? 'Beta' : 'Alpha', titleCode:'specialized_sme',
      coordinate:{sourceFile:'notice.txt',attachment:null,listNo:10,page:null},
      publishedRow:{...row, ...(i===0 ? {usccRaw:null} : variant==='raw' && i===2 ? {nameRaw:'Conflicting confirmed raw'} : {})},
      expectedRowRevision:0,
    }))
    expect(() => planOfficialEvidenceChanges(db, order.map(i=>changes[i]!), dir)).toThrowError(expect.objectContaining({code:variant==='only-unknown'?'ambiguity':'source_row_conflict'}))
    // This is a read-only planner assertion, not a replacement for public atomicity.
    expect(db.$client.prepare('select count(*) n from record_evidence').get()).toEqual({n:0})
  })
}
