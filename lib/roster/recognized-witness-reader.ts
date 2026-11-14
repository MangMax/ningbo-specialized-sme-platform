import type Database from 'better-sqlite3'
import type { RecognizedFilterSourceRow } from './recognized-filter-source'
/** Structured inputs only. SourcePage's opaque value is not consumed by R5 qualification. */
export type RecognizedWitnessSource = Omit<RecognizedFilterSourceRow,'pages'> & {
 position: {state:'unmatched'} | {state:'matched';ordinal:number;rdjbKey:string|null;pageKind:string}
}
export type RecognizedWitnessResult = {kind:'available';source:RecognizedWitnessSource} | {
 kind:'unavailable';reason:'missing'|'owner'|'unconfirmed'|'unverified'|'fidelity_uncaptured'|'evidence_uncaptured'|'not_applicable'|'position_rejected'
}
export interface RecognizedWitnessReader {
 /** Synchronous request scope: validate catalog before any caller streaming SELECT. */
 withinSnapshot<T>(read:()=>T):T
 withinBatch?<T>(relationIds: readonly number[], read: () => T): T
 readonly connection:Database.Database
 readMany(input:{enterpriseId:number;uscc:string|null;relationIds:readonly number[]}):ReadonlyMap<number,RecognizedWitnessResult>
}
