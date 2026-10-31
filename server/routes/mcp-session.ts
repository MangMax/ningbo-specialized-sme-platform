import { defineEventHandler, getRequestURL, toWebHandler, readBody } from 'h3'
import { useEvent, useNitroApp, useRuntimeConfig, useStorage } from 'nitropack/runtime'
import toolkitHandler from '#mcp-session-toolkit'
import {
  acceptsSessionFrame, createSessionEndpoint, createSessionReplay,
  nativeSessionIngress, takeSessionReplay, queueSessionResponse,
  sessionLifecycle, isSessionEvent,
} from '../utils/mcp-session-runtime'

const endpoint = createSessionEndpoint({
  invokeToolkit: event => toolkitHandler(event),
  currentEvent: () => useEvent(),
  currentCredential: event => String(useRuntimeConfig(event).mcpToken ?? ''),
  replay: async (original, request, run) => {
    const bytes = await request.arrayBuffer()
    const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!acceptsSessionFrame(frame)) return new Response(JSON.stringify({ error: { code: 'task_not_supported' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    if (frame.method === 'tools/call' && !['list_enterprises', 'get_enterprise_detail'].includes(frame.params?.name)) {
      return new Response(JSON.stringify({ error: { code: 'tool_not_allowed' } }), { status: 403, headers: { 'content-type': 'application/json' } })
    }
    const token = createSessionReplay(async current => {
      endpoint.replayIngress(original, current)
      if (useEvent() !== current) throw new Error('current_event_mismatch')
      // H3 middleware must read its public parsed-body cache,
      // while toolkit's public toWebRequest receives an untouched bounded replay.
      const webRequest = current.web?.request
      if (!webRequest) throw new Error('replay_web_request_missing')
      await readBody(current, { strict: false })
      current.web.request = new Request(webRequest.url, {
        method: webRequest.method, headers: webRequest.headers, body: bytes,
      })
      return run(current)
    })
    return toWebHandler(useNitroApp().h3App)(new Request(request.url, { method: request.method, headers: request.headers, body: bytes }), { mcpSessionReplay: token })
  },
  cleanupSession: async sid => {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(sid)) throw new Error('invalid_owned_session')
    const parent = useStorage('mcp')
    for (const namespace of ['sessions', 'sessions-meta']) {
      const base = namespace + ':' + sid, scoped = useStorage('mcp:' + base)
      if (await parent.hasItem(base)) await parent.removeItem(base, { removeMeta: true })
      for (const key of await scoped.getKeys()) await scoped.removeItem(key, { removeMeta: true })
      if (await parent.hasItem(base) || (await scoped.getKeys()).length) throw new Error('session_cleanup_incomplete')
    }
    return { empty: true }
  },
})

let closeHookInstalled = false
export default defineEventHandler(async event => {
  if (!closeHookInstalled) { useNitroApp().hooks.hook('close', () => { endpoint.shutdown() }); closeHookInstalled = true }
  const replay = takeSessionReplay(event)
  sessionLifecycle(event, 'route', () => ({ replay: !!replay, sessionEvent: isSessionEvent(event) }))
  if (replay) return queueSessionResponse(event, await replay)
  let ingress
  try { ingress = nativeSessionIngress(event.node.req, event.node.res, getRequestURL(event).href) }
  catch { return queueSessionResponse(event, new Response(JSON.stringify({ error: { code: 'native_ownership_missing' } }), { status: 503, headers: { 'content-type': 'application/json' } })) }
  return queueSessionResponse(event, await endpoint.handle(event, ingress))
})
