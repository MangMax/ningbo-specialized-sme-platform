import type { IncomingMessage, ServerResponse, RequestListener } from 'node:http'
import { Readable } from 'node:stream'
import { createSocketOwnership, createSessionInitializationTransport, type SessionOwner, type OwnedIngress } from './mcp-session-transport'
import { readMcpToken, tokenMatches } from './mcp-auth'
import { channel } from 'node:diagnostics_channel'

// #445 read-only lifecycle diagnostics. Payloads never contain owners, IDs from
// callers, credentials, bodies or error messages. Weak keys confer no ownership.
const lifecycleChannel = channel('ningbo.mcp-session.445.lifecycle.v1')
const lifecycleStages = new Set(['route', 'replay', 'handle', 'factory-start', 'candidate', 'toolkit-return', 'toolkit-error', 'provider-entry', 'provider-response', 'provider-error', 'connect', 'connected', 'owner-close', 'owner-closed', 'transport-closed', 'adopted', 'init-receipt', 'init-entered', 'init-settled', 'init-end', 'receipt-wait', 'receipt-done', 'adapter-response', 'cleanup', 'overflow'])
const lifecycleBooleans = ['owner', 'response', 'sid', 'sidEqual', 'adopted', 'receipt', 'initEntered', 'initSettled', 'sameCandidate', 'currentAvailable', 'currentEqual', 'sessionEvent', 'authPresent', 'authorized', 'singleCL', 'hasTE', 'replay', 'complete', 'observerFault'] as const
type LifecycleAttempt = { id: number; count: number; receipt: boolean; initEntered: boolean; initSettled: boolean; owner: boolean; response: boolean; sid: boolean; sidEqual: boolean; adopted: boolean }
const lifecycleEvents = new WeakMap<object, LifecycleAttempt>()
const lifecycleProtocols = new WeakMap<object, LifecycleAttempt>()
let lifecycleNext = 0, lifecycleTotal = 0, lifecycleOverflow = false
function lifecycleAttempt(event: object) {
  if (!lifecycleChannel.hasSubscribers) return
  let attempt = lifecycleEvents.get(event)
  if (!attempt && lifecycleNext < 256) {
    attempt = { id: ++lifecycleNext, count: 0, receipt: false, initEntered: false, initSettled: false, owner: false, response: false, sid: false, sidEqual: false, adopted: false }; lifecycleEvents.set(event, attempt)
  }
  return attempt
}
function lifecyclePublish(attempt: LifecycleAttempt | undefined, stage: string, fields: () => Record<string, unknown> = () => ({})) {
  if (!lifecycleChannel.hasSubscribers || !lifecycleStages.has(stage) || lifecycleTotal >= 256) return
  try {
    if (!attempt || attempt.count >= 63 || lifecycleTotal >= 255) {
      if (!lifecycleOverflow) { lifecycleOverflow = true; lifecycleTotal++; if (attempt) attempt.count++; lifecycleChannel.publish({ stage: 'overflow', attempt: attempt?.id ?? 0 }) }
      return
    }
    const observed = fields(), payload: Record<string, unknown> = { stage, attempt: attempt.id }
    if (observed.receipt === true) attempt.receipt = true
    if (observed.initEntered === true) attempt.initEntered = true
    if (observed.initSettled === true) attempt.initSettled = true
    for (const key of ['owner', 'response', 'sid', 'sidEqual', 'adopted'] as const) if (typeof observed[key] === 'boolean') attempt[key] = observed[key] as boolean
    for (const key of lifecycleBooleans) if (typeof observed[key] === 'boolean') payload[key] = observed[key]
    payload.receipt = attempt.receipt; payload.initEntered = attempt.initEntered; payload.initSettled = attempt.initSettled
    for (const key of ['owner', 'response', 'sid', 'sidEqual', 'adopted'] as const) payload[key] = attempt[key]
    if (Number.isInteger(observed.status) && Number(observed.status) >= 100 && Number(observed.status) <= 599) payload.status = observed.status
    if (['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'other'].includes(String(observed.errorName))) payload.errorName = observed.errorName
    if (['ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_HTTP_HEADERS_SENT', 'initialization_closed', 'candidate_ownership_missing', 'other'].includes(String(observed.errorCode))) payload.errorCode = observed.errorCode
    attempt.count++; lifecycleTotal++; lifecycleChannel.publish(payload)
  } catch { /* Diagnostic failure never changes SDK values, throws, charge or receipt. */ }
}
export function sessionLifecycle(event: object, stage: string, fields?: () => Record<string, unknown>) {
  if (!lifecycleChannel.hasSubscribers) return
  try { lifecyclePublish(lifecycleAttempt(event), stage, fields) } catch {}
}
function lifecycleError(error: unknown) {
  try {
    const name = error instanceof Error ? error.name : 'other'
    const descriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined
    const code = descriptor && 'value' in descriptor ? descriptor.value : 'other'
    return { errorName: ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError'].includes(name) ? name : 'other', errorCode: ['ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_HTTP_HEADERS_SENT', 'initialization_closed', 'candidate_ownership_missing'].includes(code) ? code : 'other' }
  } catch { return { errorName: 'other', errorCode: 'other' } }
}
function lifecycleContext(event: object, current: () => object) {
  try { return { currentAvailable: true, currentEqual: current() === event } } catch { return { currentAvailable: false, currentEqual: false } }
}

const own = (value: unknown, key: string) => !!value && typeof value === 'object' && Object.hasOwn(value, key)
/** SDK 1.32.1 types.js RELATED_TASK_META_KEY; ordinary _meta remains legal. */
export function acceptsSessionFrame(frame: unknown): boolean {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return false
  const value = frame as { method?: unknown; params?: { task?: unknown; _meta?: unknown } }
  return typeof value.method === 'string' && !value.method.startsWith('tasks/')
    && !own(value.params, 'task') && !own(value.params?._meta, 'io.modelcontextprotocol/related-task')
}

export function createCredentialSnapshot(startup: string) {
  let disabled = false
  return Object.freeze({
    authenticate(headers: Headers, current: string) {
      if (current !== startup) disabled = true
      if (disabled || headers.has('x-mcp-token')) return { kind: 'invalid' as const }
      if (!headers.has('authorization')) return { kind: 'anonymous' as const, epoch: 0 }
      const token = readMcpToken({ authorization: headers.get('authorization') ?? '' })
      return tokenMatches(token, startup)
        ? { kind: 'authorized' as const, principal: 'mcp-token', epoch: 0 }
        : { kind: 'invalid' as const }
    },
    disabled: () => disabled,
    disable: () => { disabled = true },
  })
}

type Frame = { id?: unknown; method?: unknown }
type Extra = { sessionId?: string }
type Receipt = { finished: true }
type RuntimeOwner = { protocol: object; sid: string; currentEvent: () => object; requests: Map<string, Pending>; retired: boolean; onRelease?: () => void }
type Pending = { event: object; sid: string; id: string | number; method: string; started: boolean;
  settled: boolean; response: boolean; failed: boolean; resolve: (receipt: Receipt) => void }
const key = (sid: string, id: string | number) => JSON.stringify([sid, typeof id, id])

/** Repository-owned bounded receipts, never an SDK registry/controller mirror. */
export function createSessionRuntime() {
  let entered = 0, settled = 0, resultSends = 0, errorSends = 0
  const initializing = new Map<object, { event: object; currentEvent: () => object; receipt: ReturnType<typeof deferred<Receipt>> }>()
  const owners = new Map<object, RuntimeOwner>()
  let poisoned = false, requests = 0
  let firstFault: string | null = null
  function fault(source: unknown = 'runtime_observer') {
    poisoned = true
    const allowed = ['runtime_observer', 'binding_invalid', 'binding_duplicate_protocol', 'binding_duplicate_entry', 'binding_duplicate_provider', 'binding_duplicate_config', 'binding_duplicate_factory', 'credential_capture_duplicate']
    if (firstFault === null) firstFault = typeof source === 'string' && allowed.includes(source) ? source : 'runtime_observer'
  }
  function reconcile(owner: RuntimeOwner, token: string, item: Pending) {
    if (!item.failed && item.settled && item.response && owner.requests.get(token) === item) {
      owner.requests.delete(token); requests--
      if (owner.retired && !owner.requests.size) { owners.delete(owner.protocol); owner.onRelease?.() }
    }
  }
  function find(protocol: object, frame: Frame, extra: Extra) {
    const owner = owners.get(protocol)
    if (!owner) return
    if (extra.sessionId !== owner.sid || (typeof frame.id !== 'string' && typeof frame.id !== 'number')) { fault(); return }
    const token = key(extra.sessionId, frame.id), item = owner.requests.get(token)
    if (!item || item.method !== frame.method) { fault(); return }
    try { if (owner.currentEvent() !== item.event) throw new Error('event_mismatch') }
    catch { item.failed = true; fault(); return }
    return { owner, token, item }
  }
  return Object.freeze({
    claim(protocol: object, currentEvent: () => object, capturedSid: string, onRelease?: () => void) {
      if (poisoned || owners.has(protocol) || owners.size >= 64 || !/^[A-Za-z0-9_-]{1,256}$/.test(capturedSid)) throw new Error('runtime_owner_unavailable')
      owners.set(protocol, { protocol, sid: capturedSid, currentEvent, requests: new Map(), retired: false, onRelease })
    },
    retire(protocol: object) {
      const owner = owners.get(protocol)
      if (!owner) return
      owner.retired = true
      if (!owner.requests.size) { owners.delete(protocol); owner.onRelease?.() }
    },
    release(protocol: object) {
      const owner = owners.get(protocol)
      if (!owner || owner.requests.size) throw new Error('runtime_owner_not_closed')
      owners.delete(protocol)
    },
    reserve(protocol: object, event: object, sid: string, id: string | number, method: string, response: Promise<Receipt>) {
      const owner = owners.get(protocol), token = key(sid, id)
      if (poisoned || !owner || owner.sid !== sid || owner.retired || owner.requests.has(token) || owner.requests.size >= 4 || requests >= 32) throw new Error('runtime_receipt_unavailable')
      let resolve!: (receipt: Receipt) => void
      const receipt = new Promise<Receipt>(r => { resolve = r })
      const item: Pending = { event, sid, id, method, started: false, settled: false, response: false, failed: false, resolve }
      owner.requests.set(token, item); requests++
      response.then(value => {
        if (!value || Reflect.ownKeys(value).length !== 1 || Object.getOwnPropertyDescriptor(value, 'finished')?.value !== true) { item.failed = true; fault(); return }
        item.response = true; reconcile(owner, token, item)
      }, () => { item.failed = true; fault() }).catch(fault)
      return receipt
    },
    observe<T>(protocol: object, frame: Frame, extra: Extra, run: () => T): T {
      // Foreign (including legacy stateless) owners are exactly transparent.
      if (!owners.has(protocol)) {
        const init = initializing.get(protocol)
        if (!init || frame.method !== 'initialize') return run()
        lifecyclePublish(lifecycleProtocols.get(protocol), 'init-entered', () => ({ initEntered: true, receipt: true }))
        let valid = false
        try { valid = init.currentEvent() === init.event } catch { fault() }
        if (!valid) fault()
        else if (entered < 2147483647) entered++
        const finish = () => {
          if (valid && settled < 2147483647) { settled++; init.receipt.resolve({ finished: true }); lifecyclePublish(lifecycleProtocols.get(protocol), 'init-settled', () => ({ initSettled: true, currentEqual: valid })) } else fault()
        }
        try { return Promise.resolve(run()).then(value => { finish(); return value }, error => { finish(); throw error }) as T }
        catch (error) { finish(); throw error }
      }
      let record: ReturnType<typeof find>
      try {
        record = find(protocol, frame, extra)
        if (record) {
          if (record.item.started) { record.item.failed = true; fault() }
          record.item.started = true
          if (entered === 2147483647) { record.item.failed = true; fault() } else entered++
        }
      } catch { if (record) record.item.failed = true; fault() }
      const finish = () => {
        try {
          if (!record || record.item.failed) return
          if (settled === 2147483647) { record.item.failed = true; fault(); return }
          settled++
          record.item.settled = true; record.item.resolve({ finished: true })
          reconcile(record.owner, record.token, record.item)
        } catch { if (record) record.item.failed = true; fault() }
      }
      try {
        const result = run()
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          // Preserve fulfillment/rejection. Observer faults never replace SDK values.
          return Promise.resolve(result).then(value => { finish(); return value }, error => { finish(); throw error }) as T
        }
        finish(); return result
      } catch (error) { finish(); throw error }
    },
    unknownResponse(protocol: object, sid: string, frame: Frame & { error?: unknown }) {
      if (!own(frame, 'error') || (frame.error as { code?: unknown })?.code !== -32601) return
      const owner = owners.get(protocol)
      if (!owner) return
      if (owner.sid !== sid) { fault(); return }
      if (typeof frame.id !== 'string' && typeof frame.id !== 'number') { fault(); return }
      const token = key(sid, frame.id), item = owner.requests.get(token)
      if (!item || item.failed || item.started || item.settled) return
      try {
        if (owner.currentEvent() !== item.event) throw new Error('event_mismatch')
        item.settled = true; item.resolve({ finished: true }); reconcile(owner, token, item)
      } catch { item.failed = true; fault() }
    },
    beginInitialization(protocol: object, event: object, currentEvent: () => object) {
      if (initializing.has(protocol) || initializing.size >= 64 || owners.has(protocol)) throw new Error('initialization_owner_unavailable')
      const receipt = deferred<Receipt>(); initializing.set(protocol, { event, currentEvent, receipt })
      if (lifecycleChannel.hasSubscribers) { try { const attempt = lifecycleAttempt(event); if (attempt) lifecycleProtocols.set(protocol, attempt); sessionLifecycle(event, 'init-receipt', () => ({ receipt: true })) } catch {} }
      return receipt.promise
    },
    endInitialization: (protocol: object) => { const init = initializing.get(protocol); initializing.delete(protocol); init?.receipt.reject(new Error('initialization_closed')); const attempt = lifecycleProtocols.get(protocol); if (attempt) lifecyclePublish(attempt, 'init-end') },
    sent(frame: any) {
      if (own(frame, 'result')) { if (resultSends === 2147483647) fault(); else resultSends++ }
      if (own(frame, 'error')) { if (errorSends === 2147483647) fault(); else errorSends++ }
    },
    observations: () => ({ entered, settled, resultSends, errorSends }),
    diagnosticFault: () => firstFault,
    owns: (protocol: object, sid: string) => owners.get(protocol)?.sid === sid,
    snapshot: () => ({ owners: owners.size, requests, poisoned }),
    fault,
  })
}

export const sessionRuntime = createSessionRuntime()
const bindings = new Set<string>()
let graph = false
let entryProfile = 'unbound'
export function markSessionEntryProfile(value: string) { entryProfile = ['component', 'direct-node', 'nuxt-source'].includes(value) ? value : 'invalid' }
let diagnosticGraphValue = 'unset', diagnosticGraphAssignments = 0
const diagnosticGraphHistory: string[] = []
export function markSessionBinding(binding: string) {
  if (!['protocol', 'entry', 'provider', 'config', 'factory'].includes(binding) || bindings.has(binding)) { sessionRuntime.fault(['protocol', 'entry', 'provider', 'config', 'factory'].includes(binding) ? 'binding_duplicate_' + binding : 'binding_invalid'); return }
  bindings.add(binding)
}
export function markSessionGraph(value: string) {
  graph = value === 'ready'
  diagnosticGraphValue = ['ready', 'invalid', '__MCP_SESSION_GRAPH_V1__'].includes(value) ? value : 'other'
  diagnosticGraphAssignments = Math.min(255, diagnosticGraphAssignments + 1)
  diagnosticGraphHistory.push(diagnosticGraphValue)
  if (diagnosticGraphHistory.length > 4) diagnosticGraphHistory.shift()
}
/** Read-only bounded observation, exposed over HTTP ONLY by the owned fixture. */
export function sessionBindingDiagnostic() {
  return { graph, entryProfile, graphValue: diagnosticGraphValue, graphAssignments: diagnosticGraphAssignments, graphHistory: [...diagnosticGraphHistory], bindings: [...bindings].sort(), poisoned: sessionRuntime.snapshot().poisoned, firstFault: sessionRuntime.diagnosticFault() }
}
export function sessionBindingReady() {
  return graph && ['component', 'direct-node', 'nuxt-source'].includes(entryProfile) && bindings.has('protocol') && bindings.has('entry') && bindings.has('provider') && bindings.has('config') && bindings.has('factory') && !sessionRuntime.snapshot().poisoned
}
/** Injected only into the locked complete Protocol registration thunk. */
export function observeRegisteredRequest<T>(protocol: object, frame: Frame, extra: Extra, run: () => T): T {
  return sessionRuntime.observe(protocol, frame, extra, run)
}

// Public-client framing is a separate authority from Nitro worker body reading.
export type SessionMount = { baseURL: string; route: '/mcp-session' }
export type SessionEntryProfile = { kind: 'component' | 'direct-node'; mount: SessionMount }
  | { kind: 'nuxt-source'; mount: SessionMount; frontendReady: () => boolean }
type FramingResult = { kind: 'pass' } | { kind: 'reject'; status: 400 | 413; code: 'invalid_framing' | 'body_too_large' }
const frontendChannel = channel('ningbo.mcp-session.445.frontend.v1')
const frontendBudgetKey = Symbol.for('ningbo.mcp-session.445.frontend-budget.v1')
const frontendServerKey = Symbol.for('ningbo.mcp-session.445.frontend-server.v1')
type FrontendRefusalReason = 'pin-false' | 'request-listener-count' | 'once-wrapper' | 'previous-version' | 'mount' | 'wrapped-mismatch'
function frontendObservation(stage: 'installed' | 'install-refused' | 'registered' | 'app-installed' | 'app-entered' | 'refusal-end', fields: { owned?: boolean; session?: boolean; status?: number; ended?: boolean; reason?: FrontendRefusalReason; listenerCount?: number; singleFunction?: boolean; onceWrapper?: boolean; previousPresent?: boolean; versionEqual?: boolean; mountEqual?: boolean; wrappedEqual?: boolean } = {}) {
  if (!frontendChannel.hasSubscribers) return
  try {
    const global = globalThis as any
    const budget = global[frontendBudgetKey] ??= { count: 0 }
    if (budget.count >= 64) return
    if (budget.count === 63) { budget.count++; frontendChannel.publish({ stage: 'overflow' }); return }
    budget.count++; frontendChannel.publish({ stage, ...fields })
  } catch { /* Read-only diagnostic failure never changes native disposal. */ }
}

/** Diagnostic-only lazy reads; no subscriber means no extra listener inspection. */
function frontendInstallRefused(server: any, reason: () => FrontendRefusalReason, shape: () => { previousPresent: boolean; versionEqual?: boolean; mountEqual?: boolean; wrappedEqual?: boolean }) {
  if (!frontendChannel.hasSubscribers) return
  try {
    const listeners = server.rawListeners('request')
    frontendObservation('install-refused', { reason: reason(), listenerCount: Math.min(listeners.length, 65535), singleFunction: listeners.length === 1 && typeof listeners[0] === 'function', onceWrapper: !!listeners[0]?.listener, ...shape() })
  } catch { /* Inspection failure never changes the original return or gate. */ }
}

/** Locked H3 1.15.11 _decodePath/ufo decodePath + radix3 trailing-slash semantics.
 * Never mutate req.url/headers. The mount comes from resolved Nuxt config.
 */
export function isPublicSessionTarget(target: string, mount: SessionMount) {
  if (!mount || typeof mount.baseURL !== 'string' || !mount.baseURL.startsWith('/') || mount.route !== '/mcp-session') return false
  const q = target.indexOf('?'), raw = q < 0 ? target : target.slice(0, q)
  const escaped = raw.replace(/%25/g, '%2525').replace(/%2f/gi, '%252F')
  let decoded = escaped
  try { decoded = decodeURIComponent(escaped) } catch { /* ufo.decode returns the original text. */ }
  const base = mount.baseURL.replace(/\/$/, '')
  return decoded.replace(/\/$/, '') === base + mount.route
}
export function isPublicSessionPost(method: string, target: string, mount: SessionMount) { return method === 'POST' && isPublicSessionTarget(target, mount) }
export function inspectPublicSessionPost(method: string, target: string, rawHeaders: readonly string[], mount: SessionMount): FramingResult {
  if (!isPublicSessionPost(method, target, mount)) return { kind: 'pass' }
  let lengths = 0, length = '', sid = false, forbidden = false
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase()
    if (name === 'content-length') { lengths++; length = rawHeaders[i + 1] ?? '' }
    if (name === 'mcp-session-id') sid = true
    if (name === 'transfer-encoding' || name === 'content-encoding') forbidden = true
  }
  if (lengths !== 1 || forbidden || !/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length))) return { kind: 'reject', status: 400, code: 'invalid_framing' }
  if (Number(length) > (sid ? 65536 : 16384)) return { kind: 'reject', status: 413, code: 'body_too_large' }
  return { kind: 'pass' }
}
function publicRefusal(req: IncomingMessage, res: ServerResponse, status: number, code: string) {
  // This is the exact original native response, never a Web/H3 mock response.
  const terminate = hasNativeSessionOwnership(req) && nativeResponses.get(req) === res ? ownedTermination(req, res) : undefined
  try {
    if (!res.closed && !res.writableEnded) {
      const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: code, data: { code } } }))
      res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store')
      res.setHeader('content-length', bytes.byteLength); res.end(bytes)
      frontendObservation('refusal-end', { status, ended: res.writableEnded, owned: !!terminate })
    }
  } finally { terminate?.() } // Intent is recorded AFTER native end; finish/close still required.
}

export interface SessionFrontendBinding {
  readonly installed: boolean
  ready(): boolean
  bindApp(app: any, defineHandler: (handler: (event: any) => void) => any): boolean
}
type FrontendState = SessionFrontendBinding & { version: string; mountKey: string; wrapped: RequestListener;
  rearm(): void; disable(): void }
const unavailableFrontend: SessionFrontendBinding = Object.freeze({ installed: false, ready: () => false, bindApp: () => false })
/** Public listen hook only. No CLI code copy, global prototype or listener fanout. */
export function installSessionFrontend(server: any, mount: SessionMount, version: string, pinsOK: boolean): SessionFrontendBinding {
  if (!server || typeof server.rawListeners !== 'function' || typeof server.on !== 'function' || typeof server.removeListener !== 'function' || !Object.isExtensible(server) || !mount || typeof mount.baseURL !== 'string' || !isPublicSessionTarget(mount.baseURL.replace(/\/$/, '') + mount.route, mount)) return unavailableFrontend
  const mountKey = JSON.stringify(mount)
  const previous = server[frontendServerKey] as FrontendState | undefined
  if (previous) {
    if (typeof previous.disable !== 'function' || typeof previous.rearm !== 'function' || typeof previous.ready !== 'function' || typeof previous.bindApp !== 'function') return unavailableFrontend
    if (!pinsOK || previous.version !== version || previous.mountKey !== mountKey || server.rawListeners('request').length !== 1 || server.rawListeners('request')[0] !== previous.wrapped) {
      previous.disable()
      frontendInstallRefused(server, () => !pinsOK ? 'pin-false' : previous.version !== version ? 'previous-version' : previous.mountKey !== mountKey ? 'mount' : server.rawListeners('request').length !== 1 ? 'request-listener-count' : 'wrapped-mismatch', () => ({ previousPresent: true, versionEqual: previous.version === version, mountEqual: previous.mountKey === mountKey, wrappedEqual: server.rawListeners('request').length === 1 && server.rawListeners('request')[0] === previous.wrapped }))
      return unavailableFrontend
    }
    previous.rearm(); return previous
  }
  const listeners = server.rawListeners('request')
  if (!pinsOK || listeners.length !== 1 || typeof listeners[0] !== 'function' || listeners[0].listener) {
    frontendInstallRefused(server, () => !pinsOK ? 'pin-false' : listeners.length !== 1 || typeof listeners[0] !== 'function' ? 'request-listener-count' : 'once-wrapper', () => ({ previousPresent: false }))
    return unavailableFrontend
  }
  const original: RequestListener = listeners[0]
  let enabled = true, configured = false, currentApp: any = null, currentLayer: any = null, installed = true
  // Requests already active before this hook have no discoverable public owner.
  // Only sockets observed at connection/secureConnection AFTER installation can
  // confer destruction authority. Unknown old sockets remain cleanup-UNKNOWN
  // until real close; never pretend their loading/foreign responses finished.
  const newConnections = new WeakSet<IncomingMessage['socket']>()
  const connected = (socket: IncomingMessage['socket']) => { newConnections.add(socket) }
  // Keep the SAME ownership closure across Nuxt reloads on this Server.
  const wrapped = ownAllRequests(function (this: unknown, req, res) {
    const session = isPublicSessionTarget(req.url ?? '/', mount)
    frontendObservation('registered', { session, owned: hasNativeSessionOwnership(req) })
    if (session && (!enabled || !configured || currentApp?.stack?.[0] !== currentLayer)) return publicRefusal(req, res, 503, 'session_binding_unavailable')
    return original.call(this, req, res)
  }, undefined, true, newConnections)
  const state: FrontendState = {
    version, mountKey, wrapped,
    get installed() { return installed },
    ready: () => installed && enabled && configured && currentApp?.stack?.[0] === currentLayer,
    rearm() { configured = false },
    disable() { enabled = false; configured = false },
    bindApp(app, defineHandler) {
      if (!installed || !enabled || !Array.isArray(app?.stack) || typeof app?.use !== 'function' || !app.options || app.options.onRequest != null) { configured = false; return false }
      if (currentApp === app) { configured = app.stack[0] === currentLayer; return configured }
      // Public H3 App.stack/use. Put a scoped first layer BEFORE Vite/proxy.
      // The CLI reaches this layer only after publishing this actual app handler.
      const handler = defineHandler(event => {
        frontendObservation('app-entered', { owned: hasNativeSessionOwnership(event.node.req), session: true })
        if (!enabled || !hasNativeSessionOwnership(event.node.req)) return publicRefusal(event.node.req, event.node.res, 503, 'session_binding_unavailable')
        const result = inspectPublicSessionPost(event.node.req.method ?? 'GET', event.node.req.originalUrl ?? event.node.req.url ?? '/', event.node.req.rawHeaders, mount)
        if (result.kind === 'reject') publicRefusal(event.node.req, event.node.res, result.status, result.code)
      })
      const size = app.stack.length
      app.use({ route: '/', match: (_path: string, event: any) => !!event?.node?.req && isPublicSessionPost(event.node.req.method ?? 'GET', event.node.req.originalUrl ?? event.node.req.url ?? '/', mount), handler })
      if (app.stack.length !== size + 1) { configured = false; return false }
      const layer = app.stack.pop(); app.stack.unshift(layer)
      currentApp = app; currentLayer = layer; configured = true; frontendObservation('app-installed'); return true
    },
  }
  // Same-isolate synchronous swap: no request can interleave remove/on.
  Object.defineProperty(server, frontendServerKey, { value: state, configurable: false })
  server.on('connection', connected); server.on('secureConnection', connected)
  server.removeListener('request', original); server.on('request', wrapped)
  server.once('close', () => { installed = false; enabled = false; configured = false; currentApp = null; server.removeListener('connection', connected); server.removeListener('secureConnection', connected) })
  frontendObservation('installed'); return state
}

const sockets = createSocketOwnership<IncomingMessage['socket']>()
const handles = new WeakMap<IncomingMessage, ReturnType<typeof sockets.register>>()
const responses = new WeakMap<IncomingMessage, Promise<Receipt>>()
const nativeResponses = new WeakMap<IncomingMessage, ServerResponse>()
const responseTerminations = new WeakMap<IncomingMessage, () => void>()
const seen = new WeakSet<IncomingMessage['socket']>()
/** Called synchronously at the ORIGINAL prod/dev listener boundary, for all URLs. */
export function ownAllRequests(next: RequestListener, publicMount?: SessionMount, publicInstalled = true, disposalAuthority?: WeakSet<IncomingMessage['socket']>): RequestListener {
  return function (this: unknown, req, res) {
    const socket = req.socket
    if (!seen.has(socket)) {
      seen.add(socket)
      socket.once('close', () => sockets.closed(socket))
    }
    let handle: ReturnType<typeof sockets.register>
    try { handle = sockets.register(socket, () => {
      // S1 acknowledges ONLY an actual socket close, never this action's return.
      // Declining an unproved disposal leaves its real charge/close UNKNOWN.
      if (!disposalAuthority || disposalAuthority.has(socket)) socket.destroy()
    }) }
    catch { sessionRuntime.fault(); if (publicMount && isPublicSessionTarget(req.url ?? '/', publicMount)) return publicRefusal(req, res, 503, 'session_binding_unavailable'); return next.call(this, req, res) }
    handles.set(req, handle); nativeResponses.set(req, res)
    const requestDone = () => { req.off('end', requestDone); req.off('close', requestDone); handle.requestFinished() }
    req.once('end', requestDone); req.once('close', requestDone)
    const response = new Promise<Receipt>(resolve => {
      const done = () => {
        res.off('finish', done); res.off('close', done)
        handle.responseFinished(); resolve({ finished: true })
      }
      res.once('finish', done); res.once('close', done)
      if (res.closed) done() // actual close, never destroy() scheduling
    })
    responses.set(req, response)
    if (req.readableEnded || req.closed) requestDone()
    if (socket.closed) sockets.closed(socket)
    if (publicMount) {
      if (!publicInstalled && isPublicSessionTarget(req.url ?? '/', publicMount)) return publicRefusal(req, res, 503, 'session_binding_unavailable')
      const result = inspectPublicSessionPost(req.method ?? 'GET', req.url ?? '/', req.rawHeaders, publicMount)
      if (result.kind === 'reject') return publicRefusal(req, res, result.status, result.code)
    }
    return next.call(this, req, res)
  }
}

export function hasNativeSessionOwnership(req: IncomingMessage) { return handles.has(req) && responses.has(req) }

/** Caller disposal is scheduled only after this native response actually finishes
 * or closes. end()/handler return alone confer no socket destruction authority.
 * No body is read, no timer/promise or close receipt is manufactured here.
 */
export function createResponseTermination(
  response: { readonly closed: boolean; readonly writableFinished: boolean;
    once(event: 'finish' | 'close', listener: () => void): unknown;
    off(event: 'finish' | 'close', listener: () => void): unknown },
  terminate: () => void,
) {
  let requested = false, retired = false
  const completed = () => {
    if (retired) return
    retired = true
    response.off('finish', completed); response.off('close', completed)
    // The ORIGINAL S1 handle dynamically protects all other active owners.
    // A close event is not evidence that the intended HTTP status was delivered.
    terminate()
  }
  return () => {
    if (requested) return
    requested = true
    response.once('finish', completed); response.once('close', completed)
    // Native flags cover finish/close that occurred before listener registration.
    if (response.writableFinished || response.closed) completed()
  }
}

function ownedTermination(req: IncomingMessage, res: ServerResponse) {
  const handle = handles.get(req)
  if (!handle || !responses.has(req) || nativeResponses.get(req) !== res) throw new Error('native_ownership_missing')
  let terminate = responseTerminations.get(req)
  if (!terminate) { terminate = createResponseTermination(res, () => handle.terminate()); responseTerminations.set(req, terminate) }
  return terminate
}
export function nativeSessionIngress(req: IncomingMessage, res: ServerResponse, url: string): OwnedIngress {
  const handle = handles.get(req), responseFinished = responses.get(req)
  if (!handle || !responseFinished || nativeResponses.get(req) !== res) throw new Error('native_ownership_missing')
  const terminate = ownedTermination(req, res)
  const rawHeaders: Array<[string, string]> = []
  const headers = new Headers()
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!, value = req.rawHeaders[i + 1]!
    rawHeaders.push([name, value]); headers.append(name, value)
  }
  let body: ReadableStream<Uint8Array> | null | undefined
  return { method: req.method ?? 'GET', url, headers, rawHeaders,
    get body() { return body ??= req.method === 'POST' ? Readable.toWeb(req) as ReadableStream<Uint8Array> : null },
    responseFinished, closed: handle.closed, subscribeClosed: handle.subscribeClosed,
    terminate,
  }
}

const observedTransports = new WeakSet<object>()
/** Wrap only the owned public transport; no controller/handler registry access. */
export function observeSessionSend<T extends { sessionId?: string; send: (...args: any[]) => any }>(protocol: object, transport: T) {
  const capturedSid = transport.sessionId
  if (!capturedSid || !sessionRuntime.owns(protocol, capturedSid) || observedTransports.has(transport)) throw new Error('transport_not_owned')
  const original = transport.send
  transport.send = function (this: T, ...args: Parameters<T['send']>) {
    try {
      if (transport.sessionId !== capturedSid || !sessionRuntime.owns(protocol, capturedSid)) sessionRuntime.fault()
      else if (args[0]?.jsonrpc === '2.0') { sessionRuntime.sent(args[0]); sessionRuntime.unknownResponse(protocol, capturedSid, args[0]) }
    } catch { sessionRuntime.fault() }
    return original.apply(this, args)
  } as T['send']
  observedTransports.add(transport)
}

// Only module-private object identity confers the new-entry capability.
const sessionEvents = new WeakSet<object>()
const replayTokens = new WeakMap<object, (event: any) => Promise<Response>>()
export function isSessionEvent(event: object) { return sessionEvents.has(event) }
export function createSessionReplay(run: (event: any) => Promise<Response>) {
  const token = Object.freeze({})
  replayTokens.set(token, run)
  return token
}
export function takeSessionReplay(event: any): Promise<Response> | undefined {
  const token = event.context?.mcpSessionReplay
  if (!token || typeof token !== 'object') return
  const run = replayTokens.get(token)
  if (!run) return
  replayTokens.delete(token); sessionEvents.add(event)
  return run(event)
}
let startupCredential: ReturnType<typeof createCredentialSnapshot> | undefined
let startupEnvironment: string | undefined
export function captureSessionCredential(value: unknown) {
  if (startupCredential) { sessionRuntime.fault('credential_capture_duplicate'); return }
  startupEnvironment = process.env.NUXT_MCP_TOKEN
  startupCredential = createCredentialSnapshot(typeof value === 'string' ? value : '')
}
function authenticateSession(headers: Headers, current: string) {
  if (!startupCredential) return { kind: 'invalid' as const }
  if (process.env.NUXT_MCP_TOKEN !== startupEnvironment) startupCredential.disable()
  return startupCredential.authenticate(headers, current)
}

interface ToolkitOwner extends SessionOwner { server: object }
type NativeProvider = (factory: () => ToolkitOwner, event: any) => Promise<Response>
type Dispatch = (factory: () => ToolkitOwner, provider: NativeProvider) => Promise<Response>
const toolkitDispatch = new WeakMap<object, Dispatch>()
export function dispatchSessionTransport(factory: () => ToolkitOwner, event: any, provider: NativeProvider) {
  if (!isSessionEvent(event)) return provider(factory, event)
  return toolkitDispatch.get(event)?.(factory, provider) ?? Promise.resolve(sessionRefusal('transport_not_owned'))
}
function sessionRefusal(code: string, status = 503) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: code } }), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  // Gates may fail before their bounded S1 caller starts awaiting them.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

/** No toolkit dispatcher copy: real handler hands us its ORIGINAL factory.
 * Every start occurs inside an already charged S1 factory/provider call.
 */
export function createSessionEndpoint(deps: {
  invokeToolkit(event: any): Promise<Response>
  replay(event: any, request: Request, run: (current: any) => Promise<Response>): Promise<Response>
  currentEvent(): object
  currentCredential(event: any): string
  cleanupSession(sid: string): Promise<{ empty: true }>
}) {
  type Resource = { owner: ToolkitOwner; connection?: any; ownerClosed: boolean; transportClosed: boolean; storageEmpty: boolean; sid?: string; claimed: boolean }
  type Run = { initialization?: Promise<Receipt>; candidate: ReturnType<typeof deferred<ToolkitOwner>>; dispatch: ReturnType<typeof deferred<(provider: NativeProvider) => Promise<Response>>>; final: Promise<Response>; resource?: Resource }
  const runs = new WeakMap<object, Run>()
  let toolkitRuns = 0, accepting = true
  const replays = new Set<object>() // H3 onRequest can await BEFORE S1 dispatch; bounded separately.
  const resources = new WeakMap<ToolkitOwner, Resource>()
  const bySid = new Map<string, Resource>() // only explicitly captured owners; <= S1 64
  function reconcile(resource: Resource) {
    if (resource.claimed && resource.ownerClosed && resource.transportClosed && resource.storageEmpty) sessionRuntime.retire(resource.owner.server)
  }
  function start(event: any): Run {
    sessionLifecycle(event, 'factory-start', () => ({ ...lifecycleContext(event, deps.currentEvent), sessionEvent: isSessionEvent(event) }))
    if (runs.has(event)) throw new Error('duplicate_toolkit_run')
    const candidate = deferred<ToolkitOwner>(), dispatch = deferred<(provider: NativeProvider) => Promise<Response>>()
    const state: Run = { candidate, dispatch, final: undefined as unknown as Promise<Response> }
    runs.set(event, state); toolkitRuns++
    toolkitDispatch.set(event, async (factory, provider) => {
      let owner: ToolkitOwner
      try { owner = factory() }
      catch (error) { sessionLifecycle(event, 'candidate', () => ({ owner: false, ...lifecycleError(error) })); throw error }
      if (resources.has(owner)) throw new Error('borrowed_toolkit_candidate')
      const resource: Resource = { owner, ownerClosed: false, transportClosed: false, storageEmpty: false, claimed: false }
      resources.set(owner, resource); state.resource = resource
      candidate.resolve(owner) // S1 owns this candidate even if public wrapping partially throws.
      sessionLifecycle(event, 'candidate', () => ({ owner: true, ...lifecycleContext(event, deps.currentEvent) }))
      if (!event.node.req.headers['mcp-session-id']) state.initialization = sessionRuntime.beginInitialization(owner.server, event, deps.currentEvent)
      const originalClose = owner.close.bind(owner)
      owner.close = async () => {
        sessionLifecycle(event, 'owner-close', () => ({ owner: true, adopted: event.context._mcpServer === owner }))
        // Release an unselected gate on revoke/late factory. Never start native work.
        dispatch.resolve(async () => sessionRefusal('initialization_revoked'))
        try { await originalClose() }
        catch (error) { sessionLifecycle(event, 'owner-closed', () => ({ complete: false, ...lifecycleError(error) })); throw error }
        resource.ownerClosed = true
        sessionLifecycle(event, 'owner-closed', () => ({ complete: resource.ownerClosed, adopted: event.context._mcpServer === owner }))
        if (!resource.claimed) sessionRuntime.endInitialization(owner.server)
        reconcile(resource)
      }
      const connect = owner.connect.bind(owner)
      owner.connect = async connection => {
        sessionLifecycle(event, 'connect', () => ({ owner: true, sid: typeof connection.sessionId === 'string' }))
        resource.connection = connection
        const close = connection.close.bind(connection)
        connection.close = async () => {
          try { await close() }
          catch (error) { sessionLifecycle(event, 'transport-closed', () => ({ complete: false, ...lifecycleError(error) })); throw error }
          resource.transportClosed = true; sessionLifecycle(event, 'transport-closed', () => ({ complete: true })); reconcile(resource)
        }
        await connect(connection)
        sessionLifecycle(event, 'connected', () => ({ sid: typeof connection.sessionId === 'string' }))
      }
      return (await dispatch.promise)(provider)
    })
    state.final = Promise.resolve().then(() => deps.invokeToolkit(event)).then(response => {
      sessionLifecycle(event, 'toolkit-return', () => {
        const sid = state.resource?.connection?.sessionId
        return { owner: !!state.resource, response: !!response, status: response?.status, sid: typeof sid === 'string', sidEqual: typeof sid === 'string' && response?.headers.get('mcp-session-id') === sid, adopted: !!state.resource && event.context._mcpServer === state.resource.owner, receipt: !!state.initialization, authPresent: !!event.context.mcpAuth, authorized: event.context.mcpAuth?.writeAuthorized === true }
      })
      if (!state.resource) candidate.reject(new Error('toolkit_rejected_before_factory'))
      return response
    }, error => { sessionLifecycle(event, 'toolkit-error', () => lifecycleError(error)); candidate.reject(new Error('toolkit_factory_failed')); throw error }).finally(() => {
      toolkitDispatch.delete(event); runs.delete(event); toolkitRuns--
    })
    void state.final.catch(() => {})
    return state
  }
  const adapter = createSessionInitializationTransport<any, ToolkitOwner>({
    authenticate: event => authenticateSession(new Headers(event.node.req.headers as Record<string, string>), deps.currentCredential(event)),
    replay: async (event, request, run) => {
      if (replays.size >= 40 || replays.has(event)) return sessionRefusal('replay_capacity')
      replays.add(event)
      try { return await deps.replay(event, request, run) } finally { replays.delete(event) }
    },
    factory: event => start(event).candidate.promise,
    adopted: event => event.context._mcpServer,
    handlerFinished: (event, request) => {
      const resource = bySid.get(request.sessionId)
      const ingress = ingressFor.get(event)
      if (!resource || !ingress?.responseFinished) throw new Error('receipt_owner_missing')
      return sessionRuntime.reserve(resource.owner.server, event, request.sessionId, request.id, request.method, ingress.responseFinished)
    },
    provider: async (factory, event) => {
      const chosen = factory()
      sessionLifecycle(event, 'provider-entry', () => ({ owner: !!chosen, ...lifecycleContext(event, deps.currentEvent), sessionEvent: isSessionEvent(event) }))
      const state = runs.get(event) ?? start(event)
      // Existing sessions skip factory(), but this request still runs middleware.
      const candidate = await state.candidate.promise
      state.dispatch.resolve(async native => {
        sessionLifecycle(event, 'provider-entry', () => ({ sameCandidate: candidate === chosen, ...lifecycleContext(event, deps.currentEvent) }))
        if (candidate !== chosen) await candidate.close()
        let response: Response
        try { response = await native(() => chosen, event) }
        catch (error) { sessionLifecycle(event, 'provider-error', () => lifecycleError(error)); throw error }
        sessionLifecycle(event, 'provider-response', () => {
          const sid = resources.get(chosen)?.connection?.sessionId
          return { owner: !!chosen, response: !!response, status: response.status, sid: typeof sid === 'string', sidEqual: typeof sid === 'string' && response.headers.get('mcp-session-id') === sid, adopted: event.context._mcpServer === chosen, receipt: !!state.initialization, ...lifecycleContext(event, deps.currentEvent) }
        })
        if (state.initialization && response.ok) {
          sessionLifecycle(event, 'receipt-wait')
          await state.initialization; sessionRuntime.endInitialization(chosen.server)
          sessionLifecycle(event, 'receipt-done')
        }
        const resource = resources.get(chosen)
        if (!resource) throw new Error('candidate_ownership_missing')
        const sid = resource.connection?.sessionId
        if (!resource.claimed && response.ok && typeof sid === 'string' && response.headers.get('mcp-session-id') === sid && event.context._mcpServer === chosen) {
          if (bySid.has(sid) || bySid.size >= 64) throw new Error('duplicate_session_owner')
          resource.sid = sid
          sessionRuntime.claim(chosen.server, deps.currentEvent, sid, () => { if (bySid.get(sid) === resource) bySid.delete(sid) })
          resource.claimed = true; bySid.set(sid, resource)
          observeSessionSend(chosen.server, resource.connection)
          sessionLifecycle(event, 'adopted', () => ({ adopted: true }))
        }
        return response
      })
      return state.final
    },
    cleanupSession: async sid => {
      const receipt = await deps.cleanupSession(sid)
      const resource = bySid.get(sid)
      if (resource) lifecyclePublish(lifecycleProtocols.get(resource.owner.server), 'cleanup', () => ({ complete: receipt.empty === true }))
      if (resource) { resource.storageEmpty = true; reconcile(resource) }
      return receipt
    },
  })
  const ingressFor = new WeakMap<object, OwnedIngress>()
  return Object.freeze({
    async handle(event: any, ingress: OwnedIngress) {
      sessionLifecycle(event, 'handle', () => ({ ...lifecycleContext(event, deps.currentEvent), singleCL: ingress.rawHeaders.filter(([name]) => name.toLowerCase() === 'content-length').length === 1, hasTE: ingress.rawHeaders.some(([name]) => name.toLowerCase() === 'transfer-encoding') }))
      if (!accepting || !sessionBindingReady() || !startupCredential) { if (ingress.method === 'POST') ingress.terminate('binding_unavailable'); return sessionRefusal('session_binding_unavailable') }
      if (ingress.method === 'POST' && adapter.bodySnapshot().total >= 40) { ingress.terminate('body_capacity'); return sessionRefusal('body_capacity') }
      sessionEvents.add(event); ingressFor.set(event, ingress)
      if (authenticateSession(ingress.headers, deps.currentCredential(event)).kind === 'invalid') {
        if (ingress.method === 'POST') ingress.terminate('invalid_identity')
        return sessionRefusal('invalid_identity', 401)
      }
      const response = await adapter.handle(event, ingress)
      sessionLifecycle(event, 'adapter-response', () => ({ status: response.status }))
      return response
    },
    replayIngress(original: any, current: any) {
      const ingress = ingressFor.get(original)
      if (!ingress) throw new Error('replay_ingress_missing')
      sessionEvents.add(current); ingressFor.set(current, ingress)
      if (lifecycleChannel.hasSubscribers) { try { const attempt = lifecycleAttempt(original); if (attempt) lifecycleEvents.set(current, attempt) } catch {} }
      sessionLifecycle(current, 'replay', () => ({ replay: true, ...lifecycleContext(current, deps.currentEvent) }))
    },
    shutdown() { accepting = false; const result = adapter.shutdown(); return { ...result, complete: result.complete && replays.size === 0 && toolkitRuns === 0 } },
    snapshot: () => ({ admission: adapter.snapshot(), requests: adapter.requestSnapshot(), body: adapter.bodySnapshot(), runtime: sessionRuntime.snapshot(), observations: sessionRuntime.observations(), replays: replays.size, toolkitRuns }),
  })
}

/** Bounded error JSON only. Normal SDK SSE/binary stays streaming through H3. */
export async function queueSessionResponse(event: any, response: Response): Promise<any> {
  if (event.node.res.closed || event.node.res.writableEnded) return
  if (response.status < 400 || !response.headers.get('content-type')?.includes('application/json')) return response
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []
  let count = 0
  if (reader) {
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        count += part.value.byteLength
        if (count > 8192) { void reader.cancel().catch(() => {}); throw new Error('error_response_limit') }
        chunks.push(part.value)
      }
    } catch {
      chunks.length = 0
      chunks.push(new TextEncoder().encode('{"error":{"code":"session_response_failed"}}'))
      count = chunks[0]!.byteLength
    } finally { reader.releaseLock() }
  }
  const bytes = Buffer.concat(chunks, count)
  event.node.res.statusCode = response.status
  for (const [key, value] of response.headers) event.node.res.setHeader(key, value)
  event.node.res.setHeader('content-length', bytes.byteLength)
  event.node.res.end(bytes)
}
