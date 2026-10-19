#!/usr/bin/env node
// Read-only semantic comparison against a frozen checkout on an isolated small fixture.
// node scripts/verify-record-comparison-equivalence.mjs /absolute/synthetic.db /absolute/baseline-checkout
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
const { createJiti }=createRequire(import.meta.resolve('nuxt/package.json'))('jiti'),jiti=createJiti(import.meta.url)
const [dbPath,baseline]=process.argv.slice(2)
assert.ok(dbPath?.startsWith('/') && baseline?.startsWith('/') && !dbPath.includes('/full-snapshot/'))
const {useDb}=await jiti.import('../db/client.ts'),db=useDb({dbPath,readOnly:true})
const current=await jiti.import('../server/utils/record-comparison.ts'),old=await jiti.import(`${baseline}/server/utils/record-comparison.ts`)
const proofs=await jiti.import('../server/utils/comparison-scope-proof.ts'),oldProofs=await jiti.import(`${baseline}/server/utils/comparison-scope-proof.ts`)
const ids=table=>db.$client.prepare(`select id from ${table} order by id`).all().map(row=>row.id)
const queryIds=ids('platform_query'),documents=ids('source_document'),exportBatchIds=ids('platform_export_batch'),proofIds=ids('comparison_scope_proof')
assert.ok(queryIds.length<=100 && documents.length<=100 && exportBatchIds.length<=100,'Use a small synthetic equivalence fixture')
let checks=0;const hashes=[]
for(const kind of [undefined,'query','official_document','export_batch'])for(const page of [1,2,3]){
 const input={kind,page,pageSize:3},actual=current.listRecordComparisonSources(db,input)
 assert.deepEqual(actual,old.listRecordComparisonSources(db,input));checks++
}
for(const asOf of [undefined,'2026-10-18T16:30:00Z','2026-10-19T00:30:00+08:00'])for(const page of [1,2,3]){
 const input={queryIds,exportBatchIds,officialSourceDocumentIds:documents,proofIds,asOf,page,pageSize:3}
 const evidence=proofs.resolveVerifiedComparisonEvidence(db,proofIds,input),previous=oldProofs.resolveVerifiedComparisonEvidence(db,proofIds,input)
 assert.deepEqual(evidence,previous,'stored proof fingerprints and validity remain compatible')
 const actual=current.getRecordComparison(db,input,evidence)
 assert.deepEqual(actual,old.getRecordComparison(db,input,previous));checks+=2
 hashes.push(createHash('sha256').update(JSON.stringify(actual)).digest('hex'))
}
console.log(JSON.stringify({checks,resultHashes:hashes,scope:'readonly synthetic, old/new source and stored proof semantics'}));db.$client.close()
