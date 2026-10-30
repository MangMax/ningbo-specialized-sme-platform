import { createSessionAdmission, type AdmissionLease } from './mcp-session-admission'

export type SessionIdentity = { kind: 'invalid' } | { kind: 'anonymous'; epoch: number } | {
  kind: 'authorized'; epoch: number; principal: string
}
export interface SessionConnection {
  sessionId?: string
  closeStandaloneSSEStream?(): void
  closeSSEStream?(requestId: string | number): void
  close(): Promise<void>
}
export interface SessionOwner {
  close(): Promise<void>
  connect(transport: SessionConnection): Promise<void>
}
/** Caller transfers only this request's ingress, never a shared session connection.
 * closed must acknowledge actual reader/connection termination, not scheduling it.
 * A capacity refusal does not accept ownership; caller must dispose that ingress. */
export interface OwnedIngress {
  method: string; url: string; headers: Headers
  rawHeaders: Array<[string, string]>
  body: ReadableStream<Uint8Array> | null
  responseFinished?: Promise<{ finished: true }>
  closed: Promise<{ closed: true }>
  /** Actual peer close; registration must report an already-closed peer synchronously.
   * The returned detach must synchronously remove the observer and must not throw.
   * This is an actual listener, not a non-removable Promise.then wrapper. */
  subscribeClosed?(listener: () => void): () => void
  terminate(reason: string): void | Promise<void>
}
export interface IngressClock {
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(timer: unknown): void
}
export interface InitializationDependencies<E, O extends SessionOwner> {
  /** Receipt from the actual registered SDK handler, not provider Response return. */
  handlerFinished?(event: E, request: { sessionId: string; id: string | number; method: string }): Promise<{ finished: true }>
  /** Trusted monotonic component clock; never vendor lastAccessed or wall clock. */
  lifecycleClock?: IngressClock & { now(): number }
  clock?: IngressClock
  replay(event: E, request: Request, run: (event: E) => Promise<Response>): Promise<Response>
  authenticate(event: E): SessionIdentity | Promise<SessionIdentity>
  factory(event: E): O | Promise<O>
  provider(factory: () => O, event: E): Promise<Response>
  adopted(event: E): O | undefined
  cleanupSession(sessionId: string): Promise<{ empty: true }>
}

function refusal(status: number, code: string) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: code, data: { code } } }), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}
function sameIdentity(a: Exclude<SessionIdentity, { kind: 'invalid' }>, b: Exclude<SessionIdentity, { kind: 'invalid' }>) {
  return a.kind === b.kind && a.epoch === b.epoch && (a.kind !== 'authorized' || (b.kind === 'authorized' && a.principal === b.principal))
}

/** Admission, request quotas and public-provider dispatch. Independent GET streams and monotonic bounded session lifetime. */
export function createSessionInitializationTransport<E, O extends SessionOwner>(deps: InitializationDependencies<E, O>) {
  const admission = createSessionAdmission()
  type IdState = { active: boolean; handlerDone: boolean; cancelled: boolean }
  type Entry = { lease: AdmissionLease; identity: Exclude<SessionIdentity, { kind: 'invalid' }>; owner: O; connection?: SessionConnection; ordinary: number; control: number; get: number; life: Life; ids: Map<string, IdState>; jobs: Set<Job> }
  type Job = { context: E; kind: 'ordinary' | 'control' | 'get'; deleting: boolean; done: Promise<void> }
  const sessions = new Map<string, Entry>()
  const jobs = new Set<Job>()
  let ordinary = 0, control = 0, streams = 0
  type Life = { lease: AdmissionLease; created: number; last: number; published: boolean; timer?: unknown;
    closing: boolean; observerFailed?: boolean; detachInitialization?: () => void; resources: Promise<boolean>; resourceDone: (ok: boolean) => void }
  const lives = new Map<AdmissionLease, Life>()
  const lifeClock = deps.lifecycleClock ?? {
    now: () => performance.now(),
    setTimeout(callback: () => void, delay: number) {
      const timer = setTimeout(callback, delay)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      return timer
    },
    clearTimeout(timer: unknown) { clearTimeout(timer as ReturnType<typeof setTimeout>) },
  }
  const deadline = (life: Life) => !life.published
    ? life.created + 5000
    : Math.min(life.created + 1800000, life.last + 300000)
  function disarm(life: Life) {
    if (life.timer !== undefined) lifeClock.clearTimeout(life.timer)
    life.timer = undefined
  }
  function retire(life: Life) {
    if (life.closing) return
    life.closing = true; disarm(life)
    life.detachInitialization?.()
    // close synchronously revokes before any public resource cleanup awaits.
    void life.lease.close().then(result => { if (result.complete) lives.delete(life.lease) })
  }
  function arm(life: Life) {
    disarm(life)
    if (life.closing) return
    const remaining = deadline(life) - lifeClock.now()
    if (remaining <= 0) { retire(life); return }
    life.timer = lifeClock.setTimeout(() => { life.timer = undefined; arm(life) }, remaining)
  }
  function touch(life: Life) { life.last = lifeClock.now(); arm(life) }
  function lifecycleSnapshot() {
    return { streams, timers: [...lives.values()].filter(life => life.timer !== undefined).length, retained: lives.size }
  }
  const idKey = (id: string | number) => typeof id + ':' + String(id)
  const utf8 = new TextEncoder()
  const validId = (id: unknown): id is string | number => (typeof id === 'string' && id.length > 0 && utf8.encode(id).byteLength <= 128) || (typeof id === 'number' && Number.isSafeInteger(id) && id !== 0)
  const verified = (receipt: unknown): boolean => !!receipt && typeof receipt === 'object' && Reflect.ownKeys(receipt).length === 1 && Object.getOwnPropertyDescriptor(receipt, 'finished')?.value === true
  function requestSnapshot() {
    let distinctIds = 0
    for (const entry of sessions.values()) distinctIds += entry.ids.size
    return { ordinary, control, distinctIds, charged: jobs.size }
  }
  function charge(entry: Entry, kind: Job['kind'], response: Promise<{ finished: true }>, context: E, deleting = false) {
    if ((kind === 'ordinary' && (entry.ordinary >= 4 || ordinary >= 32)) || (kind === 'control' && (entry.control >= 2 || control >= 8)) || (kind === 'get' && (entry.get >= 1 || streams >= 8))) return undefined
    let handler = false, finished = false, released = false, resolve!: () => void
    const job: Job = { context, kind, deleting, done: new Promise<void>(r => { resolve = r }) }
    entry[kind]++; kind === 'ordinary' ? ordinary++ : kind === 'control' ? control++ : streams++; entry.jobs.add(job); jobs.add(job)
    function reconcile() {
      if (released || !handler || !finished) return
      released = true; entry[kind]--; kind === 'ordinary' ? ordinary-- : kind === 'control' ? control-- : streams--; entry.jobs.delete(job); jobs.delete(job); resolve()
    }
    response.then(value => { if (verified(value)) { finished = true; reconcile() } }, () => {})
    return { job, handlerDone() { handler = true; reconcile() } }
  }
  // Repository ownership guards, bounded by charged leases; no vendor internals.
  const claims = new Map<string, AdmissionLease>()
  const ownerLeases = new WeakMap<O, AdmissionLease>()
  const connectionLeases = new WeakMap<SessionConnection, AdmissionLease>()
  const clock: IngressClock = deps.clock ?? {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  }
  const bodies = new Set<{ state: 'reading' | 'closing' }>()
  const accepted = new WeakSet<OwnedIngress>()
  function bodySnapshot() {
    let reading = 0, closing = 0
    for (const slot of bodies) slot.state === 'reading' ? reading++ : closing++
    return { reading, closing, total: bodies.size }
  }
  async function consume(input: OwnedIngress, slot: { state: 'reading' | 'closing' }) {
    let active = true, deadline: unknown
    const limit = input.headers.has('mcp-session-id') ? 65536 : 16384
    const fail = (status: number, code: string) => Object.assign(new Error(code), { status, code })
    try {
      const raw = input.rawHeaders.map(([key, value]) => [key.toLowerCase(), value])
      const lengths = raw.filter(([key]) => key === 'content-length')
      if (lengths.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(lengths[0]![1]!)
        || raw.some(([key]) => key === 'transfer-encoding' || key === 'content-encoding')) throw fail(400, 'invalid_framing')
      const expected = Number(lengths[0]![1])
      if (!Number.isSafeInteger(expected)) throw fail(400, 'invalid_framing')
      if (expected > limit) throw fail(413, 'body_too_large')
      if (!input.body) throw fail(400, 'invalid_body')
      const reader = input.body.getReader()
      const read = (async () => {
        const chunks: Uint8Array[] = []; let count = 0
        try {
          while (active) {
            const part = await reader.read()
            if (!active) throw fail(408, 'body_timeout')
            if (part.done) break
            count += part.value.byteLength
            if (count > limit) throw fail(413, 'body_too_large')
            chunks.push(part.value)
          }
          if (count !== expected) throw fail(400, 'invalid_framing')
          const bytes = new Uint8Array(count); let offset = 0
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
          const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
          if (message?.method === 'initialize' && count > 16384) throw fail(413, 'body_too_large')
          return { bytes, message }
        } finally { reader.releaseLock() }
      })()
      const result = await Promise.race([read, new Promise<never>((_, reject) => {
        deadline = clock.setTimeout(() => reject(fail(408, 'body_timeout')), 5000)
      })])
      bodies.delete(slot) // EOF and framing verified; no orphan tee exists.
      return { ok: true as const, ...result }
    } catch (error) {
      active = false
      slot.state = 'closing'
      // Retain one bounded slot until a strict external close receipt arrives.
      const receipt = input.closed.then(value => {
        if (!value || Reflect.ownKeys(value).length !== 1 || Object.getOwnPropertyDescriptor(value, 'closed')?.value !== true) return false
        bodies.delete(slot); return true
      }, () => false)
      try { Promise.resolve(input.terminate('body_rejected')).catch(() => {}) } catch { /* receipt still required */ }
      let observation: unknown
      await Promise.race([receipt, new Promise<void>(resolve => { observation = clock.setTimeout(resolve, 250) })])
      clock.clearTimeout(observation)
      const failure = error as { status?: number; code?: string }
      return { ok: false as const, response: refusal(failure.status ?? 400, failure.code ?? 'invalid_body') }
    } finally { active = false; clock.clearTimeout(deadline) }
  }

  async function handle(event: E, request: OwnedIngress): Promise<Response> {
    let message: any
    if (request.method === 'POST') {
      if (bodies.size >= 40) return refusal(503, 'body_capacity')
      if (accepted.has(request)) return refusal(409, 'ingress_already_owned')
      accepted.add(request)
      const slot = { state: 'reading' as const }; bodies.add(slot)
      const result = await consume(request, slot)
      if (!result.ok) return result.response
      message = result.message
      const replay = new Request(request.url, { method: 'POST', headers: request.headers, body: result.bytes })
      try { return await deps.replay(event, replay, current => dispatch(current, request, message)) }
      catch { return refusal(500, 'replay_failed') }
    }
    return dispatch(event, request, message)
  }

  async function dispatch(event: E, request: OwnedIngress, message: any): Promise<Response> {
    let identity: SessionIdentity
    try { identity = await deps.authenticate(event) } catch { return refusal(401, 'invalid_identity') }
    const authorization = request.headers.get('authorization')
    if (identity.kind === 'invalid' || !Number.isSafeInteger(identity.epoch) || identity.epoch < 0
      || (identity.kind === 'anonymous' && authorization !== null)
      || (identity.kind === 'authorized' && (!authorization?.trim() || /^Bearer\s*$/i.test(authorization) || !identity.principal || identity.principal.length > 256))) {
      return refusal(401, 'invalid_identity')
    }
    const sid = request.headers.get('mcp-session-id')
    const existing = sid ? sessions.get(sid) : undefined
    if (sid !== null && (!existing || !sameIdentity(existing.identity, identity))) return refusal(404, 'session_not_found')
    if (existing && deadline(existing.life) <= lifeClock.now()) retire(existing.life)
    if (existing && existing.lease.state() !== 'ready') return refusal(409, 'session_closing')
    if (request.method === 'GET') {
      if (!existing) return refusal(404, 'session_not_found')
      if (!request.responseFinished) return refusal(503, 'response_receipt_required')
      if (existing.get >= 1) return refusal(409, 'stream_already_active')
      if (streams >= 8) return refusal(503, 'stream_capacity')
      if (!existing.connection?.closeStandaloneSSEStream) return refusal(501, 'stream_close_unavailable')
      const ticket = charge(existing, 'get', request.responseFinished, event)!
      // The caller's native close alone does not cancel every Web stream bridge.
      // Keep this generation charged until its public SDK stream is closed too;
      // a successor GET cannot enter before the old receipt reconciles.
      let finishDispatch!: () => void
      const dispatchDone = new Promise<void>(resolve => { finishDispatch = resolve })
      Promise.all([request.responseFinished, dispatchDone]).then(([receipt]) => {
        if (!verified(receipt)) return
        existing.connection!.closeStandaloneSSEStream!()
        ticket.handlerDone()
      }).catch(() => {}) // close failure retains the charge; no retry
      touch(existing.life)
      try { return await deps.provider(() => existing.owner, event) }
      catch { return refusal(500, 'provider_failed') }
      finally { finishDispatch() }
    }
    if (request.method === 'DELETE') {
      if (!existing) return refusal(404, 'session_not_found')
      if (!request.responseFinished) return refusal(503, 'response_receipt_required')
      const ticket = charge(existing, 'control', request.responseFinished, event, true)
      if (!ticket) return refusal(503, 'control_capacity')
      try {
        retire(existing.life)
        // Resource completion permits the DELETE response. Final lease release
        // still waits for this response receipt, avoiding a self-await cycle.
        const clean = await existing.life.resources
        return clean ? new Response(null, { status: 204 }) : refusal(503, 'cleanup_incomplete')
      } finally { ticket.handlerDone() }
    }
    if (request.method !== 'POST') return refusal(405, 'method_not_supported')
    if (existing) {
      if (existing.lease.state() !== 'ready') return refusal(409, 'session_closing')
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return refusal(400, 'invalid_rpc')
      if (!request.responseFinished) return refusal(503, 'response_receipt_required')
      const isControl = message.method === 'notifications/initialized' || message.method === 'notifications/cancelled'
      if (isControl) {
        if ('id' in message || (message.method === 'notifications/cancelled' && !validId(message.params?.requestId))) return refusal(400, 'invalid_control')
        if (message.method === 'notifications/cancelled' && message.params?.reason !== undefined
          && (typeof message.params.reason !== 'string' || utf8.encode(message.params.reason).byteLength > 1024)) return refusal(400, 'invalid_control')
        const ticket = charge(existing, 'control', request.responseFinished, event)
        if (!ticket) return refusal(503, 'control_capacity')
        try {
          if (message.method === 'notifications/cancelled') {
            const target = existing.ids.get(idKey(message.params.requestId))
            // Do not call vendor (which refreshes lastAccessed) for no-op cancels.
            if (!target?.active || target.handlerDone || target.cancelled) return new Response(null, { status: 202 })
            target.cancelled = true
          }
          touch(existing.life)
          return await deps.provider(() => existing.owner, event)
        } catch { return refusal(500, 'provider_failed') }
        finally { ticket.handlerDone() }
      }
      if (!validId(message.id) || message.method === 'initialize') return refusal(400, 'invalid_request_id')
      const key = idKey(message.id)
      if (existing.ids.has(key)) return refusal(409, 'duplicate_request_id')
      if (existing.ids.size >= 256) return refusal(503, 'request_id_capacity')
      if (existing.ordinary >= 4 || ordinary >= 32) return refusal(503, 'request_capacity')
      let handlerReceipt: Promise<{ finished: true }>
      try {
        if (!deps.handlerFinished) return refusal(501, 'handler_receipt_unavailable')
        handlerReceipt = deps.handlerFinished(event, { sessionId: sid!, id: message.id, method: message.method })
      } catch { return refusal(501, 'handler_receipt_unavailable') }
      const ticket = charge(existing, 'ordinary', request.responseFinished, event)!
      const state: IdState = { active: true, handlerDone: false, cancelled: false }
      existing.ids.set(key, state)
      ticket.job.done.then(() => { state.active = false })
      handlerReceipt.then(receipt => {
        if (!verified(receipt)) return
        state.handlerDone = true
        if (state.cancelled) existing.connection?.closeSSEStream?.(message.id)
        ticket.handlerDone()
      }, () => {}).catch(() => {}) // failure to close stream retains the charge
      touch(existing.life)
      try { return await deps.provider(() => existing.owner, event) }
      catch { return refusal(500, 'provider_failed') } // no fabricated handler receipt
    }
    if (message?.jsonrpc !== '2.0' || message.method !== 'initialize' || !('id' in message)) return refusal(501, 'rpc_not_implemented')
    if (message.id !== 0 && !validId(message.id)) return refusal(400, 'invalid_request_id')
    if (!request.subscribeClosed) return refusal(503, 'disconnect_observer_required')
    // A native-ready lease can still be waiting for authentication revalidation.
    // Its unpublished handshake keeps this admission charge until publish/retire.
    if ([...lives.values()].filter(life => !life.published && !life.closing).length >= 8) return refusal(503, 'pending_capacity')
    const reserved = admission.reserve()
    if (!reserved.ok) return refusal(503, reserved.reason)
    const lease = reserved.lease
    let resourceDone!: (ok: boolean) => void
    const resources = new Promise<boolean>(resolve => { resourceDone = resolve })
    const created = lifeClock.now()
    const life: Life = { lease, created, last: created, published: false, closing: false, resources, resourceDone }
    lives.set(lease, life); arm(life)
    let initializing = true
    let detach = () => {}
    const finishInitialization = () => {
      initializing = false
      life.detachInitialization = undefined
      const remove = detach; detach = () => {}
      try { remove() } catch { life.observerFailed = true }
    }
    life.detachInitialization = finishInitialization
    try {
      detach = request.subscribeClosed(() => { if (initializing) retire(life) })
      if (typeof detach !== 'function') throw new Error('invalid_detach')
      if (!initializing) finishInitialization() // synchronous already-closed notification
    } catch {
      life.observerFailed = true
      retire(life)
      return refusal(503, 'disconnect_observer_failed')
    }
    let published: Entry | undefined
    let response: Response | undefined
    let initializationFailed = false
    let captured: SessionConnection | undefined
    let capturedSid: string | undefined
    let unsafeConnection = false
    let retired = false
    let closeOwned: (() => Promise<void>) | undefined
    const initialized = await lease.initialize(async () => {
      let owner: O
      try {
        owner = await deps.factory(event)
        // A rejected borrowed owner is not this lease's resource to close.
        if (ownerLeases.has(owner)) throw new Error('owner_already_owned')
      }
      catch (error) {
        // Reconcile our observer before admission is allowed to release a failed
        // factory. A failed detach is still an owned, unclosed resource.
        finishInitialization()
        if (!life.observerFailed) throw error
        initializationFailed = true
        return { owner: undefined, sessionId: undefined }
      }
      try {
        ownerLeases.set(owner, lease)
        // Explicit candidate ownership. Public close is coalesced even if vendor calls it.
        const originalClose = owner.close.bind(owner)
        let close: Promise<void> | undefined
        closeOwned = () => close ??= Promise.resolve().then(originalClose)
        owner.close = closeOwned
        const originalConnect = owner.connect.bind(owner)
        owner.connect = async transport => {
          if (lease.state() !== 'pending') throw new Error('revoked')
          if (captured || connectionLeases.has(transport)) throw new Error('transport_already_owned')
          captured = transport
          connectionLeases.set(transport, lease)
          // SDK1.32.1 declares a writable public sessionId field. Its assignment
          // precedes onsessioninitialized, so reject collisions BEFORE publication.
          const descriptor = Object.getOwnPropertyDescriptor(transport, 'sessionId')
          if (transport.sessionId !== undefined || (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set))) {
            unsafeConnection = true
            throw new Error('unsupported_transport_identity')
          }
          Object.defineProperty(transport, 'sessionId', {
            configurable: false, enumerable: true,
            get: () => capturedSid,
            set: (value: string | undefined) => {
              if (value === undefined && capturedSid === undefined) return
              if (retired || typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)
                || (capturedSid !== undefined && capturedSid !== value)
                || (claims.has(value) && claims.get(value) !== lease)) throw new Error('session_identity_conflict')
              capturedSid = value
              claims.set(value, lease)
            },
          })
          const originalTransportClose = transport.close.bind(transport)
          let transportClose: Promise<void> | undefined
          transport.close = () => transportClose ??= Promise.resolve().then(originalTransportClose)
          await originalConnect(transport)
          if (lease.state() !== 'pending') throw new Error('revoked')
        }
        if (lease.state() !== 'pending') throw new Error('revoked')
        response = await deps.provider(() => owner, event)
        const headerSid = response.headers.get('mcp-session-id')
        if (!response.ok || !capturedSid || headerSid !== capturedSid || deps.adopted(event) !== owner) initializationFailed = true
      } catch { initializationFailed = true; finishInitialization() }
      // Return ownership even on activation failure: cleanup failure must keep charge.
      return { owner, sessionId: capturedSid }
    }, async ({ owner, sessionId }) => {
      if (!owner) { life.resourceDone(false); throw new Error('disconnect_observer_failed') }
      // A pre-populated/unsupported connection has unproven ownership. Quarantine
      // without invoking a close that could delete somebody else's native session.
      if (unsafeConnection) { life.resourceDone(false); throw new Error('cleanup_ownership_unknown') }
      let failed = life.observerFailed === true
      if (captured?.closeStandaloneSSEStream) {
        try { captured.closeStandaloneSSEStream() } catch { failed = true }
      }
      // A failed public-method assignment must not lose the owned close handle.
      if (closeOwned) { try { await closeOwned() } catch { failed = true } }
      else failed = true
      if (captured) {
        try { await captured.close() } catch { failed = true }
      }
      if (sessionId) {
        if (claims.get(sessionId) !== lease) { life.resourceDone(false); throw new Error('cleanup_ownership_conflict') }
        try {
          const receipt = await deps.cleanupSession(sessionId)
          // Completion of a callback alone is not a verified storage receipt.
          if (!receipt || typeof receipt !== 'object' || Reflect.ownKeys(receipt).length !== 1
            || Object.getOwnPropertyDescriptor(receipt, 'empty')?.value !== true) failed = true
        } catch { failed = true }
      }
      life.resourceDone(!failed)
      if (published) await Promise.all([...published.jobs].map(job => job.done))
      if (failed) throw new Error('cleanup_failed')
      disarm(life); lives.delete(lease)
      retired = true
      if (sessionId) claims.delete(sessionId)
      if (sessionId && sessions.get(sessionId)?.lease === lease) sessions.delete(sessionId)
    })
    if (!initialized.ok) {
      finishInitialization()
      disarm(life); if (lease.state() === 'closed') lives.delete(lease)
      return refusal(503, initialized.reason === 'revoked' ? 'initialization_revoked' : 'initialization_failed')
    }
    if (initializationFailed || !response || !initialized.value.sessionId || !initialized.value.owner) {
      finishInitialization()
      retire(life)
      const result = await lease.close()
      return refusal(result.complete ? 500 : 503, result.complete ? 'initialization_failed' : 'cleanup_incomplete')
    }
    let current: SessionIdentity
    try { current = await deps.authenticate(event) } catch { current = { kind: 'invalid' } }
    if (current.kind === 'invalid' || !sameIdentity(identity, current)) {
      finishInitialization()
      retire(life); await lease.close()
      return refusal(401, 'identity_changed')
    }
    // No await between ready check and publication; shutdown cannot interleave here.
    if (deadline(life) <= lifeClock.now()) retire(life)
    if (life.closing || lease.state() !== 'ready') { finishInitialization(); return refusal(503, 'initialization_revoked') }
    finishInitialization()
    if (life.observerFailed) { retire(life); return refusal(503, 'disconnect_observer_failed') }
    published = { lease, identity, owner: initialized.value.owner, connection: captured, ordinary: 0, control: 0, get: 0, life, ids: new Map([[idKey(message.id), { active: false, handlerDone: true, cancelled: false }]]), jobs: new Set() }
    sessions.set(initialized.value.sessionId, published)
    life.published = true
    finishInitialization()
    touch(life)
    return response
  }

  return Object.freeze({ handle, bodySnapshot, requestSnapshot, lifecycleSnapshot, snapshot: admission.snapshot, shutdown: () => { for (const life of lives.values()) retire(life); const result = admission.shutdown(); return { ...result, complete: result.complete && bodies.size === 0 && jobs.size === 0 && lives.size === 0 } } })
}

/** Caller-side socket ownership. Register EVERY native request before routing.
 * Completion means both actual request end/close and response finish/close.
 * A handler returning is not completion. This helper does not parse HTTP.
 */
export function createSocketOwnership<S extends object>() {
  type Owner = { request: boolean; response: boolean; terminating: boolean; observer?: () => void }
  type State = { active: Set<Owner>; pending: Set<Owner>; destroy: () => void; scheduled: boolean;
    destroyRequested: boolean; closed: boolean; receipt: Promise<{ closed: true }>; acknowledge: () => void }
  const sockets = new WeakMap<S, State>()
  function schedule(state: State) {
    if (state.scheduled || state.closed || state.destroyRequested || !state.pending.size) return
    state.scheduled = true
    queueMicrotask(() => {
      state.scheduled = false
      if (state.closed || state.destroyRequested || !state.pending.size) return
      // New pipelined owners may have joined since termination was requested.
      // No await between this dynamic check, retirement and the actual action.
      for (const owner of state.active) if (!owner.terminating) return
      state.destroyRequested = true
      try { state.destroy() } catch { /* no receipt, no retry, charge remains */ }
    })
  }
  return Object.freeze({
    register(socket: S, destroy: () => void) {
      let state = sockets.get(socket)
      if (!state) {
        let acknowledge!: () => void
        const receipt = new Promise<{ closed: true }>(resolve => { acknowledge = () => resolve({ closed: true }) })
        state = { active: new Set(), pending: new Set(), destroy, scheduled: false, destroyRequested: false, closed: false, receipt, acknowledge }
        sockets.set(socket, state)
      }
      if (state.closed || state.destroyRequested) throw new Error('socket_closing')
      const current = state
      const owner: Owner = { request: false, response: false, terminating: false }
      current.active.add(owner)
      function complete() {
        if (owner.request && owner.response && !owner.observer) current.active.delete(owner)
        schedule(current)
      }
      return Object.freeze({
        closed: current.receipt,
        subscribeClosed(listener: () => void) {
          if (current.closed) { listener(); return () => {} }
          if (!current.active.has(owner) || owner.observer) throw new Error('inactive_or_observed_owner')
          owner.observer = listener
          return () => { if (owner.observer === listener) owner.observer = undefined; complete() }
        },
        requestFinished() { owner.request = true; complete() },
        responseFinished() { owner.response = true; complete() },
        terminate() {
          // A finished old request cannot acquire authority over a reused socket.
          if (current.closed || (!current.active.has(owner) && !owner.terminating)) return
          owner.terminating = true; current.pending.add(owner); schedule(current)
        },
      })
    },
    closed(socket: S) {
      const state = sockets.get(socket)
      if (!state || state.closed) return
      state.closed = true
      const observers = [...state.active].map(owner => { const observer = owner.observer; owner.observer = undefined; return observer })
      state.active.clear(); state.pending.clear(); state.acknowledge()
      for (const observer of observers) { try { observer?.() } catch { /* one caller cannot prevent other close notifications */ } }
    },
    observerCount(socket: S) { return [...(sockets.get(socket)?.active ?? [])].filter(owner => owner.observer).length },
    snapshot(socket: S) {
      const state = sockets.get(socket)
      return { active: state?.active.size ?? 0, terminating: state?.pending.size ?? 0,
        destroyRequested: state?.destroyRequested ?? false, closed: state?.closed ?? false }
    },
  })
}
