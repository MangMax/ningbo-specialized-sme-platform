/** Explicit offline CLI; evidence directory must be new. No runtime migration import. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { indexLegacyProvenance } from './legacy-provenance'
const [source,target,evidence,runId,mode] = process.argv.slice(2)
if (!source || !target || !evidence || !runId || (mode !== undefined && mode !== '--preflight')) throw new Error('Usage: FIXED_SOURCE_71612 INDEPENDENT_TARGET NEW_EVIDENCE_DIR RUN_ID [--preflight]')
mkdirSync(evidence)
const emit = (name:string,value:unknown) => writeFileSync(`${evidence}/${name}`,JSON.stringify(value,null,2)+'\n',{flag:'wx'})
emit('invocation.json',{source,target,runId,preflightOnly:mode === '--preflight'})
try {
  const result = indexLegacyProvenance({source,target,runId,preflightOnly:mode === '--preflight'})
  emit('receipt.json',result)
  process.stdout.write(JSON.stringify(result)+'\n')
} catch (error) {
  emit('failure.json',{message:error instanceof Error ? error.message : String(error)})
  throw error
}
