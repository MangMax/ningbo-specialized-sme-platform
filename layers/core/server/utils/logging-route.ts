import { defineEventHandler, getHeader, getQuery, getRouterParam, setHeader, setResponseStatus, type H3Event } from 'h3'
import { applicationLogs } from '../../lib/logging'
import { dispatchLogAction, type LogAction } from '../../lib/logging/application'
import { logAccessAllowed } from './logging-access'
class LogBodyError extends Error {
  constructor(public statusCode: number, public code: 'log_body_too_large' | 'invalid_log_input') { super(code) }
}
/** h3 1.x readBody/readRawBody accumulate without a size bound. Retain <=4096 raw bytes. */
function readLogBody(event: H3Event): Promise<Record<string, unknown>> {
  const req = event.node?.req
  if (!req) return Promise.reject(new LogBodyError(400, 'invalid_log_input'))
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0, settled = false
    const finish = (error?: LogBodyError, body?: Record<string, unknown>) => {
      if (settled) return
      settled = true
      req.off('data', data); req.off('end', end); req.off('aborted', aborted)
      chunks.length = 0
      if (error) {
        // Return the bounded error before any remaining body arrives. Closing this
        // connection avoids retaining/draining an unbounded rejected upload.
        req.pause(); setHeader(event, 'connection', 'close'); reject(error)
      } else resolve(body!)
    }
    const data = (chunk: Buffer) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > 4096) { finish(new LogBodyError(413, 'log_body_too_large')); return }
      chunks.push(buffer)
    }
    const end = () => {
      try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { finish(new LogBodyError(400, 'invalid_log_input')) }
    }
    const aborted = () => finish(new LogBodyError(400, 'invalid_log_input'))
    // A rejected/aborted stream can emit error after settlement; absorb it until
    // close without retaining body buffers or allowing an unhandled exception.
    req.on('error', aborted)
    req.once('close', () => { aborted(); req.off('error', aborted) })
    req.on('data', data); req.once('end', end); req.once('aborted', aborted)
  })
}
export function createLoggingRoute(action: LogAction) {
  return defineEventHandler(async event => {
    const authorized = logAccessAllowed(event)
    // Check before body parsing/storage acquisition: sensitive reads fail closed too.
    if (!authorized) { setResponseStatus(event, 401); setHeader(event, 'cache-control', 'no-store'); return { error: { code: 'log_access_denied' } } }
    let input: Record<string, unknown> = action === 'detail' ? { id: getRouterParam(event, 'id') } : getQuery(event)
    if (['setPolicy','clear'].includes(action)) {
      const header = getHeader(event, 'content-length')
      const length = typeof header === 'string' && /^[0-9]+$/.test(header) ? Number(header) : NaN
      if (!Number.isInteger(length) || length < 1 || length > 4096) { setResponseStatus(event, 413); setHeader(event, 'cache-control', 'no-store'); return { error: { code: 'log_body_too_large' } } }
      try { input = await readLogBody(event) }
      catch (error) {
        setResponseStatus(event, error instanceof LogBodyError ? error.statusCode : 400)
        setHeader(event, 'cache-control', 'no-store')
        return { error: { code: error instanceof LogBodyError ? error.code : 'invalid_log_input' } }
      }
    }
    const result = await dispatchLogAction(applicationLogs(), action, input, authorized)
    setResponseStatus(event, result.status)
    for (const [key,value] of Object.entries(result.headers)) setHeader(event, key, value)
    return result.body
  })
}
