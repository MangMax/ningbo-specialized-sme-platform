import {mkdirSync,writeFileSync} from 'node:fs'
import {createOfflineSnapshot} from './offline-snapshot'
const [source,snapshot,evidence]=process.argv.slice(2)
if(!source||!snapshot||!evidence)throw new Error('Usage: SOURCE NEW_SNAPSHOT NEW_EVIDENCE_DIR')
mkdirSync(evidence)
try {
 const receipt=await createOfflineSnapshot(source,snapshot)
 writeFileSync(`${evidence}/receipt.json`,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
 process.stdout.write(JSON.stringify(receipt)+'\n')
}catch(error){
 writeFileSync(`${evidence}/failure.json`,JSON.stringify({message:String(error),snapshotUsable:false})+'\n',{flag:'wx'})
 throw error
}
