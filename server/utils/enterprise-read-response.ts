import { createError, type H3Event } from 'h3'

const admitted = new WeakSet<object>()
let inFlight = 0
/** Keep at most one native execution plus16 admitted responses, through Node's
 * finish/close event. Slow clients cannot keep admitting unbounded large bodies
 * after native computation has finished. No response payload is retained here. */
export function admitEnterpriseResponse(event: H3Event): void {
  const response = event.node?.res
  if (!response || admitted.has(response)) return
  if (inFlight >= 17) throw createError({ statusCode: 503, statusMessage: 'Enterprise read temporarily unavailable' })
  admitted.add(response); inFlight++
  const release = () => {
    response.off('finish', release); response.off('close', release)
    admitted.delete(response); inFlight--
  }
  response.once('finish', release); response.once('close', release)
}
