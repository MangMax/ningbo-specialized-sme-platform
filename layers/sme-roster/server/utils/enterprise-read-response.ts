import { createError, type H3Event } from 'h3'

const admitted = new WeakSet<object>()
let inFlight = 0
/** Limit retained JSON responses across roster routes. A slow client keeps its
 * admission slot until the HTTP response finishes or closes. */
export function admitEnterpriseResponse(event: H3Event): void {
  const response = event.node?.res
  if (!response || admitted.has(response)) return
  if (event.node.req.aborted || response.destroyed || response.closed || response.writableFinished) {
    throw createError({ statusCode: 499, statusMessage: 'Enterprise read aborted' })
  }
  if (inFlight >= 17) throw createError({ statusCode: 503, statusMessage: 'Enterprise read temporarily unavailable' })
  admitted.add(response); inFlight++
  let released = false
  const release = () => {
    if (released) return
    released = true
    response.off('finish', release); response.off('close', release)
    admitted.delete(response); inFlight--
  }
  response.once('finish', release); response.once('close', release)
  // Check after taking ownership too: no terminal event may strand a slot.
  if (response.destroyed || response.closed || response.writableFinished) release()
}
