/** Offline T04 envelope grammar, frozen from ab503081dae3e24680afc9b07395a7e3ff21fc9f. */
import { z } from 'zod'
const cellSchema = z.object({name:z.string(),storageClass:z.enum(['null','text','blob','integer','real']),hex:z.string().regex(/^(?:[a-fA-F0-9]{2})*$/),real64be:z.string().regex(/^[a-fA-F0-9]{16}$/).optional()})
export function* targetProvenanceCells(envelope:Buffer) {
  let cursor=Buffer.byteLength('T04-PROVENANCE\n')
  if(!envelope.subarray(0,cursor).equals(Buffer.from('T04-PROVENANCE\n')))throw new Error('Invalid original provenance envelope')
  for(const name of ['query_id','source_identity','source_sha256','segment_index','collection','input_fingerprint','import_batch_id','created_at']) {
    const end=envelope.indexOf(10,cursor)
    const match=/^(\w+) (null|text|blob|integer|real) (\d+)$/.exec(envelope.subarray(cursor,end).toString())
    if(end<0||!match||match[1]!==name)throw new Error('Invalid original provenance cell')
    const size=Number(match[3]),begin=end+1,tail=begin+size
    if(!Number.isSafeInteger(size)||tail>=envelope.length||envelope[tail]!==10)throw new Error('Truncated original provenance cell')
    yield cellSchema.parse({name,storageClass:match[2],hex:envelope.subarray(begin,tail).toString('hex')})
    cursor=tail+1
  }
  if(cursor!==envelope.length)throw new Error('Trailing original provenance cells')
}
