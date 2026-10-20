#!/usr/bin/env node
// Actual app read functions on an explicit readonly isolated fixture; private hashes only.
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const [dbPath, manifestPath, outputPath, modulesRoot] = process.argv.slice(2)
if (!dbPath?.startsWith('/tmp/ningbo-perf-83-90/') || !manifestPath || !outputPath || !modulesRoot) throw Error('explicit private fixture, manifest, output, modules root required')
const require = createRequire(join(resolve(modulesRoot),'package.json'))
const { createJiti } = createRequire(require.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url)
const { useDb } = await jiti.import('../../db/client.ts')
const { listPlatformQueries } = await jiti.import('../../lib/platform/read.ts')
const { readPlatformQueryEvidence } = await jiti.import('../../lib/platform/evidence-read.ts')
const db = useDb({dbPath,readOnly:true})
const canonical = value => Array.isArray(value)?value.map(canonical):value!==null&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value
const sha = value => createHash('sha256').update(value).digest('hex')
const results = {}
for (const entry of JSON.parse(readFileSync(manifestPath)).cases) {
  const result = entry.kind==='summary'?listPlatformQueries(db,{...entry.args,view:'summary'}):readPlatformQueryEvidence(db,entry.args)
  results[entry.name]={semantic_sha256:sha(JSON.stringify(canonical(result))),bytes:Buffer.byteLength(JSON.stringify(result))}
}
const sourceFiles=['lib/platform/read.ts','lib/platform/evidence-read.ts','db/schema.ts']
const baseline='fc37375eb35ecd175a5746d93dc22129d2a2ffe3'
writeFileSync(outputPath,JSON.stringify({source_sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  algorithm_hashes:Object.fromEntries(sourceFiles.map(p=>[p,sha(readFileSync(p))])),
  baseline_source_sha:baseline,baseline_algorithm_hashes:Object.fromEntries(sourceFiles.map(p=>[p,sha(execFileSync('git',['show',`${baseline}:${p}`]))])),
  baseline_note:'static algorithm provenance only; baseline not measured in this run',cases:results},null,2)+'\n')
db.$client.close()
console.log(JSON.stringify({oracle_cases:Object.keys(results).length,private_output:true}))
