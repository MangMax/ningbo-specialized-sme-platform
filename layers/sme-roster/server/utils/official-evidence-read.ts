import { z } from 'zod'
import { OfficialEvidenceError } from './official-evidence'
import type { ReceiptRedactor } from './import-receipt-redaction'

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const paging = { pageSize: id.max(50).optional(), maxBytes: id.max(65536).optional() }
export const evidenceReadShape = { id, official: z.enum(['latest','history']).optional(), beforeRevision: id.optional(), ...paging }
export const eventReadShape = { eventId: id, official: z.literal('latest').optional(), afterEvidenceId: id.optional(), ...paging }
export const evidenceReadSchema = z.strictObject(evidenceReadShape).refine(v => v.official === 'history' ? true : v.beforeRevision === undefined && v.pageSize === undefined).refine(v => v.official !== undefined || v.maxBytes === undefined)
export const eventReadSchema = z.strictObject(eventReadShape).refine(v => v.official !== undefined || v.afterEvidenceId === undefined && v.pageSize === undefined && v.maxBytes === undefined)
export const importItemsReadShape = {
  batchId: id.optional(), receiptId: id.optional(), idempotencyKey: z.string().min(1).max(4096).optional(),
  page: id.max(1000000).optional(), pageSize: id.max(50).optional(),
  projection: z.enum(['snapshot','eventIds','qualification']).optional(), source: z.enum(['private_batch','redacted_receipt']).optional(),
  itemIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1).optional(), oldRecordId: id.optional(),
  cursor: z.string().min(1).max(512).optional(), maxBytes: id.max(65536).optional(),
}
export const importItemsReadSchema = z.strictObject(importItemsReadShape).superRefine((v,ctx) => {
  const valid = v.projection === 'qualification'
    ? v.itemIndex!==undefined && [v.idempotencyKey,v.page,v.pageSize,v.oldRecordId,v.cursor].every(x=>x===undefined)
      && (v.source==='private_batch' ? v.batchId!==undefined && v.receiptId===undefined : v.source==='redacted_receipt' && v.receiptId!==undefined && v.batchId===undefined)
    : v.projection === undefined
    ? [v.batchId,v.receiptId,v.idempotencyKey].filter(x=>x!==undefined).length===1 && [v.source,v.itemIndex,v.oldRecordId,v.cursor,v.maxBytes].every(x=>x===undefined)
    : v.itemIndex!==undefined && v.oldRecordId!==undefined && v.idempotencyKey===undefined && v.page===undefined
      && (v.source==='private_batch' ? v.batchId!==undefined && v.receiptId===undefined : v.source==='redacted_receipt' && v.receiptId!==undefined && v.batchId===undefined)
      && (v.projection==='eventIds' || v.cursor===undefined && v.pageSize===undefined)
  if (!valid) ctx.addIssue({code:'custom',message:'Exact projection/source selector required'})
})
export type EvidenceRead = z.infer<typeof evidenceReadSchema>
export type EventRead = z.infer<typeof eventReadSchema>
export type ImportItemsRead = z.infer<typeof importItemsReadSchema>
/** HTTP accepts canonical scalar integer strings; repeated/blank/boolean values stay invalid. */
export function officialReadQuery(query: Record<string,unknown>) {
  return Object.fromEntries(Object.entries(query).map(([key,value]) => [key,
    ['id','eventId','batchId','receiptId','itemIndex','oldRecordId','page','pageSize','beforeRevision','afterEvidenceId','maxBytes'].includes(key) && typeof value==='string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value]))
}

const projectionMetadata = { source: 'official_evidence' as const, responseRedacted: true as const, uncaptured: 'unknown_legacy' as const }

export function officialProjectionBudget(args: EvidenceRead | EventRead) {
  const maxBytes = args.maxBytes ?? 16384
  const overhead = Buffer.byteLength(JSON.stringify({ ...projectionMetadata, availability: 'unknown_legacy' })) - 2
  if (maxBytes <= overhead) throw new OfficialEvidenceError(413, 'response_limit', 'Official projection exceeds maxBytes')
  return { maxBytes, budget: maxBytes - overhead }
}

export function officialProjectionResponse(result: object, availability: string, maxBytes: number, redact: ReceiptRedactor) {
  const projection = redact({ ...result, ...projectionMetadata, availability })
  if (Buffer.byteLength(JSON.stringify(projection)) > maxBytes) throw new OfficialEvidenceError(413, 'response_limit', 'Redacted official projection exceeds maxBytes')
  return projection
}

/** Toolkit takes raw shapes and strips root extras. Validate the original RPC, and
 * authorize only the new sensitive opt-in; ordinary exact public reads stay public. */
export function officialEvidenceRpcError(body:unknown,authorized:boolean):Response|null {
  for(const entry of Array.isArray(body)?body:[body]) {
    if(!entry || typeof entry!=='object') continue
    const rpc=entry as {method?:string;id?:unknown;params?:{name?:string;arguments?:unknown}}
    if(rpc.method!=='tools/call') continue
    const name=rpc.params?.name
    if(!['get_roster_evidence','get_official_event','list_roster_import_items'].includes(name??'')) continue
    const args=rpc.params?.arguments
    // Evidence's legacy raw-shape SDK historically ignored root extras; only the new opt-in is strict.
    if(name==='get_roster_evidence' && args && typeof args==='object' && !('official' in args)) continue
    const sensitive=name==='list_roster_import_items' || args && typeof args==='object' && 'official' in args
    const status=sensitive&&!authorized?401:400
    // Preserve the SDK's legacy field-error envelope, but only after auth. Any
    // new/unknown own key (even undefined) must still pass the strict raw gate.
    if(status!==401 && name==='list_roster_import_items' && args && typeof args==='object' && !Array.isArray(args)
      && Reflect.ownKeys(args).every(key=>typeof key==='string' && ['batchId','receiptId','idempotencyKey','page','pageSize'].includes(key))) continue
    const contract=name==='get_roster_evidence'?evidenceReadSchema:name==='get_official_event'?eventReadSchema:importItemsReadSchema
    if(status!==401 && contract.safeParse(args).success) continue
    return new Response(JSON.stringify({jsonrpc:'2.0',id:typeof rpc.id==='number'||typeof rpc.id==='string'?rpc.id:null,error:{code:status===401?-32001:-32602,message:status===401?'Configured MCP token required':'Invalid exact official read arguments'}}),{status,headers:{'content-type':'application/json','cache-control':'no-store'}})
  }
  return null
}
