import { afterAll, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { count } from 'drizzle-orm'
import { recordEvidence } from '../../../db/postgresql/ledger-tables'
import { planPostgresOfficialEvidenceChanges } from '../../../layers/sme-roster/server/utils/official-evidence-plan-postgres'
import type { OfficialClaimChange } from '../../../layers/sme-roster/server/utils/official-evidence-claim-model'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'

const dir = mkdtempSync(join(tmpdir(), 'claim-priority-'))
const createDatabase = useIsolatedPostgresCases()
const text = 'Independent literal published row\n'
writeFileSync(join(dir, 'notice.txt'), text)
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const orders = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]
for (const variant of ['owner','raw','only-unknown'] as const) for (const order of orders) {
  it(`whole-K domain ${variant} priority in order ${order.join('')}`, async () => {
    const db = createDatabase()
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
    await expect(planPostgresOfficialEvidenceChanges(db, order.map(i => changes[i]!), dir)).rejects.toThrowError(expect.objectContaining({code:variant==='only-unknown'?'ambiguity':'source_row_conflict'}))
    expect(await db.select({ n: count() }).from(recordEvidence)).toEqual([{ n: 0 }])
  })
}
