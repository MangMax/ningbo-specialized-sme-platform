import * as schema from '../../../../db/schema'
import type { initializeDb } from '../../../../db/client'
export function createSemanticRecorder(db: ReturnType<typeof initializeDb>) {
  const tables = {
    enterprise:schema.enterprise,record:schema.record,recordEvent:schema.recordEvent,recordEvidence:schema.recordEvidence,
    enterpriseAlias:schema.enterpriseAlias,differenceReason:schema.differenceReason,
    platformCollection:schema.platformCollection,platformBusinessObservation:schema.platformBusinessObservation,
    platformObservationAssignment:schema.platformObservationAssignment,
    platformLegacyQueryAlias:schema.platformLegacyQueryAlias,platformLegacyRelationAlias:schema.platformLegacyRelationAlias,
    platformArchiveValue:schema.platformArchiveValue,importBatch:schema.importBatch,importReceipt:schema.importReceipt,
  }
  const steps:Array<{label:string;outcome:unknown;rowCounts:Record<string,number>;changed:Record<string,unknown[]>}>=[]
  let previous:Record<string,string>={}
  return {steps,capture(label:string,outcome:unknown){
    const changed:Record<string,unknown[]>={},rowCounts:Record<string,number>={},current:Record<string,string>={}
    for(const [name,table]of Object.entries(tables)){
      const rows=db.select().from(table).all();rowCounts[name]=rows.length;current[name]=JSON.stringify(rows)
      if(previous[name]!==current[name])changed[name]=rows
    }
    steps.push({label,outcome,rowCounts,changed});previous=current
  }}
}
