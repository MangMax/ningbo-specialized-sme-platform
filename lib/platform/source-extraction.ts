/** Ingestion-boundary extraction shared with the frozen-source upgrade. */
import type * as schema from '../../db/schema'
import { processFactsFromRow } from './identity'
import { normalizePlatformRelation } from './normalization'
import type { PlatformRow } from './types'
type Kind=NonNullable<typeof schema.platformApplyProjection.$inferInsert.sourceTitleKind>
export function sourceValueKind(v:unknown):Kind {
  if(v===undefined)return 'absent'
  if(v===null)return 'null'
  if(Array.isArray(v))return 'array'
  switch(typeof v) {case 'string':return 'text';case 'number':return Number.isFinite(v)?'number':'invalid';case 'boolean':return 'boolean';case 'object':return 'object';default:return 'invalid'}
}
const fieldKeys={province:'szsfmc',status:'cszt',batch:'whpc',declareKind:'sblx',appliedAt:'sqsj',awardBatchLabel:'personuuid',year:'year'} as const
// These seven fields are the accepted normalization contract, not a mixed business table.
export function sourceFieldComparison(source:string,stored:Omit<Pick<typeof schema.platformRelation.$inferSelect,keyof typeof fieldKeys>, 'declareKind'> & { declareKind: string | null },row:Record<string,unknown>|null,state:'valid'|'invalid'|'absent') {
  const process=source==='apply_list'||source==='business_list'
  // Legacy PlatformRow declares strings, but this parser intentionally checks unknown JSON
  // scalar types itself (as normalizePlatformRelation does); never stringify its inputs.
  const parsed=process&&row?processFactsFromRow(row as PlatformRow):null
  const normalized=normalizePlatformRelation(source,{...stored,rawFields:row})
  const entries=Object.entries(fieldKeys).flatMap(([field,key])=>{
    const f=field as keyof typeof fieldKeys,v=stored[f]
    const storedValue=process&&f==='declareKind'?processFactsFromRow({sblx:typeof v==='string'?v:''}).declareKind:typeof v==='string'?v.trim()||null:v
    const parsedValue=parsed?.[f]??null
    for(const value of [storedValue,parsedValue]) if(typeof value==='number'&&!Number.isSafeInteger(value))throw new Error('Unrepresentable legacy process year')
    const cap=f[0]!.toUpperCase()+f.slice(1)
    return [[`stored${cap}Kind`,sourceValueKind(v)],[`stored${cap}`,storedValue],[`parsed${cap}Kind`,process?(state==='valid'?sourceValueKind(row?.[key]):state==='invalid'?'invalid':'absent'):'absent'],[`parsed${cap}`,parsedValue],[`reconciled${cap}`,normalized[f]],[`${f}Conflict`,Number(normalized.normalizationConflicts.some(c=>c.field===f))]]
  })
  return Object.fromEntries(entries) as Pick<typeof schema.platformApplyProjection.$inferInsert,
    'storedProvinceKind'|'storedProvince'|'parsedProvinceKind'|'parsedProvince'|'reconciledProvince'|'provinceConflict'|
    'storedStatusKind'|'storedStatus'|'parsedStatusKind'|'parsedStatus'|'reconciledStatus'|'statusConflict'|
    'storedBatchKind'|'storedBatch'|'parsedBatchKind'|'parsedBatch'|'reconciledBatch'|'batchConflict'|
    'storedDeclareKindKind'|'storedDeclareKind'|'parsedDeclareKindKind'|'parsedDeclareKind'|'reconciledDeclareKind'|'declareKindConflict'|
    'storedAppliedAtKind'|'storedAppliedAt'|'parsedAppliedAtKind'|'parsedAppliedAt'|'reconciledAppliedAt'|'appliedAtConflict'|
    'storedAwardBatchLabelKind'|'storedAwardBatchLabel'|'parsedAwardBatchLabelKind'|'parsedAwardBatchLabel'|'reconciledAwardBatchLabel'|'awardBatchLabelConflict'|
    'storedYearKind'|'storedYear'|'parsedYearKind'|'parsedYear'|'reconciledYear'|'yearConflict'>
}
