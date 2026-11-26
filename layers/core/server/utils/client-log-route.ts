import { defineEventHandler, getHeader, setHeader, setResponseStatus, type H3Event } from 'h3'
import { requestLogContext } from '../../lib/logging'
import { logAccessAllowed } from './logging-access'
import { createClientLogIntake } from './client-log-intake'

const intake = createClientLogIntake()
/** Bounded before parsing, even for chunked or falsely declared bodies. No decompression. */
async function readClientBody(event: H3Event): Promise<{ status: number; body?: unknown }> {
  const declared = getHeader(event, 'content-length')
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > 4096)) return { status: 413 }
  if (!/^application\/json(?:\s*;|$)/i.test(getHeader(event, 'content-type') ?? '')
    || !['', 'identity'].includes(getHeader(event, 'content-encoding') ?? '')) return { status: 415 }
  const req = event.node?.req
  if (!req) return { status: 400 }
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let bytes = 0, settled = false
    const finish = (result: { status: number; body?: unknown }) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', failed)
      req.resume(); resolve(result)
    }
    const data = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 4096) finish({ status: 413 })
      else chunks.push(chunk)
    }
    const end = () => {
      try { finish({ status: 200, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
      catch { finish({ status: 400 }) }
    }
    const failed = () => finish({ status: 400 })
    const timer = setTimeout(() => finish({ status: 408 }), 1000)
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', failed)
  })
}
export default defineEventHandler(async event => {
  setHeader(event, 'cache-control', 'no-store')
  // Same default same-origin access as log UI; same-origin is not user identity.
  if (!logAccessAllowed(event)) {
    setResponseStatus(event, 401); return { error: { code: 'log_access_denied' } }
  }
  const body = await readClientBody(event)
  if (body.status !== 200) {
    setResponseStatus(event, body.status); return { error: { code: 'invalid_client_log_body' } }
  }
  // Socket address is budget-only, never stored; forwarded headers are untrusted.
  const result = intake.accept(body.body, event.node?.req.socket.remoteAddress ?? 'unknown', requestLogContext(event))
  setResponseStatus(event, result.status)
  if (result.status === 429) setHeader(event, 'retry-after', '60')
  if (result.status !== 202) return { error: { code: result.status === 429 ? 'client_log_rate_limited' : 'invalid_client_log_body' } }
  return { accepted: result.accepted, duplicates: result.duplicates }
})
