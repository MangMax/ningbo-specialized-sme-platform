import { preflightDisposition, commitDisposition, currentDispositions, historyDispositions } from './title-cycle-disposition'
import { dispositionSchemas, type DispositionAction } from './title-cycle-disposition-protocol'
import { decisionOutput102 } from './decision-lifecycle-102-output-sqlite'

export function dispositionOperation(db: Parameters<typeof preflightDisposition>[0], action: DispositionAction, body: unknown) {
 // Prepare credential redactors before any possible transaction commit. The
 // stored receipt and source facts remain immutable; only this response is redacted.
 const output = decisionOutput102(db)
 const input = dispositionSchemas[action].parse(body)
 const value = action === 'preflight' ? preflightDisposition(db,input)
 : action === 'commit' ? commitDisposition(db,input)
 : action === 'current' ? currentDispositions(db,dispositionSchemas.current.parse(input).enterpriseIds)
 : {rows:historyDispositions(db,dispositionSchemas.current.parse(input).enterpriseIds)}
 return output(value)
}
