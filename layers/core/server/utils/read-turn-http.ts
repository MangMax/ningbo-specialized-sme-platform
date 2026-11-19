import type { H3Event } from 'h3'
import { runReadTurn } from './read-turn'
import { withEnterpriseReadSignal } from './enterprise-read-signal'

/** Reuse the established req.aborted/res.close/finally cleanup convention. */
export function withReadTurn<I, O>(
  event: H3Event,
  turns: { submit(input: I): { result: Promise<O | undefined>; cancel(): void } },
  input: I,
) {
  return withEnterpriseReadSignal(event, signal => runReadTurn(turns, input, signal))
}
