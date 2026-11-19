import { z } from 'zod'
import { dispositionRequestSchema, DispositionError, preflightDisposition, commitDisposition, currentDispositions, historyDispositions } from './title-cycle-disposition'
import { decisionOutput102 } from './decision-lifecycle-102-output'
const scope = z.strictObject({ enterpriseIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(500) })
export const dispositionSchemas = {
 preflight: dispositionRequestSchema,
 commit: z.strictObject({ request: dispositionRequestSchema, planHash: z.string().min(1).max(4000) }),
 current: scope, history: scope,
}
export type DispositionAction = keyof typeof dispositionSchemas
export function dispositionFailure(error: unknown) {
 const status = error instanceof z.ZodError ? 400 : error instanceof DispositionError ? 409 : 500
 const code = status === 400 ? 'invalid_request' : error instanceof DispositionError ? error.code : 'transaction_failed'
 return {status, body:{error:{code,message: status === 409 ? code : status === 400 ? 'Invalid disposition request' : 'Disposition operation failed'}}}
}
export function dispositionOperation(db: Parameters<typeof preflightDisposition>[0], action: DispositionAction, body: unknown) {
 // Prepare credential redactors before any possible transaction commit. The
 // stored receipt and source facts remain immutable; only this response is redacted.
 const output = decisionOutput102(db)
 const input = dispositionSchemas[action].parse(body)
 const value = action === 'preflight' ? preflightDisposition(db,input)
 : action === 'commit' ? commitDisposition(db,input)
 : action === 'current' ? currentDispositions(db,scope.parse(input).enterpriseIds)
 : {rows:historyDispositions(db,scope.parse(input).enterpriseIds)}
 return output(value)
}
export const dispositionToolActions = {
 preflight_title_cycle_disposition: 'preflight', commit_title_cycle_disposition: 'commit',
 get_current_title_cycle_dispositions: 'current', list_title_cycle_disposition_history: 'history',
} as const
