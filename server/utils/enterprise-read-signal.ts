import type { H3Event } from 'h3'

/** HTTP disconnects cancel admitted enterprise work and remove listeners after
 * every outcome. MCP supplies its SDK request signal to the same executor. */
export async function withEnterpriseReadSignal<T>(event: H3Event, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const req = event.node?.req, res = event.node?.res
  const abort = () => { if (!res?.writableEnded) controller.abort() }
  req?.once('aborted', abort)
  res?.once('close', abort)
  try { return await read(controller.signal) } finally {
    req?.off('aborted', abort)
    res?.off('close', abort)
  }
}
